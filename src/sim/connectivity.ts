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
  const visited = new Uint8Array(nx * ny * nz);
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  const bfs = (sx: number, sy: number, sz: number): { x: number; y: number; z: number; mat: number }[] => {
    const out: { x: number; y: number; z: number; mat: number }[] = [];
    const queue = [idx(sx, sy, sz)];
    visited[idx(sx, sy, sz)] = 1;
    while (queue.length > 0) {
      const cur = queue.pop()!;
      const x = cur % nx;
      const y = Math.floor(cur / nx) % ny;
      const z = Math.floor(cur / (nx * ny));
      out.push({ x, y, z, mat: grid.get(x, y, z) });
      const neighbors: [number, number, number][] = [
        [x - 1, y, z],
        [x + 1, y, z],
        [x, y - 1, z],
        [x, y + 1, z],
        [x, y, z - 1],
        [x, y, z + 1],
      ];
      for (const [px, py, pz] of neighbors) {
        if (!grid.isSolid(px, py, pz)) continue;
        const ni = idx(px, py, pz);
        if (visited[ni]) continue;
        visited[ni] = 1;
        queue.push(ni);
      }
    }
    return out;
  };

  // collect ALL connected components
  const components: { x: number; y: number; z: number; mat: number }[][] = [];
  let anchorComponent = -1;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!grid.isSolid(x, y, z) || visited[idx(x, y, z)]) continue;
        const comp = bfs(x, y, z);
        components.push(comp);
        if (comp.some((c) => c.x === keelAnchor[0] && c.y === keelAnchor[1] && c.z === keelAnchor[2])) {
          anchorComponent = components.length - 1;
        }
      }
    }
  }

  if (components.length <= 1) return [];

  // if the anchor cell itself was destroyed, the largest component is the ship
  if (anchorComponent === -1) {
    let largest = 0;
    for (let i = 1; i < components.length; i++) {
      if (components[i].length > components[largest].length) largest = i;
    }
    anchorComponent = largest;
  }

  return components.filter((_, i) => i !== anchorComponent).map((cells) => ({ cells }));
}
