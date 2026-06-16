import * as THREE from "three";
import { TUN } from "../core/tunables";
import { detectContacts, type HullView, type ContactScratch } from "../sim/voxelOverlap";
import { breakImpulse, splitClosingImpulse } from "../sim/crush";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";

/**
 * Ship-vs-ship deformable contact — the Teardown rule. Ship-ship pairs are pulled OUT of Rapier's
 * rigid solver (physics.ts), so the hulls freely interpenetrate and the real voxel overlap is
 * visible. Each fixed step `stepPair` finds the overlapping voxel-pairs (detectContacts) and
 * branches PER CONTACT on the closing speed at that point:
 *
 *   • CLOSING > vBreak  → BREAK both voxels. The fracture energy is taken straight out of the closing
 *     motion (breakImpulse: destruction and deceleration are one inelastic event), but it is shed as a
 *     split by splitClosingImpulse into a DRAG on the hull DRIVING in (the crumbling layer carries its
 *     momentum off as debris → a stationary victim is untouched) plus a tunable momentum-TRANSFER
 *     share (TUN.crush.transferFrac) that shoves the struck hull toward the common velocity. At
 *     transferFrac 0 a heavy ram spends its OWN speed boring through and does NOT launch a dead-in-the-
 *     water victim; dialling it up trades that back for more "the hit shoves her" (the old equal-and-
 *     opposite bite was transferFrac 1 → both hit a common velocity, the differential vanished, breaking
 *     stopped, and the ram coasted on through lodged — so keep it modest). Only the thin overlapping
 *     layer breaks each step, so the hull keeps most of its speed and PLOWS into the cleared space next
 *     step, shedding a little per layer, until its approach falls under vBreak. Non-penetration is free
 *     here: the voxel in the way is GONE, so nothing pushes back (no "jar"). The drag is applied
 *     HORIZONTALLY at COM height → an off-centre hit yaws her, never rolls. Heavier hull → smaller
 *     Δv = J/m → it barely slows and guts a light one ("heavier = harder to shove").
 *
 *   • CLOSING ≤ vBreak  → REST. No damage. DELETE the (small) remaining closing and push the bodies
 *     apart in POSITION until no two voxels share space — the "final layer it can't break stops the ram
 *     dead". Direction is the horizontal COM→COM line (the geometric push-out axis FLIPS when one hull
 *     engulfs another → it would shove a lodged ram deeper, "the nose rotates straight through"). The
 *     separation is strong enough to actually EXPEL a lodged hull, but position-only (no velocity
 *     added) and only ever shrinks the overlap (closing zeroed first), so it can never re-penetrate or
 *     "jar" — the previous design ran a shove every step EVEN WHILE breaking, and THAT was the jar.
 *
 * Everything destructible is grid voxels (hull, deck, quarterdeck, cabin, bulwark, bulkheads,
 * ballast, bow armor); cannons / wheel / masts / sails are separate render meshes, never in the
 * grid, so the carve (carveCells) can't touch them — the "spare the props" requirement is structural.
 */

/**
 * The "other body" (hull B) in a deformable contact. A ship implements this as a thin pass-through
 * (ship-vs-ship is unchanged); IslandTarget implements it for static terrain (infinite mass, zero
 * velocity, never carved). The contact rule (resolveContact) is written entirely against this
 * interface, so terrain is just another hull — THE LAW invariant #4, one destruction rule.
 */
export interface ContactTarget {
  /** This body's voxel cell size in metres (ship 0.25, terrain 1.0). */
  readonly voxelSize: number;
  /** False for indestructible terrain — its voxels are never carved. */
  readonly canCarve: boolean;
  /** Fill a HullView for overlap detection. Surface is only walked when this body is hull A. */
  fillHullView(hv: HullView): void;
  /** World AABB of this body's voxel envelope, written into out (broad-phase cull). */
  aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }): void;
  /** World centre (closing direction + point velocity), into out. */
  comWorld(out: THREE.Vector3): THREE.Vector3;
  linvel(): { x: number; y: number; z: number };
  angvel(): { x: number; y: number; z: number };
  /** Effective mass (kg); terrain reports a huge value so it acts immovable. */
  mass(): number;
  /** Joules to break the local cell (only called when canCarve). */
  cellBreakEnergy(x: number, y: number, z: number): number;
  /** Remove local cells; returns count removed (only called when canCarve). */
  carveCells(cells: [number, number, number][]): number;
  /** Apply a world impulse at a world point (no-op for immovable terrain). */
  applyImpulseAtPoint(impulse: THREE.Vector3, point: { x: number; y: number; z: number }): void;
  /** Current world translation (for de-penetration). */
  translation(): { x: number; y: number; z: number };
  /** Set world translation (no-op for immovable terrain). */
  setTranslation(t: { x: number; y: number; z: number }): void;
}

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
  private tAabb = { min: new THREE.Vector3(), max: new THREE.Vector3() }; // terrain broad-phase scratch
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

  /** Run the deformable contact for every ship↔ship and ship↔terrain pair this fixed step. */
  stepAll(ships: Ship[], terrain: ContactTarget[], dt: number): void {
    if (!TUN.crush.enabled) {
      this.debug = zeroDebug();
      return;
    }
    while (this.aabbs.length < ships.length) this.aabbs.push({ min: new THREE.Vector3(), max: new THREE.Vector3() });
    for (let i = 0; i < ships.length; i++) ships[i].aabbWorld(this.aabbs[i]);

    let best = zeroDebug();
    // ship ↔ ship: both hulls carve (existing behavior)
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        if (!aabbIntersect(this.aabbs[i], this.aabbs[j])) continue; // broad cull
        best = this.worse(best, this.stepPair(ships[i], ships[j], dt));
      }
    }
    // ship ↔ terrain: terrain is hull B — immovable + indestructible, only the SHIP erodes
    for (let i = 0; i < ships.length; i++) {
      for (let t = 0; t < terrain.length; t++) {
        terrain[t].aabbWorld(this.tAabb);
        if (!aabbIntersect(this.aabbs[i], this.tAabb)) continue;
        best = this.worse(best, this.resolveContact(ships[i], terrain[t], dt));
      }
    }
    this.debug = best;
  }

  /** Keep whichever debug reflects the most-damaged pair this step (for the dev harness). */
  private worse(best: ContactDebug, d: ContactDebug | null): ContactDebug {
    if (!d) return best;
    const dRem = d.removedA + d.removedB, bRem = best.removedA + best.removedB;
    return dRem > bRem || (dRem === bRem && d.overlapCount > best.overlapCount) ? d : best;
  }

  /** Grow the contact scratch so it can hold `contacts` entries. */
  private ensureScratch(contacts: number): void {
    if (this.scratch.aCells.length >= contacts * 3) return;
    const n = contacts * 3;
    this.scratch = { aCells: new Int32Array(n), bCells: new Int32Array(n), points: new Float32Array(n) };
  }

  /** One ship pair: walk the SMALLER hull's surface (fewer cells) as A; both ships carve. */
  private stepPair(s1: Ship, s2: Ship, dt: number): ContactDebug | null {
    const aSmaller = s1.surfaceCells().length <= s2.surfaceCells().length;
    return aSmaller ? this.resolveContact(s1, s2, dt) : this.resolveContact(s2, s1, dt);
  }

  /**
   * The ONE deformable-contact rule, run for ANY pair: ship↔ship (both carve) or ship↔terrain
   * (B is immovable + indestructible). A's surface is walked against B's occupancy. Returns the
   * per-pair debug, or null if the hulls don't overlap. See the module header for the two regimes.
   */
  resolveContact(a: ContactTarget, b: ContactTarget, dt: number): ContactDebug | null {
    a.fillHullView(this.hvA);
    b.fillHullView(this.hvB);
    this.ensureScratch(this.hvA.surface.length / 3);
    const ov = detectContacts(this.hvA, this.hvB, a.voxelSize, TUN.crush.buffer, this.scratch, b.voxelSize);
    if (!ov) return null;

    const sc = this.scratch;
    const count = ov.count;
    const depth = ov.depth;

    // world COM + velocities of both bodies, sampled once.
    a.comWorld(this.comA);
    b.comWorld(this.comB);
    const lvA = a.linvel(), avA = a.angvel();
    const lvB = b.linvel(), avB = b.angvel();

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

    const mA = Math.max(a.mass(), 1);
    const mB = Math.max(b.mass(), 1);
    const mu = (mA * mB) / (mA + mB); // reduced mass — terrain's huge mB makes this ≈ mA
    const tough = TUN.crush.toughness;

    // ---- classify each contact: BREAK (closing > vBreak) vs REST ----
    let breakCount = 0, bSumX = 0, bSumY = 0, bSumZ = 0;
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
        brokenA.push([sc.aCells[o], sc.aCells[o + 1], sc.aCells[o + 2]]);
        if (b.canCarve) brokenB.push([sc.bCells[o], sc.bCells[o + 1], sc.bCells[o + 2]]);
        bSumX += px; bSumY += py; bSumZ += pz; breakCount++;
      }
    }

    let removedA = 0, removedB = 0, energy = 0, force = 0, vClose = 0;

    if (breakCount > 0) {
      // ---- BREAK regime: destruction is BOUNDED by the collision energy ----
      // Carve cheapest-first up to ½·μ·vClose² (the closing KE): a ram can only break as much wood
      // as its energy can pay for, so it bites a hole and LODGES once that energy is spent instead of
      // carving the whole overlap for free and clipping out the far side. The broken wood's energy is
      // then taken straight out of the closing motion (breakImpulse). The carve clears the wood in the
      // way, so NO position de-penetration runs here (running it while breaking was the jar). maxStepEnergy
      // is only an anti-vaporize clamp for a pathological (teleport) deep overlap. Against terrain B can't
      // carve, so ALL the budget erodes the ship — an immovable, indestructible wall takes the full hit.
      const bcx = bSumX / breakCount, bcy = bSumY / breakCount, bcz = bSumZ / breakCount;
      this.velAt(this.comA, lvA, avA, bcx, bcy, bcz, this.vA);
      this.velAt(this.comB, lvB, avB, bcx, bcy, bcz, this.vB);
      const sA = this.vA.x * dhx + this.vA.z * dhz; // A's speed along the closing axis d̂
      const sB = this.vB.x * dhx + this.vB.z * dhz; // B's speed along d̂ (0 for static terrain)
      vClose = sA - sB;
      const budget = Math.min(0.5 * mu * vClose * vClose, TUN.crush.maxStepEnergy);
      energy = this.carveWithinBudget(a, b, brokenA, brokenB, tough, budget);
      removedA = this.lastRemovedA; removedB = this.lastRemovedB;
      // The fracture energy is shed as a DRAG on the hull(s) driving INTO the contact — the crumbling
      // layer carries its momentum off as debris and pushes the body behind it ~nothing, so a heavy
      // ram spends its OWN speed boring through and a dead-in-the-water victim is NOT accelerated up to
      // ramming speed. The old equal-and-opposite bite did exactly that → both ships ended at the same
      // speed, the closing differential vanished, breaking stopped, and the ram coasted on through,
      // lodged. Slowing only the aggressor keeps the differential alive so it chews until IT stops.
      const dvClose = breakImpulse(mu, vClose, energy, TUN.crush.biteDvCap) / mu; // closing-speed to remove
      // split into the aggressor-drag + (tunable) momentum-transfer mix (see crush.splitClosingImpulse):
      // transferFrac 0 = a stationary victim isn't shoved at all; higher = it picks up more of the hit.
      // For static terrain (sB=0, huge mB) jA ≈ mShip·dvClose and jB lands on the immovable rock (no-op).
      const { jA, jB } = splitClosingImpulse(mA, mB, mu, sA, sB, dvClose, TUN.crush.transferFrac);
      this.pushAtComHeight(a, bcx, bcz, this.comA.y, -dhx, -dhz, jA); // slow A's approach (+d̂)
      this.pushAtComHeight(b, bcx, bcz, this.comB.y, dhx, dhz, jB);   // drag/transfer onto B (−d̂; no-op for terrain)
      force = (jA + jB) / dt;

      const removed = removedA + removedB;
      if (this.effects && TUN.crush.fling > 0 && removed > 0) {
        this.pt2.set(bcx, bcy, bcz);
        this.imp.set(dhx, 0, dhz);
        this.effects.impactDebris(this.pt2, this.imp, Math.min(removed * TUN.crush.fling, 40));
      }
    } else if (depth >= TUN.crush.minDepth) {
      // ---- REST regime: too slow to break → DELETE the closing velocity + push the hulls apart so no
      // two voxels share space. This is the "the final voxel that won't break stops the ram dead" the
      // player asked for: once breaking has bled the approach below vBreak, the solid layer it can't
      // pay to break cancels the rest of the closing and expels the lodged hull.
      //
      // Direction is the HORIZONTAL line between the two COMs — NOT the geometric push-out axis, which
      // FLIPS when one hull engulfs another (a deep-lodged ram would then be shoved further IN, the
      // bug behind "the nose rotates straight through the voxels"). The COM line never flips and points
      // sensibly along the ram for any lodge. HORIZONTAL only so buoyancy keeps owning the vertical (a
      // downward shove used to ram a holed victim past the −12 m "sunk" line → premature respawn).
      // Against terrain (huge mB) the inverse-mass split puts ~all the de-penetration on the ship.
      let nx = this.comB.x - this.comA.x, nz = this.comB.z - this.comA.z;
      const hlen = Math.hypot(nx, nz);
      if (hlen > 1e-4) {
        nx /= hlen; nz /= hlen;
        this.velAt(this.comA, lvA, avA, cx, cy, cz, this.vA);
        this.velAt(this.comB, lvB, avB, cx, cy, cz, this.vB);
        vClose = (this.vA.x - this.vB.x) * nx + (this.vA.z - this.vB.z) * nz;
        if (vClose > 0) {
          // full inelastic cancel of the (sub-vBreak) closing — they stop moving INTO each other.
          const jv = mu * Math.min(vClose, TUN.crush.biteDvCap);
          this.pushAtComHeight(a, cx, cz, this.comA.y, -nx, -nz, jv);
          this.pushAtComHeight(b, cx, cz, this.comB.y, nx, nz, jv);
          force = jv / dt;
        }
        // POSITION de-penetration, inverse-mass split. Strong enough to actually EXPEL a lodged hull
        // (depen + maxDepenSpeed raised) — the overlap only ever decreases because the closing above is
        // zeroed first, so it can't re-penetrate: the two hulls converge to "pressed together, not
        // sharing space" within a few steps instead of the ram coasting through forever. Position-only
        // (no velocity added) so a hard separation still can't "jar" / fling them.
        const corr = Math.min(depth * TUN.crush.depen, TUN.crush.maxDepenSpeed * dt);
        const moveA = corr * (mB / (mA + mB)), moveB = corr * (mA / (mA + mB)); // terrain's huge mB → moveA≈corr, moveB≈0
        const ta = a.translation();
        a.setTranslation({ x: ta.x - nx * moveA, y: ta.y, z: ta.z - nz * moveA });
        const tb = b.translation();
        b.setTranslation({ x: tb.x + nx * moveB, y: tb.y, z: tb.z + nz * moveB }); // no-op for terrain
      }
    }

    return { overlapCount: count, depth, force, energy, removedA, removedB, vClose };
  }

  // carveWithinBudget writes its two removal counts here (avoids allocating a result object).
  private lastRemovedA = 0;
  private lastRemovedB = 0;

  /** Spend the energy budget cheapest-first across both sides' broken candidates, carving only the
   *  sides that CAN break (terrain's canCarve === false → all the energy erodes the ship). Returns
   *  the energy actually spent; writes the two removal counts into lastRemovedA/lastRemovedB. */
  private carveWithinBudget(
    a: ContactTarget, b: ContactTarget,
    brokenA: [number, number, number][], brokenB: [number, number, number][],
    tough: number, budget: number,
  ): number {
    const cand: { isA: boolean; c: [number, number, number]; e: number }[] = [];
    if (a.canCarve) for (const c of brokenA) cand.push({ isA: true, c, e: a.cellBreakEnergy(c[0], c[1], c[2]) * tough });
    if (b.canCarve) for (const c of brokenB) cand.push({ isA: false, c, e: b.cellBreakEnergy(c[0], c[1], c[2]) * tough });
    cand.sort((x, y) => x.e - y.e);
    let bud = budget, spent = 0;
    const remA: [number, number, number][] = [], remB: [number, number, number][] = [];
    for (const k of cand) { if (k.e > bud) break; bud -= k.e; spent += k.e; (k.isA ? remA : remB).push(k.c); }
    this.lastRemovedA = remA.length ? a.carveCells(remA) : 0;
    this.lastRemovedB = remB.length ? b.carveCells(remB) : 0;
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
  private pushAtComHeight(target: ContactTarget, px: number, pz: number, comY: number, dx: number, dz: number, jMag: number): void {
    if (jMag === 0) return;
    this.imp.set(dx * jMag, 0, dz * jMag);
    this.pt2.set(px, comY, pz);
    target.applyImpulseAtPoint(this.imp, this.pt2);
  }
}

function aabbIntersect(a: { min: THREE.Vector3; max: THREE.Vector3 }, b: { min: THREE.Vector3; max: THREE.Vector3 }): boolean {
  return a.max.x >= b.min.x && a.min.x <= b.max.x &&
    a.max.y >= b.min.y && a.min.y <= b.max.y &&
    a.max.z >= b.min.z && a.min.z <= b.max.z;
}

