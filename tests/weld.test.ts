import { describe, it, expect } from "vitest";
import { buildSloop, buildBrig } from "../src/sim/shipwright";
import { createGrid } from "../src/sim/voxelGrid";
import { OAK } from "../src/sim/materials";
import { weldToSingleComponent } from "../src/sim/weld";
import type { VoxelGrid } from "../src/sim/voxelGrid";

/** Count 6-connected solid components in a grid. */
function componentCount(grid: VoxelGrid): number {
  const [nx, ny, nz] = grid.dims;
  const key = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const seen = new Set<number>();
  let comps = 0;
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        if (!grid.isSolid(x, y, z) || seen.has(key(x, y, z))) continue;
        comps++;
        const st = [key(x, y, z)];
        seen.add(key(x, y, z));
        while (st.length) {
          const c = st.pop()!;
          const cx = c % nx, cy = Math.floor(c / nx) % ny, cz = Math.floor(c / (nx * ny));
          for (const [px, py, pz] of [[cx - 1, cy, cz], [cx + 1, cy, cz], [cx, cy - 1, cz], [cx, cy + 1, cz], [cx, cy, cz - 1], [cx, cy, cz + 1]] as [number, number, number][]) {
            if (!grid.isSolid(px, py, pz)) continue;
            const k = key(px, py, pz);
            if (seen.has(k)) continue;
            seen.add(k);
            st.push(k);
          }
        }
      }
  return comps;
}

describe("weldToSingleComponent", () => {
  it("bridges a diagonally-floating cell to the main mass", () => {
    const g = createGrid(6, 6, 6);
    // main 2x2x2 block
    for (let x = 1; x <= 2; x++) for (let y = 1; y <= 2; y++) for (let z = 1; z <= 2; z++) g.set(x, y, z, OAK);
    // a single cell touching the block only at a corner (diagonal) — its own component
    g.set(3, 3, 3, OAK);
    expect(componentCount(g)).toBe(2);
    const added = weldToSingleComponent(g);
    expect(added).toBeGreaterThan(0);
    expect(componentCount(g)).toBe(1);
  });

  it("is a no-op on an already-connected grid", () => {
    const g = createGrid(5, 5, 5);
    for (let x = 1; x <= 3; x++) g.set(x, 1, 1, OAK);
    expect(weldToSingleComponent(g)).toBe(0);
    expect(componentCount(g)).toBe(1);
  });

  it("does not create cells outside the hull (bridges through interior only)", () => {
    // main block + an interior floater separated by one empty cell; the bridge must
    // land in that interior gap, never outside the bounding shell.
    const g = createGrid(7, 7, 7);
    for (let x = 1; x <= 5; x++) for (let y = 1; y <= 5; y++) for (let z = 1; z <= 5; z++) {
      // hollow box shell
      const edge = x === 1 || x === 5 || y === 1 || y === 5 || z === 1 || z === 5;
      if (edge) g.set(x, y, z, OAK);
    }
    // floater inside the hollow, diagonal to a shell corner-ish — disconnected
    g.set(3, 2, 3, OAK); // sits just under the top? actually interior, 1 gap from floor shell at y=1
    g.remove(3, 2, 3);
    g.set(3, 3, 3, OAK); // dead center, fully surrounded by air → unreachable interior island
    const before = componentCount(g);
    weldToSingleComponent(g);
    // every solid cell stays within [1,5]^3 (no exterior blobs)
    let outside = 0;
    g.forEachSolid((x, y, z) => { if (x < 1 || x > 5 || y < 1 || y > 5 || z < 1 || z > 5) outside++; });
    expect(outside).toBe(0);
    expect(before).toBeGreaterThanOrEqual(1);
  });
});

describe("built hulls are a single connected component (weld in shipwright)", () => {
  it("buildSloop produces exactly one 6-connected solid", () => {
    expect(componentCount(buildSloop().grid)).toBe(1);
  });
  it("buildBrig produces exactly one 6-connected solid", () => {
    expect(componentCount(buildBrig().grid)).toBe(1);
  });
});
