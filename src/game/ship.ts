import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { G, MAX_CARVE_CELLS, VOXEL_SIZE, VOXEL_VOLUME, WATER_DENSITY } from "../core/constants";
import { TUN } from "../core/tunables";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { makeVoxelColumns, type VoxelColumn } from "../sim/buoyancy";
import { planCarve } from "../sim/carve";
import { planCrush } from "../sim/crush";
import { computeSurface, updateSurfaceAfterRemoval, unpackCell } from "../sim/surfaceSet";
import { floodStep, type BreachInput, type Opening, type Compartment } from "../sim/compartments";
import { findSevered, type Island } from "../sim/connectivity";
import { MATERIALS, breakEnergy } from "../sim/materials";
import { segmentBoxHit, segmentMastHit, segmentSailHit } from "../sim/rigDamage";
import { meshChunk } from "../render/voxelMesher";
import type { ShipBuild } from "../sim/shipwright";
import type { ShipVisual, SailRecord } from "../render/shipVisual";
import type { Physics } from "./physics";
import { HullCollider } from "./hullCollider";
import type { HullView } from "../sim/voxelOverlap";
import type { ContactTarget } from "./voxelContact";

/**
 * A ship: ONE dynamic rigid body + voxel grid + compartments + visual.
 * Buoyancy/flood/drag forces are applied at probe points every fixed step;
 * listing, trim, and sinking are emergent — nothing here scripts motion.
 */
export class Ship implements ContactTarget {
  readonly body: RAPIER.RigidBody;
  readonly build: ShipBuild;
  readonly visual: ShipVisual;
  /** per-(x,z) hull columns of displacing cells — TRUE per-voxel buoyancy (r16). */
  columns: VoxelColumn[];

  /** Diagnostic: 0..1 share of envelope currently below the surface. */
  submergedFrac = 0;
  /** Live turn-heel lever (m): COM height above the centre of buoyancy, recomputed each
   *  step from the wet voxels. The real arm the old `turnHeelArm` magic number faked. */
  heelArm = 0;

  /** r18 VOXEL-DRIVEN SPRAY. Refreshed every physics step from the wet columns so spray
   *  rides the real hull, not a mechanical outline.
   *  `bowSpray` = the frontmost column still IN the water (the stem at the waterline), world
   *  XYZ at the surface; as the bow lifts clear it retreats to the next wet column. `wet` is
   *  false only when nothing touches the sea.
   *  `waterline` = flat [wx, surfaceY, wz, …] of every column CUTTING the surface (length is
   *  reused across steps; only the first `waterlineN` triples are live), for the subtle
   *  per-voxel fizz all along the hull. */
  readonly bowSpray = { x: 0, y: 0, z: 0, wet: false };
  readonly waterline: number[] = [];
  waterlineN = 0;

  /** Fired when damage severs hull sections; receiver spawns debris bodies. */
  onSevered?: (islands: Island[]) => void;
  /** Fired when a mast goes by the board (foot shot out or trunk smashed). */
  onMastFelled?: (mi: number) => void;
  /** Fired when the rudder takes a ball. */
  onRudderHit?: (hpLeft: number) => void;

  // ---- rig damage state (round 7) ----
  /** Per mast: still standing? */
  mastAlive: boolean[];
  /** Per mast: trunk hits it can still take. */
  mastHp: number[];
  /** Per mast: 1 = whole canvas → 0.15 floor as shot full of holes. */
  sailIntegrity: number[];
  rudderHp = 3;
  /** Steering authority 0.15..1 — yaw torque multiplier. */
  rudderEff = 1;
  private mastFootInit: number[];
  private mastColliders: RAPIER.Collider[] = [];

  /** Ship-local center of mass (meters), cached for force application points. */
  comLocal: [number, number, number];

  /**
   * Waterlogging 0..0.5: once essentially fully flooded, the structure
   * saturates and loses lift until she founders. This is what lets a wooden
   * ship sink without carrying absurd iron ballast (wood alone floats awash).
   */
  waterlog = 0;

  private keelAnchor: [number, number, number];
  private inertia: [number, number, number];
  /** the TUNED box inertia at full health (carries the 1.6× added-mass) — the calibration we keep. */
  private inertiaBox: [number, number, number] = [1, 1, 1];
  /** the REAL voxel inertia of the intact hull — denominator for the per-axis damage ratio. */
  private inertia0Real: [number, number, number] = [1, 1, 1];

  /** cell index → compartment id, for breach detection. */
  private cellComp = new Map<number, number>();
  /** Per compartment: breach cell coordinates (hull holes below decks). */
  private breachCells = new Map<number, [number, number, number][]>();
  /** Holes shot through bulkheads connecting compartments. */
  private openings: Opening[] = [];
  /** Per-compartment flood geometry, recomputed each step for compartments that hold water or
   *  have a breach: the world-horizontal POOL surface height (for two-reservoir breach heads) and
   *  the WET-cell local centroid (where the floodwater weight bears → free-surface list/capsize).
   *  Cell local centres + sort scratch are built once per compartment (cells are static). */
  private floodGeom = new Map<
    number,
    {
      lx: Float32Array; ly: Float32Array; lz: Float32Array;
      worldY: Float32Array; order: Int32Array;
      poolY: number; cx: number; cy: number; cz: number; hasWater: boolean;
    }
  >();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  /** live heave stiffness k = ρg·waterplaneArea·buoyancy (N/m), set each step for damping. */
  private heaveStiffness = 0;

  private phys: Physics;
  private deckCollider: RAPIER.Collider | null = null;
  /** SHIP-SHIP / debris contact shape: the real voxel hull, mutated on damage (Task 1). */
  readonly hull!: HullCollider;

  /** Packed keys of every solid cell with an exposed face — the hull's boundary. Maintained
   *  incrementally as the hull is carved; the deformable contact (voxelContact) tests only
   *  these against the other hull, never the ~10^4 interior cells. */
  private surface!: Set<number>;
  /** Lazily-materialized packed [x,y,z,...] view of `surface`, rebuilt when the set changes. */
  private surfaceCache: Int32Array | null = null;

  constructor(phys: Physics, build: ShipBuild, visual: ShipVisual, spawn: { x: number; y: number; z: number }) {
    this.phys = phys;
    this.build = build;
    this.visual = visual;
    this.columns = makeVoxelColumns(build.grid, build.compartments);
    this.surface = computeSurface(build.grid);

    // keel anchor: lowest solid cell on the midship centerline
    const [kx, , knz] = build.grid.dims;
    const ax = Math.floor(kx / 2);
    const az = Math.floor(knz / 2);
    let ay = 0;
    while (ay < build.grid.dims[1] && !build.grid.isSolid(ax, ay, az)) ay++;
    this.keelAnchor = [ax, ay, az];

    for (const c of build.compartments) {
      for (const cell of c.cells) this.cellComp.set(cell, c.id);
      this.breachCells.set(c.id, []);
    }

    const { world, RAPIER: R } = phys;
    const mass = build.grid.totalMass();
    const com = build.grid.centerOfMass();
    this.comLocal = com;
    const [nx, ny, nz] = build.grid.dims;
    const l = nx * VOXEL_SIZE;
    const h = ny * VOXEL_SIZE;
    const w = nz * VOXEL_SIZE;

    // box-approximated principal inertia about the COM. Pitch/yaw carry a
    // 1.6× added-mass factor: a hull drags entrained water with it when it
    // pitches, and the bare box value let the brig hobby-horse in the swell
    // (raised again round 8 with the rest of the "substantial" pass)
    const ixx = (mass / 12) * (w * w + h * h);
    const iyy = (mass / 12) * (l * l + w * w) * 1.6;
    const izz = (mass / 12) * (l * l + h * h) * 1.6;
    this.inertia = [ixx, iyy, izz];
    this.inertiaBox = [ixx, iyy, izz];
    this.inertia0Real = build.grid.massProperties().inertia;

    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(0.02)
      .setAngularDamping(0.15)
      .setAdditionalMassProperties(
        mass,
        { x: com[0], y: com[1], z: com[2] },
        { x: ixx, y: iyy, z: izz },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    this.body = world.createRigidBody(desc);

    // SHIP-SHIP / debris contact: the real voxel hull shape (mutated on damage).
    // Group 0x0002ffff keeps it out of the character world; the deck trimesh
    // (below) is what characters walk. Replaces the old coarse box (Task 1).
    this.hull = new HullCollider(phys, this.body, build.grid);
    // Take ship-vs-ship out of Rapier's rigid solver: tag this body as a ship and flag the
    // hull collider so phys.hooks.filterContactPair fires for any pair touching it. Two ship
    // hulls then generate no rigid impulse — the deformable voxelContact owns that response.
    phys.shipBodies.add(this.body.handle);
    this.hull.collider.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);

    // the mast is solid — you should not be able to walk through it
    // (playtest round 5: "the mast has no physical hitbox")
    for (const m of build.masts) {
      const deckTop = (build.deckYAt(m.x) + 1) * VOXEL_SIZE;
      const mastCol = R.ColliderDesc.cylinder(m.h / 2, 0.18)
        .setTranslation((m.x + 0.5) * VOXEL_SIZE, deckTop + m.h / 2 - 0.5, (m.z + 0.5) * VOXEL_SIZE)
        .setDensity(0);
      const mc = world.createCollider(mastCol, this.body);
      mc.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS); // ship-vs-ship → deformable, not rigid
      this.mastColliders.push(mc);
    }

    this.mastAlive = build.masts.map(() => true);
    this.mastHp = build.masts.map(() => 2);
    this.sailIntegrity = build.masts.map(() => 1);
    this.mastFootInit = build.masts.map((m) => this.mastFootCount(m));

    this.rebuildDeckCollider();
  }

  /** Solid planking left in the disk the mast steps on (deck + the support
   *  course under it). When most of it is blown away, the mast goes. */
  private mastFootCount(m: { x: number; z: number }): number {
    const grid = this.build.grid;
    const yd = this.build.deckYAt(m.x);
    let n = 0;
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        if (dx * dx + dz * dz > 5) continue;
        if (grid.isSolid(m.x + dx, yd, m.z + dz)) n++;
        if (grid.isSolid(m.x + dx, yd - 1, m.z + dz)) n++;
      }
    }
    return n;
  }

  /** The mast goes by the board: rig falls, drive dies, trunk stops blocking. */
  fellMast(mi: number): void {
    if (!this.mastAlive[mi]) return;
    this.mastAlive[mi] = false;
    this.sailIntegrity[mi] = 0;
    const col = this.mastColliders[mi];
    if (col) this.phys.world.removeCollider(col, false);
    this.visual.fellMast(mi);
    this.onMastFelled?.(mi);
  }

  /** A ball into the trunk. Two stop the mast cold. */
  hitMast(mi: number): void {
    if (!this.mastAlive[mi]) return;
    this.mastHp[mi] -= 1;
    if (this.mastHp[mi] <= 0) this.fellMast(mi);
  }

  /** A ball through the canvas: that mast pulls a little less. */
  hitSail(mi: number): void {
    this.sailIntegrity[mi] = Math.max(this.sailIntegrity[mi] - 0.07, 0.15);
  }

  /** A ball into the rudder: the helm answers ever more sluggishly. */
  hitRudder(): void {
    this.rudderHp = Math.max(this.rudderHp - 1, 0);
    this.rudderEff = Math.max(this.rudderHp / 3, 0.15);
    this.onRudderHit?.(this.rudderHp);
  }

  private tmpHitA = new THREE.Vector3();
  private tmpHitB = new THREE.Vector3();

  /**
   * Everything a ball's swept segment hits in the RIG this step: every sail
   * crossed (cloth never stops a ball) plus the first hard stop (mast trunk
   * or rudder blade), if any. World-space in, ship-local tests inside.
   */
  rigImpacts(
    fromW: THREE.Vector3,
    toW: THREE.Vector3,
  ): {
    sails: { rec: SailRecord; y: number; z: number }[];
    stop: { kind: "mast"; mi: number } | { kind: "rudder" } | null;
  } {
    const p0 = this.worldToLocal(this.tmpHitA.copy(fromW), this.tmpHitA);
    const p1 = this.worldToLocal(this.tmpHitB.copy(toW), this.tmpHitB);

    const sails: { rec: SailRecord; y: number; z: number }[] = [];
    for (const rec of this.visual.sails) {
      if (!this.mastAlive[rec.mastIdx]) continue; // fallen rig: rects are stale
      const hit = segmentSailHit(p0, p1, rec);
      if (hit) sails.push({ rec, y: hit.y, z: hit.z });
    }

    let stop: { kind: "mast"; mi: number } | { kind: "rudder" } | null = null;
    this.build.masts.forEach((m, mi) => {
      if (stop || !this.mastAlive[mi]) return;
      const deckTop = (this.build.deckYAt(m.x) + 1) * VOXEL_SIZE;
      const cyl = {
        x: (m.x + 0.5) * VOXEL_SIZE,
        z: (m.z + 0.5) * VOXEL_SIZE,
        yBase: deckTop,
        yTop: deckTop + m.h - 0.5,
        r: 0.32,
      };
      if (segmentMastHit(p0, p1, cyl)) stop = { kind: "mast", mi };
    });

    if (!stop && this.rudderHp > 0) {
      // the rudder hangs off the stern post (low-x end), reaching from the
      // heel up the transom — mirror of shipVisual's blade construction
      const sternX = 4 * VOXEL_SIZE;
      const bladeW = 0.9 + this.build.lengthM * 0.022;
      const bladeH = this.build.deckY * VOXEL_SIZE * 0.95;
      const zC = (this.build.grid.dims[2] / 2) * VOXEL_SIZE;
      const box = {
        min: { x: sternX - bladeW - 0.4, y: 0.1, z: zC - 0.45 },
        max: { x: sternX + 0.3, y: 1.8 + bladeH * 0.55, z: zC + 0.45 },
      };
      if (segmentBoxHit(p0, p1, box)) stop = { kind: "rudder" };
    }

    return { sails, stop };
  }

  /**
   * Exact walkable surface: a trimesh from the greedy mesh, attached to the
   * ship body (characters stand on the real deck and fall through real
   * holes). Rebuilt after damage so blast craters become terrain.
   */
  rebuildDeckCollider(): void {
    const { world, RAPIER: R } = this.phys;
    if (this.deckCollider) {
      world.removeCollider(this.deckCollider, false);
      this.deckCollider = null;
    }
    const grid = this.build.grid;
    const [nx, ny, nz] = grid.dims;
    const verts: number[] = [];
    const idxs: number[] = [];
    const CS = 16;
    for (let cx = 0; cx <= Math.floor((nx - 1) / CS); cx++) {
      for (let cy = 0; cy <= Math.floor((ny - 1) / CS); cy++) {
        for (let cz = 0; cz <= Math.floor((nz - 1) / CS); cz++) {
          const data = meshChunk(grid, cx, cy, cz);
          if (!data) continue;
          const base = verts.length / 3;
          verts.push(...data.positions);
          for (const i of data.indices) idxs.push(base + i);
        }
      }
    }
    if (idxs.length === 0) return;
    this.deckCollider = world.createCollider(
      R.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idxs)).setDensity(0),
      this.body,
    );
    // ship-vs-ship is deformable: flag the deck too so the contact hook fires for ANY pair of
    // ship colliders (deck-deck, deck-hull, …) and filters them out of the rigid solver —
    // otherwise two decks/superstructures rigidly hold the hulls apart and the crunch starves.
    this.deckCollider.setActiveHooks(this.phys.RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
  }

  /** Planks left for breach repairs. */
  planks = 8;
  /** Pump state: drains the most-flooded compartment while on. */
  pumpOn = false;
  private static PUMP_RATE = 0.12; // m³/s

  /**
   * Plug the deepest open breach with a plank. Returns true on success.
   * (Channel time is the caller's concern — this is the instantaneous fix.)
   */
  plugBreach(): boolean {
    if (this.planks <= 0) return false;
    let bestComp = -1;
    let bestIdx = -1;
    let bestY = Infinity;
    for (const [compId, cells] of this.breachCells) {
      for (let i = 0; i < cells.length; i++) {
        if (cells[i][1] < bestY) {
          bestY = cells[i][1];
          bestComp = compId;
          bestIdx = i;
        }
      }
    }
    if (bestComp < 0) return false;
    this.breachCells.get(bestComp)!.splice(bestIdx, 1);
    this.planks--;
    return true;
  }

  /** Any unplugged breaches left? */
  hasBreaches(): boolean {
    for (const cells of this.breachCells.values()) if (cells.length > 0) return true;
    return false;
  }

  /** Fill fraction (0..1) of a compartment. */
  floodFrac(compartmentId: number): number {
    const c = this.build.compartments[compartmentId];
    return c ? c.waterVolume / c.volume : 0;
  }

  /** Total water aboard, m³ — for HUD/AI. */
  waterAboard(): number {
    return this.build.compartments.reduce((s, c) => s + c.waterVolume, 0);
  }

  /**
   * Advance flooding one fixed step. Each breach is a TWO-RESERVOIR orifice between the sea and the
   * compartment's own pool: we resolve the sea surface and the pool surface AT each hole and hand
   * the signed heads to the deterministic floodStep, which fills toward the waterline EQUILIBRIUM
   * and DRAINS back out when a hole rides above the pool (heel/capsize). Foundering is a separate,
   * later stage gated on lost reserve buoyancy — a single waterline nick just settles her.
   */
  updateFlooding(dt: number, waves: Wave[], t: number): void {
    // pool surfaces + wet centroids for every compartment that holds water or is breached
    this.updateFloodGeom();

    const breaches: BreachInput[] = [];
    const p = this.tmpV;
    const cellArea = VOXEL_SIZE * VOXEL_SIZE * TUN.flood.inflowScale;

    for (const c of this.build.compartments) {
      const poolY = this.floodGeom.get(c.id)?.poolY ?? -Infinity;

      // each hull hole is its own orifice (a low hole floods while a high one on the same
      // compartment drains): sea above the hole drives IN, the pool above it drives OUT.
      const cells = this.breachCells.get(c.id);
      if (cells && cells.length > 0) {
        for (const [x, y, z] of cells) {
          this.localToWorld([(x + 0.5) * VOXEL_SIZE, (y + 0.5) * VOXEL_SIZE, (z + 0.5) * VOXEL_SIZE], p);
          const extHead = surfaceHeight(waves, p.x, p.z, t) - p.y; // sea above the hole
          const intHead = poolY - p.y; // internal pool above the hole
          if (extHead > 0 || intHead > 0) breaches.push({ compartmentId: c.id, area: cellArea, extHead, intHead });
        }
      }

      // deck hatch: an orifice at the coaming lip (raised, so deck wash doesn't flood the hold).
      // Two-way for free — the sea floods in when it tops the coaming; the pool drains out the
      // same lip once she's rolled far enough that the hatch goes under on the low side.
      if (c.hatchArea > 0) {
        const COAMING = 0.55; // m
        const hx = (c.bboxMin[0] + c.bboxMax[0]) / 2;
        this.localToWorld(
          [(hx + 0.5) * VOXEL_SIZE, (this.build.deckY + 0.5) * VOXEL_SIZE, (this.build.grid.dims[2] / 2) * VOXEL_SIZE],
          p,
        );
        const holeY = p.y + COAMING;
        const extHead = surfaceHeight(waves, p.x, p.z, t) - holeY;
        const intHead = poolY - holeY;
        if (extHead > 0 || intHead > 0) {
          breaches.push({ compartmentId: c.id, area: c.hatchArea * TUN.flood.inflowScale, extHead, intHead });
        }
      }
    }

    floodStep(this.build.compartments, this.openings, breaches, dt);

    // Foundering is the END stage, gated on lost reserve buoyancy (she's settling under), NOT on a
    // compartment merely topping up — so a single waterline breach settles & survives. `waterlog`
    // bleeds her remaining lift once she's that deep; she recovers if drained/pumped back up.
    let totWater = 0;
    for (const c of this.build.compartments) totWater += c.waterVolume;
    const founder = TUN.flood.founderSubmerge;
    if (totWater > 0 && this.submergedFrac > founder) {
      this.waterlog = Math.min(this.waterlog + 0.02 * dt, 0.5);
    } else if (this.submergedFrac < founder * 0.7) {
      this.waterlog = Math.max(this.waterlog - 0.02 * dt, 0);
    }

    if (this.pumpOn) {
      let worst: (typeof this.build.compartments)[number] | null = null;
      for (const c of this.build.compartments) {
        if (!worst || c.waterVolume > worst.waterVolume) worst = c;
      }
      if (worst) worst.waterVolume = Math.max(worst.waterVolume - Ship.PUMP_RATE * dt, 0);
    }
  }

  /** Recompute pool surfaces + wet centroids for compartments that hold water or are breached. The
   *  pool is a world-horizontal plane: rank the interior cells by world-Y and wet the lowest
   *  `fill·n` (volume-exact, since cells are equal). `poolY` is that pool's surface; the wet-cell
   *  local centroid is where the floodwater weight bears (low side when heeled). Dry, unbreached
   *  compartments are skipped — normally that's all of them, so this is ~free while afloat. */
  private updateFloodGeom(): void {
    const tr = this.body.translation();
    const rot = this.body.rotation();
    const qx = rot.x, qy = rot.y, qz = rot.z, qw = rot.w;
    for (const c of this.build.compartments) {
      const breached = (this.breachCells.get(c.id)?.length ?? 0) > 0;
      if (c.waterVolume <= 1e-6 && !breached) {
        const old = this.floodGeom.get(c.id);
        if (old) { old.hasWater = false; old.poolY = -Infinity; }
        continue;
      }
      const g = this.floodCellArrays(c);
      const n = g.lx.length;
      if (n === 0) { g.hasWater = false; g.poolY = -Infinity; continue; }
      const wy = g.worldY, ord = g.order;
      for (let i = 0; i < n; i++) {
        const vx = g.lx[i], vy = g.ly[i], vz = g.lz[i];
        // quaternion-rotate the cell centre, y-component only, + translation → absolute world-Y
        const tx = 2 * (qy * vz - qz * vy);
        const ty = 2 * (qz * vx - qx * vz);
        const tz = 2 * (qx * vy - qy * vx);
        wy[i] = vy + qw * ty + (qz * tx - qx * tz) + tr.y;
        ord[i] = i;
      }
      (ord as unknown as { sort(cmp: (a: number, b: number) => number): void }).sort((a, b) => wy[a] - wy[b]);
      const fill = c.volume > 0 ? c.waterVolume / c.volume : 0;
      const wetCount = Math.min(n, Math.max(0, Math.round(fill * n)));
      // pool surface = top of the highest wet cell; empty → just under the lowest cell (a dry floor)
      g.poolY = wetCount > 0 ? wy[ord[wetCount - 1]] + VOXEL_SIZE * 0.5 : wy[ord[0]] - VOXEL_SIZE * 0.5;
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < wetCount; k++) {
        const i = ord[k];
        sx += g.lx[i]; sy += g.ly[i]; sz += g.lz[i];
      }
      const m = Math.max(wetCount, 1);
      g.cx = sx / m; g.cy = sy / m; g.cz = sz / m;
      g.hasWater = wetCount > 0;
    }
  }

  /** Lazily build + cache the per-compartment cell local-centre arrays and sort scratch. Compartment
   *  cells are static after build, so this runs once per compartment. */
  private floodCellArrays(c: Compartment) {
    let g = this.floodGeom.get(c.id);
    if (g && g.lx.length === c.cells.size) return g;
    const n = c.cells.size;
    const lx = new Float32Array(n), ly = new Float32Array(n), lz = new Float32Array(n);
    const [nx, ny] = this.build.grid.dims;
    const layer = nx * ny;
    let i = 0;
    for (const pcell of c.cells) {
      const x = pcell % nx, y = Math.floor(pcell / nx) % ny, z = Math.floor(pcell / layer);
      lx[i] = (x + 0.5) * VOXEL_SIZE; ly[i] = (y + 0.5) * VOXEL_SIZE; lz[i] = (z + 0.5) * VOXEL_SIZE;
      i++;
    }
    g = { lx, ly, lz, worldY: new Float32Array(n), order: new Int32Array(n), poolY: -Infinity, cx: 0, cy: 0, cz: 0, hasWater: false };
    this.floodGeom.set(c.id, g);
    return g;
  }

  /** Apply buoyancy + water drag for one fixed step. Call before world.step(). */
  applyForces(waves: Wave[], t: number): void {
    const body = this.body;
    body.resetForces(true);
    body.resetTorques(true);

    const tr = body.translation();
    const rot = body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);

    // ---- TRUE PER-VOXEL buoyancy (r16) -------------------------------------
    // Every displacing cell pushes up by ρ·g·V_cell·(its OWN submerged fraction)
    // at its OWN height. The wave surface depends only on (x,z), so it's sampled
    // ONCE per column and reused down the stack → per-voxel accuracy at O(columns)
    // wave evals. We accumulate the net vertical force + the couple it makes about
    // the COM and apply them once (rigid-body-identical to per-cell forces, far
    // cheaper than thousands of addForceAtPoint). Because lift grows by exactly
    // ρ·g·(waterplane area) per metre of draft, the stiffness is CONSTANT — she
    // holds a near-fixed waterline instead of wandering ±3 m, and a small bit of
    // bow under water lifts far less than a fat midship section (playtest r16).
    const liftPerCell = WATER_DENSITY * G * VOXEL_VOLUME * TUN.phys.buoyancy * (1 - this.waterlog);
    const com0 = body.worldCom();
    // world-Y gained per 1 m of LOCAL up — folds the live heel/pitch into the
    // vertical stacking of cells without a full transform per cell.
    const upY = this.tmpV2.set(0, 1, 0).applyQuaternion(this.tmpQ).y;
    let netLift = 0;
    let torqueX = 0;
    let torqueZ = 0;
    let waterplane = 0; // m² straddling the surface this step → live heave stiffness
    let submergedVolume = 0;
    let totalVolume = 0;
    // centre of buoyancy (world point) — where the keel's lateral resistance acts, so
    // the leeway force there both RIGHTS her against sail heel and BANKS her in a turn.
    let cbWeight = 0; // Σ submergedFrac  (voxel volume cancels in the centroid ratio)
    let cbXSum = 0; // Σ submergedFrac · cellWorldX
    let cbYSum = 0; // Σ submergedFrac · cellWorldY
    let cbZSum = 0; // Σ submergedFrac · cellWorldZ
    // ... and the wet waterplane's area-moments about the COM, which turn the single
    // heave-damping coefficient into emergent pitch + roll damping (drag block below).
    let aSub = 0; // Σ col.area over columns with any submerged cell
    let sMx = 0; // Σ area·rx        (first moments)
    let sMz = 0; // Σ area·rz
    let sxx = 0; // Σ area·rx·rx     (second moments)
    let szz = 0; // Σ area·rz·rz
    let sxz = 0; // Σ area·rx·rz
    let bowMaxX = -Infinity; // r18: frontmost wet column → voxel bow-spray origin
    this.waterlineN = 0;
    for (const col of this.columns) {
      // column anchor (its lowest cell) → world; sample the surface once here
      const aw = this.tmpV.set(col.x, col.cellY[0], col.z).applyQuaternion(this.tmpQ);
      const wx = aw.x + tr.x;
      const wz = aw.z + tr.z;
      const anchorWY = aw.y + tr.y;
      const surfaceY = surfaceHeight(waves, wx, wz, t);
      const rx = wx - com0.x; // horizontal lever arm of this column from the COM
      const rz = wz - com0.z;
      const y0 = col.cellY[0];
      let straddles = false;
      let colWet = false;
      for (let k = 0; k < col.cellY.length; k++) {
        totalVolume += VOXEL_VOLUME;
        // cell center world-Y, then its submerged fraction over the voxel height
        const cellWY = anchorWY + (col.cellY[k] - y0) * upY;
        const frac = Math.min(Math.max((surfaceY - cellWY) / VOXEL_SIZE + 0.5, 0), 1);
        if (frac > 0) {
          const f = liftPerCell * frac;
          netLift += f;
          // τ = r × F for a vertical F: τx = −rz·F, τz = +rx·F (ry irrelevant)
          torqueX -= rz * f;
          torqueZ += rx * f;
          submergedVolume += VOXEL_VOLUME * frac;
          cbWeight += frac;
          cbXSum += frac * wx;
          cbYSum += frac * cellWY;
          cbZSum += frac * wz;
          colWet = true;
          if (frac < 1) straddles = true;
        }
      }
      if (straddles) waterplane += col.area;
      if (colWet) {
        aSub += col.area;
        sMx += col.area * rx;
        sMz += col.area * rz;
        sxx += col.area * rx * rx;
        szz += col.area * rz * rz;
        sxz += col.area * rx * rz;
        // r18: the frontmost (max local-x) wet column is the stem at the waterline — bow
        // spray emits there and RIDES it as the bow bobs, instead of floating in mid-air.
        if (col.x > bowMaxX) {
          bowMaxX = col.x;
          this.bowSpray.x = wx;
          this.bowSpray.y = surfaceY;
          this.bowSpray.z = wz;
        }
      }
      // every EDGE column (hull skin) actually CUTTING the surface feeds the subtle waterline
      // fizz — interior columns straddle too but their waterline is inside the hull.
      if (straddles && col.edge) {
        const o = this.waterlineN * 3;
        if (o < this.waterline.length) {
          this.waterline[o] = wx;
          this.waterline[o + 1] = surfaceY;
          this.waterline[o + 2] = wz;
        } else {
          this.waterline.push(wx, surfaceY, wz);
        }
        this.waterlineN++;
      }
    }
    // flooded water is accounted as WEIGHT below (not as a lift cut) — scaling lift
    // AND adding weight would double-count; weight-only handles partial submersion.
    body.addForce({ x: 0, y: netLift, z: 0 }, true);
    body.addTorque({ x: torqueX, y: 0, z: torqueZ }, true);
    this.submergedFrac = totalVolume > 0 ? submergedVolume / totalVolume : 0;
    this.bowSpray.wet = bowMaxX > -Infinity; // r18: anything in the water this step?
    // live hydrostatic heave stiffness for the critical-damping term in the drag block
    this.heaveStiffness = WATER_DENSITY * G * waterplane * TUN.phys.buoyancy;
    // live turn-heel lever: COM height above the centre of buoyancy (both world Y). This
    // is the real arm the magic `turnHeelArm` faked — it shrinks as she rises, grows as
    // she settles, and tracks flooding/damage for free. Guarded to a small positive.
    // live centre of buoyancy (world): the keel's lateral force is applied HERE, below
    // the COM, so a turn banks her outward and sail-leeway rights her — both emergent.
    const cbWorldY = cbWeight > 1e-6 ? cbYSum / cbWeight : com0.y;
    const clrX = cbWeight > 1e-6 ? cbXSum / cbWeight : com0.x;
    const clrZ = cbWeight > 1e-6 ? cbZSum / cbWeight : com0.z;
    // diagnostic only now (the heel force comes from applying lateral drag at the CB).
    this.heelArm = com0.y - cbWorldY;

    // flooded water is cargo: its weight bears at the WET-cell centroid, which pools to the LOW
    // side as she heels — so a flooded bow pulls the bow down AND a list deepens itself (the free
    // surface effect). List, and asymmetric-flood capsize, are emergent. Fall back to the geometric
    // centroid + fill height before the flood-geom pass has produced a wet set.
    for (const c of this.build.compartments) {
      if (c.waterVolume <= 0) continue;
      const g = this.floodGeom.get(c.id);
      let lx: number, ly: number, lz: number;
      if (g && g.hasWater) {
        lx = g.cx; ly = g.cy; lz = g.cz;
      } else {
        const fill = c.waterVolume / c.volume;
        lx = c.centroid[0];
        ly = (c.bboxMin[1] + (c.bboxMax[1] + 1 - c.bboxMin[1]) * fill * 0.5 + 0.5) * VOXEL_SIZE;
        lz = c.centroid[2];
      }
      const wp = this.tmpV.set(lx, ly, lz).applyQuaternion(this.tmpQ);
      body.addForceAtPoint(
        { x: 0, y: -c.waterVolume * WATER_DENSITY * 9.81, z: 0 },
        { x: wp.x + tr.x, y: wp.y + tr.y, z: wp.z + tr.z },
        true,
      );
    }

    // water drag split into ship-frame components: a hull slips easily
    // forward, resists sideways motion strongly (the keel), and damps heave.
    // All scaled by how much of the hull is actually in the water.
    const sub = this.submergedFrac;
    if (sub > 0.001) {
      const mass = this.body.mass();
      const v = body.linvel();
      const om = body.angvel();
      const fwd = this.tmpV.set(1, 0, 0).applyQuaternion(this.tmpQ);
      // keep the horizontal drag axes flat so heave stays separable
      fwd.y = 0;
      fwd.normalize();
      const lat = { x: -fwd.z, z: fwd.x }; // horizontal perpendicular (port +)

      const vF = v.x * fwd.x + v.z * fwd.z; // forward speed
      const vL = v.x * lat.x + v.z * lat.z; // sideways (leeway) speed
      const vY = v.y;

      // "in the water at all" — a healthy hull only sinks ~20% of its ENVELOPE, so
      // gating drag on raw `sub` would throttle it to nothing. `wet` saturates the
      // instant she's afloat.
      const wet = Math.min(sub * 5, 1);

      // ---- translational drag ---------------------------------------------------
      // forward slip is light; the keel's lateral grip (leeway resistance) is strong.
      const fF = -mass * 0.04 * (1 + 0.08 * Math.abs(vF)) * vF * sub;
      const fL = -mass * TUN.phys.lateralDrag * vL * sub;

      // ---- EMERGENT heave + pitch + roll damping (ONE coefficient) --------------
      // Every wet column resists vertical motion with a drag ∝ its waterplane area.
      // The vertical velocity at a column offset (rx,rz) from the COM is
      // vY + (ω×r)_y = vY + ωz·rx − ωx·rz, so distributing that single per-area damper
      // over the waterplane area-moments (gathered in the buoyancy pass) yields the
      // heave force AND the pitch/roll couples at once — no separate pitchDamp/rollDamp.
      // The damping matrix is a sum of area·u·uᵀ (u = [1,−rz,rx]) → provably dissipative.
      // cArea is calibrated so PURE heave equals the old critical-ratio 2·ζ·√(k·m)·vY.
      const cHeave = 2 * Math.sqrt(Math.max(this.heaveStiffness * mass, 1));
      const cArea = aSub > 1e-6 ? (TUN.phys.heaveDamp * cHeave * wet) / aSub : 0;
      const fY = -cArea * (vY * aSub + om.z * sMx - om.x * sMz);
      const dampTX = cArea * (vY * sMz + om.z * sxz - om.x * szz); // opposes roll (world X)
      const dampTZ = -cArea * (vY * sMx + om.z * sxx - om.x * sxz); // opposes pitch (world Z)

      // forward slip + heave damping ride at the COM (pure translation, no couple).
      body.addForce({ x: fwd.x * fF, y: fY, z: fwd.z * fF }, true);

      // ---- the keel's lateral resistance, applied at the CENTRE OF BUOYANCY -------
      // This one force does three jobs at once, all emergent: it resists leeway, it
      // supplies a turn's centripetal pull, and — because the CB sits BELOW the COM — it
      // both banks her OUTWARD in a turn and RIGHTS her against sail heel. No turnHeelArm,
      // no keelDepth, no heel cap: the ρgV·GM·sinθ buoyant righting bounds the heel.
      body.addForceAtPoint(
        { x: lat.x * fL, y: 0, z: lat.z * fL },
        { x: clrX, y: cbWorldY, z: clrZ },
        true,
      );

      // yaw damping: the one rotational axis with no buoyant restoring of its own.
      const yawT = -om.y * wet * TUN.phys.yawDamp * this.inertia[1];
      body.addTorque({ x: dampTX, y: yawT, z: dampTZ }, true);
    }
  }

  /** Copy body transform to the visual group. */
  syncVisual(): void {
    const tr = this.body.translation();
    const rot = this.body.rotation();
    this.visual.group.position.set(tr.x, tr.y, tr.z);
    this.visual.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  }

  /**
   * Spend an energy budget destroying voxels from `cell` along `dir` (the one
   * destruction primitive — ramming and cannon fire both route here). Removes
   * cells from the grid AND the voxel collider, registers breaches (incl. the
   * cut faces of any section that breaks off), sheds disconnected islands as
   * debris, and recomputes mass + buoyancy + deck. Returns cells destroyed.
   */
  carve(cell: [number, number, number], energy: number, dir: [number, number, number] | null, maxCells = MAX_CARVE_CELLS): number {
    const grid = this.build.grid;
    const plan = planCarve({
      dims: grid.dims,
      isSolid: (x, y, z) => grid.isSolid(x, y, z),
      strengthAt: (x, y, z) => MATERIALS[grid.get(x, y, z)]?.strength ?? 0,
      origin: cell,
      dir,
      energy,
      maxCells,
    });
    return this.carveCells(plan.cells);
  }

  /** Remove an explicit list of cells — the shared tail of EVERY destruction path
   *  (energy-budget ram carve, cannon bore-through, future tools): grid + voxel collider
   *  + breach bookkeeping, then flag the throttled heavy recompute. Destroyed voxels just
   *  VANISH (callers spawn dust) — they are never regrouped into a rigid body; only a
   *  fully-disconnected island above a size threshold becomes one (see debris.ts). Returns
   *  the count actually removed (already-empty cells are skipped). */
  carveCells(cells: [number, number, number][]): number {
    const grid = this.build.grid;
    const gone: [number, number, number][] = [];
    for (const [x, y, z] of cells) {
      if (!grid.isSolid(x, y, z)) continue;
      grid.remove(x, y, z);
      this.hull.removeVoxel(x, y, z);
      gone.push([x, y, z]);
    }
    if (gone.length === 0) return 0;
    updateSurfaceAfterRemoval(grid, this.surface, gone); // keep the boundary set fresh
    this.surfaceCache = null;
    this.registerBreaches(cells);
    this.damageDirty = true; // sever/mass recompute is deferred + throttled (flushDamage)
    this.colliderDirty = true; this.framesSinceCarve = 0; // debounce the heavy deck-collider rebuild
    return gone.length;
  }

  /** The universal destruction entry point: spend `energy` joules removing as many of the
   *  given candidate cells as it can afford (toughest survive), paying each cell's real
   *  material break-energy. Routes removal through carveCells (grid + collider + breaches +
   *  dust). Unlike carve(), the candidate cells are SUPPLIED by the caller — the real
   *  hull-hull overlap (ramming) or the real bore ray (cannon fire) — so holes land exactly
   *  where contact happened, and penetration depth is emergent (the budget reaches as far
   *  down the toughness-sorted candidates as it can pay for). Returns voxels removed +
   *  leftover energy (the caller spends leftover on push/debris). */
  crush(cells: [number, number, number][], energy: number): { removed: number; leftover: number } {
    const grid = this.build.grid;
    // only solid cells cost energy (empty cells are free at strength 0 and would inflate
    // the count for nothing) — pre-filter so the budget is spent on real material.
    const solid = cells.filter(([x, y, z]) => grid.isSolid(x, y, z));
    const { removed, leftover } = planCrush(
      solid,
      ([x, y, z]) => breakEnergy(grid.get(x, y, z)),
      energy,
    );
    const n = this.carveCells(removed);
    return { removed: n, leftover };
  }

  /** Local-frame integer coords of every solid cell with an exposed face, packed
   *  [x,y,z, x,y,z, ...]. Cached; rebuilt only when the hull is carved. Consumed by
   *  voxelOverlap as the cheap boundary set for hull-vs-hull overlap tests. */
  surfaceCells(): Int32Array {
    if (this.surfaceCache) return this.surfaceCache;
    const [nx, ny] = this.build.grid.dims;
    const out = new Int32Array(this.surface.size * 3);
    let i = 0;
    for (const key of this.surface) {
      const [x, y, z] = unpackCell(key, nx, ny);
      out[i++] = x; out[i++] = y; out[i++] = z;
    }
    this.surfaceCache = out;
    return out;
  }

  /** World-space AABB of the live hull's grid envelope, written into `out`, for broad-phase
   *  culling of the deformable contact. Transforms the 8 corners of the local grid box by the
   *  body pose — a safe (slightly loose) bound as cells carve away. */
  aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }): { min: THREE.Vector3; max: THREE.Vector3 } {
    const [nx, ny, nz] = this.build.grid.dims;
    const ex = nx * VOXEL_SIZE, ey = ny * VOXEL_SIZE, ez = nz * VOXEL_SIZE;
    const tr = this.body.translation();
    const rot = this.body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    out.min.set(Infinity, Infinity, Infinity);
    out.max.set(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i < 8; i++) {
      this.tmpV.set(i & 1 ? ex : 0, i & 2 ? ey : 0, i & 4 ? ez : 0).applyQuaternion(this.tmpQ);
      this.tmpV.x += tr.x; this.tmpV.y += tr.y; this.tmpV.z += tr.z;
      out.min.min(this.tmpV); out.max.max(this.tmpV);
    }
    return out;
  }

  /** Heavy post-damage recompute (shed disconnected islands, rebuild buoyancy columns
   *  + deck trimesh), THROTTLED to ~10 Hz. carve() fires every frame during a ram, and
   *  running these whole-hull rebuilds 60×/s per ship tanked the frame rate; the cheap
   *  per-voxel removal (grid + collider + breaches) stays immediate in carve(), so the
   *  visible hole is instant — only this physics recompute lags a few steps. Called once
   *  per fixed step by the world loop; deterministic (step-counted, no wall clock). */
  private damageDirty = false;
  private framesSinceFlush = 0;
  /** The walkable-deck collider rebuild is DEBOUNCED separately from the heavy recompute below.
   *  That ~40 ms whole-grid trimesh rebuild was firing every 6 steps during a sustained ram — the
   *  impact lag. Nobody walks the deck mid-crash, so it now waits for carving to PAUSE
   *  (COLLIDER_QUIET steps) before refreshing the craters; COLLIDER_MAX_STALE forces a refresh
   *  during a very long continuous grind so it can't be starved forever. */
  private colliderDirty = false;
  private framesSinceCarve = 0;
  private stepsSinceColliderBuild = 0;
  flushDamage(): void {
    const COLLIDER_QUIET = 18;      // ~0.3 s of no carving before the deck collider refreshes
    const COLLIDER_MAX_STALE = 300; // ...but a very long continuous grind still refreshes by ~5 s
    this.framesSinceCarve++;
    this.stepsSinceColliderBuild++;
    if (this.colliderDirty && (this.framesSinceCarve >= COLLIDER_QUIET || this.stepsSinceColliderBuild >= COLLIDER_MAX_STALE)) {
      this.colliderDirty = false;
      this.stepsSinceColliderBuild = 0;
      this.rebuildDeckCollider();
    }

    if (!this.damageDirty) return;
    if (++this.framesSinceFlush < 6) return; // ~10 Hz during sustained carving
    this.framesSinceFlush = 0;
    this.damageDirty = false;
    const grid = this.build.grid;
    // anything no longer connected to the anchor breaks off as debris; its removed
    // cells are fresh holes too — register them so the stump floods from the cut.
    const islands = findSevered(grid, this.keelAnchor);
    if (islands.length > 0) {
      const islandCells: [number, number, number][] = [];
      for (const island of islands) {
        for (const c of island.cells) {
          grid.remove(c.x, c.y, c.z);
          this.hull.removeVoxel(c.x, c.y, c.z);
          islandCells.push([c.x, c.y, c.z]);
        }
      }
      updateSurfaceAfterRemoval(grid, this.surface, islandCells); // shed cells leave the boundary
      this.surfaceCache = null;
      this.registerBreaches(islandCells);
      this.colliderDirty = true; this.framesSinceCarve = 0; // geometry changed → refresh (debounced)
      this.onSevered?.(islands);
    }
    // a mast whose step has been blown out goes by the board
    this.build.masts.forEach((m, mi) => {
      if (this.mastAlive[mi] && this.mastFootCount(m) < this.mastFootInit[mi] * 0.5) this.fellMast(mi);
    });
    this.recomputeMassProperties();
  }

  /** Register removed hull cells as breaches: a removed cell adjacent to ONE
   *  compartment's interior is a hull breach; adjacent to TWO is a bulkhead opening.
   *  (Extracted verbatim from the old applyDamage breach loop.) */
  private registerBreaches(cells: [number, number, number][]): void {
    const grid = this.build.grid;
    const [nx, ny] = grid.dims;
    const cidx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
    for (const [x, y, z] of cells) {
      const adj = new Set<number>();
      for (const [px, py, pz] of [[x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1]] as [number, number, number][]) {
        const comp = this.cellComp.get(cidx(px, py, pz));
        if (comp !== undefined) adj.add(comp);
      }
      if (adj.size === 1) {
        const id = adj.values().next().value!;
        this.breachCells.get(id)?.push([x, y, z]);
      } else if (adj.size >= 2) {
        const ids = [...adj];
        for (let i = 0; i < ids.length - 1; i++) this.openings.push({ a: ids[i], b: ids[i + 1], area: VOXEL_SIZE * VOXEL_SIZE });
      }
    }
  }

  /** Refresh rapier mass props + buoyancy probes from the current grid. */
  recomputeMassProperties(): void {
    const grid = this.build.grid;
    const mp = grid.massProperties();
    const mass = Math.max(mp.mass, 1);
    this.comLocal = mp.com;
    // Keep the hull's TUNED rotational feel (the box inertia + its 1.6× added-mass) but track the
    // REAL per-axis change as it's carved: scale each tuned axis by how that axis's true voxel
    // inertia has shifted from the intact hull. The old mass-only rescale left an asymmetrically
    // holed hull with a falsely-symmetric tensor → wrong righting dynamics → it turtled.
    this.inertia = [
      this.inertiaBox[0] * (mp.inertia[0] / this.inertia0Real[0]),
      this.inertiaBox[1] * (mp.inertia[1] / this.inertia0Real[1]),
      this.inertiaBox[2] * (mp.inertia[2] / this.inertia0Real[2]),
    ];
    this.body.setAdditionalMassProperties(
      mass,
      { x: mp.com[0], y: mp.com[1], z: mp.com[2] },
      { x: this.inertia[0], y: this.inertia[1], z: this.inertia[2] },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );
    this.columns = makeVoxelColumns(grid, this.build.compartments);
  }

  /** World-space position of the ship-local point (meters). Alias-safe:
   *  no internal temp vectors, so `out` may be any vector including temps. */
  localToWorld(local: [number, number, number], out: THREE.Vector3): THREE.Vector3 {
    const tr = this.body.translation();
    const rot = this.body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    out.set(local[0], local[1], local[2]).applyQuaternion(this.tmpQ);
    out.x += tr.x;
    out.y += tr.y;
    out.z += tr.z;
    return out;
  }

  /** Ship-local position of a world point (meters). Alias-safe: `out` may
   *  be the same vector as `world`. */
  worldToLocal(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const tr = this.body.translation();
    const rot = this.body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w).invert();
    out.set(world.x - tr.x, world.y - tr.y, world.z - tr.z).applyQuaternion(this.tmpQ);
    return out;
  }

  /** Density-ratio draft estimate (diagnostics): expected submerged fraction at rest. */
  expectedSubmergedFrac(): number {
    return this.build.grid.totalMass() / (WATER_DENSITY * this.build.envelopeVolume);
  }

  // ---- ContactTarget (game/voxelContact.ts B-side): Ship is a full participant in the one
  //      deformable-contact rule. carveCells() and aabbWorld() already exist above. ----
  readonly voxelSize = VOXEL_SIZE;
  readonly canCarve = true;

  fillHullView(hv: HullView): void {
    hv.surface = this.surfaceCells();
    const grid = this.build.grid;
    hv.isSolid = (x, y, z) => grid.isSolid(x, y, z);
    hv.dims = grid.dims;
    const tr = this.body.translation();
    hv.pos[0] = tr.x; hv.pos[1] = tr.y; hv.pos[2] = tr.z;
    const rot = this.body.rotation();
    hv.quat[0] = rot.x; hv.quat[1] = rot.y; hv.quat[2] = rot.z; hv.quat[3] = rot.w;
  }

  comWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.localToWorld(this.comLocal, out);
  }

  linvel(): { x: number; y: number; z: number } { return this.body.linvel(); }
  angvel(): { x: number; y: number; z: number } { return this.body.angvel(); }
  mass(): number { return this.body.mass(); }
  cellBreakEnergy(x: number, y: number, z: number): number { return breakEnergy(this.build.grid.get(x, y, z)); }
  applyImpulseAtPoint(impulse: THREE.Vector3, point: { x: number; y: number; z: number }): void {
    this.body.applyImpulseAtPoint(impulse, point, true);
  }
  translation(): { x: number; y: number; z: number } { return this.body.translation(); }
  setTranslation(t: { x: number; y: number; z: number }): void { this.body.setTranslation(t, true); }
}
