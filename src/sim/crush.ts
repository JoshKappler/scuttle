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
// impulse magnitude to apply equal-and-opposite along the closing direction; the caller splits it
// by mass (heavier hull → smaller Δv = J/m → "hard to shove"), so a fast heavy ram sheds only a
// little per layer and plows on, while a light hull stops after a few layers.
//
//   vc'  = sqrt(max(vc² − 2·energy/μ, 0))      // closing speed after losing `energy` joules
//   J    = μ·min(vc − vc', dvCap)              // impulse; ½μ(vc²−vc'²) == energy when uncapped
//
// Self-limiting: it can never remove more than the closing KE (vc' ≥ 0), so it can't reverse the
// approach or fling. `dvCap` caps the per-step closing-Δv for stability (and clamps a pathological
// deep overlap that broke a huge slab in one step).
export function breakImpulse(reducedMass: number, vc: number, energy: number, dvCap: number): number {
  if (vc <= 0 || reducedMass <= 0) return 0;
  const after = Math.sqrt(Math.max(vc * vc - (2 * Math.max(energy, 0)) / reducedMass, 0));
  const dv = Math.min(vc - after, dvCap);
  return reducedMass * dv;
}
