import type { VoxelGrid } from "./voxelGrid";

/**
 * Structural connectivity: after damage, any solid cells no longer connected
 * to the ship's main body (anchored at the keel) are severed islands — they
 * break off as debris.
 *
 * 18-CONNECTIVITY BFS (FACE + EDGE adjacency). The player's rule: a voxel survives only if it links
 * to the body through a shared FACE (±1 on one axis) or a shared flat EDGE (±1 on exactly two axes —
 * the in-plane diagonal). A voxel touching the body ONLY at a corner (±1 on all THREE axes — a vertex)
 * is NOT considered attached and is shed as debris. So the 6 face + 12 edge neighbours connect; the 8
 * pure body-diagonal (corner) neighbours do NOT. A voxel with no face/edge neighbour at all (or whose
 * only path to the keel runs through corners) ends up in a non-anchor component and breaks off.
 */
export interface Island {
  cells: { x: number; y: number; z: number; mat: number }[];
}

// The 18 face+edge neighbour offsets: every (dx,dy,dz) ∈ {-1,0,1}³ with |dx|+|dy|+|dz| ∈ {1,2}.
// |·|=1 are the 6 faces; |·|=2 are the 12 in-plane (edge-sharing) diagonals. The 8 |·|=3 corner
// (vertex-only) offsets are deliberately EXCLUDED — a corner touch does not keep a voxel attached.
const NEIGHBORS18: [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (m === 1 || m === 2) out.push([dx, dy, dz]); // face or flat-edge, never corner (m===3) or self (0)
      }
  return out;
})();

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
      // FACE + EDGE neighbours (18-connectivity). isSolid() is bounds-safe (false past the edge), so
      // we test it on the neighbour's LOCAL coords first and only compute the flat index for an
      // in-bounds solid neighbour — never indexing visited[] with a wrapped/out-of-range key.
      for (let n = 0; n < NEIGHBORS18.length; n++) {
        const off = NEIGHBORS18[n];
        const px = x + off[0], py = y + off[1], pz = z + off[2];
        if (!grid.isSolid(px, py, pz)) continue;
        const ni = px + nx * (py + ny * pz);
        if (visited[ni]) continue;
        visited[ni] = 1;
        stack.push(ni);
      }
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
