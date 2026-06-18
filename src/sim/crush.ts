// Pure, engine-free. The universal energy->voxels primitive: spend an energy budget
// removing supplied candidate cells, cheapest (toughest-to-break LAST) first, until the
// next cell is unaffordable. Ramming feeds it the overlap cells; cannon fire the bore-ray
// cells; both pay the same per-voxel material toughness. Returns removed prefix + leftover.
//
// This is planCarve's sibling: instead of flood-filling from a guessed seed, the candidate
// cells are SUPPLIED by the caller (the real overlap, or the real bore ray). That single
// change is what kills the wrong-location "hole on the far side" bug — we only ever remove
// cells the caller actually selected.
export interface CrushResult<C> {
  removed: C[];
  leftover: number;
}

export function planCrush<C>(
  cells: C[],
  toughnessAt: (c: C) => number, // joules to break this cell
  energy: number,
): CrushResult<C> {
  // cheapest-first so a fixed budget bites as many cells as it can afford; a tough belt
  // (iron) it cannot pay for halts the spend, leaving the cells behind it intact.
  const order = [...cells].sort((a, b) => toughnessAt(a) - toughnessAt(b));
  const removed: C[] = [];
  let budget = energy;
  for (const c of order) {
    const cost = toughnessAt(c);
    if (cost > budget) break;
    budget -= cost;
    removed.push(c);
  }
  return { removed, leftover: budget };
}

// The momentum side of the same collision: destruction and deceleration are ONE event. When a
// pair breaks `energy` joules of wood this step, that energy comes out of their closing motion —
// the contact is an inelastic micro-collision whose energy loss IS the fracture work. Returns the
// reduced-mass momentum (μ·Δv_closing) that the fracture removes from the approach; the caller turns
// it into a closing-speed reduction Δv = J/μ and hands that to distributeClosingDrag (below) to slow
// whichever hull is driving in — NOT an equal-and-opposite kick, which used to shove a stationary
// victim up to ramming speed. A fast heavy ram sheds only a little per layer and plows on.
//
//   vc'  = sqrt(max(vc² − 2·energy/μ, 0))      // closing speed after losing `energy` joules
//   J    = μ·min(vc − vc', dvCap)              // ½μ(vc²−vc'²) == energy when uncapped
//
// Self-limiting: it can never remove more than the closing KE (vc' ≥ 0), so it can't reverse the
// approach or fling. `dvCap` caps the per-step closing-Δv for stability (and clamps a pathological
// deep overlap that broke a huge slab in one step).
export function breakImpulse(reducedMass: number, vc: number, energy: number, dvCap: number): number {
  if (vc <= 0 || reducedMass <= 0) return 0;
  // Defensive clamp (deterministic, constant): real closing speeds are <~10 m/s; 50 is a generous
  // ceiling that only catches a teleport-deep degenerate overlap whose vc² would otherwise blow the
  // impulse up. Cannot affect a healthy frame. Mirrors the same clamp in game/voxelContact.ts.
  vc = Math.min(vc, 50);
  const after = Math.sqrt(Math.max(vc * vc - (2 * Math.max(energy, 0)) / reducedMass, 0));
  const dv = Math.min(vc - after, dvCap);
  return reducedMass * dv;
}

// Where the fracture's closing-speed reduction goes. The broken material crumbles and carries its
// momentum off as debris (we don't simulate the chips), so a crushing layer transmits ~no force to
// the solid body behind it: the energy slows the hull(s) DRIVING into the contact and does NOT push
// the one being hit. This is the fix for "the ship being hit just picks up all the velocity from the
// ship doing the hitting" — with an equal-and-opposite bite, a heavy ram drove a light victim up to
// its own speed, the closing differential vanished, breaking stopped, and the ram then coasted on
// through, lodged. Slowing only the aggressor keeps the differential alive, so it keeps chewing
// until IT stops — energy goes to destruction, not to launching the victim.
//
// sA, sB are each hull's velocity component along the closing axis d̂ (d̂ points from A into B). A
// "approaches" when it moves toward B (sA > 0); B approaches when it moves toward A (sB < 0). The
// closing reduction dvClose is split by how hard each is driving in, so a hull that isn't pushing in
// (a stationary victim) sheds nothing. dvA reduces A's +d̂ speed; dvB reduces B's −d̂ speed; the
// caller applies impulses mA·dvA (along −d̂ on A) and mB·dvB (along +d̂ on B) — sized to each hull's
// OWN mass, so they are deliberately NOT equal-and-opposite (the debris took the difference).
export function distributeClosingDrag(sA: number, sB: number, dvClose: number): { dvA: number; dvB: number } {
  if (dvClose <= 0) return { dvA: 0, dvB: 0 };
  const towardA = Math.max(sA, 0);  // A moving in +d̂ → toward B
  const towardB = Math.max(-sB, 0); // B moving in −d̂ → toward A
  const tot = towardA + towardB;
  if (tot <= 1e-9) return { dvA: 0, dvB: 0 }; // neither is driving in (degenerate) — nothing to slow
  return { dvA: dvClose * (towardA / tot), dvB: dvClose * (towardB / tot) };
}

// The break bite, as the two impulse MAGNITUDES to apply along the closing axis (jA along −d̂ on A,
// jB along +d̂ on B). It BLENDS two models by `transferFrac` so the feel is tunable:
//   • the momentum-CONSERVING part (fraction tf) is an equal-and-opposite kick μ·tf·dvClose — it
//     drives both hulls toward their common velocity, i.e. the struck hull picks up speed ("velocity
//     transfers"). This is real collision momentum; too much of it is the round-2 "the victim steals
//     all my speed" bug, so it's a dial, not the whole story.
//   • the DRAG part (fraction 1−tf) slows only the aggressor (distributeClosingDrag) — the crumbling
//     debris carries that momentum off, so a stationary victim is left untouched.
// tf=0 → pure drag (round-3 default behaviour, no steal); tf=1 → pure equal-and-opposite (old steal).
// dvClose is the closing-speed reduction the fracture removes (breakImpulse/μ); mu the reduced mass.
export function splitClosingImpulse(
  mA: number, mB: number, mu: number,
  sA: number, sB: number, dvClose: number, transferFrac: number,
): { jA: number; jB: number } {
  if (dvClose <= 0) return { jA: 0, jB: 0 };
  const tf = Math.min(Math.max(transferFrac, 0), 1);
  const jMC = mu * tf * dvClose;                                          // equal-and-opposite share
  const { dvA, dvB } = distributeClosingDrag(sA, sB, (1 - tf) * dvClose); // aggressor-drag share
  return { jA: jMC + mA * dvA, jB: jMC + mB * dvB };
}
