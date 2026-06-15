import * as THREE from "three";
import { TUN } from "../core/tunables";
import { VOXEL_SIZE } from "../core/constants";
import { detectContacts, type HullView, type ContactScratch } from "../sim/voxelOverlap";
import { breakEnergy } from "../sim/materials";
import { breakImpulse } from "../sim/crush";
import type { VoxelGrid } from "../sim/voxelGrid";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";

/**
 * Ship-vs-ship deformable contact — the Teardown rule. Ship-ship pairs are pulled OUT of Rapier's
 * rigid solver (physics.ts), so the hulls freely interpenetrate and the real voxel overlap is
 * visible. Each fixed step `stepPair` finds the overlapping voxel-pairs (detectContacts) and
 * branches PER CONTACT on the closing speed at that point:
 *
 *   • CLOSING > vBreak  → BREAK both voxels. The fracture energy is taken straight out of the
 *     closing motion (breakImpulse: destruction and deceleration are one inelastic event). Only the
 *     thin currently-overlapping layer breaks each step, so the hull keeps most of its speed and
 *     advances into the cleared space next step — it PLOWS in, shedding a little per layer, until
 *     closing falls under vBreak. Non-penetration is free here: the voxel in the way is GONE, so
 *     nothing pushes back (no "jar"). The bite is applied HORIZONTALLY at COM height → an off-centre
 *     hit yaws her, never rolls; the keel's own ~42×-sideways water drag bleeds the struck hull's
 *     gain ("in molasses"). Heavier hull → smaller Δv = J/m → it barely slows and guts a light one.
 *
 *   • CLOSING ≤ vBreak  → REST. No damage. Cancel the (small) closing and push the bodies apart in
 *     POSITION by the overlap depth (rate-capped) so two solid hulls can't share space. This is the
 *     ONLY place positional separation runs — the previous design ran it every step EVEN WHILE
 *     breaking, and that unconditional shove WAS the "jar the other ship out of the way" bug.
 *
 * Everything destructible is grid voxels (hull, deck, quarterdeck, cabin, bulwark, bulkheads,
 * ballast, bow armor); cannons / wheel / masts / sails are separate render meshes, never in the
 * grid, so the carve (carveCells) can't touch them — the "spare the props" requirement is structural.
 */

/** Live per-step readback for the dev harness. Reflects the most-damaged pair this step. */
export interface ContactDebug {
  overlapCount: number; // voxel-contacts found this step
  depth: number;        // m, interpenetration depth
  force: number;        // N-ish, contact response this step (impulse/dt)
  energy: number;       // J spent breaking voxels this step (both hulls)
  removedA: number;     // voxels removed from hull A (the smaller hull)
  removedB: number;     // voxels removed from hull B
  vClose: number;       // m/s closing speed at the contact (>0 = closing)
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

  // ---- temps (no per-step allocation on the hot path) ----
  private aabbs: { min: THREE.Vector3; max: THREE.Vector3 }[] = [];
  private comA = new THREE.Vector3();
  private comB = new THREE.Vector3();
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private imp = new THREE.Vector3();
  private pt2 = new THREE.Vector3();
  private hvA: HullView = { surface: new Int32Array(0), isSolid: () => false, dims: [0, 0, 0], pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  private hvB: HullView = { surface: new Int32Array(0), isSolid: () => false, dims: [0, 0, 0], pos: [0, 0, 0], quat: [0, 0, 0, 1] };
  // contact scratch, grown to hold the smaller hull's surface (one contact per A surface cell max).
  private scratch: ContactScratch = { aCells: new Int32Array(0), bCells: new Int32Array(0), points: new Float32Array(0) };

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

  /** Grow the contact scratch so it can hold `contacts` entries. */
  private ensureScratch(contacts: number): void {
    if (this.scratch.aCells.length >= contacts * 3) return;
    const n = contacts * 3;
    this.scratch = { aCells: new Int32Array(n), bCells: new Int32Array(n), points: new Float32Array(n) };
  }

  /** One pair, one fixed step. Returns its debug, or null if the hulls don't overlap. */
  private stepPair(s1: Ship, s2: Ship, dt: number): ContactDebug | null {
    // walk the SMALLER hull's surface against the larger's occupancy (detectContacts' convention).
    const aSmaller = s1.surfaceCells().length <= s2.surfaceCells().length;
    const shipA = aSmaller ? s1 : s2;
    const shipB = aSmaller ? s2 : s1;

    fillHullView(this.hvA, shipA);
    fillHullView(this.hvB, shipB);
    this.ensureScratch(this.hvA.surface.length / 3);
    const ov = detectContacts(this.hvA, this.hvB, VOXEL_SIZE, TUN.crush.buffer, this.scratch);
    if (!ov) return null;

    const sc = this.scratch;
    const count = ov.count;
    const depth = ov.depth;

    // world COM + velocities of both bodies, sampled once.
    shipA.localToWorld(shipA.comLocal, this.comA);
    shipB.localToWorld(shipB.comLocal, this.comB);
    const lvA = shipA.body.linvel(), avA = shipA.body.angvel();
    const lvB = shipB.body.linvel(), avB = shipB.body.angvel();

    // aggregate HORIZONTAL closing direction d̂ from the relative velocity at the contact centroid.
    // Horizontal-only so wave heave never reads as closing, and so the bite (applied at COM height)
    // yaws but never rolls. If there's essentially no relative motion, it's a pure REST contact.
    const cx = ov.centroid[0], cy = ov.centroid[1], cz = ov.centroid[2];
    this.velAt(this.comA, lvA, avA, cx, cy, cz, this.vA);
    this.velAt(this.comB, lvB, avB, cx, cy, cz, this.vB);
    let dhx = this.vA.x - this.vB.x, dhz = this.vA.z - this.vB.z;
    const dlen = Math.hypot(dhx, dhz);
    const moving = dlen > 1e-4;
    if (moving) { dhx /= dlen; dhz /= dlen; }

    const mA = Math.max(shipA.body.mass(), 1);
    const mB = Math.max(shipB.body.mass(), 1);
    const mu = (mA * mB) / (mA + mB); // reduced mass — the collision's effective mass
    const gA = shipA.build.grid, gB = shipB.build.grid;
    const tough = TUN.crush.toughness;

    // ---- classify each contact: BREAK (closing > vBreak) vs REST ----
    let breakCount = 0, bSumX = 0, bSumY = 0, bSumZ = 0, costSum = 0;
    const brokenA: [number, number, number][] = [];
    const brokenB: [number, number, number][] = [];
    if (moving) {
      for (let i = 0; i < count; i++) {
        const o = i * 3;
        const px = sc.points[o], py = sc.points[o + 1], pz = sc.points[o + 2];
        this.velAt(this.comA, lvA, avA, px, py, pz, this.vA);
        this.velAt(this.comB, lvB, avB, px, py, pz, this.vB);
        const vci = (this.vA.x - this.vB.x) * dhx + (this.vA.z - this.vB.z) * dhz; // horizontal closing
        if (vci <= TUN.crush.vBreak) continue;
        const ax = sc.aCells[o], ay = sc.aCells[o + 1], az = sc.aCells[o + 2];
        const bx = sc.bCells[o], by = sc.bCells[o + 1], bz = sc.bCells[o + 2];
        brokenA.push([ax, ay, az]);
        brokenB.push([bx, by, bz]);
        costSum += (breakEnergy(gA.get(ax, ay, az)) + breakEnergy(gB.get(bx, by, bz))) * tough;
        bSumX += px; bSumY += py; bSumZ += pz; breakCount++;
      }
    }

    let removedA = 0, removedB = 0, energy = 0, force = 0, vClose = 0;

    if (breakCount > 0) {
      // ---- BREAK regime: carve the overlapping layer, take its energy out of the closing motion ----
      // The geometry already limits the layer to ~one advance per step; maxStepEnergy is only an
      // anti-vaporize clamp for a pathological deep overlap, so the common path carves the whole
      // layer. The carve clears the path, so NO de-penetration runs (that was the jar).
      if (costSum <= TUN.crush.maxStepEnergy) {
        removedA = shipA.carveCells(brokenA);
        removedB = shipB.carveCells(brokenB);
        energy = costSum;
      } else {
        energy = this.carveWithinBudget(shipA, shipB, brokenA, brokenB, gA, gB, tough, TUN.crush.maxStepEnergy);
        removedA = this.lastRemovedA; removedB = this.lastRemovedB;
      }

      const bcx = bSumX / breakCount, bcy = bSumY / breakCount, bcz = bSumZ / breakCount;
      this.velAt(this.comA, lvA, avA, bcx, bcy, bcz, this.vA);
      this.velAt(this.comB, lvB, avB, bcx, bcy, bcz, this.vB);
      vClose = (this.vA.x - this.vB.x) * dhx + (this.vA.z - this.vB.z) * dhz;
      const j = breakImpulse(mu, vClose, energy, TUN.crush.biteDvCap);
      this.pushAtComHeight(shipA, bcx, bcz, this.comA.y, -dhx, -dhz, j); // slow A (closing +d̂)
      this.pushAtComHeight(shipB, bcx, bcz, this.comB.y, dhx, dhz, j);   // shove B along +d̂
      force = j / dt;

      const removed = removedA + removedB;
      if (this.effects && TUN.crush.fling > 0 && removed > 0) {
        this.pt2.set(bcx, bcy, bcz);
        this.imp.set(dhx, 0, dhz);
        this.effects.impactDebris(this.pt2, this.imp, Math.min(removed * TUN.crush.fling, 40));
      }
    } else if (depth >= TUN.crush.minDepth) {
      // ---- REST regime: too slow to break → cancel the closing + de-penetrate by POSITION ----
      // Direction = the geometric push-out axis (reliable for the SHALLOW overlaps this branch sees;
      // deep engulfing overlap only happens while breaking, which uses d̂ instead).
      const nx = ov.axis[0], ny = ov.axis[1], nz = ov.axis[2];
      this.velAt(this.comA, lvA, avA, cx, cy, cz, this.vA);
      this.velAt(this.comB, lvB, avB, cx, cy, cz, this.vB);
      vClose = (this.vA.x - this.vB.x) * nx + (this.vA.y - this.vB.y) * ny + (this.vA.z - this.vB.z) * nz;
      if (vClose > 0) {
        const jv = mu * Math.min(vClose, TUN.crush.biteDvCap);
        this.pushAtComHeight(shipA, cx, cz, this.comA.y, -nx, -nz, jv);
        this.pushAtComHeight(shipB, cx, cz, this.comB.y, nx, nz, jv);
        force = jv / dt;
      }
      // POSITION de-penetration, inverse-mass split, rate-capped so it can never fling.
      const corr = Math.min(depth * TUN.crush.depen, TUN.crush.maxDepenSpeed * dt);
      const moveA = corr * (mB / (mA + mB)), moveB = corr * (mA / (mA + mB));
      const ta = shipA.body.translation();
      shipA.body.setTranslation({ x: ta.x - nx * moveA, y: ta.y - ny * moveA, z: ta.z - nz * moveA }, true);
      const tb = shipB.body.translation();
      shipB.body.setTranslation({ x: tb.x + nx * moveB, y: tb.y + ny * moveB, z: tb.z + nz * moveB }, true);
    }

    return { overlapCount: count, depth, force, energy, removedA, removedB, vClose };
  }

  // carveWithinBudget writes its two removal counts here (avoids allocating a result object).
  private lastRemovedA = 0;
  private lastRemovedB = 0;

  /** Rare path: the overlapping layer's break-energy exceeds maxStepEnergy (e.g. a teleport-deep
   *  overlap). Spend the budget cheapest-first across both hulls' candidates so we never vaporize a
   *  huge slab in one frame; returns the energy actually spent. */
  private carveWithinBudget(
    shipA: Ship, shipB: Ship,
    brokenA: [number, number, number][], brokenB: [number, number, number][],
    gA: VoxelGrid, gB: VoxelGrid, tough: number, budget: number,
  ): number {
    const cand: { s: 0 | 1; c: [number, number, number]; e: number }[] = [];
    for (const c of brokenA) cand.push({ s: 0, c, e: breakEnergy(gA.get(c[0], c[1], c[2])) * tough });
    for (const c of brokenB) cand.push({ s: 1, c, e: breakEnergy(gB.get(c[0], c[1], c[2])) * tough });
    cand.sort((x, y) => x.e - y.e);
    let bud = budget, spent = 0;
    const remA: [number, number, number][] = [], remB: [number, number, number][] = [];
    for (const k of cand) { if (k.e > bud) break; bud -= k.e; spent += k.e; (k.s === 0 ? remA : remB).push(k.c); }
    this.lastRemovedA = remA.length ? shipA.carveCells(remA) : 0;
    this.lastRemovedB = remB.length ? shipB.carveCells(remB) : 0;
    return spent;
  }

  /** World velocity of body with COM `com`, linvel `lv`, angvel `av` at world point (px,py,pz):
   *  v = lv + av × (p − com). Writes into `out`. */
  private velAt(
    com: THREE.Vector3,
    lv: { x: number; y: number; z: number }, av: { x: number; y: number; z: number },
    px: number, py: number, pz: number, out: THREE.Vector3,
  ): void {
    const rx = px - com.x, ry = py - com.y, rz = pz - com.z;
    out.set(lv.x + (av.y * rz - av.z * ry), lv.y + (av.z * rx - av.x * rz), lv.z + (av.x * ry - av.y * rx));
  }

  /** Nudge a hull by impulse magnitude `jMag` along the horizontal direction (dx,0,dz), applied at
   *  the contact (px, comY, pz) — i.e. projected to the ship's OWN COM HEIGHT. Zeroing the vertical
   *  lever arm makes the torque purely vertical (YAW): a corner hit can spin her (the PIT) but can
   *  NEVER roll her — the sea holds her upright. */
  private pushAtComHeight(ship: Ship, px: number, pz: number, comY: number, dx: number, dz: number, jMag: number): void {
    if (jMag === 0) return;
    this.imp.set(dx * jMag, 0, dz * jMag);
    this.pt2.set(px, comY, pz);
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
