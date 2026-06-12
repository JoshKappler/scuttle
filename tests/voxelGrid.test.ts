import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { MATERIALS, OAK } from "../src/sim/materials";
import { VOXEL_VOLUME, VOXEL_SIZE } from "../src/core/constants";

describe("VoxelGrid", () => {
  it("set/get/remove round-trip and out-of-bounds safety", () => {
    const g = createGrid(8, 8, 8);
    g.set(1, 2, 3, OAK);
    expect(g.get(1, 2, 3)).toBe(OAK);
    expect(g.isSolid(1, 2, 3)).toBe(true);
    expect(g.remove(1, 2, 3)).toBe(true);
    expect(g.remove(1, 2, 3)).toBe(false); // already empty
    expect(g.isSolid(1, 2, 3)).toBe(false);
    expect(g.isSolid(-1, 0, 0)).toBe(false); // no throw
    expect(g.get(99, 0, 0)).toBe(0);
  });

  it("counts solids", () => {
    const g = createGrid(4, 4, 4);
    g.set(0, 0, 0, OAK);
    g.set(1, 0, 0, OAK);
    expect(g.solidCount()).toBe(2);
    g.remove(0, 0, 0);
    expect(g.solidCount()).toBe(1);
  });

  it("mass = Σ density·volume", () => {
    const g = createGrid(4, 4, 4);
    g.set(0, 0, 0, OAK);
    g.set(1, 0, 0, OAK);
    expect(g.totalMass()).toBeCloseTo(2 * MATERIALS[OAK].density * VOXEL_VOLUME, 6);
  });

  it("center of mass of a symmetric pair is the midpoint (cell centers)", () => {
    const g = createGrid(4, 4, 4);
    g.set(0, 0, 0, OAK);
    g.set(2, 0, 0, OAK);
    // cell centers at (0.5, 2.5) voxels → midpoint 1.5 voxels → meters
    expect(g.centerOfMass()[0]).toBeCloseTo(1.5 * VOXEL_SIZE, 6);
    expect(g.centerOfMass()[1]).toBeCloseTo(0.5 * VOXEL_SIZE, 6);
  });

  it("mutations mark the containing 16³ chunk dirty", () => {
    const g = createGrid(40, 20, 40);
    g.set(17, 3, 33, OAK);
    expect(g.dirtyChunks.has("1,0,2")).toBe(true);
    g.dirtyChunks.clear();
    g.remove(17, 3, 33);
    expect(g.dirtyChunks.has("1,0,2")).toBe(true);
  });

  it("boundary mutations also dirty the adjacent chunk (meshes share faces)", () => {
    const g = createGrid(40, 20, 40);
    g.set(16, 0, 0, OAK); // first cell of chunk 1 in x
    expect(g.dirtyChunks.has("1,0,0")).toBe(true);
    expect(g.dirtyChunks.has("0,0,0")).toBe(true); // neighbor must re-evaluate its border faces
  });

  it("iterates all solid cells", () => {
    const g = createGrid(4, 4, 4);
    g.set(0, 0, 0, OAK);
    g.set(3, 3, 3, OAK);
    const seen: number[][] = [];
    g.forEachSolid((x, y, z, m) => seen.push([x, y, z, m]));
    expect(seen).toEqual([
      [0, 0, 0, OAK],
      [3, 3, 3, OAK],
    ]);
  });
});
