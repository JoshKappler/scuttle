import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { VOXEL_SIZE, WATER_DENSITY } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { makeProbes, probeForce, submergedFraction, type Probe } from "../sim/buoyancy";
import { sphereCells } from "../sim/ballistics";
import { floodStep, type BreachInput, type Opening } from "../sim/compartments";
import { findSevered, type Island } from "../sim/connectivity";
import { IRON } from "../sim/materials";
import { segmentBoxHit, segmentMastHit, segmentSailHit } from "../sim/rigDamage";
import { meshChunk } from "../render/voxelMesher";
import type { ShipBuild } from "../sim/shipwright";
import type { ShipVisual, SailRecord } from "../render/shipVisual";
import type { Physics } from "./physics";

/**
 * A ship: ONE dynamic rigid body + voxel grid + compartments + visual.
 * Buoyancy/flood/drag forces are applied at probe points every fixed step;
 * listing, trim, and sinking are emergent — nothing here scripts motion.
 */
export class Ship {
  readonly body: RAPIER.RigidBody;
  readonly build: ShipBuild;
  readonly visual: ShipVisual;
  probes: Probe[];

  /** Diagnostic: 0..1 share of envelope currently below the surface. */
  submergedFrac = 0;

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

  /** cell index → compartment id, for breach detection. */
  private cellComp = new Map<number, number>();
  /** Per compartment: breach cell coordinates (hull holes below decks). */
  private breachCells = new Map<number, [number, number, number][]>();
  /** Holes shot through bulkheads connecting compartments. */
  private openings: Opening[] = [];
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  private phys: Physics;
  private deckCollider: RAPIER.Collider | null = null;

  constructor(phys: Physics, build: ShipBuild, visual: ShipVisual, spawn: { x: number; y: number; z: number }) {
    this.phys = phys;
    this.build = build;
    this.visual = visual;
    this.probes = makeProbes(build.grid, build.compartments);

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

    // coarse hull collider for SHIP-SHIP contact only; zero density — mass
    // comes from the voxel grid above. Collision group 0x0002 keeps it OUT
    // of the character controller's world: its flat top stood 1.1 m proud
    // of the brig's waist deck, and a jump landed you ON it — "able to
    // levitate a meter or two off the ground and walk on air" (round 7).
    // Characters walk the deck trimesh; ships and debris still hit this box.
    const collider = R.ColliderDesc.cuboid(l / 2, (h * 0.7) / 2, w / 2)
      .setTranslation(l / 2, (h * 0.7) / 2, w / 2)
      .setDensity(0)
      .setCollisionGroups(0x0002ffff);
    world.createCollider(collider, this.body);

    // the mast is solid — you should not be able to walk through it
    // (playtest round 5: "the mast has no physical hitbox")
    for (const m of build.masts) {
      const deckTop = (build.deckYAt(m.x) + 1) * VOXEL_SIZE;
      const mastCol = R.ColliderDesc.cylinder(m.h / 2, 0.18)
        .setTranslation((m.x + 0.5) * VOXEL_SIZE, deckTop + m.h / 2 - 0.5, (m.z + 0.5) * VOXEL_SIZE)
        .setDensity(0);
      this.mastColliders.push(world.createCollider(mastCol, this.body));
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
   * Advance flooding one fixed step: aggregate per-breach depths below the
   * live wave surface (including deck-hatch downflooding once hatches go
   * under), then integrate compartment fill and inter-compartment exchange.
   */
  updateFlooding(dt: number, waves: Wave[], t: number): void {
    const breaches: BreachInput[] = [];
    const p = this.tmpV;

    for (const c of this.build.compartments) {
      const cells = this.breachCells.get(c.id);
      if (cells && cells.length > 0) {
        // aggregate: average depth across breach cells, total area
        let depthSum = 0;
        let wet = 0;
        for (const [x, y, z] of cells) {
          this.localToWorld([(x + 0.5) * VOXEL_SIZE, (y + 0.5) * VOXEL_SIZE, (z + 0.5) * VOXEL_SIZE], p);
          const d = surfaceHeight(waves, p.x, p.z, t) - p.y;
          if (d > 0) {
            depthSum += d;
            wet++;
          }
        }
        if (wet > 0) {
          breaches.push({
            compartmentId: c.id,
            area: wet * VOXEL_SIZE * VOXEL_SIZE,
            depth: depthSum / wet,
          });
        }
      }

      // deck hatches downflood once the water tops the hatch coaming (a
      // raised lip): waves slopping across the deck don't flood the hold
      if (c.hatchArea > 0) {
        const COAMING = 0.55; // m — raised with the bigger seas
        const hx = (c.bboxMin[0] + c.bboxMax[0]) / 2;
        this.localToWorld(
          [(hx + 0.5) * VOXEL_SIZE, (this.build.deckY + 0.5) * VOXEL_SIZE, (this.build.grid.dims[2] / 2) * VOXEL_SIZE],
          p,
        );
        const d = surfaceHeight(waves, p.x, p.z, t) - p.y - COAMING;
        if (d > 0) breaches.push({ compartmentId: c.id, area: c.hatchArea, depth: d });
      }
    }

    floodStep(this.build.compartments, this.openings, breaches, dt);

    // foundering: a hull that is essentially full of water waterlogs and
    // slides under over the following half-minute or so
    let totVol = 0;
    let totWater = 0;
    for (const c of this.build.compartments) {
      totVol += c.volume;
      totWater += c.waterVolume;
    }
    if (totVol > 0 && totWater / totVol > 0.9) {
      this.waterlog = Math.min(this.waterlog + 0.015 * dt, 0.5);
    }

    if (this.pumpOn) {
      let worst: (typeof this.build.compartments)[number] | null = null;
      for (const c of this.build.compartments) {
        if (!worst || c.waterVolume > worst.waterVolume) worst = c;
      }
      if (worst) worst.waterVolume = Math.max(worst.waterVolume - Ship.PUMP_RATE * dt, 0);
    }
  }

  /** Apply buoyancy + water drag for one fixed step. Call before world.step(). */
  applyForces(waves: Wave[], t: number): void {
    const body = this.body;
    body.resetForces(true);
    body.resetTorques(true);

    const tr = body.translation();
    const rot = body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);

    let submergedVolume = 0;
    let totalVolume = 0;

    for (const p of this.probes) {
      const wp = this.tmpV.set(p.local[0], p.local[1], p.local[2]).applyQuaternion(this.tmpQ);
      const wx = wp.x + tr.x;
      const wy = wp.y + tr.y;
      const wz = wp.z + tr.z;
      const surfaceY = surfaceHeight(waves, wx, wz, t);
      // flood = 0 here deliberately: the hull envelope always displaces;
      // flooded water is accounted as WEIGHT below (scaling lift AND adding
      // weight would double-count — a full submerged compartment must be
      // net-zero, and weight-only handles partial submersion correctly)
      const f = probeForce(p, wy, surfaceY, 0) * (1 - this.waterlog);
      totalVolume += p.volume;
      if (f > 0) {
        const sub = submergedFraction(p, wy, surfaceY);
        // apply at the submerged-segment centroid (ship-local), else the ship
        // is hydrostatically unstable — see buoyancy.ts and stability.test.ts
        const ap = this.tmpV
          .set(p.local[0], p.local[1] + (sub * p.height) / 2, p.local[2])
          .applyQuaternion(this.tmpQ);
        body.addForceAtPoint(
          { x: 0, y: f, z: 0 },
          { x: ap.x + tr.x, y: ap.y + tr.y, z: ap.z + tr.z },
          true,
        );
        submergedVolume += p.volume * sub;
      }
    }
    this.submergedFrac = totalVolume > 0 ? submergedVolume / totalVolume : 0;

    // flooded water is cargo: its weight bears at each compartment's water
    // centroid, so a flooded bow pulls the bow down — listing is emergent
    for (const c of this.build.compartments) {
      if (c.waterVolume <= 0) continue;
      const fill = c.waterVolume / c.volume;
      const waterY =
        (c.bboxMin[1] + (c.bboxMax[1] + 1 - c.bboxMin[1]) * fill * 0.5 + 0.5) * VOXEL_SIZE;
      const wp = this.tmpV.set(c.centroid[0], waterY, c.centroid[2]).applyQuaternion(this.tmpQ);
      body.addForceAtPoint(
        { x: 0, y: -c.waterVolume * WATER_DENSITY * 9.81, z: 0 },
        { x: wp.x + tr.x, y: wp.y + tr.y, z: wp.z + tr.z },
        true,
      );
    }

    // water drag split into ship-frame components: a hull slips easily
    // forward, resists sideways motion strongly (the keel), and damps heave
    // hard. All scaled by how much of the hull is actually in the water.
    const sub = this.submergedFrac;
    if (sub > 0.001) {
      const mass = this.body.mass();
      const v = body.linvel();
      const fwd = this.tmpV.set(1, 0, 0).applyQuaternion(this.tmpQ);
      const pitch = Math.asin(Math.min(Math.max(fwd.y, -1), 1)); // bow-up +
      // keep drag axes horizontal so heave stays separable
      fwd.y = 0;
      fwd.normalize();
      const lat = { x: -fwd.z, z: fwd.x }; // horizontal perpendicular

      const vF = v.x * fwd.x + v.z * fwd.z;
      const vL = v.x * lat.x + v.z * lat.z;
      const vY = v.y;

      // "in the water at all" — a healthy hull only sinks ~20% of its ENVELOPE,
      // so gating drag on raw `sub` throttles it to nothing. The angular terms
      // were fixed to use `wet` back in round 4; HEAVE was missed, leaving the
      // buoyancy spring ~6× under-damped — she resonated and bobbed clean out
      // of the sea on a modest swell (round 9). `wet` saturates the instant
      // she's afloat, so heave is now near-critically damped: she rides the
      // swell and settles instead of porpoising.
      const wet = Math.min(sub * 5, 1);

      const fF = -mass * 0.04 * (1 + 0.08 * Math.abs(vF)) * vF * sub;
      const fL = -mass * 1.7 * vL * sub;
      // round 14: the round-9 value 4.5 was OVER-critical and sat her flat — the
      // playtest "she doesn't rise with the waves even close to enough". 2.8 lets
      // vertical velocity TRACK the swell crests (she rides up and over instead of
      // pushing through) while staying damped enough not to porpoise out of the sea.
      const fY = -mass * 2.8 * vY * wet;

      // forward + heave drag at the COM. LATERAL resistance belongs to the
      // keel, and the keel is DEEP — applying it all below the COM is what
      // banks her in turns and against a beam wind (playtest round 5:
      // "the boat should have some sense of what G forces are happening")
      body.addForce({ x: fwd.x * fF, y: fY, z: fwd.z * fF }, true);
      const keelDepth = 2.2; // m below COM
      const com = body.worldCom();
      body.addForceAtPoint(
        { x: lat.x * fL, y: 0, z: lat.z * fL },
        { x: com.x, y: com.y - keelDepth, z: com.z },
        true,
      );

      // angular damping decomposed in the SHIP frame: pitch is damped
      // hardest — a real hull's waterplane kills porpoising almost dead.
      // (`wet` computed above — gated on "is she in the water at all", not
      // submergedFrac, which a healthy hull keeps near 0.2.)
      const om = body.angvel();
      const [ix, iy, iz] = this.inertia;
      const fx = fwd.x;
      const fz = fwd.z;
      const wRoll = om.x * fx + om.z * fz; // rate about the fore-aft axis
      const wPitch = om.x * lat.x + om.z * lat.z; // rate about the beam axis
      const tRoll = -wRoll * wet * 1.2 * ix;
      // speed trim: a RESTORING moment toward level, saturating at ±4° of
      // error. Its predecessor was a one-signed bow lift growing with v²
      // without limit — at full sail she pitched past vertical and looped
      // (playtest round 5: "almost doing a wheelie … flipped upside down")
      const trim = wet * vF * vF * mass * 12 * Math.min(Math.max(-pitch, -0.07), 0.07);
      const tPitch = -wPitch * wet * 4.2 * iz + trim;
      body.addTorque(
        {
          x: tRoll * fx + tPitch * lat.x,
          y: -om.y * wet * 0.7 * iy,
          z: tRoll * fz + tPitch * lat.z,
        },
        true,
      );
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
   * Remove voxels in a blast radius around a hit cell. Returns the number of
   * cells destroyed. Mass properties and buoyancy probes are recomputed so
   * handling and flotation genuinely change with damage.
   */
  applyDamage(cell: [number, number, number], radiusVox: number): number {
    const grid = this.build.grid;
    const [nx, ny] = grid.dims;
    const cidx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
    let removed = 0;
    const removedCells: [number, number, number][] = [];
    for (const [x, y, z] of sphereCells(cell, radiusVox)) {
      const mat = grid.get(x, y, z);
      if (mat === 0) continue;
      if (mat === IRON) {
        const d = Math.hypot(x - cell[0], y - cell[1], z - cell[2]);
        if (d > radiusVox * 0.55) continue; // iron shrugs off the blast fringe
      }
      grid.remove(x, y, z);
      removedCells.push([x, y, z]);
      removed++;
    }
    if (removed === 0) return 0;

    // breach registration: a removed cell adjacent to one compartment is a
    // hull breach for it; adjacent to two compartments, a bulkhead opening
    for (const [x, y, z] of removedCells) {
      const adj = new Set<number>();
      for (const [px, py, pz] of [
        [x - 1, y, z],
        [x + 1, y, z],
        [x, y - 1, z],
        [x, y + 1, z],
        [x, y, z - 1],
        [x, y, z + 1],
      ] as [number, number, number][]) {
        const comp = this.cellComp.get(cidx(px, py, pz));
        if (comp !== undefined) adj.add(comp);
      }
      if (adj.size === 1) {
        const id = adj.values().next().value!;
        this.breachCells.get(id)?.push([x, y, z]);
      } else if (adj.size >= 2) {
        const ids = [...adj];
        for (let i = 0; i < ids.length - 1; i++) {
          this.openings.push({ a: ids[i], b: ids[i + 1], area: VOXEL_SIZE * VOXEL_SIZE });
        }
      }
    }

    // anything no longer connected to the keel breaks off as debris
    const islands = findSevered(grid, this.keelAnchor);
    if (islands.length > 0) {
      for (const island of islands) {
        for (const c of island.cells) grid.remove(c.x, c.y, c.z);
      }
      this.onSevered?.(islands);
    }

    // a mast whose step has been blown out goes by the board (round 7)
    this.build.masts.forEach((m, mi) => {
      if (this.mastAlive[mi] && this.mastFootCount(m) < this.mastFootInit[mi] * 0.5) {
        this.fellMast(mi);
      }
    });

    this.recomputeMassProperties();
    this.rebuildDeckCollider();
    return removed;
  }

  /** Refresh rapier mass props + buoyancy probes from the current grid. */
  recomputeMassProperties(): void {
    const grid = this.build.grid;
    const mass = Math.max(grid.totalMass(), 1);
    const com = grid.centerOfMass();
    this.comLocal = com;
    const [ix, iy, iz] = this.inertia;
    // rescale the box inertia with the new mass (shape change is second-order)
    const scale = mass / Math.max(this.body.mass(), 1);
    this.inertia = [ix * scale, iy * scale, iz * scale];
    this.body.setAdditionalMassProperties(
      mass,
      { x: com[0], y: com[1], z: com[2] },
      { x: this.inertia[0], y: this.inertia[1], z: this.inertia[2] },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );
    this.probes = makeProbes(grid, this.build.compartments);
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
}
