// Pure, engine-free surface-voxel tracking. A cell is "surface" if it is solid AND at least
// one of its 6 face-neighbours is empty or out of bounds — i.e. it has an exposed face.
// Hull-vs-hull overlap tests (voxelOverlap) only need the ~boundary cells of a hull, never
// its ~10^4 interior cells, so we keep this set fresh incrementally as the hull is carved.
//
// Key invariant that makes the incremental update cheap: removing solid material can only
// EXPOSE neighbours (turn them into surface), never cover a face — so an existing surface
// cell stays surface forever. After a carve we only ever (a) drop the removed cells and
// (b) add their newly-exposed solid neighbours. No full rescan.

export interface GridView {
  dims: [number, number, number];
  isSolid(x: number, y: number, z: number): boolean;
}

/** Pack integer cell coords into one number key. nx,ny are the grid's first two dims. */
export function packCell(x: number, y: number, z: number, nx: number, ny: number): number {
  return x + nx * (y + ny * z);
}

/** Inverse of packCell. */
export function unpackCell(key: number, nx: number, ny: number): [number, number, number] {
  const x = key % nx;
  const y = Math.floor(key / nx) % ny;
  const z = Math.floor(key / (nx * ny));
  return [x, y, z];
}

const NEIGHBORS: [number, number, number][] = [
  [-1, 0, 0], [1, 0, 0],
  [0, -1, 0], [0, 1, 0],
  [0, 0, -1], [0, 0, 1],
];

/** A solid cell is surface iff any of its 6 face-neighbours is non-solid or out of bounds. */
export function isSurface(grid: GridView, x: number, y: number, z: number): boolean {
  if (!grid.isSolid(x, y, z)) return false;
  const [nx, ny, nz] = grid.dims;
  for (const [dx, dy, dz] of NEIGHBORS) {
    const px = x + dx, py = y + dy, pz = z + dz;
    if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) return true; // OOB face exposed
    if (!grid.isSolid(px, py, pz)) return true;
  }
  return false;
}

/** Build the full surface set from scratch (called once at hull construction). Returns a
 *  Set of packed cell keys. */
export function computeSurface(grid: GridView): Set<number> {
  const [nx, ny, nz] = grid.dims;
  const surface = new Set<number>();
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (isSurface(grid, x, y, z)) surface.add(packCell(x, y, z, nx, ny));
      }
    }
  }
  return surface;
}

/** Incrementally update `surface` after `removed` cells were carved out of `grid` (which has
 *  already had them removed). Each removed cell leaves the set; each of its solid
 *  face-neighbours may now be exposed, so we (re)test and add it. */
export function updateSurfaceAfterRemoval(
  grid: GridView,
  surface: Set<number>,
  removed: Iterable<[number, number, number]>,
): void {
  const [nx, ny, nz] = grid.dims;
  for (const [x, y, z] of removed) {
    surface.delete(packCell(x, y, z, nx, ny)); // the carved cell is gone
    for (const [dx, dy, dz] of NEIGHBORS) {
      const px = x + dx, py = y + dy, pz = z + dz;
      if (px < 0 || py < 0 || pz < 0 || px >= nx || py >= ny || pz >= nz) continue;
      if (isSurface(grid, px, py, pz)) surface.add(packCell(px, py, pz, nx, ny));
    }
  }
}
