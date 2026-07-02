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
  /** Per-hull break-cost multiplier (≥1) — the "Hull Reinforcement" upgrade. Terrain reports 1
   *  (unused: it never carves). Multiplies the global crush.toughness when pricing a broken cell. */
  readonly hullToughness: number;
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
  private scratch: ContactScratch = { aCells: new Int32Array(0), bCells: new Int32Array(0), points: new Float32Array(0), normals: new Float32Array(0) };
  // BREAK-regime scratch: the cells broken this step per hull, reused (cleared each pair) backed by
  // a tuple pool, so a sustained ram allocates nothing classifying or carving contacts.
  private brokenA: [number, number, number][] = [];
  private brokenB: [number, number, number][] = [];
  private poolA: [number, number, number][] = [];
  private poolB: [number, number, number][] = [];
  // Parallel WORLD contact points for each broken cell (same index as brokenA/brokenB), so an
  // energy-limited partial carve can order candidates by distance from the impact and bore a COMPACT
  // cavity instead of pulling soft cells from across the overlap (the "checkerboard" bug). Reused +
  // pooled, so a sustained ram still allocates nothing.
  private ptsA: number[] = [];
  private ptsB: number[] = [];
  // PERF — reused scratch for carveWithinBudget's energy-limited partial bite, so a sustained ram
  // allocates NOTHING there (the old path built a fresh `{isA,c,e,d2}[]` + per-cell objects + .sort()
  // every step → GC churn). Parallel arrays over the merged A∪B candidate set, sorted via an index
  // permutation (candOrder) rather than reordering the data. candCell holds the same POOLED tuples
  // already collected in brokenA/brokenB, so no new tuples are made. remA/remB collect the affordable
  // prefix for carveCells; they hold pooled tuples too (refs into brokenA/brokenB), never fresh.
  private candIsA: boolean[] = [];
  private candCell: [number, number, number][] = [];
  private candE: number[] = [];
  private candD2: number[] = [];
  private candOrder: number[] = [];
  private remA: [number, number, number][] = [];
  private remB: [number, number, number][] = [];

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
    this.scratch = { aCells: new Int32Array(n), bCells: new Int32Array(n), points: new Float32Array(n), normals: new Float32Array(n) };
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

    // Aggregate HORIZONTAL relative direction d̂ at the contact centroid — now only (a) a cheap
    // "is anything moving" gate and (b) the FALLBACK closing axis for contacts whose local surface
    // normal is degenerate (contacted B cell fully interior — a deep engulf — or a purely vertical
    // face). Classification itself is PER CONTACT along each contact's local normal (below): a
    // T-bone/angled ram reads its true perpendicular closing speed and a parallel scrape reads ~0
    // instead of the full slide speed (the old single-d̂ rule misread both). Horizontal-only so
    // wave heave never reads as closing, and so the bite (applied at COM height) yaws, never rolls.
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

    // ---- classify each contact: BREAK (LOCAL closing > vBreak) vs REST ----
    // Each contact's closing speed is measured along its OWN horizontal contact normal ĝ — the
    // occupancy-gradient normal of B at the contacted cell (from detectContacts), negated to point
    // INTO B, horizontal-projected and re-normalized. Round-12 fix: the old rule projected every
    // contact onto ONE aggregate direction d̂ (the relative-velocity direction itself), which (a)
    // read a parallel side-scrape's slide speed as "closing" → grinding hulls tore each other's
    // sides off, and (b) mixed a T-bone victim's forward motion into the closing axis → the bite
    // braked motion TANGENT to the impact. A degenerate local normal (interior cell in a deep
    // engulf, or a purely vertical face) falls back to d̂ — the old behavior, which is what the
    // deep-lodge COM-line logic was designed around. brokenA/brokenB are reused member scratch
    // (cleared here), backed by a tuple pool, so classification allocates nothing in a sustained ram.
    let bSumX = 0, bSumY = 0, bSumZ = 0;
    let sumV2 = 0;            // Σ vci² over breaking contacts → per-contact energy budget (½·μ·mean v²)
    let gSumX = 0, gSumZ = 0; // Σ ĝ·vci → closing-weighted mean break direction ḡ
    const brokenA = this.brokenA, brokenB = this.brokenB;
    const ptsA = this.ptsA, ptsB = this.ptsB;
    const nrm = sc.normals!;
    brokenA.length = 0;
    brokenB.length = 0;
    ptsA.length = 0;
    ptsB.length = 0;
    if (moving) {
      for (let i = 0; i < count; i++) {
        const o = i * 3;
        const px = sc.points[o], py = sc.points[o + 1], pz = sc.points[o + 2];
        // local horizontal closing axis ĝ, pointing INTO B (= −outward normal of B at the contact).
        let gx = -nrm[o], gz = -nrm[o + 2];
        const glen = Math.hypot(gx, gz);
        if (glen > 1e-4) { gx /= glen; gz /= glen; }
        else { gx = dhx; gz = dhz; } // degenerate local normal → aggregate fallback (old behavior)
        this.velAt(this.comA, lvA, avA, px, py, pz, this.vA);
        this.velAt(this.comB, lvB, avB, px, py, pz, this.vB);
        const vci = (this.vA.x - this.vB.x) * gx + (this.vA.z - this.vB.z) * gz; // horizontal LOCAL closing
        if (vci <= TUN.crush.vBreak) continue;
        // DEFENSIVE clamp, mirrored from sim/crush.breakImpulse: real closing speeds are <~10 m/s;
        // 50 only catches a teleport-deep degenerate overlap blowing up the energy budget.
        const vc = Math.min(vci, 50);
        // pooled push (no per-contact allocation in a sustained ram). Only flag B's cell when B can
        // actually be carved — terrain (canCarve === false) is never eroded, so its broken layer is
        // never collected and ALL the budget falls on the ship. The A and B cells of one contact share
        // the same world contact point (the A-cell centre), so both get `px,py,pz` for the distance sort.
        this.pushBroken(brokenA, this.poolA, sc.aCells[o], sc.aCells[o + 1], sc.aCells[o + 2]);
        ptsA.push(px, py, pz);
        if (b.canCarve) { this.pushBroken(brokenB, this.poolB, sc.bCells[o], sc.bCells[o + 1], sc.bCells[o + 2]); ptsB.push(px, py, pz); }
        bSumX += px; bSumY += py; bSumZ += pz;
        sumV2 += vc * vc;
        gSumX += gx * vc; gSumZ += gz * vc;
      }
    }
    const breakCount = brokenA.length;

    let removedA = 0, removedB = 0, energy = 0, force = 0, vClose = 0;

    if (breakCount > 0) {
      // ---- BREAK regime: destruction is BOUNDED by the collision energy ----
      // The budget is allocated PER CONTACT: each breaking contact contributes ½·(μ/N)·vci² — its
      // own closing KE at an equal reduced-mass share — so the total is ½·μ·mean(vci²) = ½·μ·vEff².
      // For a uniform head-on this is EXACTLY the old ½·μ·vClose² (every vci equal); for an angled
      // hit only the genuinely-closing share of the motion pays for carving — the tangential slide
      // is never spent as break energy, and since vci ≤ |vrel| per contact the total can never
      // exceed the pair's real closing KE (no energy injection). Carve nearest-the-impact first up
      // to that budget: a ram bites a hole and LODGES once the energy is spent instead of carving
      // the whole overlap. Against terrain B can't carve, so ALL the budget erodes the ship.
      // maxStepEnergy is only an anti-vaporize clamp for a pathological (teleport) deep overlap.
      const bcx = bSumX / breakCount, bcy = bSumY / breakCount, bcz = bSumZ / breakCount;
      // closing-weighted mean break direction ḡ (unit, horizontal). Head-on: every ĝ ≡ d̂ → ḡ = d̂
      // exactly. Degenerate (a symmetric pincer summing to ~0) → d̂ fallback.
      let gbx = gSumX, gbz = gSumZ;
      const gblen = Math.hypot(gbx, gbz);
      if (gblen > 1e-6) { gbx /= gblen; gbz /= gblen; } else { gbx = dhx; gbz = dhz; }
      this.velAt(this.comA, lvA, avA, bcx, bcy, bcz, this.vA);
      this.velAt(this.comB, lvB, avB, bcx, bcy, bcz, this.vB);
      const sA = this.vA.x * gbx + this.vA.z * gbz; // A's speed along ḡ (who is driving in?)
      const sB = this.vB.x * gbx + this.vB.z * gbz; // B's speed along ḡ (0 for static terrain)
      vClose = Math.min(Math.sqrt(sumV2 / breakCount), 50); // RMS per-contact closing (≡ old head-on vClose)
      const budget = Math.min(0.5 * mu * vClose * vClose, TUN.crush.maxStepEnergy);
      energy = this.carveWithinBudget(a, b, brokenA, brokenB, this.ptsA, this.ptsB, bcx, bcy, bcz, tough, budget);
      removedA = this.lastRemovedA; removedB = this.lastRemovedB;
      // The fracture energy is shed as a DRAG on the hull(s) driving INTO the contact — the crumbling
      // layer carries its momentum off as debris and pushes the body behind it ~nothing, so a heavy
      // ram spends its OWN speed boring through and a dead-in-the-water victim is NOT accelerated up
      // to ramming speed (see crush.splitClosingImpulse; transferFrac dials the shove back in).
      const dvClose = breakImpulse(mu, vClose, energy, TUN.crush.biteDvCap) / mu; // closing-speed to remove
      let { jA, jB } = splitClosingImpulse(mA, mB, mu, sA, sB, dvClose, TUN.crush.transferFrac);
      // DEFENSIVE finite guard: a NaN/Inf impulse (e.g. from a degenerate mass/velocity) must never
      // reach applyImpulseAtPoint and launch a hull. Real impulses are finite; this only catches corruption.
      if (!Number.isFinite(jA)) jA = 0;
      if (!Number.isFinite(jB)) jB = 0;
      this.pushAtComHeight(a, bcx, bcz, this.comA.y, -gbx, -gbz, jA); // slow A's approach (+ḡ)
      this.pushAtComHeight(b, bcx, bcz, this.comB.y, gbx, gbz, jB);   // drag/transfer onto B (−ḡ; no-op for terrain)
      force = (jA + jB) / dt;

      const removed = removedA + removedB;
      if (this.effects && removed > 0) {
        this.effects.crunch(this.pt2.set(bcx, bcy, bcz), removed);
      }
      if (this.effects && TUN.crush.fling > 0 && removed > 0) {
        this.pt2.set(bcx, bcy, bcz);
        this.imp.set(gbx, 0, gbz);
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
      const invA = mB / (mA + mB), invB = mA / (mA + mB); // inverse-mass split (terrain huge mB → invA≈1, invB≈0)
      const cap = TUN.crush.maxDepenSpeed * dt;            // per-step positional ceiling (HORIZONTAL)
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
        const corr = Math.min(depth * TUN.crush.depen, cap);
        const moveA = corr * invA, moveB = corr * invB; // terrain's huge mB → moveA≈corr, moveB≈0
        const ta = a.translation();
        a.setTranslation({ x: ta.x - nx * moveA, y: ta.y, z: ta.z - nz * moveA });
        const tb = b.translation();
        b.setTranslation({ x: tb.x + nx * moveB, y: tb.y, z: tb.z + nz * moveB }); // no-op for terrain
      }

      // OFF-AXIS push-out (the side-scrape / parallel-rub blind spot). The COM→COM cancel + de-pen above
      // only resolves motion projected on the COM line; a GLANCING scrape carries most of its velocity
      // PERPENDICULAR to that line (two hulls grinding side-by-side, COMs roughly abeam), so neither the
      // cancel nor the COM-line push-out fires meaningfully and the weak separation lets her slide
      // straight through the side. detectContacts already hands us the contact's thin SEPARATING axis
      // (ov.axis, signed A→B), which IS the genuine push-out for a side-on overlap. Resolve along its
      // HORIZONTAL projection too — but ONLY when the COM line is degenerate for this contact (its
      // horizontal share of ov.axis is small), so for a normal bow-on ram (axis ≈ COM line) this is a
      // no-op and the engulf-flip hazard the COM-line rule guards against can't bite (we gate on |axis·n|
      // being LOW, i.e. exactly when the two directions disagree — the scrape — not when they agree).
      // Position-only, same maxDepenSpeed cap, closing already zeroed above → can only shrink the overlap
      // (never re-penetrate or fling). HORIZONTAL only, so buoyancy keeps owning the vertical.
      let axx = ov.axis[0], axz = ov.axis[2];
      const axLen = Math.hypot(axx, axz);
      if (axLen > 1e-4) {
        axx /= axLen; axz /= axLen;
        // alignment of the (horizontal) separating axis with the COM line; near 1 = bow-on (skip), near
        // 0 = side-scrape (the COM line did ~nothing along the real push-out → resolve along the axis).
        const align = hlen > 1e-4 ? Math.abs(axx * nx + axz * nz) : 0;
        if (align < 0.5) {
          // de-weight by how degenerate the COM line was (full off-axis correction at align 0, fading to
          // none by align 0.5 where the COM-line push-out already covers it) → no double-counting.
          const w = 1 - align / 0.5;
          const corr = Math.min(depth * TUN.crush.depen, cap) * w;
          if (corr > 0) {
            const moveA = corr * invA, moveB = corr * invB;
            const ta = a.translation();
            a.setTranslation({ x: ta.x - axx * moveA, y: ta.y, z: ta.z - axz * moveA });
            const tb = b.translation();
            b.setTranslation({ x: tb.x + axx * moveB, y: tb.y, z: tb.z + axz * moveB }); // no-op for terrain
          }
        }
      }
    }

    return { overlapCount: count, depth, force, energy, removedA, removedB, vClose };
  }

  // carveWithinBudget writes its two removal counts here (avoids allocating a result object).
  private lastRemovedA = 0;
  private lastRemovedB = 0;

  /** Store cell (x,y,z) into `list` at its next slot, reusing a pooled tuple so the BREAK regime
   *  never allocates a fresh array per broken contact. */
  private pushBroken(list: [number, number, number][], pool: [number, number, number][], x: number, y: number, z: number): void {
    const i = list.length;
    let t = pool[i];
    if (t) { t[0] = x; t[1] = y; t[2] = z; }
    else { t = [x, y, z]; pool[i] = t; }
    list.push(t);
  }

  /** Carve the broken cells against the closing-energy budget; returns the energy actually spent.
   *  Carves only the sides that CAN break (terrain's canCarve === false → all the energy erodes the
   *  ship and the immovable, indestructible wall takes none). Each hull's cells also pay its own
   *  hullToughness (the "Hull Reinforcement" upgrade, ≥1). When the budget covers every broken cell
   *  (a high-energy hit), carve them all directly — no per-candidate object and no sort, order is moot
   *  when all are affordable. Only when the energy can't pay for the whole flagged layer (the
   *  energy-limited bite-and-lodge, or the maxStepEnergy anti-vaporize clamp) does it order candidates
   *  and spend a prefix.
   *
   *  ORDERING (the "no checkerboard" fix): the partial bite is taken NEAREST-the-impact first — each
   *  candidate is keyed by the squared distance of its world contact point to the break centroid
   *  (cx,cy,cz), so a limited budget removes a COMPACT cavity growing outward from the contact, not a
   *  cheapest-first scatter. The old rule sorted purely by break energy; with the bow's RAM armor laid
   *  over OAK that pulled the soft oak from BEHIND the armor across the whole overlap (the player's
   *  "front of my ship is a checkerboard of voxels"). Break energy is only the tiebreaker now (within
   *  the same shell of distance the softer cell still goes first), so emergent penetration is kept: a
   *  tough belt the budget can't reach still survives, but the hole is always one connected bore.
   *  pointsA/pointsB are the world contact points parallel to brokenA/brokenB (flat [x,y,z,...]).
   *  Writes the removal counts into lastRemovedA/lastRemovedB. */
  private carveWithinBudget(
    a: ContactTarget, b: ContactTarget,
    brokenA: [number, number, number][], brokenB: [number, number, number][],
    pointsA: number[], pointsB: number[],
    cx: number, cy: number, cz: number,
    tough: number, budget: number,
  ): number {
    // each hull's cells also pay its own hullToughness (the "Hull Reinforcement" upgrade, ≥1),
    // so a reinforced hull loses fewer voxels in a ram while still grinding the other ship. A side
    // that CAN'T carve (terrain, canCarve === false) is skipped entirely — its broken layer is never
    // collected, so all the energy erodes the ship.
    const canA = a.canCarve, canB = b.canCarve;
    const toughA = tough * a.hullToughness;
    const toughB = tough * b.hullToughness;
    let total = 0;
    if (canA) for (const c of brokenA) total += a.cellBreakEnergy(c[0], c[1], c[2]) * toughA;
    if (canB) for (const c of brokenB) total += b.cellBreakEnergy(c[0], c[1], c[2]) * toughB;
    if (total <= budget) {
      // everything is affordable → carve the whole broken layer, no sort/allocation
      this.lastRemovedA = canA && brokenA.length ? a.carveCells(brokenA) : 0;
      this.lastRemovedB = canB && brokenB.length ? b.carveCells(brokenB) : 0;
      return total;
    }
    // energy-limited: can't break the whole flagged layer this step — order NEAREST-the-impact first
    // (squared distance to the break centroid) so the bite is a compact bore, energy as the tiebreaker.
    // PERF: fill REUSED parallel scratch arrays (candIsA/candCell/candE/candD2) over the merged A∪B
    // candidate set instead of allocating a fresh object array + per-cell objects each step, then sort
    // an INDEX permutation (candOrder) — the data never moves, only the indices. candCell reuses the
    // already-pooled brokenA/brokenB tuples (no new tuples). The fill order is A-cells then B-cells,
    // identical to the old object-array insertion order, so the stable index sort below produces the
    // SAME order on ties as V8's stable Array.sort did on the object array.
    const candIsA = this.candIsA, candCell = this.candCell, candE = this.candE, candD2 = this.candD2;
    let nc = 0;
    if (canA) for (let i = 0; i < brokenA.length; i++) {
      const c = brokenA[i], o = i * 3;
      const ddx = pointsA[o] - cx, ddy = pointsA[o + 1] - cy, ddz = pointsA[o + 2] - cz;
      candIsA[nc] = true; candCell[nc] = c;
      candE[nc] = a.cellBreakEnergy(c[0], c[1], c[2]) * toughA;
      candD2[nc] = ddx * ddx + ddy * ddy + ddz * ddz; nc++;
    }
    if (canB) for (let i = 0; i < brokenB.length; i++) {
      const c = brokenB[i], o = i * 3;
      const ddx = pointsB[o] - cx, ddy = pointsB[o + 1] - cy, ddz = pointsB[o + 2] - cz;
      candIsA[nc] = false; candCell[nc] = c;
      candE[nc] = b.cellBreakEnergy(c[0], c[1], c[2]) * toughB;
      candD2[nc] = ddx * ddx + ddy * ddy + ddz * ddz; nc++;
    }
    // index permutation, sorted nearest-the-impact first (cheaper breaks the d2 tie, original index
    // breaks an exact d2+e tie → stable, matching the old object-array Array.sort under V8 TimSort).
    const order = this.candOrder;
    for (let i = 0; i < nc; i++) order[i] = i;
    order.length = nc;
    order.sort((x, y) => candD2[x] - candD2[y] || candE[x] - candE[y] || x - y);
    let bud = budget, spent = 0;
    const remA = this.remA, remB = this.remB;
    remA.length = 0; remB.length = 0;
    // STOP at the first cell the budget can't afford (in nearest-first order): the bite LODGES at that
    // depth — a compact bore that reaches exactly as far from the impact as the energy can pay for, and
    // a tough belt it can't reach survives (emergent penetration, THE LAW #4). Because the order is by
    // distance, stopping leaves a connected cavity, never a scatter.
    for (let i = 0; i < nc; i++) {
      const k = order[i], e = candE[k];
      if (e > bud) break;
      bud -= e; spent += e;
      (candIsA[k] ? remA : remB).push(candCell[k]);
    }
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

