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
