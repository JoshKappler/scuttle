import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { surfaceBandVoxels } from "../src/sim/islandCollider";

describe("surfaceBandVoxels", () => {
  it("drops fully-enclosed interior cells, keeping only the surface shell", () => {
    // a solid 3×3×3 block: the center (1,1,1) is the only fully-enclosed cell.
    const g = createGrid(3, 3, 3);
    for (let x = 0; x < 3; x++)
      for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) g.set(x, y, z, 1);
    const out = surfaceBandVoxels(g, 1, 5, 5); // band wide enough to cover all 3 layers
    const coords = new Set<string>();
    for (let i = 0; i < out.length; i += 3) coords.add(`${out[i]},${out[i + 1]},${out[i + 2]}`);
    expect(out.length / 3).toBe(26); // 27 cells minus the 1 interior
    expect(coords.has("1,1,1")).toBe(false); // interior excluded
    expect(coords.has("0,0,0")).toBe(true); // corner kept
  });

  it("clips to the waterline Y-band", () => {
    // a 1×5×1 column (every cell is surface); only the band rows survive.
    const g = createGrid(1, 5, 1);
    for (let y = 0; y < 5; y++) g.set(0, y, 0, 1);
    const out = surfaceBandVoxels(g, 2, 1, 1); // band y ∈ [1, 3]
    const ys: number[] = [];
    for (let i = 0; i < out.length; i += 3) ys.push(out[i + 1]);
    expect(ys.sort((a, b) => a - b)).toEqual([1, 2, 3]); // y=0 (below) and y=4 (above) dropped
  });

  it("returns a flat Int32Array of x,y,z triples", () => {
    const g = createGrid(2, 2, 2);
    g.set(0, 0, 0, 1);
    const out = surfaceBandVoxels(g, 0, 4, 4);
    expect(out).toBeInstanceOf(Int32Array);
    expect(out.length).toBe(3);
    expect([out[0], out[1], out[2]]).toEqual([0, 0, 0]);
  });
});
