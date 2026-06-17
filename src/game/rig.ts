import * as THREE from "three";
import { TUN } from "../core/tunables";
import { buildRig, type RigSpec } from "../sim/rigBuild";
import {
  type Rig, type RigidChunk, type Vec3, NodeFlag, dist,
  freezeChunk, integrateChunk, applyChunk,
} from "../sim/rigLattice";
import { breakImpulse, splitClosingImpulse } from "../sim/crush";
import { VOXEL_SIZE, G } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
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
  /** accumulated bore load (J) the bowsprit has shed into enemy hulls. Once it crosses
   *  TUN.rig.spritBreak the spar snaps off and falls (Task 9). −1 once detached. */
  boreLoad: number;
}

/**
 * A felled mast (or snapped bowsprit) living its own life in WORLD space. The PHYSICS is a single
 * RIGID CHUNK (holds its shape — no noodle): it integrates ONE centroid position + orientation under
 * gravity + summed per-node buoyancy + the topple kick. The VISUAL is the ship's REAL spars + sail
 * meshes (cloned by shipVisual.detachMast / detachBowsprit), so a downed mast looks like an actual
 * mast WITH its canvas — not voxel confetti — and it's posed rigidly each frame from the chunk's
 * pos+quaternion (a delta transform about the spawn centroid). The chunk's member nodes drive the
 * deck crush (crushFalling) so the wreck lands ON the hull instead of phasing through.
 */
interface FallingRig {
  rig: Rig;                         // the lattice nodes that carry the chunk's mass + crush samples
  group: THREE.Group;               // the REAL cloned spars/sail (added to the scene at identity)
  chunk: RigidChunk;                // the rigidly-falling section
  /** spawn centroid (world) — the visual delta transform rotates the clones about this point. */
  pivot0: THREE.Vector3;
  age: number;
  buoy: number;     // lift multiplier, decays so she floats then founders (cf. debris.wreckLift)
  ship: Ship;       // the ship she fell from (for crush targeting + despawn cleanup)
  rested: boolean;  // landed on a deck → motion mostly bled, stops re-crushing every step
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
  // scratch for posing the cloned falling-mast group rigidly from its chunk transform.
  private _mTrans = new THREE.Matrix4();
  private _mRot = new THREE.Matrix4();
  private _mBack = new THREE.Matrix4();
  private _q = new THREE.Quaternion();

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
    sr = { rig, sprit, reach: spritLen, alive: ship.mastAlive.slice(), boreLoad: 0 };
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

    // Phase 2: bowsprit boring (still on-ship, follows the hull rigidly). Task 9: once a spar has
    // shed enough bore-load into hulls, it SNAPS OFF and falls (reusing the mast-fall machinery).
    if (TUN.crush.enabled && TUN.rig.bowsprit) {
      for (const A of ships) {
        const sr = this.rigFor(A);
        if (sr.sprit.length === 0 || sr.boreLoad < 0) continue; // <0 = already detached
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
        if (sr.boreLoad >= TUN.rig.spritBreak) this.detachBowsprit(A, sr);
      }
    }

    if (TUN.rig.masts) this.stepFalling(ships, simTime, dt);
  }

  /** The bowsprit has bored enough — it snaps off and falls. The VISUAL is the real cloned spar
   *  (shipVisual.detachBowsprit, which also hides the static one); the PHYSICS is a rigid chunk over
   *  the spar's lattice nodes, dropped forward+down off the bow. (Task 9.) */
  private detachBowsprit(A: Ship, sr: ShipRig): void {
    sr.boreLoad = -1; // mark detached so it never re-fires / re-bores
    if (!this.scene || !TUN.rig.masts) return;
    const detached = A.visual.detachBowsprit?.() ?? null;
    // build a tiny rig of JUST the spar nodes in world space so a chunk can carry/sink it.
    const spritLocal = sr.sprit.map((i) => sr.rig.nodes[i].pos);
    const rig: Rig = { nodes: [], links: [], awake: true, sleepTimer: 0 };
    const idx: number[] = [];
    for (const p of spritLocal) {
      A.localToWorld([p.x, p.y, p.z], this.wp);
      rig.nodes.push({ pos: { x: this.wp.x, y: this.wp.y, z: this.wp.z }, prev: { x: this.wp.x, y: this.wp.y, z: this.wp.z }, mass: 4, pinned: false, flags: NodeFlag.WOOD });
      idx.push(rig.nodes.length - 1);
    }
    if (idx.length < 2) { if (detached) this.scene.add(detached.group); return; }
    const sv = A.body.linvel();
    // it pitches DOWN and forward off the bow as it tears free.
    const vel: Vec3 = { x: sv.x + 1.0, y: sv.y - 1.5, z: sv.z };
    const omega: Vec3 = { x: 0, y: 0, z: -1.2 };
    const chunk = freezeChunk(rig, idx, vel, omega);
    let group: THREE.Group;
    if (detached) { group = detached.group; this.scene.add(group); }
    else group = new THREE.Group();
    const pivot0 = new THREE.Vector3(chunk.pos.x, chunk.pos.y, chunk.pos.z);
    const F: FallingRig = { rig, group, chunk, pivot0, age: 0, buoy: TUN.rig.fallFloatBuoy, ship: A, rested: false };
    this.poseFalling(F);
    this.falling.push(F);
  }

  /** Sync the falling-mast visuals to the latest chunk transform (called from the RENDER loop, not
   *  the fixed step, so wreckage moves smoothly between physics steps). */
  refresh(): void {
    for (const F of this.falling) this.poseFalling(F);
  }

  /** Pose the cloned spars/sail group rigidly from its chunk: the clones were captured at their
   *  SPAWN world transforms, so applying the delta `T(pos) · R(q) · T(−pivot0)` about the spawn
   *  centroid moves them exactly as the rigid chunk moves (the chunk starts at q=identity). */
  private poseFalling(F: FallingRig): void {
    const c = F.chunk;
    this._q.set(c.q[0], c.q[1], c.q[2], c.q[3]);
    this._mRot.makeRotationFromQuaternion(this._q);
    this._mBack.makeTranslation(-F.pivot0.x, -F.pivot0.y, -F.pivot0.z);
    this._mTrans.makeTranslation(c.pos.x, c.pos.y, c.pos.z);
    F.group.matrix.copy(this._mTrans).multiply(this._mRot).multiply(this._mBack);
  }

  /**
   * A mast goes by the board. The VISUAL is the ship's real spars + sail (cloned by
   * shipVisual.detachMast, which also clips the static parts so EXACTLY one mast disappears and one
   * real mast falls). The PHYSICS is a lattice for the falling section only: build it ship-local,
   * GEOMETRICALLY split at the recorded hit height (nodes above hitY fall; below stay as the static
   * stub — connectivity is NOT used to split, because yards/cloth bridge a single trunk cut and the
   * top would never separate), lift the falling nodes to WORLD space, and freeze ONE rigid chunk
   * that topples + crushes the deck. A foot/low hit (hitY < 0) fells the WHOLE mast.
   */
  private spawnFallingMast(ship: Ship, mi: number): void {
    if (!this.scene || !TUN.rig.masts || mi >= ship.build.masts.length) return;
    const b = ship.build;
    const hitY = ship.mastHitY[mi];

    // the real cloned spars/sail (clips the static parts as a side effect) — null in headless tests.
    const detached = ship.visual.detachMast?.(mi, hitY) ?? null;

    const rig = buildRig({ voxelSize: VOXEL_SIZE, deckTopY: (xv) => (b.deckYAt(xv) + 1) * VOXEL_SIZE, masts: [b.masts[mi]] });
    const foot = rig.nodes.find((n) => n.flags & NodeFlag.FOOT);
    const footY = foot ? foot.pos.y : 0;
    // GEOMETRIC split: a node FALLS if its ship-local height clears the hit (a real mid-break leaves a
    // stub); a foot/low hit (hitY < footY+1) fells everything. Robust where connectivity wasn't.
    const wholeMast = !(hitY >= footY + 1);
    const fallIdx: number[] = [];
    for (let i = 0; i < rig.nodes.length; i++) {
      if (wholeMast || rig.nodes[i].pos.y > hitY) fallIdx.push(i);
    }
    if (fallIdx.length === 0) { if (detached) this.scene.add(detached.group); return; }

    // lift the falling nodes into WORLD space (the stub nodes are irrelevant — the stub is the
    // clipped static mesh, no physics needed for it).
    for (const i of fallIdx) {
      const n = rig.nodes[i];
      ship.localToWorld([n.pos.x, n.pos.y, n.pos.z], this.wp);
      n.pos = { x: this.wp.x, y: this.wp.y, z: this.wp.z };
      n.prev = { x: this.wp.x, y: this.wp.y, z: this.wp.z };
      n.pinned = false;
    }
    rig.awake = true;

    // ONE rigid chunk: inherit the ship's velocity + a topple shove abeam + a roll kick so a vertical
    // spar goes OVER the side instead of dropping straight down.
    const sv = ship.body.linvel();
    const lean = mi % 2 === 0 ? 1 : -1;
    const vel: Vec3 = { x: sv.x - 0.4 * TUN.rig.toppleKick, y: sv.y, z: sv.z + lean * TUN.rig.toppleKick };
    const omega: Vec3 = { x: lean * TUN.rig.toppleKick * 0.18, y: 0, z: 0 };
    const chunk = freezeChunk(rig, fallIdx, vel, omega);

    let group: THREE.Group;
    let pivot0: THREE.Vector3;
    if (detached) {
      group = detached.group;
      // the clones move rigidly about the CHUNK centroid (its spawn world pos), so the visual ≡ physics.
      pivot0 = new THREE.Vector3(chunk.pos.x, chunk.pos.y, chunk.pos.z);
      this.scene.add(group);
    } else {
      group = new THREE.Group(); pivot0 = new THREE.Vector3(chunk.pos.x, chunk.pos.y, chunk.pos.z);
    }
    const F: FallingRig = { rig, group, chunk, pivot0, age: 0, buoy: TUN.rig.fallFloatBuoy, ship, rested: false };
    this.poseFalling(F);
    this.falling.push(F);
  }

  /** Integrate every falling piece as ONE RIGID CHUNK (gravity + summed per-node buoyancy off the
   *  swell), let it crush the deck it lands on, waterlog and sink. The chunk holds its shape — it
   *  topples and falls stiff, never noodle — and the cloned real spars/sail are posed from it. */
  private stepFalling(ships: Ship[], simTime: number, dt: number): void {
    if (this.falling.length === 0) return;
    for (let fi = this.falling.length - 1; fi >= 0; fi--) {
      const F = this.falling[fi];
      F.age += dt;
      const c = F.chunk;

      // per-node accel = gravity + a GENTLE buoyancy (computed at the node's current world position);
      // integrateChunk sums force+torque about the centroid so the chunk topples while staying rigid.
      // The OLD spring (1.3·(1+2·sub) ≈ up to +3·G net) rocketed the spar back off the swell and it
      // bounced. Now buoy≈neutral: a fully-submerged node lifts at only ~+0.4·G so the spar rises just
      // enough to float AWASH, never trampolines. We also record how WET the chunk is this step so we
      // can near-critically damp its VERTICAL velocity after integrating (the real anti-bounce lever).
      const buoy = F.buoy;
      let wet = 0;
      const accel = (n: { pos: Vec3 }): Vec3 => {
        let ay = -G;
        const surf = surfaceHeight(this.waves, n.pos.x, n.pos.z, simTime);
        if (n.pos.y < surf) {
          const sub = Math.min(surf - n.pos.y, 1);
          if (sub > wet) wet = sub;
          ay += G * (1 + 0.4 * sub) * buoy; // gentle Archimedes-ish lift (≈neutral), scaled by waterlog
        }
        return { x: 0, y: ay, z: 0 };
      };
      integrateChunk(F.rig, c, accel, dt, TUN.rig.linDamp, TUN.rig.angDamp);

      // Anti-bounce: when submerged, damp the chunk's VELOCITY near-critically on the VERTICAL axis
      // (so the bob dies in ~1 s) and LIGHTLY on the horizontal (so she still drifts), mirroring the
      // proven debris.ts float (kv = m·6·wet, kh = m·0.8·wet). The chunk stores ONE linear velocity
      // (c.vel) + an angular velocity (c.omega); damping c.vel post-integrate is cleaner than a
      // velocity term inside accel (accel only sees position, not the chunk's rigid velocity). The
      // implicit form v *= 1/(1+k·dt) is unconditionally stable even at a near-critical k.
      if (wet > 0) {
        c.vel.y /= 1 + TUN.rig.fallVertDamp * wet * dt;
        const kh = 0.8 * wet;
        c.vel.x /= 1 + kh * dt;
        c.vel.z /= 1 + kh * dt;
        // bleed the tumble too, so a felled spar lies still on the surface instead of spinning forever.
        const ka = 1.2 * wet;
        c.omega.x /= 1 + ka * dt; c.omega.y /= 1 + ka * dt; c.omega.z /= 1 + ka * dt;
      }
      applyChunk(F.rig, c, dt); // re-derive member node world positions from the rigid transform

      this.crushFalling(F, ships, dt);
      this.poseFalling(F); // re-pose the cloned spars/sail from the (possibly bled) transform
      F.buoy = Math.max(F.buoy - dt * TUN.rig.waterlog, TUN.rig.fallSinkFloor); // float, drift, then founder

      // despawn once the whole section has sunk well under the sea, or it times out.
      let sunk = true;
      for (const i of c.nodeIdx) {
        const n = F.rig.nodes[i];
        if (n.pos.y > surfaceHeight(this.waves, n.pos.x, n.pos.z, simTime) - 4) { sunk = false; break; }
      }
      if (sunk || F.age > TUN.rig.fallLifetime) this.disposeFalling(fi);
    }
  }

  /** Remove a falling piece: detach its cloned group from the scene and free its geometry/materials. */
  private disposeFalling(fi: number): void {
    const F = this.falling[fi];
    F.group.removeFromParent();
    F.group.traverse((o) => {
      const m = o as THREE.Mesh;
      // Most geometries are SHARED with the live ship (clones reuse them) — never dispose those.
      // Only a synthesized one-off (the mid-hit top-pole cylinder) is flagged ownDispose.
      if (m.geometry && m.geometry.userData && m.geometry.userData.ownDispose) m.geometry.dispose();
      // debris materials are fresh ones we own in detach*(); their map/alphaMap textures are shared → keep.
      const mat = m.material as THREE.Material | undefined;
      if (mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) mat.dispose();
    });
    this.falling.splice(fi, 1);
  }

  /** The falling chunk lands ON a hull and rests across it instead of phasing through (BUG 3). Each
   *  node buried in solid wood (a) CRUSHES that wood — the same energy→voxels primitive, so a heavy
   *  mast staves in a light deck — and (b) records the deepest penetration so we can push the chunk
   *  UP and rest it on top. A low rest threshold (not vBreak) is used for a mast landing on its OWN
   *  slow-moving deck: a topple barely exceeds vBreak vertically, yet must still settle on the deck. */
  private crushFalling(F: FallingRig, ships: Ship[], dt: number): void {
    if (!TUN.crush.enabled) return;
    const inv = 1 / VOXEL_SIZE;
    const c = F.chunk;
    let contacted = false;
    let maxPen = 0; // deepest node penetration below the deck top this step (m)
    for (const ni of c.nodeIdx) {
      const n = F.rig.nodes[ni];
      const vx = (n.pos.x - n.prev.x) / dt, vy = (n.pos.y - n.prev.y) / dt, vz = (n.pos.z - n.prev.z) / dt;
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      for (const S of ships) {
        const g = S.build.grid, [bx, by, bz] = g.dims;
        S.worldToLocal(this.wp.set(n.pos.x, n.pos.y, n.pos.z), this.wl);
        const cvx = Math.floor(this.wl.x * inv), cvy = Math.floor(this.wl.y * inv), cvz = Math.floor(this.wl.z * inv);
        if (cvx < 0 || cvy < 0 || cvz < 0 || cvx >= bx || cvy >= by || cvz >= bz) continue;
        if (!g.isSolid(cvx, cvy, cvz)) continue;
        contacted = true;
        // penetration depth: how far the node sits below this solid cell's TOP face (ship-local Y).
        const cellTopLocalY = (cvy + 1) * VOXEL_SIZE;
        const pen = cellTopLocalY - this.wl.y;
        if (pen > maxPen) maxPen = pen;
        // CRUSH only at a real impact speed (a slow rest must NOT keep eating the deck). The mast is
        // heavy (fallMass) so even a modest landing speed staves in light planking.
        if (speed >= TUN.crush.vBreak) {
          const cells = this.cells; cells.length = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
            const yy = cvy + dy, zz = cvz + dz;
            if (yy < 0 || zz < 0 || yy >= by || zz >= bz) continue;
            if (g.isSolid(cvx, yy, zz)) this.pushCell(cells, cvx, yy, zz);
          }
          const { removed } = S.crush(cells, 0.5 * TUN.rig.fallMass * speed * speed);
          if (removed > 0 && this.effects) this.effects.crunch(this.wp.set(n.pos.x, n.pos.y, n.pos.z), removed);
        }
        break; // one hull per node per step
      }
    }
    if (contacted) {
      // REST on the deck: lift the whole chunk out of penetration (it can't sink through what it
      // didn't carve) and bleed its motion so it lies stiff across the hull rather than bouncing.
      if (maxPen > 0) c.pos.y += Math.min(maxPen, TUN.rig.restLift);
      c.vel.x *= 0.35; c.vel.y *= 0.1; c.vel.z *= 0.35;
      c.omega.x *= 0.4; c.omega.y *= 0.4; c.omega.z *= 0.4;
      F.rested = true;
      applyChunk(F.rig, c, dt); // re-sync node prev so the next step reads the bled velocity
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
    // Task 9: the spar accumulates the load it sheds into hulls; once it crosses TUN.rig.spritBreak
    // it snaps off (handled in stepAll after this pass, so we don't mutate the rig mid-bore).
    sr.boreLoad += energy;

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
