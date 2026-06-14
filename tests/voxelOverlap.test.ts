import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { computeSurface, unpackCell } from "../src/sim/surfaceSet";
import { voxelOverlap, type HullView } from "../src/sim/voxelOverlap";
import { OAK } from "../src/sim/materials";

const ID: [number, number, number, number] = [0, 0, 0, 1];

function block(n: number, pos: [number, number, number], quat: [number, number, number, number]): HullView {
  const grid = createGrid(n, n, n);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) grid.set(x, y, z, OAK);
  const set = computeSurface(grid);
  const surface = new Int32Array(set.size * 3);
  let i = 0;
  for (const k of set) {
    const [x, y, z] = unpackCell(k, n, n);
    surface[i++] = x; surface[i++] = y; surface[i++] = z;
  }
  return { surface, isSolid: (x, y, z) => grid.isSolid(x, y, z), dims: [n, n, n], pos, quat };
}

describe("voxelOverlap", () => {
  it("two 4^3 blocks overlapping 1 voxel along +x: shared slab, ~1 voxel depth, +x push axis", () => {
    const vs = 1;
    const a = block(4, [0, 0, 0], ID); // world x [0,4)
    const b = block(4, [3, 0, 0], ID); // world x [3,7) -> overlap is A's x=3 layer vs B's x=0 layer
    const ov = voxelOverlap(a, b, vs);
    expect(ov).not.toBeNull();
    // exactly the shared slab, in each grid's own local indices
    expect(ov!.aCells.length).toBe(16);
    expect(ov!.bCells.length).toBe(16);
    expect(ov!.aCells.every(([x]) => x === 3)).toBe(true); // A's +x face layer
    expect(ov!.bCells.every(([x]) => x === 0)).toBe(true); // B's -x face layer
    // penetration ≈ 1 voxel along the thin (x) axis
    expect(ov!.depth).toBeCloseTo(1, 5);
    // push-out axis points A->B = +x
    expect(ov!.axis).toEqual([1, 0, 0]);
  });

  it("returns null when the two hulls are disjoint", () => {
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [10, 0, 0], ID);
    expect(voxelOverlap(a, b, 1)).toBeNull();
  });

  it("is symmetric in detection: swapping A/B still finds the same slab (mirrored axis)", () => {
    const vs = 1;
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [3, 0, 0], ID);
    const ov = voxelOverlap(b, a, vs); // now B-at-3 is the 'A' arg
    expect(ov).not.toBeNull();
    expect(ov!.aCells.every(([x]) => x === 0)).toBe(true); // the at-3 block's -x layer
    expect(ov!.bCells.every(([x]) => x === 3)).toBe(true); // the at-0 block's +x layer
    expect(ov!.depth).toBeCloseTo(1, 5);
    expect(ov!.axis).toEqual([-1, 0, 0]); // push the at-3 block back toward -x
  });
});
