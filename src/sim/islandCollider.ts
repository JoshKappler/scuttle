import type { VoxelGrid } from "./voxelGrid";

/**
 * The SURFACE voxels of an island within a Y-band around its waterline — the only cells a
 * ship hull can ever physically reach. Returned flat as [x,y,z, x,y,z, …] for
 * `RAPIER.ColliderDesc.voxels`.
 *
 * Why a subset: rapier-compat generates NO contacts between a Voxels shape (the ship hull)
 * and a Trimesh (the island's render/character collider), so hulls phase straight through
 * islands. The fix is to give each island a second, voxel-shaped collider — but a solid
 * harbor island is ~500 k cells, far too many. A ship only ever touches the coast near the
 * waterline, so we keep ONLY:
 *   - cells with `waterlineY - below ≤ y ≤ waterlineY + above` (a hull's vertical reach), and
 *   - cells with at least one empty face (the outer shell; fully-enclosed interior cells can
 *     never be contacted).
 * That trims a 0.5 M-cell harbor island to ~150 k — built once at startup. Pure: grid in,
 * coords out, no engine deps, so it unit-tests directly.
 */
export function surfaceBandVoxels(
  grid: VoxelGrid,
  waterlineY: number,
  below: number,
  above: number,
): Int32Array {
  const out: number[] = [];
  const loY = waterlineY - below;
  const hiY = waterlineY + above;
  grid.forEachSolid((x, y, z) => {
    if (y < loY || y > hiY) return;
    // surface = at least one empty neighbour face (isSolid is false out of bounds, so the
    // grid-edge columns correctly count as surface).
    if (
      !grid.isSolid(x + 1, y, z) ||
      !grid.isSolid(x - 1, y, z) ||
      !grid.isSolid(x, y + 1, z) ||
      !grid.isSolid(x, y - 1, z) ||
      !grid.isSolid(x, y, z + 1) ||
      !grid.isSolid(x, y, z - 1)
    ) {
      out.push(x, y, z);
    }
  });
  return new Int32Array(out);
}
