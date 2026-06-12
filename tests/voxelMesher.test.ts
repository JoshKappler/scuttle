import { describe, it, expect } from "vitest";
import { meshChunk } from "../src/render/voxelMesher";
import { createGrid } from "../src/sim/voxelGrid";
import { OAK, PINE } from "../src/sim/materials";

describe("greedy voxel mesher", () => {
  it("a solid 2×2×2 block merges to exactly 6 quads", () => {
    const g = createGrid(16, 16, 16);
    for (let x = 0; x < 2; x++)
      for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) g.set(x, y, z, OAK);
    const m = meshChunk(g, 0, 0, 0)!;
    expect(m.positions.length / 3).toBe(6 * 4); // 4 verts per quad
    expect(m.indices.length).toBe(6 * 6); // 6 indices per quad
  });

  it("two diagonal cubes yield 12 quads (no shared faces)", () => {
    const g = createGrid(16, 16, 16);
    g.set(0, 0, 0, OAK);
    g.set(1, 1, 1, OAK);
    const m = meshChunk(g, 0, 0, 0)!;
    expect(m.positions.length / 3).toBe(12 * 4);
  });

  it("interior faces are culled: 3×1×1 bar has 14 faces → merged quads", () => {
    const g = createGrid(16, 16, 16);
    for (let x = 0; x < 3; x++) g.set(x, 0, 0, OAK);
    const m = meshChunk(g, 0, 0, 0)!;
    // greedy merge: 4 long side faces merge to 1 quad each + 2 end caps = 6 quads
    expect(m.positions.length / 3).toBe(6 * 4);
  });

  it("differing materials do not merge", () => {
    const g = createGrid(16, 16, 16);
    g.set(0, 0, 0, OAK);
    g.set(1, 0, 0, PINE);
    const m = meshChunk(g, 0, 0, 0)!;
    // 10 exposed outer faces; the +x/-x top faces etc cannot merge across materials:
    // top: 2 quads (different mats), bottom: 2, front: 2, back: 2, ends: 2 → 10 quads
    expect(m.positions.length / 3).toBe(10 * 4);
  });

  it("empty chunk returns null", () => {
    const g = createGrid(40, 40, 40);
    g.set(20, 20, 20, OAK); // different chunk
    expect(meshChunk(g, 0, 0, 0)).toBeNull();
  });

  it("chunk border faces respect neighbors in adjacent chunks", () => {
    const g = createGrid(32, 16, 16);
    g.set(15, 0, 0, OAK); // last cell of chunk 0
    g.set(16, 0, 0, OAK); // first cell of chunk 1 — shared face must be culled
    const m0 = meshChunk(g, 0, 0, 0)!;
    // 5 faces only (the +x face is hidden by the neighbor chunk's cell)
    expect(m0.positions.length / 3).toBe(5 * 4);
  });
});
