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
 * The hull-hull pair is OUT of Rapier's rigid solver (physics.ts), so each fixed step we own
 * the response. THE RULE: where the two hulls' voxels overlap AND are closing, the relative
 * closing KE (reduced mass × closing speed) is spent breaking the cheapest contacting voxels
 * of BOTH hulls; the KE lost to that breaking IS the momentum exchanged — a single impulse
 * μ·Δv at the contact point. That one impulse both swaps velocity (faster ship slows, slower
 * speeds up toward a common velocity) and, acting off-centre, yaws them (a corner hit spins
 * the target — the PIT). If the KE can't break the material in the way, the same impulse is an
 * elastic bounce instead (a solid stop — no clipping / riding over).
 *
 * Everything falls out of this: a big ship rams a small one and breaks THROUGH (it barely
 * slows per step, the small one is flung forward) until their closing speed drops too low to
 * break a voxel; two equals head-on disintegrate into each other; a diagonal hit spins. Per
 * voxel, ALL materials (hull, ballast, deck) — toughness is just each cell's break energy, so
 * the RAM bow outlasts the oak it strikes with no special case.
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
  private nrm = new THREE.Vector3();
  private imp = new THREE.Vector3();
  private tmpc = new THREE.Vector3();
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

    // ===== THE RULE =====
    // Where two hulls' voxels overlap AND are closing, the relative closing KE (reduced mass ×
    // closing speed) is spent breaking the cheapest contacting voxels of BOTH hulls. The KE lost
    // to that breaking IS the momentum exchanged: ONE impulse μ·Δv at the contact point, which
    // (a) conserves momentum so the faster ship slows and the slower speeds toward a common
    // velocity, and (b) acting at the contact POINT, yaws them — a corner hit spins the target
    // (the PIT). If the KE can't break the material in the way, the same impulse becomes an
    // elastic bounce. Big-rams-small breaks through; head-on equals disintegrate into each
    // other; everything stops once the closing speed is too low to break a voxel. Emergent.

    // robust contact normal: centre-to-centre (the overlap thin-axis is too noisy when shallow,
    // which collapsed the closing speed and let the old spring bulldoze/clip).
    shipA.localToWorld(shipA.comLocal, this.comA);
    shipB.localToWorld(shipB.comLocal, this.comB);
    const nx = this.comB.x - this.comA.x, ny = this.comB.y - this.comA.y, nz = this.comB.z - this.comA.z;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    const n = this.nrm.set(nx / nlen, ny / nlen, nz / nlen); // unit, A->B
    const point = this.pt.set(ov.centroid[0], ov.centroid[1], ov.centroid[2]);
    const depth = ov.depth;

    // relative closing speed of the contact point along n (includes spin via velAtPoint)
    velAtPoint(shipA, point, this.tmpc, this.vA);
    velAtPoint(shipB, point, this.tmpc, this.vB);
    const vClose = (this.vA.x - this.vB.x) * n.x + (this.vA.y - this.vB.y) * n.y + (this.vA.z - this.vB.z) * n.z;
    // below a sub-voxel graze → no contact response (kills flicker on a glancing touch).
    if (depth < TUN.crush.minDepth) return { overlapCount: ov.aCells.length, depth, force: 0, energy: 0, removedA: 0, removedB: 0, vClose };

    const mA = Math.max(shipA.body.mass(), 1);
    const mB = Math.max(shipB.body.mass(), 1);
    const mu = (mA * mB) / (mA + mB); // reduced mass — "the mass of the bodies hitting each other"
    const closing = vClose > 0;

    const gA = shipA.build.grid, gB = shipB.build.grid;

    // BREAK: spend the closing KE on the cheapest contacting voxels, POOLED across BOTH hulls
    // (one budget, cheapest-first). The soft oak in the bow's path breaks before the dear RAM bow,
    // so the path clears (nothing embeds) while the prow survives → light bow damage, emergent and
    // hull-agnostic (a small ship ramming a big one is spared the same way). Only while CLOSING.
    let removedA = 0, removedB = 0, spent = 0;
    if (closing) {
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

    // is solid material still interpenetrating after this step's breaking?
    let residual = 0;
    for (let i = 0; i < ov.aCells.length; i++) { const a = ov.aCells[i]; if (gA.isSolid(a[0], a[1], a[2])) residual++; }
    for (let i = 0; i < ov.bCells.length; i++) { const b = ov.bCells[i]; if (gB.isSolid(b[0], b[1], b[2])) residual++; }
    const removed = removedA + removedB;

    // inward speed left after breaking (energy conservation: the KE that became destruction is
    // gone from the relative motion).
    const vIn = closing ? Math.sqrt(Math.max(0, vClose * vClose - (2 * spent / mu) * TUN.crush.carveDamp)) : 0;

    let jOut = 0;
    if (closing && removed > 0 && spent > 0) {
      // CRUSHING → gentle BREAK-TRANSFER. Fracturing wood transmits only a little momentum
      // (TUN.crush.transfer of the breaking's Δv) — far less than the force to fling/roll a heavy
      // hull. Applied at the contact POINT so a diagonal hit yaws the target (the PIT). The ram
      // keeps digging on through at its barely-reduced speed; over many voxels the faster ship
      // slows + the slower speeds up a LITTLE each, and the carve clears the bow's path so the
      // overlap stays shallow (no deep embed). A big ram breaks clean through a small hull; near
      // equals trade enough to slow each other. No de-penetration here — it would accumulate into
      // a hull-fling, and it isn't needed (the carve, not a push, keeps penetration shallow).
      jOut = TUN.crush.transfer * mu * (vClose - vIn);
      this.imp.copy(n).multiplyScalar(jOut);
      shipB.body.applyImpulseAtPoint(this.imp, point, true);
      this.imp.copy(n).multiplyScalar(-jOut);
      shipA.body.applyImpulseAtPoint(this.imp, point, true);
    } else if (closing && residual > 0) {
      // closing but NOTHING broke → an unbreakable belt or a nudge too slow to break a voxel →
      // SOLID contact: stop the closing so nothing clips through. At the COM (no roll).
      jOut = mu * vClose;
      this.imp.copy(n).multiplyScalar(jOut);
      shipB.body.applyImpulse(this.imp, true);
      this.imp.copy(n).multiplyScalar(-jOut);
      shipA.body.applyImpulse(this.imp, true);
    } else if (!closing && residual > 0) {
      // not closing but still overlapping → a post-ram embed: ease the hulls apart so they don't
      // stay clipped together. Gentle, at the COM (no roll), proportional to how deep they sit.
      jOut = mu * TUN.crush.separate * Math.min(depth, 1);
      this.imp.copy(n).multiplyScalar(jOut);
      shipB.body.applyImpulse(this.imp, true);
      this.imp.copy(n).multiplyScalar(-jOut);
      shipA.body.applyImpulse(this.imp, true);
    }

    if (this.effects && TUN.crush.fling > 0 && removed > 0) {
      this.effects.impactDebris(point, n, Math.min(removed * TUN.crush.fling, 40));
    }

    return { overlapCount: ov.aCells.length, depth, force: jOut / dt, energy: spent, removedA, removedB, vClose };
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
