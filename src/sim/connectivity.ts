import type { VoxelGrid } from "./voxelGrid";

/**
 * Structural connectivity: after damage, any solid cells no longer connected
 * to the ship's main body (anchored at the keel) are severed islands — they
 * break off as debris. 6-connectivity BFS.
 */
export interface Island {
  cells: { x: number; y: number; z: number; mat: number }[];
}

export function findSevered(grid: VoxelGrid, keelAnchor: [number, number, number]): Island[] {
  const [nx, ny, nz] = grid.dims;
  const nxy = nx * ny;
  const visited = new Uint8Array(nx * ny * nz);
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const anchorIdx = idx(keelAnchor[0], keelAnchor[1], keelAnchor[2]);

  // BFS from a seed, collecting cell INDICES (cheap numbers, not {x,y,z,mat} objects) and noting
  // whether this component holds the anchor — folded into the walk, so the old separate O(hull)
  // `comp.some(...)` anchor scan is gone. Neighbours are tested inline (no per-cell array of tuples).
  // Only the SEVERED components are later turned into cell objects, so the kept main hull — by far
  // the largest component, allocated then discarded every flush before — never builds a cell object.
  const stack: number[] = [];
  const bfs = (start: number): { cells: number[]; hasAnchor: boolean } => {
    const cells: number[] = [];
    let hasAnchor = false;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === anchorIdx) hasAnchor = true;
      cells.push(cur);
      const x = cur % nx;
      const y = Math.floor(cur / nx) % ny;
      const z = Math.floor(cur / nxy);
      // same neighbour order as before (−x,+x,−y,+y,−z,+z) so the LIFO traversal — and thus cell
      // order within an island — is unchanged. isSolid() is bounds-safe (false past the edge), so
      // the flat-index step (cur±1 / ±nx / ±nxy) is only used for an in-bounds neighbour.
      if (grid.isSolid(x - 1, y, z) && !visited[cur - 1]) { visited[cur - 1] = 1; stack.push(cur - 1); }
      if (grid.isSolid(x + 1, y, z) && !visited[cur + 1]) { visited[cur + 1] = 1; stack.push(cur + 1); }
      if (grid.isSolid(x, y - 1, z) && !visited[cur - nx]) { visited[cur - nx] = 1; stack.push(cur - nx); }
      if (grid.isSolid(x, y + 1, z) && !visited[cur + nx]) { visited[cur + nx] = 1; stack.push(cur + nx); }
      if (grid.isSolid(x, y, z - 1) && !visited[cur - nxy]) { visited[cur - nxy] = 1; stack.push(cur - nxy); }
      if (grid.isSolid(x, y, z + 1) && !visited[cur + nxy]) { visited[cur + nxy] = 1; stack.push(cur + nxy); }
    }
    return { cells, hasAnchor };
  };

  // collect ALL connected components (as index lists)
  const components: { cells: number[]; hasAnchor: boolean }[] = [];
  let anchorComponent = -1;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = idx(x, y, z);
        if (!grid.isSolid(x, y, z) || visited[i]) continue;
        const comp = bfs(i);
        components.push(comp);
        if (comp.hasAnchor) anchorComponent = components.length - 1;
      }
    }
  }

  if (components.length <= 1) return [];

  // if the anchor cell itself was destroyed, the largest component is the ship
  if (anchorComponent === -1) {
    let largest = 0;
    for (let i = 1; i < components.length; i++) {
      if (components[i].cells.length > components[largest].cells.length) largest = i;
    }
    anchorComponent = largest;
  }

  // materialize ONLY the severed components into {x,y,z,mat} cell objects (discovery order preserved)
  const islands: Island[] = [];
  for (let i = 0; i < components.length; i++) {
    if (i === anchorComponent) continue;
    const indices = components[i].cells;
    const cells: { x: number; y: number; z: number; mat: number }[] = new Array(indices.length);
    for (let j = 0; j < indices.length; j++) {
      const ci = indices[j];
      const x = ci % nx;
      const y = Math.floor(ci / nx) % ny;
      const z = Math.floor(ci / nxy);
      cells[j] = { x, y, z, mat: grid.get(x, y, z) };
    }
    islands.push({ cells });
  }
  return islands;
}
