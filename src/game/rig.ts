import * as THREE from "three";
import { TUN } from "../core/tunables";
import { buildRig, type RigSpec } from "../sim/rigBuild";
import {
  type Rig, type RigidChunk, type Vec3, NodeFlag, dist,
  components, freezeChunk, integrateChunk, applyChunk,
} from "../sim/rigLattice";
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

/**
 * A felled mast living its own life in WORLD space. The detached section(s) move as RIGID
 * CHUNKS (each holds its shape — no noodle): a chunk integrates ONE position + orientation
 * under gravity + summed per-node buoyancy + the topple kick, and the member nodes' world
 * positions are re-derived from that transform each step. Break-at-hit: when a ball strikes
 * mid-trunk, only the section ABOVE the hit becomes a falling chunk; the stub BELOW stays
 * STANDING (its nodes ride the moving deck, rendered as the same voxel beams). A foot hit
 * fells the WHOLE mast as one chunk.
 */
interface FallingRig {
  rig: Rig;
  visual: RigPieceVisual;
  chunks: RigidChunk[];             // the detached, rigidly-falling section(s)
  standing: number[];              // node indices of the still-attached stub (ride the deck), empty if whole mast fell
  age: number;
  buoy: number;     // lift multiplier, decays so she floats then founders (cf. debris.wreckLift)
  ship: Ship;                       // the ship she fell from — the standing stub rides its MOVING deck
  /** standing stub nodes' ship-local rest positions (parallel to `standing`), to track the moving hull. */
  standLocal: [number, number, number][];
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
        if (sr.alive[mi] && !A.mastAlive[mi]) this.spawnFallingMast(A, mi);
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

  /**
   * A mast goes by the board. Build its lattice (ship-local), BREAK the trunk at the recorded hit
   * height (ship.mastHitY[mi]; <0 → break at the foot = whole mast), lift it into WORLD space, then
   * flood the alive links into connected components: the component still reaching the foot is the
   * STANDING stub (held fixed, rides the deck); every other component is frozen into a RIGID CHUNK
   * that topples + falls as one stiff body (no noodle). shipVisual has already hidden the static mast.
   */
  private spawnFallingMast(ship: Ship, mi: number): void {
    if (!this.scene || !TUN.rig.masts || mi >= ship.build.masts.length) return;
    const b = ship.build;
    const rig = buildRig({ voxelSize: VOXEL_SIZE, deckTopY: (xv) => (b.deckYAt(xv) + 1) * VOXEL_SIZE, masts: [b.masts[mi]] });

    // --- break the trunk at the hit height (ship-local Y, meters) -------------------------------
    // Identify the trunk: the WOOD nodes sharing the foot's x/z (the yards/cloth sit fore/abeam of it).
    const foot = rig.nodes.find((n) => n.flags & NodeFlag.FOOT);
    const footIdx = foot ? rig.nodes.indexOf(foot) : -1;
    const hitY = ship.mastHitY[mi];
    // a mid-trunk break leaves a STANDING stub below + a falling top above. It only happens when
    // the hit is genuinely up the trunk (hitY >= 0 AND it straddles a trunk segment above the foot).
    // A foot/low hit (hitY < 0, or below the first trunk segment) severs nothing here → the WHOLE
    // mast falls (handled below: with no stub, every component is a falling chunk).
    let midBreak = false;
    if (foot && hitY >= 0) {
      const fx = foot.pos.x, fz = foot.pos.z;
      // a trunk node sits exactly on the mast axis (x==fx, z==fz). Yards sit +0.25 m fore and cloth
      // +0.4 m, so a tight 0.15 m tolerance excludes them — we only ever cut the vertical trunk.
      const onTrunk = (n: { pos: Vec3 }) => Math.abs(n.pos.x - fx) < 0.15 && Math.abs(n.pos.z - fz) < 0.15;
      for (const lk of rig.links) {
        if (!lk.alive) continue;
        const a = rig.nodes[lk.a], c = rig.nodes[lk.b];
        if (!onTrunk(a) || !onTrunk(c)) continue;
        const yLo = Math.min(a.pos.y, c.pos.y), yHi = Math.max(a.pos.y, c.pos.y);
        // break the trunk segment spanning the hit, but ONLY if it sits clear above the foot — a hit
        // right at the foot (yLo ≈ foot.y) should topple the whole mast, not leave a degenerate stub.
        if (hitY >= yLo && hitY <= yHi && yLo > foot.pos.y + 0.5) { lk.alive = false; midBreak = true; }
      }
    }

    // --- lift the whole lattice into WORLD space (record standing-stub local rest first) --------
    const localPos: Vec3[] = rig.nodes.map((n) => ({ x: n.pos.x, y: n.pos.y, z: n.pos.z }));
    for (let i = 0; i < rig.nodes.length; i++) {
      ship.localToWorld([localPos[i].x, localPos[i].y, localPos[i].z], this.wp);
      rig.nodes[i].pos = { x: this.wp.x, y: this.wp.y, z: this.wp.z };
      rig.nodes[i].prev = { x: this.wp.x, y: this.wp.y, z: this.wp.z };
      rig.nodes[i].pinned = false; // chunks integrate themselves; the stub is held explicitly
    }
    rig.awake = true;

    // --- split into components; on a MID break the foot's component STANDS, the rest fall as rigid
    //     chunks. With no mid break (foot/low hit) NOTHING stands → the whole mast falls. ----------
    const { comp, count } = components(rig);
    const footComp = midBreak && footIdx >= 0 ? comp[footIdx] : -1;
    const sv = ship.body.linvel();
    const lean = mi % 2 === 0 ? 1 : -1; // abeam topple direction, alternating per mast
    const chunks: RigidChunk[] = [];
    const standing: number[] = [];
    const standLocal: [number, number, number][] = [];
    for (let cId = 0; cId < count; cId++) {
      const idx: number[] = [];
      for (let i = 0; i < comp.length; i++) if (comp[i] === cId) idx.push(i);
      if (idx.length === 0) continue;
      if (cId === footComp) {
        // the standing stub — keep these nodes fixed on the (moving) deck, do not integrate.
        for (const i of idx) { standing.push(i); standLocal.push([localPos[i].x, localPos[i].y, localPos[i].z]); }
        continue;
      }
      // a falling chunk: inherit the ship's velocity + a topple shove + a roll kick about its base.
      const vel: Vec3 = { x: sv.x - 0.4 * TUN.rig.toppleKick, y: sv.y, z: sv.z + lean * TUN.rig.toppleKick };
      // angular kick: tip it OVER (rotate about the fore-aft axis so it falls abeam), scaled to the kick.
      const omega: Vec3 = { x: lean * TUN.rig.toppleKick * 0.18, y: 0, z: 0 };
      chunks.push(freezeChunk(rig, idx, vel, omega));
    }

    const visual = new RigPieceVisual(rig);
    this.scene.add(visual.group);
    this.falling.push({ rig, visual, chunks, standing, standLocal, age: 0, buoy: 1.3, ship });
  }

  /** Integrate every falling mast as RIGID CHUNKS (gravity + summed per-node buoyancy off the swell),
   *  hold the standing stub on the moving deck, let chunks crush what they land on, waterlog and sink.
   *  The chunks hold their shape — they topple and fall stiff, never noodle. */
  private stepFalling(ships: Ship[], simTime: number, dt: number): void {
    if (this.falling.length === 0) return;
    for (let fi = this.falling.length - 1; fi >= 0; fi--) {
      const F = this.falling[fi];
      F.age += dt;
      const shipGone = ships.indexOf(F.ship) === -1;

      // standing stub: ride the ship's MOVING deck (ship-local rest → world) so it stays planted.
      // If the ship is gone (sunk/despawned) the stub can't be tracked → let it fall with the rest
      // by converting it into a chunk once, then it integrates like any other.
      if (F.standing.length > 0) {
        if (shipGone) {
          const sv0 = { x: 0, y: 0, z: 0 };
          F.chunks.push(freezeChunk(F.rig, F.standing.slice(), sv0, sv0));
          F.standing.length = 0; F.standLocal.length = 0;
        } else {
          for (let k = 0; k < F.standing.length; k++) {
            const n = F.rig.nodes[F.standing[k]];
            F.ship.localToWorld(F.standLocal[k], this.wp);
            n.pos.x = this.wp.x; n.pos.y = this.wp.y; n.pos.z = this.wp.z;
            n.prev.x = this.wp.x; n.prev.y = this.wp.y; n.prev.z = this.wp.z;
          }
        }
      }

      // each detached section integrates as ONE rigid body. Per-node accel = gravity + buoyancy
      // (computed at the node's current world position); integrateChunk sums force+torque about
      // the centroid so the chunk topples and falls while holding its shape.
      const buoy = F.buoy;
      const accel = (n: { pos: Vec3 }): Vec3 => {
        let ay = -G;
        const surf = surfaceHeight(this.waves, n.pos.x, n.pos.z, simTime);
        if (n.pos.y < surf) {
          const sub = Math.min(surf - n.pos.y, 1);
          ay += G * (1 + 2 * sub) * buoy; // Archimedes-ish lift, scaled by waterlog
        }
        return { x: 0, y: ay, z: 0 };
      };
      for (const c of F.chunks) {
        integrateChunk(F.rig, c, accel, dt, TUN.rig.linDamp, TUN.rig.angDamp);
        applyChunk(F.rig, c, dt); // re-derive member node world positions from the rigid transform
      }

      this.crushFalling(F, ships, dt);
      F.buoy = Math.max(F.buoy - dt * TUN.rig.waterlog, 0.25); // float, then founder

      // a chunk that has fully sunk well under the sea collapses (kill its links) so it stops drawing
      // underwater — and frees a stub-bearing piece to keep its STANDING stump on deck indefinitely.
      let chunksLeft = false;
      for (let ci = F.chunks.length - 1; ci >= 0; ci--) {
        const c = F.chunks[ci];
        let sunk = true;
        for (const i of c.nodeIdx) {
          const n = F.rig.nodes[i];
          if (n.pos.y > surfaceHeight(this.waves, n.pos.x, n.pos.z, simTime) - 4) { sunk = false; break; }
        }
        if (sunk) {
          for (const lk of F.rig.links) if (c.nodeIdx.includes(lk.a) || c.nodeIdx.includes(lk.b)) lk.alive = false;
          F.chunks.splice(ci, 1);
        } else chunksLeft = true;
      }
      F.visual.update();

      // despawn: a fully-fallen piece (no standing stub) goes once all its chunks have sunk or it
      // times out. A piece WITH a standing stub stays — its stump is part of the ship now.
      const done = (F.standing.length === 0 && (!chunksLeft || F.age > TUN.rig.fallLifetime));
      if (done) { F.visual.dispose(); this.falling.splice(fi, 1); }
    }
  }

  /** A falling rigid chunk that drives a node into a hull crushes it (the same energy→voxels
   *  primitive) and the whole CHUNK comes to rest — "damages stuff on the way down". The crush
   *  bleeds the chunk's linear+angular velocity (not just one node) so it lands as a stiff body. */
  private crushFalling(F: FallingRig, ships: Ship[], dt: number): void {
    if (!TUN.crush.enabled) return;
    const inv = 1 / VOXEL_SIZE;
    for (const c of F.chunks) {
      let crushedThisChunk = false;
      for (const ni of c.nodeIdx) {
        const n = F.rig.nodes[ni];
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
          crushedThisChunk = true;
          if (removed > 0 && this.effects) this.effects.crunch(this.wp.set(n.pos.x, n.pos.y, n.pos.z), removed);
          break; // one hull per node per step
        }
      }
      if (crushedThisChunk) {
        // the chunk lands and settles: bleed most of its motion (it rests on the wreckage, stiff).
        c.vel.x *= 0.2; c.vel.y *= 0.2; c.vel.z *= 0.2;
        c.omega.x *= 0.2; c.omega.y *= 0.2; c.omega.z *= 0.2;
        applyChunk(F.rig, c, dt); // re-sync node prev so the next step reads the bled velocity
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
