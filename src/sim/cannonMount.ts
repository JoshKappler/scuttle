import type { VoxelGrid } from "./voxelGrid";

/** A cannon port's mounting cells: the integer voxel coords of its own bed cell
 *  plus the deck/carriage planking it stands on. Pure (a grid lookup is the
 *  caller's job) so it can be unit-tested without a Ship/Rapier. */
export interface CannonPortLike {
  x: number;
  y: number;
  z: number;
  side: 1 | -1;
  facing?: "fore" | "aft";
}

/**
 * The voxel cells a cannon is BOLTED to — the "mount". A broadside gun's truck
 * stands on the deck planking at its port station (the bed cell + the deck cell
 * under it, spread a little fore/aft and inboard so a single lost plank doesn't
 * drop the gun). A bow/stern chaser sits on the heavy bow/stern timber, so we
 * sample inboard along ±x instead of across the beam.
 *
 * Returns integer [x,y,z] anchor cells; the caller tests `grid.isSolid` on each
 * (see {@link mountSolidCount}). Cells outside the grid are simply never solid,
 * so they're harmless to include.
 */
export function cannonMountCells(port: CannonPortLike): [number, number, number][] {
  const cells: [number, number, number][] = [];
  const push = (x: number, y: number, z: number) => cells.push([x, y, z]);
  if (port.facing) {
    // A bow/stern CHASER sits low in the wedge: its carriage hangs off the surrounding heavy
    // timber + the deck above it (the notional port cell itself is hollow). Sample the wedge
    // cross-section at its station — INBOARD along ±x, ACROSS the beam (±z), and UP toward the
    // deck — so the anchor is the structure it's actually bolted into. Carving that local timber
    // away drops it. (A slightly generous box is fine: the threshold is a FRACTION of this same
    // count, so a hole through the chaser's quarter of the wedge still trips it.)
    const inboard = port.facing === "fore" ? -1 : 1; // fore chaser seats toward the stern (−x)
    for (let dx = 0; dx <= 3; dx++) {
      for (let dy = 0; dy <= 6; dy++) {
        for (let dz = -3; dz <= 3; dz++) {
          push(port.x + dx * inboard, port.y + dy, port.z + dz);
        }
      }
    }
  } else {
    // A broadside gun stands on the deck at its station: the bed cell + the deck plank directly
    // beneath it (two y-layers), spread a little fore/aft and inboard so a single lost plank
    // doesn't drop the gun. Inboard is −side in z (the truck sits in from the bulwark port).
    const inboard = -port.side;
    for (let dy = 0; dy >= -1; dy--) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = 0; dz <= 1; dz++) {
          push(port.x + dx, port.y + dy, port.z + dz * inboard);
        }
      }
    }
  }
  return cells;
}

/** How many of a cannon port's mount cells are still solid in the grid. */
export function mountSolidCount(grid: VoxelGrid, port: CannonPortLike): number {
  let n = 0;
  for (const [x, y, z] of cannonMountCells(port)) {
    if (grid.isSolid(x, y, z)) n++;
  }
  return n;
}

/**
 * Has a cannon lost its mount? True once fewer than `frac` of its initial mount
 * cells survive — the carriage has nothing left to bolt to and tips off the side.
 * `init` is the count sampled on the intact hull at build time.
 */
export function mountLost(grid: VoxelGrid, port: CannonPortLike, init: number, frac: number): boolean {
  if (init <= 0) return false; // never had a real mount (degenerate) → don't churn
  return mountSolidCount(grid, port) < init * frac;
}
