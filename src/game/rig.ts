import * as THREE from "three";
import { TUN } from "../core/tunables";
import { buildRig, type RigSpec } from "../sim/rigBuild";
import { type Rig, NodeFlag, dist, relax } from "../sim/rigLattice";
import { breakImpulse, splitClosingImpulse } from "../sim/crush";
import { VOXEL_SIZE, G } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { RigPieceVisual } from "../render/rigVisual";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";

/**
 * RigManager — the GAME-side runtime for the voxel rig (sim/rigLattice + sim/rigBuild).
 *
 * Phase 2: the BOWSPRIT (the forward ram spar) stops phasing through. Each fixed step,
 * every ship's bowsprit nodes are tested against every OTHER ship's hull grid; where a
 * node is buried in enemy wood AND the two ships are closing faster than vBreak, it BORES —
 * fed straight into the existing ½·μ·v² crush rule (ship.crush), exactly like a hull-hull
 * ram, just sourced from the spar's forward reach instead of the hull surface. So the ram
 * bites a hole and sheds the aggressor's speed (crush.breakImpulse / splitClosingImpulse),
 * and NO new destruction system is introduced — THE LAW #4, one rule.
 *
 * The bowsprit follows its ship rigidly here (rest node positions transformed by the body);
 * the lattice's own physics (topple / snap / flap) arrives in later phases. Rigs are built
 * lazily per ship and cached in a WeakMap (no edit to Ship required).
 */
interface ShipRig {
  rig: Rig;
  sprit: number[]; // node indices flagged SPRIT (the bowsprit chain)
  reach: number;   // bowsprit length (m), the broad-phase AABB margin
  alive: boolean[]; // last-seen ship.mastAlive — a true→false edge spawns a falling mast
}

/** A felled mast living its own life in WORLD space: it pivots at the (briefly pinned) foot, topples,
 *  can break in half, crushes whatever it lands on, then waterlogs and sinks. */
interface FallingRig {
  rig: Rig;
  visual: RigPieceVisual;
  age: number;
  buoy: number;     // lift multiplier, decays so she floats then founders (cf. debris.wreckLift)
  footIdx: number;  // the hinge node, released after a beat so the wreck can sink
  released: boolean;
  ship: Ship;                       // the ship she fell from — the foot hinges on its MOVING deck
  footLocal: [number, number, number]; // foot's ship-local rest position (to track the moving hull)
}

export class RigManager {
  /** main.ts attaches this for bore dust/crunch FX; optional so headless tests no-op. */
  effects?: Effects;
  /** scene + waves for the falling-mast pieces; set by GameWorld once built. Headless → no falls. */
  scene?: THREE.Scene;
  waves: Wave[] = [];

  private rigs = new WeakMap<Ship, ShipRig>();
  private falling: FallingRig[] = [];
  private aabbA = { min: new THREE.Vector3(), max: new THREE.Vector3() };
  private aabbB = { min: new THREE.Vector3(), max: new THREE.Vector3() };
  private wp = new THREE.Vector3(); // node world pos
  private wl = new THREE.Vector3(); // node in B-local
  private comA = new THREE.Vector3();
  private comB = new THREE.Vector3();
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private imp = new THREE.Vector3();
  private cells: [number, number, number][] = [];
  private cellPool: [number, number, number][] = [];
  private seen = new Set<number>(); // cell dedup across dense samples within one bore

  /** Build (once) and cache the rig for a ship, deriving the bowsprit from the SAME geometry
   *  render/shipVisual draws it from, so the spar lines up with the hull. */
  private rigFor(ship: Ship): ShipRig {
    let sr = this.rigs.get(ship);
    if (sr) return sr;
    const b = ship.build;
    const spritLen = b.lengthM * 0.28;
    const steeve = 0.3; // radians above horizontal — matches shipVisual
    const zMid = (b.grid.dims[2] / 2) * VOXEL_SIZE;
    const bowDeckTop = (b.deckY + 2) * VOXEL_SIZE;
    const heelX = b.footprint.maxX - 1.5 - 2.0; // stem (maxX-1.5) then heel 2 m inboard
    const heelY = bowDeckTop - 0.15;
    const heel = { x: heelX, y: heelY, z: zMid };
    const tip = { x: heelX + Math.cos(steeve) * spritLen, y: heelY + Math.sin(steeve) * spritLen, z: zMid };
    const spec: RigSpec = {
      voxelSize: VOXEL_SIZE,
      deckTopY: (xv) => (b.deckYAt(xv) + 1) * VOXEL_SIZE,
      masts: b.masts,
      bowsprit: { heel, tip },
    };
    const rig = buildRig(spec);
    const sprit: number[] = [];
    rig.nodes.forEach((n, i) => { if (n.flags & NodeFlag.SPRIT) sprit.push(i); });
    sr = { rig, sprit, reach: spritLen, alive: ship.mastAlive.slice() };
    this.rigs.set(ship, sr);
    return sr;
  }

  /** Run the rig's contributions to this fixed step. Call AFTER the hull-hull VoxelContact and
   *  BEFORE the Rapier step (impulses integrate this step). Phase 2: bowsprit boring; Phase 3:
   *  detect newly-felled masts → spawn a falling lattice piece, and step the falling pieces. */
  stepAll(ships: Ship[], simTime: number, dt: number): void {
    if (!TUN.rig.enabled) return;

    // a mast going alive→dead (foot shot out / trunk smashed — ship.fellMast) spawns its lattice.
    for (const A of ships) {
      const sr = this.rigFor(A);
      for (let mi = 0; mi < A.mastAlive.length; mi++) {
        if (sr.alive[mi] && !A.mastAlive[mi]) this.spawnFallingMast(A, mi, dt);
        sr.alive[mi] = A.mastAlive[mi];
      }
    }

    // Phase 2: bowsprit boring (still on-ship, follows the hull rigidly).
    if (TUN.crush.enabled && TUN.rig.bowsprit) {
      for (const A of ships) {
        const sr = this.rigFor(A);
        if (sr.sprit.length === 0) continue;
        A.aabbWorld(this.aabbA);
        const m = sr.reach; // inflate so the broad cull keeps pairs where only the spar overlaps
        this.aabbA.min.x -= m; this.aabbA.min.y -= m; this.aabbA.min.z -= m;
        this.aabbA.max.x += m; this.aabbA.max.y += m; this.aabbA.max.z += m;
        for (const B of ships) {
          if (B === A) continue;
          B.aabbWorld(this.aabbB);
          if (!aabbIntersect(this.aabbA, this.aabbB)) continue;
          this.bore(A, sr, B);
        }
      }
    }

    if (TUN.rig.masts) this.stepFalling(ships, simTime, dt);
  }

  /** Sync the falling-mast visuals to the latest node positions (called from the RENDER loop, not
   *  the fixed step, so wreckage moves smoothly between physics steps). */
  refresh(): void {
    for (const F of this.falling) F.visual.update();
  }

  /** A mast goes by the board: lift its lattice into WORLD space, hinge the foot, give it a topple
   *  lean + the ship's velocity, and turn it loose. shipVisual has already hidden the static mast. */
  private spawnFallingMast(ship: Ship, mi: number, dt: number): void {
    if (!this.scene || !TUN.rig.masts || mi >= ship.build.masts.length) return;
    const b = ship.build;
    const rig = buildRig({ voxelSize: VOXEL_SIZE, deckTopY: (xv) => (b.deckYAt(xv) + 1) * VOXEL_SIZE, masts: [b.masts[mi]] });
    const sv = ship.body.linvel();
    const lean = mi % 2 === 0 ? 1 : -1; // abeam, alternating side (matches the old canned topple)
    let footIdx = -1;
    let footLocal: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < rig.nodes.length; i++) {
      const n = rig.nodes[i];
      const isFoot = (n.flags & NodeFlag.FOOT) !== 0;
      if (isFoot) footLocal = [n.pos.x, n.pos.y, n.pos.z]; // keep the local foot to track the moving deck
      ship.localToWorld([n.pos.x, n.pos.y, n.pos.z], this.wp);
      // initial velocity = ship's + a topple shove (so a vertical mast actually goes over, not straight down)
      const lvx = sv.x + (isFoot ? 0 : -0.4 * TUN.rig.toppleKick);
      const lvy = sv.y;
      const lvz = sv.z + (isFoot ? 0 : lean * TUN.rig.toppleKick);
      n.pos = { x: this.wp.x, y: this.wp.y, z: this.wp.z };
      n.prev = { x: this.wp.x - lvx * dt, y: this.wp.y - lvy * dt, z: this.wp.z - lvz * dt };
      n.pinned = isFoot; // hinge at the foot so she pivots over the side
      if (isFoot) footIdx = i;
    }
    rig.awake = true;
    const visual = new RigPieceVisual(rig);
    this.scene.add(visual.group);
    this.falling.push({ rig, visual, age: 0, buoy: 1.3, footIdx, released: false, ship, footLocal });
  }

  /** Integrate + relax (with breaking) every falling mast, let it crush what it lands on, waterlog
   *  and finally sink. Pure Verlet in world space — gravity + per-node buoyancy off the swell. */
  private stepFalling(ships: Ship[], simTime: number, dt: number): void {
    if (this.falling.length === 0) return;
    const dt2 = dt * dt, damp = 0.99;
    for (let fi = this.falling.length - 1; fi >= 0; fi--) {
      const F = this.falling[fi];
      F.age += dt;
      // release the hinge after a beat (so the wreck slides off + sinks), OR immediately if the
      // ship she fell from is gone (sunk/despawned) — then it can't be tracked.
      const shipGone = ships.indexOf(F.ship) === -1;
      if (!F.released && (F.age > TUN.rig.hingeTime || shipGone)) {
        if (F.footIdx >= 0) F.rig.nodes[F.footIdx].pinned = false;
        F.released = true;
      }
      // while hinged, the foot rides the ship's MOVING deck so the mast topples ONTO her (not into
      // the wake behind a ship under way) — track the ship-local foot each step.
      if (!F.released && F.footIdx >= 0 && !shipGone) {
        const fn = F.rig.nodes[F.footIdx];
        F.ship.localToWorld(F.footLocal, this.wp);
        fn.pos.x = this.wp.x; fn.pos.y = this.wp.y; fn.pos.z = this.wp.z;
        fn.prev.x = this.wp.x; fn.prev.y = this.wp.y; fn.prev.z = this.wp.z;
      }
      let nWet = 0;
      for (const n of F.rig.nodes) {
        if (n.pinned) continue;
        let ay = -G;
        const surf = surfaceHeight(this.waves, n.pos.x, n.pos.z, simTime);
        if (n.pos.y < surf) {
          nWet++;
          const sub = Math.min(surf - n.pos.y, 1);
          ay += G * (1 + 2 * sub) * F.buoy;            // Archimedes-ish lift, scaled by waterlog
          // vertical water drag, applied as a velocity bleed below
        }
        const px = n.pos.x, py = n.pos.y, pz = n.pos.z;
        const vyDamp = py < surf ? 0.86 : damp;        // wet nodes lose vertical bob faster
        n.pos.x = px + (px - n.prev.x) * damp;
        n.pos.y = py + (py - n.prev.y) * vyDamp + ay * dt2;
        n.pos.z = pz + (pz - n.prev.z) * damp;
        n.prev.x = px; n.prev.y = py; n.prev.z = pz;
      }
      relax(F.rig, 4); // satisfy the spars/cloth + BREAK overstressed links (break-in-half emerges)
      this.crushFalling(F, ships, dt);
      F.buoy = Math.max(F.buoy - dt * TUN.rig.waterlog, 0.25); // float, then founder
      F.visual.update();
      // despawn: timed out, or every node has sunk well under the sea
      let allSunk = true;
      for (const n of F.rig.nodes) { if (n.pos.y > surfaceHeight(this.waves, n.pos.x, n.pos.z, simTime) - 4) { allSunk = false; break; } }
      if (F.age > TUN.rig.fallLifetime || allSunk) { F.visual.dispose(); this.falling.splice(fi, 1); }
    }
  }

  /** A falling spar/cloth node that drives into a hull crushes it (the same energy→voxels primitive)
   *  and comes to rest — "damages stuff on the way down". Light per-node energy (a spar section). */
  private crushFalling(F: FallingRig, ships: Ship[], dt: number): void {
    if (!TUN.crush.enabled) return;
    const inv = 1 / VOXEL_SIZE;
    for (const n of F.rig.nodes) {
      if (n.pinned) continue;
      const vx = (n.pos.x - n.prev.x) / dt, vy = (n.pos.y - n.prev.y) / dt, vz = (n.pos.z - n.prev.z) / dt;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed < TUN.crush.vBreak) continue;
      for (const S of ships) {
        const g = S.build.grid, [bx, by, bz] = g.dims;
        S.worldToLocal(this.wp.set(n.pos.x, n.pos.y, n.pos.z), this.wl);
        const cvx = Math.floor(this.wl.x * inv), cvy = Math.floor(this.wl.y * inv), cvz = Math.floor(this.wl.z * inv);
        if (cvx < 0 || cvy < 0 || cvz < 0 || cvx >= bx || cvy >= by || cvz >= bz) continue;
        if (!g.isSolid(cvx, cvy, cvz)) continue;
        const cells = this.cells; cells.length = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const yy = cvy + dy, zz = cvz + dz;
          if (yy < 0 || zz < 0 || yy >= by || zz >= bz) continue;
          if (g.isSolid(cvx, yy, zz)) this.pushCell(cells, cvx, yy, zz);
        }
        const { removed } = S.crush(cells, 0.5 * TUN.rig.fallMass * speed * speed);
        n.prev.x = n.pos.x; n.prev.y = n.pos.y; n.prev.z = n.pos.z; // node stops — rests on the wreckage
        if (removed > 0 && this.effects) this.effects.crunch(this.wp.set(n.pos.x, n.pos.y, n.pos.z), removed);
        break; // one hull per node per step
      }
    }
  }

  /** Bowsprit of A boring into hull B: the hull-crush rule, fed the spar's penetrating cells. */
  private bore(A: Ship, sr: ShipRig, B: Ship): void {
    const grid = B.build.grid;
    const [bx, by, bz] = grid.dims;
    const inv = 1 / VOXEL_SIZE;

    // Walk the bowsprit polyline densely (the spar is continuous, not 7 points) and collect
    // every solid B cell it occupies, widened by a bore radius perpendicular to its length so a
    // hit punches a real gash, not a needle hole. Deduped across samples. This is what makes the
    // ram bore a tunnel like a cannonball instead of pricking a single voxel.
    const cells = this.cells; cells.length = 0;
    const seen = this.seen; seen.clear();
    const rad = TUN.rig.boreRadiusVox;
    const stepM = Math.max(TUN.rig.boreStep, 0.1) * VOXEL_SIZE;
    let cx = 0, cy = 0, cz = 0, hit = 0;
    for (let s = 0; s + 1 < sr.sprit.length; s++) {
      const n0 = sr.rig.nodes[sr.sprit[s]].pos, n1 = sr.rig.nodes[sr.sprit[s + 1]].pos;
      const samples = Math.max(1, Math.ceil(dist(n0, n1) / stepM));
      for (let k = 0; k <= samples; k++) {
        const f = k / samples;
        A.localToWorld([n0.x + (n1.x - n0.x) * f, n0.y + (n1.y - n0.y) * f, n0.z + (n1.z - n0.z) * f], this.wp);
        B.worldToLocal(this.wp, this.wl);
        const cvx = Math.floor(this.wl.x * inv), cvy = Math.floor(this.wl.y * inv), cvz = Math.floor(this.wl.z * inv);
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dz = -rad; dz <= rad; dz++) {
            const vx = cvx, vy = cvy + dy, vz = cvz + dz;
            if (vx < 0 || vy < 0 || vz < 0 || vx >= bx || vy >= by || vz >= bz) continue;
            if (!grid.isSolid(vx, vy, vz)) continue;
            const key = (vx * by + vy) * bz + vz;
            if (seen.has(key)) continue;
            seen.add(key);
            this.pushCell(cells, vx, vy, vz);
            cx += this.wp.x; cy += this.wp.y; cz += this.wp.z; hit++;
          }
        }
      }
    }
    if (hit === 0) return; // the spar isn't buried in B's wood → nothing to bore (it overrides/misses)
    cx /= hit; cy /= hit; cz /= hit;

    // horizontal closing speed at the contact centroid (same convention as the hull-crush rule:
    // horizontal so wave heave never reads as closing, and the impulse at COM height yaws not rolls).
    A.comWorld(this.comA); B.comWorld(this.comB);
    velAt(this.comA, A.linvel(), A.angvel(), cx, cy, cz, this.vA);
    velAt(this.comB, B.linvel(), B.angvel(), cx, cy, cz, this.vB);
    let dhx = this.vA.x - this.vB.x, dhz = this.vA.z - this.vB.z;
    const dlen = Math.hypot(dhx, dhz);
    if (dlen < 1e-4) return;
    dhx /= dlen; dhz /= dlen;
    const sA = this.vA.x * dhx + this.vA.z * dhz;
    const sB = this.vB.x * dhx + this.vB.z * dhz;
    const vClose = sA - sB;
    if (vClose <= TUN.crush.vBreak) return; // a slow nudge does no damage (same gate as hull crush)

    const mA = Math.max(A.mass(), 1), mB = Math.max(B.mass(), 1);
    const mu = (mA * mB) / (mA + mB);
    const budget = Math.min(0.5 * mu * vClose * vClose, TUN.crush.maxStepEnergy);
    const { removed, leftover } = B.crush(cells, budget); // the universal energy→voxels primitive
    if (removed === 0) return;
    const energy = budget - leftover;

    // shed the fracture energy off the closing motion: drag the aggressor + a tunable transfer
    // to the struck hull — identical to the hull-hull bite (crush.splitClosingImpulse).
    const dvClose = breakImpulse(mu, vClose, energy, TUN.crush.biteDvCap) / mu;
    const { jA, jB } = splitClosingImpulse(mA, mB, mu, sA, sB, dvClose, TUN.crush.transferFrac);
    this.imp.set(-dhx * jA, 0, -dhz * jA); A.applyImpulseAtPoint(this.imp, { x: cx, y: this.comA.y, z: cz });
    this.imp.set(dhx * jB, 0, dhz * jB); B.applyImpulseAtPoint(this.imp, { x: cx, y: this.comB.y, z: cz });

    if (this.effects) {
      this.imp.set(cx, cy, cz);
      this.effects.crunch(this.imp, removed);
    }
  }

  /** Store a cell in `list`, reusing a pooled tuple so a sustained bore allocates nothing. */
  private pushCell(list: [number, number, number][], x: number, y: number, z: number): void {
    const i = list.length;
    let t = this.cellPool[i];
    if (t) { t[0] = x; t[1] = y; t[2] = z; } else { t = [x, y, z]; this.cellPool[i] = t; }
    list.push(t);
  }
}

/** World velocity of a body (com, linvel lv, angvel av) at world point (px,py,pz). */
function velAt(
  com: THREE.Vector3,
  lv: { x: number; y: number; z: number }, av: { x: number; y: number; z: number },
  px: number, py: number, pz: number, out: THREE.Vector3,
): void {
  const rx = px - com.x, ry = py - com.y, rz = pz - com.z;
  out.set(lv.x + (av.y * rz - av.z * ry), lv.y + (av.z * rx - av.x * rz), lv.z + (av.x * ry - av.y * rx));
}

function aabbIntersect(a: { min: THREE.Vector3; max: THREE.Vector3 }, b: { min: THREE.Vector3; max: THREE.Vector3 }): boolean {
  return a.max.x >= b.min.x && a.min.x <= b.max.x &&
    a.max.y >= b.min.y && a.min.y <= b.max.y &&
    a.max.z >= b.min.z && a.min.z <= b.max.z;
}
