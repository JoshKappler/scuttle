import { VOXEL_SIZE, VOXEL_VOLUME } from "../core/constants";
import type { VoxelGrid } from "./voxelGrid";

/**
 * Compartment detection: partition the enclosed interior air of a hull into
 * watertight spaces via flood-fill. Runtime flooding dynamics (Bernoulli
 * inflow, inter-compartment flow) live here too once Task 11 lands.
 */
export interface Compartment {
  id: number;
  /** Packed cell indices (x + nx*(y + ny*z)) of interior air cells. */
  cells: Set<number>;
  volume: number; // m³ capacity
  waterVolume: number; // m³ currently flooded
  centroid: [number, number, number]; // local meters
  /** Open deck-hatch area connecting this compartment upward, m². */
  hatchArea: number;
  /** Lowest cell y (voxels) — used for water-level rendering and breach depth. */
  floorY: number;
}

/**
 * Find watertight compartments: connected regions of empty cells strictly
 * below deckY that never escape to the grid boundary. Regions that DO escape
 * are exterior water/air, not compartments.
 *
 * Returns compartments ordered bow-ward (ascending centroid x) with stable ids.
 */
export function findCompartments(grid: VoxelGrid, deckY: number): Compartment[] {
  const [nx, ny, nz] = grid.dims;
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const visited = new Uint8Array(nx * ny * nz);
  const compartments: Compartment[] = [];

  for (let z0 = 0; z0 < nz; z0++) {
    for (let y0 = 0; y0 < deckY; y0++) {
      for (let x0 = 0; x0 < nx; x0++) {
        const start = idx(x0, y0, z0);
        if (visited[start] || grid.isSolid(x0, y0, z0)) continue;

        // BFS this empty region (bounded above by deckY)
        const cells: number[] = [];
        let escaped = false;
        const queue: number[] = [start];
        visited[start] = 1;
        while (queue.length > 0) {
          const cur = queue.pop()!;
          const cx = cur % nx;
          const cy = Math.floor(cur / nx) % ny;
          const cz = Math.floor(cur / (nx * ny));
          cells.push(cur);
          const neighbors: [number, number, number][] = [
            [cx - 1, cy, cz],
            [cx + 1, cy, cz],
            [cx, cy - 1, cz],
            [cx, cy + 1, cz],
            [cx, cy, cz - 1],
            [cx, cy, cz + 1],
          ];
          for (const [px, py, pz] of neighbors) {
            if (px < 0 || pz < 0 || py < 0 || px >= nx || pz >= nz) {
              escaped = true; // reached the grid boundary → exterior region
              continue;
            }
            if (py >= deckY) continue; // hatches connect upward; not an escape below deck
            const ni = idx(px, py, pz);
            if (visited[ni] || grid.isSolid(px, py, pz)) continue;
            visited[ni] = 1;
            queue.push(ni);
          }
        }

        if (escaped) continue;

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let floorY = ny;
        for (const c of cells) {
          const cx = c % nx;
          const cy = Math.floor(c / nx) % ny;
          const cz = Math.floor(c / (nx * ny));
          sx += cx + 0.5;
          sy += cy + 0.5;
          sz += cz + 0.5;
          if (cy < floorY) floorY = cy;
        }
        const n = cells.length;
        compartments.push({
          id: 0, // assigned after sorting
          cells: new Set(cells),
          volume: n * VOXEL_VOLUME,
          waterVolume: 0,
          centroid: [(sx / n) * VOXEL_SIZE, (sy / n) * VOXEL_SIZE, (sz / n) * VOXEL_SIZE],
          hatchArea: 0, // measured by the caller (shipwright) which knows hatch placement
          floorY,
        });
      }
    }
  }

  compartments.sort((a, b) => a.centroid[0] - b.centroid[0]);
  compartments.forEach((c, i) => (c.id = i));
  return compartments;
}
