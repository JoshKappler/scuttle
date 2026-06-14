import * as THREE from "three";
import { TUN } from "../core/tunables";
import { VOXEL_SIZE } from "../core/constants";
import { voxelOverlap, type HullView } from "../sim/voxelOverlap";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";

/**
 * The deformable ship-vs-ship contact — "Layer 2" of the destruction core.
 *
 * The hull-hull pair is OUT of Rapier's rigid solver (physics.ts), so each fixed step we own
 * the response: read the real voxel overlap (sim/voxelOverlap), apply a soft, force-CAPPED,
 * critically-damped penalty spring that pushes the hulls apart, and feed the energy the cap
 * can't absorb into crush() on BOTH hulls at the actual overlap cells. Carving removes those
 * cells → the overlap shrinks next step → the spring is bled, not returned: the rammer digs a
 * gouge instead of bouncing, both hulls indent where they touch, and because the push is
 * capped the struck ship is barely shoved no matter how hard the ram. Mutual wet-wood crunch.
 *
 * Stability comes from the force cap (per-step impulse ≤ fMax·dt) + a clamped penetration +
 * critical damping — a single pass per fixed step, no sub-stepping. The "dig in over time"
 * emerges across fixed steps as the rammer stays driven into the carved void.
 *
 * NOT YET (Task 7 / future): explicit rammer deceleration by extracting the carved energy
 * from the closing motion, with the flung debris as the momentum sink (so a hard rammer
 * visibly slows as it grinds in). v1 relies on the carve consuming the overlap + the capped
 * push; the rammer advances at the carve rate.
 */

/** Live per-step readback for the tuning harness (Task 8). Reflects the most-overlapping pair. */
export interface ContactDebug {
  overlapCount: number; // A-cells in contact
  depth: number;        // m, clamped penetration used for the spring
  force: number;        // N, penalty magnitude applied this step (post-cap)
  energy: number;       // J carved this step (both hulls)
  removedA: number;     // voxels removed from hull A
  removedB: number;     // voxels removed from hull B
  vClose: number;       // m/s closing speed along the contact normal (>0 = closing)
}

function zeroDebug(): ContactDebug {
  return { overlapCount: 0, depth: 0, force: 0, energy: 0, removedA: 0, removedB: 0, vClose: 0 };
}

/** Penetration fed to the spring is clamped to this many voxels — a momentary deep overlap
 *  (e.g. first contact of a fast ram) can't produce an explosive force. */
const MAX_DEPTH_VOXELS = 4;

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

    const n = this.nrm.set(ov.axis[0], ov.axis[1], ov.axis[2]); // unit, A->B
    const c0 = ov.centroid;
    const point = this.pt.set(c0[0], c0[1], c0[2]);
    const depth = Math.min(ov.depth, MAX_DEPTH_VOXELS * VOXEL_SIZE);

    // closing speed along n at the contact point: vClose = (vA - vB)·n  (>0 = approaching)
    velAtPoint(shipA, point, this.comA, this.vA);
    velAtPoint(shipB, point, this.comB, this.vB);
    const vClose = (this.vA.x - this.vB.x) * n.x + (this.vA.y - this.vB.y) * n.y + (this.vA.z - this.vB.z) * n.z;

    const mA = Math.max(shipA.body.mass(), 1);
    const mB = Math.max(shipB.body.mass(), 1);
    const mu = (mA * mB) / (mA + mB); // reduced mass

    // penalty spring: F = k·d + c·vClose, critically damped, CAPPED. The +c·vClose term
    // RESISTS closing (a damped oscillator μd̈ + cḋ + kd = 0 — stable); clamp ≥0 so it never
    // sucks the hulls together, and ≤fMax so it can never rigidly launch the struck ship.
    const k = TUN.crush.k;
    const c = TUN.crush.damping * 2 * Math.sqrt(k * mu);
    let F = k * depth + c * vClose;
    if (F < 0) F = 0;
    if (F > TUN.crush.fMax) F = TUN.crush.fMax;

    // equal-and-opposite impulse at the contact: push B along +n, A along -n.
    const j = F * dt;
    this.imp.copy(n).multiplyScalar(j);
    shipB.body.applyImpulseAtPoint(this.imp, point, true);
    this.imp.copy(n).multiplyScalar(-j);
    shipA.body.applyImpulseAtPoint(this.imp, point, true);

    // carve: the closing KE the capped spring can't absorb this step becomes destruction,
    // split symmetrically over the real overlap cells. Gated by minDepth (no flicker on a
    // grazing touch / a calm raft) and by actually closing.
    let energy = 0, removedA = 0, removedB = 0;
    if (depth >= TUN.crush.minDepth && vClose > 0) {
      const closingKE = 0.5 * mu * vClose * vClose;
      const absorbable = TUN.crush.fMax * depth; // work the capped spring can do over the overlap
      const E = Math.max(0, closingKE - absorbable) * TUN.crush.yield;
      if (E > 0) {
        removedA = shipA.crush(ov.aCells, E / 2).removed;
        removedB = shipB.crush(ov.bCells, E / 2).removed;
        energy = E;
        const removed = removedA + removedB;
        if (this.effects && TUN.crush.fling > 0 && removed > 0) {
          this.effects.impactDebris(point, n, Math.min(removed * TUN.crush.fling, 40));
        }
      }
    }

    return { overlapCount: ov.aCells.length, depth, force: F, energy, removedA, removedB, vClose };
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
