import * as THREE from "three";
import { TUN } from "../core/tunables";
import { VOXEL_SIZE } from "../core/constants";
import { voxelOverlap, type HullView } from "../sim/voxelOverlap";
import { breakEnergy } from "../sim/materials";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";

/**
 * The deformable ship-vs-ship contact — ONE emergent rule (stepPair below).
 *
 * THE MENTAL MODEL: two loosely-assembled Lego ships, each ROOTED in the sea. A hull half in
 * the water has enormous keel drag (ship.ts), so for a brief collision it is nearly anchored —
 * this is NOT a free two-body collision. Crucially we therefore do NOT conserve momentum
 * between the hulls (the old reduced-mass, equal-and-opposite μ·Δv impulse is exactly what
 * FLUNG the lighter ship — there is no way around that with momentum conservation). Instead:
 *
 *   1. Where the hulls' voxels overlap AND close faster than vBreak, the cheapest contacting
 *      voxels of BOTH hulls break, on a budget of each hull's OWN approach KE (½m·v²). So a
 *      heavier or faster rammer breaks MORE (a heavy ship guts a light one), and the toughness
 *      sort spares the RAM prow — the struck oak holes while the bow only chips.
 *   2. Breaking SAPS the speed of whichever hull drove into the wood — each hull loses the KE
 *      it spent splintering (computed against its OWN mass, like driving into sand). A still
 *      target plows through nothing, so it is retarded by ~nothing → it CANNOT be flung; a
 *      heavier target slows the rammer less per voxel, so the rammer eats MORE damage. That
 *      one-sided energy loss is the whole feel.
 *   3. Only a tiny `transfer` fraction is actually shoved into the other hull — a nudge + yaw,
 *      never a roll-away. Every shove acts at COM HEIGHT, so a corner hit can YAW her (the PIT)
 *      but can never ROLL her. The keel's lateral drag eats most of even that nudge.
 *   4. Below vBreak the wood just springs (a capped, gentle de-penetration). Bumps and
 *      side-by-side rafting do nothing.
 *
 * Carving the whole contact layer every step keeps the bow sitting in a FRESH cavity, so it
 * never embeds in solid material and never needs a stiff shove-out (the second old fling
 * source). Everything else falls out: a big ship rams a small one and tears deep until it has
 * shed enough speed to drop below vBreak; equals head-on disintegrate into each other; a
 * diagonal hit spins the target out. Per voxel, ALL materials follow the same rule — toughness
 * is just each cell's break energy, so the RAM bow outlasts the oak with no special case.
 */

/** Live per-step readback for the dev harness. Reflects the most-overlapping pair. */
export interface ContactDebug {
  overlapCount: number; // A-cells in contact
  depth: number;        // m, interpenetration depth
  force: number;        // N, effective contact force this step (impulse/dt)
  energy: number;       // J spent breaking voxels this step (both hulls)
  removedA: number;     // voxels removed from hull A
  removedB: number;     // voxels removed from hull B
  vClose: number;       // m/s closing speed at the contact (>0 = closing)
}

function zeroDebug(): ContactDebug {
  return { overlapCount: 0, depth: 0, force: 0, energy: 0, removedA: 0, removedB: 0, vClose: 0 };
}

export class VoxelContact {
  /** Latest readback (the most-overlapping pair this step), for the dev harness. */
  debug: ContactDebug = zeroDebug();

  // public so main.ts can attach pulverization dust after construction (Task 8). Optional, so
  // a headless `new VoxelContact()` still runs — dust just no-ops, like DebrisManager.
  constructor(public effects?: Effects) {}

  // ---- temps (no per-step allocation) ----
  private aabbs: { min: THREE.Vector3; max: THREE.Vector3 }[] = [];
  private comA = new THREE.Vector3();
  private comB = new THREE.Vector3();
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private pt = new THREE.Vector3();
  private imp = new THREE.Vector3();
  private tmpc = new THREE.Vector3();
  private pt2 = new THREE.Vector3();
  private hvA: HullView = { surface: new Int32Array(0), isSolid: () => false, dims: [0, 0, 0], pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  private hvB: HullView = { surface: new Int32Array(0), isSolid: () => false, dims: [0, 0, 0], pos: [0, 0, 0], quat: [0, 0, 0, 1] };

  /** Run the deformable contact for every ship pair this fixed step. */
  stepAll(ships: Ship[], dt: number): void {
    if (!TUN.crush.enabled || ships.length < 2) {
      this.debug = zeroDebug();
      return;
    }
    // ensure an AABB temp per ship
    while (this.aabbs.length < ships.length) this.aabbs.push({ min: new THREE.Vector3(), max: new THREE.Vector3() });
    for (let i = 0; i < ships.length; i++) ships[i].aabbWorld(this.aabbs[i]);

    let best = zeroDebug();
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        if (!aabbIntersect(this.aabbs[i], this.aabbs[j])) continue; // broad cull
        const d = this.stepPair(ships[i], ships[j], dt);
        if (d && d.overlapCount > best.overlapCount) best = d;
      }
    }
    this.debug = best;
  }

  /** One pair, one fixed step. Returns its debug, or null if the hulls don't overlap. */
  private stepPair(s1: Ship, s2: Ship, dt: number): ContactDebug | null {
    // walk the SMALLER hull's surface against the larger's occupancy.
    const aSmaller = s1.surfaceCells().length <= s2.surfaceCells().length;
    const shipA = aSmaller ? s1 : s2;
    const shipB = aSmaller ? s2 : s1;

    fillHullView(this.hvA, shipA);
    fillHullView(this.hvB, shipB);
    const ov = voxelOverlap(this.hvA, this.hvB, VOXEL_SIZE);
    if (!ov) return null;

    // ===== THE RULE (anchored destructible contact — see file header) =====
    // Everything is computed from each hull's OWN centre-of-mass→contact direction and its OWN
    // velocity. We deliberately do NOT use a centre-to-centre normal — it flips/degenerates when a
    // big hull engulfs a small one, which produced single-step velocity spikes. The retard always
    // opposes a hull's OWN velocity (it can only ever SLOW it, never add energy, whatever the
    // geometry); the target gets only a small, hard-capped nudge. So nothing can ever be flung.
    shipA.localToWorld(shipA.comLocal, this.comA);
    shipB.localToWorld(shipB.comLocal, this.comB);
    const point = this.pt.set(ov.centroid[0], ov.centroid[1], ov.centroid[2]);
    const depth = ov.depth;
    velAtPoint(shipA, point, this.tmpc, this.vA);
    velAtPoint(shipB, point, this.tmpc, this.vB);

    // each hull's APPROACH speed = how fast it drives toward the contact point, measured along its
    // OWN horizontal COM→point aim (uses ONE com, never a difference of two → no degeneracy at deep
    // overlap). A still / fleeing hull has approach ≤ 0 → it plows nothing → never retarded, never
    // flung. The closing speed is just the two approaches added (the gap shrinks at aA + aB).
    const dax = point.x - this.comA.x, daz = point.z - this.comA.z, dal = Math.hypot(dax, daz) || 1;
    const dbx = point.x - this.comB.x, dbz = point.z - this.comB.z, dbl = Math.hypot(dbx, dbz) || 1;
    const ahx = dax / dal, ahz = daz / dal;   // A's horizontal aim AT the contact
    const bhx = dbx / dbl, bhz = dbz / dbl;    // B's horizontal aim AT the contact
    const aA = Math.max(0, this.vA.x * ahx + this.vA.z * ahz);
    const aB = Math.max(0, this.vB.x * bhx + this.vB.z * bhz);
    const vClose = aA + aB;
    // below a sub-voxel graze → no contact response (kills flicker on a glancing touch).
    if (depth < TUN.crush.minDepth) return { overlapCount: ov.aCells.length, depth, force: 0, energy: 0, removedA: 0, removedB: 0, vClose };

    const mA = Math.max(shipA.body.mass(), 1);
    const mB = Math.max(shipB.body.mass(), 1);
    const mu = (mA * mB) / (mA + mB); // reduced mass — the collision's effective mass
    const gA = shipA.build.grid, gB = shipB.build.grid;

    // BREAK: only when closing faster than vBreak (the wood's give). Budget = the collision energy
    // ½·μ·vClose² (what an inelastic impact dissipates), capped by maxStepEnergy as an anti-vaporize
    // backstop. Spend it on the cheapest contacting voxels, POOLED cheapest-first across BOTH hulls,
    // so the soft oak in the path breaks before the dear RAM prow → the path clears (nothing embeds)
    // and the bow only chips. Per-step count is really bounded by GEOMETRY (only the thin contact
    // layer overlaps); the budget just decides how far down the toughness sort it reaches. Faster /
    // heavier closing → bigger μv² → more breaks; and a heavy hull keeps vClose high (it barely
    // slows) so it guts a lighter one over the whole impact — emergent, with NO "rammer" special case.
    let removedA = 0, removedB = 0, spent = 0;
    const breaking = vClose >= TUN.crush.vBreak;
    if (breaking) {
      const budget = Math.min(0.5 * mu * vClose * vClose * TUN.crush.yield, TUN.crush.maxStepEnergy);
      const cand: { s: 0 | 1; c: [number, number, number]; e: number }[] = [];
      for (let i = 0; i < ov.aCells.length; i++) { const c = ov.aCells[i]; const m = gA.get(c[0], c[1], c[2]); if (m) cand.push({ s: 0, c, e: breakEnergy(m) }); }
      for (let i = 0; i < ov.bCells.length; i++) { const c = ov.bCells[i]; const m = gB.get(c[0], c[1], c[2]); if (m) cand.push({ s: 1, c, e: breakEnergy(m) }); }
      cand.sort((x, y) => x.e - y.e);
      let bud = budget;
      const remA: [number, number, number][] = [], remB: [number, number, number][] = [];
      for (const k of cand) { if (k.e > bud) break; bud -= k.e; spent += k.e; (k.s === 0 ? remA : remB).push(k.c); }
      if (remA.length) removedA = shipA.carveCells(remA);
      if (remB.length) removedB = shipB.carveCells(remB);
    }
    const removed = removedA + removedB;

    // still-solid interpenetration after the carve? (drives the gentle de-penetration below)
    let residual = 0;
    for (let i = 0; i < ov.aCells.length; i++) { const a = ov.aCells[i]; if (gA.isSolid(a[0], a[1], a[2])) residual++; }
    for (let i = 0; i < ov.bCells.length; i++) { const b = ov.bCells[i]; if (gB.isSolid(b[0], b[1], b[2])) residual++; }

    // ---- MOMENTUM: ONE rule, NO "rammer" vs "target". An INELASTIC impulse along the relative-
    // velocity direction drives both hulls toward their COMMON velocity (the faster slows, the slower
    // speeds up) until their relative motion — and so the breaking — stops. It's symmetric and
    // SELF-LIMITING: as vRel → 0 the impulse → 0, so it can't accumulate or fling, and using the
    // velocity direction (not a centre-to-centre normal) means it never flips/spikes at deep overlap.
    // We do NOT root the struck hull — the keel's own water drag (ship.ts, ~42× stronger sideways
    // than fore/aft) bleeds the velocity it gains, so a broadsided hull lurches then is held by the
    // sea while a rear-ended one slides more: the "in molasses" feel, fully emergent. Applied at COM
    // HEIGHT so an off-centre hit YAWS them (a PIT) but never ROLLS them. ----
    let force = 0;
    const vrx = this.vA.x - this.vB.x, vrz = this.vA.z - this.vB.z; // horizontal relative velocity
    const vrl = Math.hypot(vrx, vrz);
    if (breaking && vrl > 1e-3) {
      const nx = vrx / vrl, nz = vrz / vrl; // A relative to B (robust direction, never flips)
      // inelastic cancel of the relative velocity (transfer = 1 → full common velocity), per step
      // capped only as a smoothing / NaN backstop — the impact still completes over a few steps.
      const jmag = mu * Math.min(vrl * TUN.crush.transfer, TUN.crush.maxDvPerStep);
      this.pushAtComHeight(shipA, point, this.comA.y, -nx, -nz, jmag); // −μ·vRel on A
      this.pushAtComHeight(shipB, point, this.comB.y, nx, nz, jmag);   // +μ·vRel on B → common velocity
      force = jmag / dt;
    } else if (residual > 0) {
      // sub-vBreak but still overlapping → ease the hulls apart GENTLY so they don't sit clipped:
      // bring their separation speed UP TO `separate` m/s (one-shot, never pulling them together,
      // capped), along the horizontal line of centres. Equal-and-opposite at the COM (no roll), tiny
      // so it can't fling. The slow-bump / lodged-after-impact case, not the impact itself.
      let scx = this.comB.x - this.comA.x, scz = this.comB.z - this.comA.z;
      const scl = Math.hypot(scx, scz) || 1; scx /= scl; scz /= scl; // A->B, horizontal
      const sepNow = -((this.vA.x - this.vB.x) * scx + (this.vA.z - this.vB.z) * scz); // >0 = separating
      const add = Math.min(TUN.crush.separate - sepNow, TUN.crush.separate);
      if (add > 0) {
        const jSep = mu * add;
        this.imp.set(-scx * jSep, 0, -scz * jSep); shipA.body.applyImpulse(this.imp, true);
        this.imp.set(scx * jSep, 0, scz * jSep); shipB.body.applyImpulse(this.imp, true);
        force = jSep / dt;
      }
    }

    if (this.effects && TUN.crush.fling > 0 && removed > 0) {
      const dl = vrl > 1e-3 ? vrl : 1;
      this.effects.impactDebris(point, this.tmpc.set(vrx / dl, 0, vrz / dl), Math.min(removed * TUN.crush.fling, 40));
    }

    return { overlapCount: ov.aCells.length, depth, force, energy: spent, removedA, removedB, vClose };
  }

  /** Nudge a hull by impulse magnitude `jMag` along the horizontal direction (dx,0,dz), applied at
   *  the contact point projected to the ship's OWN COM HEIGHT (`comY`). Zeroing the vertical lever
   *  arm makes the torque purely vertical (YAW) — a corner hit can spin her (the PIT) but can NEVER
   *  roll her: the sea holds her upright. */
  private pushAtComHeight(ship: Ship, point: THREE.Vector3, comY: number, dx: number, dz: number, jMag: number): void {
    if (jMag === 0) return;
    this.imp.set(dx * jMag, 0, dz * jMag);
    this.pt2.set(point.x, comY, point.z);
    ship.body.applyImpulseAtPoint(this.imp, this.pt2, true);
  }
}

function aabbIntersect(a: { min: THREE.Vector3; max: THREE.Vector3 }, b: { min: THREE.Vector3; max: THREE.Vector3 }): boolean {
  return a.max.x >= b.min.x && a.min.x <= b.max.x &&
    a.max.y >= b.min.y && a.min.y <= b.max.y &&
    a.max.z >= b.min.z && a.min.z <= b.max.z;
}

/** Populate a HullView from a live ship (pose snapshot + grid views). */
function fillHullView(hv: HullView, ship: Ship): void {
  hv.surface = ship.surfaceCells();
  const grid = ship.build.grid;
  hv.isSolid = (x, y, z) => grid.isSolid(x, y, z);
  hv.dims = grid.dims;
  const tr = ship.body.translation();
  hv.pos[0] = tr.x; hv.pos[1] = tr.y; hv.pos[2] = tr.z;
  const rot = ship.body.rotation();
  hv.quat[0] = rot.x; hv.quat[1] = rot.y; hv.quat[2] = rot.z; hv.quat[3] = rot.w;
}

/** World velocity of a rigid body at world point `p`: v = linvel + angvel × (p − comWorld).
 *  `comTmp` and `out` are caller temps. */
function velAtPoint(ship: Ship, p: THREE.Vector3, comTmp: THREE.Vector3, out: THREE.Vector3): void {
  const lv = ship.body.linvel();
  const av = ship.body.angvel();
  ship.localToWorld(ship.comLocal, comTmp); // world center of mass
  const rx = p.x - comTmp.x, ry = p.y - comTmp.y, rz = p.z - comTmp.z;
  out.set(
    lv.x + (av.y * rz - av.z * ry),
    lv.y + (av.z * rx - av.x * rz),
    lv.z + (av.x * ry - av.y * rx),
  );
}
