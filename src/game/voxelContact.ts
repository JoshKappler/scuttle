import * as THREE from "three";
import { TUN } from "../core/tunables";
import { VOXEL_SIZE } from "../core/constants";
import { voxelOverlap, type HullView } from "../sim/voxelOverlap";
import { breakEnergy } from "../sim/materials";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";

/**
 * The deformable ship-vs-ship contact — ONE rule (stepPair below). Ship-ship pairs are pulled OUT
 * of Rapier's rigid solver (physics.ts), so the hulls are FREE to interpenetrate; this routine then
 * reads that real voxel overlap each fixed step and resolves it in three coupled parts:
 *
 *   1. CARVE — where the hulls' solid voxels overlap AND they're closing faster than vBreak, break
 *      the cheapest contacting voxels of BOTH hulls on a budget of the closing KE ½·μ·vClose².
 *      voxelOverlap returns the EXACT overlapping solid cells of each hull, so the struck hull holes
 *      and the rammer's bow chips with no rammer/target special case (a heavier/faster hull keeps
 *      vClose high → guts a lighter one; the toughness sort spares the RAM prow).
 *   2. CANCEL — an inelastic impulse along the overlap's push-out axis drives the hulls toward their
 *      COMMON velocity (the faster slows, the struck one is shoved), at COM HEIGHT so an off-centre
 *      hit YAWS her (the PIT) but never ROLLS her. The keel's own anisotropic water drag (ship.ts,
 *      ~42× stronger sideways) then bleeds the velocity the struck hull gained — the "molasses" feel.
 *   3. DE-PENETRATE — the hard part the old soft spring got wrong: the two bodies are pushed apart
 *      in POSITION by the interpenetration depth (inverse-mass split, relaxed), so two solid hulls
 *      can NEVER end a step occupying the same space. THIS is what stops a hull sailing clean through
 *      another; carving just decides how much wood that costs.
 *
 * Because cancel stops the closing and de-penetrate clears the overlap every step, a hull can never
 * ghost through. A coasting impact is one speed-proportional crunch then they ride along at the
 * common velocity; under sustained sail the bow keeps closing, so it keeps carving and grinds in.
 * Per voxel ALL materials follow the same break-energy rule, so cannons (also a carve) reuse it.
 */

/** Live per-step readback for the dev harness. Reflects the most-damaged pair this step. */
export interface ContactDebug {
  overlapCount: number; // A-cells in solid-solid contact
  depth: number;        // m, interpenetration depth
  force: number;        // N-ish, contact response this step (impulse/dt)
  energy: number;       // J spent breaking voxels this step (both hulls)
  removedA: number;     // voxels removed from hull A (the smaller hull)
  removedB: number;     // voxels removed from hull B
  vClose: number;       // m/s closing speed along the push-out axis (>0 = closing)
}

function zeroDebug(): ContactDebug {
  return { overlapCount: 0, depth: 0, force: 0, energy: 0, removedA: 0, removedB: 0, vClose: 0 };
}

export class VoxelContact {
  /** Latest readback (the most-damaged pair this step), for the dev harness. */
  debug: ContactDebug = zeroDebug();
  /** main.ts attaches this after construction for pulverization dust. Optional, so a headless
   *  `new VoxelContact()` still runs — dust just no-ops. */
  effects?: Effects;

  // ---- temps (no per-step allocation) ----
  private aabbs: { min: THREE.Vector3; max: THREE.Vector3 }[] = [];
  private comA = new THREE.Vector3();
  private comB = new THREE.Vector3();
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private pt = new THREE.Vector3();
  private imp = new THREE.Vector3();
  private pt2 = new THREE.Vector3();
  private tmpc = new THREE.Vector3();
  private hvA: HullView = { surface: new Int32Array(0), isSolid: () => false, dims: [0, 0, 0], pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  private hvB: HullView = { surface: new Int32Array(0), isSolid: () => false, dims: [0, 0, 0], pos: [0, 0, 0], quat: [0, 0, 0, 1] };

  /** Run the deformable contact for every ship pair this fixed step. */
  stepAll(ships: Ship[], dt: number): void {
    if (!TUN.crush.enabled || ships.length < 2) {
      this.debug = zeroDebug();
      return;
    }
    while (this.aabbs.length < ships.length) this.aabbs.push({ min: new THREE.Vector3(), max: new THREE.Vector3() });
    for (let i = 0; i < ships.length; i++) ships[i].aabbWorld(this.aabbs[i]);

    let best = zeroDebug();
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        if (!aabbIntersect(this.aabbs[i], this.aabbs[j])) continue; // broad cull
        const d = this.stepPair(ships[i], ships[j], dt);
        if (!d) continue;
        const dRem = d.removedA + d.removedB, bRem = best.removedA + best.removedB;
        if (dRem > bRem || (dRem === bRem && d.overlapCount > best.overlapCount)) best = d;
      }
    }
    this.debug = best;
  }

  /** One pair, one fixed step. Returns its debug, or null if the hulls don't overlap. */
  private stepPair(s1: Ship, s2: Ship, dt: number): ContactDebug | null {
    // walk the SMALLER hull's surface against the larger's occupancy (voxelOverlap's convention).
    const aSmaller = s1.surfaceCells().length <= s2.surfaceCells().length;
    const shipA = aSmaller ? s1 : s2;
    const shipB = aSmaller ? s2 : s1;

    fillHullView(this.hvA, shipA);
    fillHullView(this.hvB, shipB);
    const ov = voxelOverlap(this.hvA, this.hvB, VOXEL_SIZE);
    if (!ov) return null;

    const nx = ov.axis[0], ny = ov.axis[1], nz = ov.axis[2]; // unit push-out, world, A→B
    const depth = ov.depth;
    const point = this.pt.set(ov.centroid[0], ov.centroid[1], ov.centroid[2]);
    shipA.localToWorld(shipA.comLocal, this.comA);
    shipB.localToWorld(shipB.comLocal, this.comB);

    // closing speed = relative velocity at the contact, projected on the push-out axis (>0 = the
    // hulls are converging). Uses voxelOverlap's axis, which is the thin overlap normal oriented
    // A→B — it never flips/degenerates the way a centre-to-centre normal does when a big hull
    // engulfs a small one (the old single-step spike source).
    velAtPoint(shipA, point, this.tmpc, this.vA);
    velAtPoint(shipB, point, this.tmpc, this.vB);
    const vClose = (this.vA.x - this.vB.x) * nx + (this.vA.y - this.vB.y) * ny + (this.vA.z - this.vB.z) * nz;

    const base: ContactDebug = { overlapCount: ov.aCells.length, depth, force: 0, energy: 0, removedA: 0, removedB: 0, vClose };
    if (depth < TUN.crush.minDepth) return base; // sub-voxel graze → ignore (kills flicker)

    const mA = Math.max(shipA.body.mass(), 1);
    const mB = Math.max(shipB.body.mass(), 1);
    const mu = (mA * mB) / (mA + mB); // reduced mass — the collision's effective mass
    const gA = shipA.build.grid, gB = shipB.build.grid;

    // ---- 1. CARVE (only while closing hard enough to splinter wood) ----
    // Budget = the closing KE ½·μ·vClose², capped by maxStepEnergy. Spend it cheapest-first POOLED
    // across BOTH hulls (the EXACT overlapping solid cells from voxelOverlap), so soft oak gives
    // before the dear RAM prow → the struck hull holes, the bow only chips. Faster/heavier closing
    // → bigger budget → deeper bite; a heavy hull keeps vClose high so it guts a lighter one.
    let removedA = 0, removedB = 0, spent = 0;
    if (vClose >= TUN.crush.vBreak) {
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

    // ---- 2. CANCEL the closing velocity (inelastic, toward a common velocity) ----
    // jv = μ·Δv brings the relative closing to zero (capped per step as a smoothing/NaN backstop —
    // the de-penetration below holds them apart meanwhile, so capping can't cause a phase-through).
    // Applied at COM HEIGHT along the horizontal push-out, so an off-centre hit yaws (PIT) not rolls.
    let force = 0;
    if (vClose > 0) {
      const jv = mu * Math.min(vClose, TUN.crush.maxDvPerStep);
      this.pushAtComHeight(shipA, point, this.comA.y, -nx, -nz, jv); // slow A (it was closing +axis)
      this.pushAtComHeight(shipB, point, this.comB.y, nx, nz, jv);   // shove B along +axis
      force = jv / dt;
    }

    // ---- 3. DE-PENETRATE by POSITION (the hard non-penetration; can't phase through) ----
    // Push the two bodies apart along the axis by the interpenetration depth, split by inverse mass
    // (the lighter hull yields more) and relaxed by `depen` (a fraction per step → smooth, and it
    // re-solves next step from the fresh overlap, so it never accumulates into a fling). Two solid
    // hulls therefore can never end a step inside each other, whatever the closing speed.
    const corr = depth * TUN.crush.depen;
    const moveA = corr * (mB / (mA + mB)), moveB = corr * (mA / (mA + mB));
    const ta = shipA.body.translation();
    shipA.body.setTranslation({ x: ta.x - nx * moveA, y: ta.y - ny * moveA, z: ta.z - nz * moveA }, true);
    const tb = shipB.body.translation();
    shipB.body.setTranslation({ x: tb.x + nx * moveB, y: tb.y + ny * moveB, z: tb.z + nz * moveB }, true);

    if (this.effects && TUN.crush.fling > 0 && removed > 0) {
      this.effects.impactDebris(point, this.tmpc.set(nx, 0, nz), Math.min(removed * TUN.crush.fling, 40));
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
