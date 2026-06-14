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
    const keA = 0.5 * mA * aA * aA;
    const keB = 0.5 * mB * aB * aB;
    const gA = shipA.build.grid, gB = shipB.build.grid;

    // BREAK: only when closing faster than vBreak (the wood's give). Budget = each hull's OWN
    // approach KE (anchored model, NOT reduced mass — so a heavy/fast rammer guts a lighter one),
    // capped by maxStepEnergy as an anti-vaporize backstop. Spend it on the cheapest contacting
    // voxels, POOLED cheapest-first across BOTH hulls, so the soft oak in the path breaks before the
    // dear RAM prow → the path clears (nothing embeds) and the bow only chips. The per-step count is
    // really bounded by GEOMETRY (only the thin contact layer overlaps); the budget just decides how
    // far down the toughness sort it reaches.
    let removedA = 0, removedB = 0, spent = 0;
    const breaking = vClose >= TUN.crush.vBreak;
    if (breaking) {
      const budget = Math.min((keA + keB) * TUN.crush.yield, TUN.crush.maxStepEnergy);
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

    // still-solid interpenetration after the carve? (drives only the gentle de-penetration fallback)
    let residual = 0;
    for (let i = 0; i < ov.aCells.length; i++) { const a = ov.aCells[i]; if (gA.isSolid(a[0], a[1], a[2])) residual++; }
    for (let i = 0; i < ov.bCells.length; i++) { const b = ov.bCells[i]; if (gB.isSolid(b[0], b[1], b[2])) residual++; }

    // INTRUDER = the harder-driving hull; TARGET = the (more) anchored one. The push direction is the
    // intruder's aim AT the contact (well-defined — a rammer's COM is never coincident with the
    // contact). Every per-step Δv is hard-capped at maxDvPerStep, so even a pathological frame can't
    // launch anything.
    const bRams = aB >= aA;
    const intr = bRams ? shipB : shipA, targ = bRams ? shipA : shipB;
    const mInt = bRams ? mB : mA, mTarg = bRams ? mA : mB;
    const aTarget = bRams ? aA : aB;
    const tComY = bRams ? this.comA.y : this.comB.y;
    const phx = bRams ? bhx : ahx, phz = bRams ? bhz : ahz; // push the target along the ram's travel
    const cap = TUN.crush.maxDvPerStep;

    let force = 0;
    if (breaking && removed > 0 && spent > 0) {
      // SLOW each hull by the energy IT plowed (its share of the spent break-energy, against its OWN
      // mass — like driving into sand), applied OPPOSING ITS OWN VELOCITY: this can only ever remove
      // speed, never add it, regardless of contact geometry, so no glitch can fling a hull. Per-hull
      // and capped per step. A still target plows nothing (its share ≈ 0) → it isn't touched here.
      const keSum = keA + keB || 1;
      const slow = TUN.crush.carveDamp;
      const dvA = Math.min(cap, aA - Math.sqrt(Math.max(0, aA * aA - (2 * spent * (keA / keSum) * slow) / mA)));
      const dvB = Math.min(cap, aB - Math.sqrt(Math.max(0, aB * aB - (2 * spent * (keB / keSum) * slow) / mB)));
      this.slowAlongOwnVel(shipA, mA * dvA);
      this.slowAlongOwnVel(shipB, mB * dvB);
      // TARGET NUDGE — only a nearly-anchored target: bring its push-direction speed UP TO (never
      // beyond) transfer × vClose, hard-capped per step. A "slight shove" + yaw (off-centre → PIT)
      // that CANNOT accumulate into a fling; the missing momentum goes into the sea. Skipped in a
      // head-on (both are intruders).
      if (aTarget < TUN.crush.vBreak) {
        const tv = targ.body.linvel();
        let add = TUN.crush.transfer * vClose - (tv.x * phx + tv.z * phz);
        if (add > 0) this.pushAtComHeight(targ, point, tComY, phx, phz, mTarg * Math.min(add, cap));
      }
      force = (mA * dvA + mB * dvB) / dt;
    } else if (residual > 0) {
      // NO breaking this step (sub-vBreak, or a genuinely unbreakable belt) but the hulls still
      // overlap → ease the INTRUDER back OUT along its own aim (reversed) until they part at
      // `separate` m/s. One-shot, capped, never pulling them together → it can't fling. Pure linear
      // (no roll), target left anchored. NOT the ram path (a real ram is breaking, branch above).
      const needed = Math.min(TUN.crush.separate + vClose, TUN.crush.separate * 2, cap);
      if (needed > 0) {
        this.imp.set(-phx, 0, -phz).multiplyScalar(mInt * needed);
        intr.body.applyImpulse(this.imp, true);
        force = (mInt * needed) / dt;
      }
    }

    if (this.effects && TUN.crush.fling > 0 && removed > 0) {
      this.effects.impactDebris(point, this.tmpc.set(phx, 0, phz), Math.min(removed * TUN.crush.fling, 40));
    }

    return { overlapCount: ov.aCells.length, depth, force, energy: spent, removedA, removedB, vClose };
  }

  /** SLOW a hull by impulse magnitude `jMag`, applied OPPOSING its own horizontal velocity at the
   *  COM (pure deceleration — no torque, no roll). Because it always opposes the hull's OWN motion,
   *  it can only ever remove speed, never add it, whatever the contact geometry — the guarantee that
   *  a ram can never fling. No-op if the hull is barely moving. */
  private slowAlongOwnVel(ship: Ship, jMag: number): void {
    if (jMag <= 0) return;
    const lv = ship.body.linvel();
    const sp = Math.hypot(lv.x, lv.z);
    if (sp < 1e-3) return;
    this.imp.set((-lv.x / sp) * jMag, 0, (-lv.z / sp) * jMag);
    ship.body.applyImpulse(this.imp, true);
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
