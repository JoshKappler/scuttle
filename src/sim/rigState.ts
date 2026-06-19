import type { VoxelGrid } from "./voxelGrid";

/** Fraction (0..1) of `cells` whose grid material still equals `mat` (1.0 for an empty list). */
export function survivingFraction(
  grid: VoxelGrid,
  cells: { x: number; y: number; z: number }[],
  mat: number,
): number {
  if (cells.length === 0) return 1;
  let alive = 0;
  for (const c of cells) if (grid.get(c.x, c.y, c.z) === mat) alive++;
  return alive / cells.length;
}

/** Thrust integrity from the surviving-canvas fraction. CONVEX (1 − 3·destroyed²) so a couple of
 *  holes barely scratch top speed (frac 0.9 → ~0.97) but a peppered sail collapses (frac 0.5 →
 *  ~0.25). Clamped 0..1; the caller forces 0 when the mast itself is down. */
export function sailIntegrityValue(survivingCanvasFrac: number): number {
  const destroyed = 1 - survivingCanvasFrac;
  return Math.min(Math.max(1 - destroyed * destroyed * 3, 0), 1);
}
