import { describe, it, expect } from "vitest";
import { createMeshScratch, meshChunk, meshGrid } from "../src/render/voxelMesher";
import { createGrid } from "../src/sim/voxelGrid";
import { OAK, PINE, ROCK } from "../src/sim/materials";
import { VOXEL_SIZE } from "../src/core/constants";

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

describe("meshGrid", () => {
  it("meshes a single voxel into a closed box (24 verts, 12 tris)", () => {
    const g = createGrid(4, 4, 4);
    g.set(1, 1, 1, ROCK);
    const m = meshGrid(g);
    expect(m.positions.length / 3).toBe(24); // 6 faces × 4 verts
    expect(m.indices.length).toBe(36); // 6 faces × 2 tris × 3
    for (let i = 0; i < m.positions.length; i++) {
      expect(m.positions[i]).toBeGreaterThanOrEqual(0);
      expect(m.positions[i]).toBeLessThanOrEqual(4 * VOXEL_SIZE);
    }
  });
  it("re-bases indices across chunks so triangles stay in range", () => {
    const g = createGrid(40, 8, 8); // spans 3 chunks along x
    g.set(2, 2, 2, ROCK);
    g.set(20, 2, 2, ROCK);
    g.set(36, 2, 2, ROCK);
    const m = meshGrid(g);
    const verts = m.positions.length / 3;
    expect(verts).toBe(72); // 3 separate boxes × 24
    for (let i = 0; i < m.indices.length; i++) expect(m.indices[i]).toBeLessThan(verts);
  });
  it("returns empty arrays for an empty grid", () => {
    const m = meshGrid(createGrid(2, 2, 2));
    expect(m.positions.length).toBe(0);
    expect(m.indices.length).toBe(0);
  });
});

describe("meshChunk with a pooled `into` scratch (round-12 SP4)", () => {
  it("yields identical data to the default (fresh-array) call", () => {
    const g = createGrid(16, 16, 16);
    for (let x = 0; x < 3; x++) for (let z = 0; z < 2; z++) g.set(x, 0, z, OAK);
    g.set(4, 2, 0, ROCK); // a second, differently-shaped island in the same chunk

    const fresh = meshChunk(g, 0, 0, 0)!;
    const scratch = createMeshScratch();
    const pooled = meshChunk(g, 0, 0, 0, undefined, scratch)!;

    expect(Array.from(pooled.positions)).toEqual(Array.from(fresh.positions));
    expect(Array.from(pooled.normals)).toEqual(Array.from(fresh.normals));
    expect(Array.from(pooled.colors)).toEqual(Array.from(fresh.colors));
    expect(Array.from(pooled.indices)).toEqual(Array.from(fresh.indices));
    expect(pooled.ironIndexCount).toBe(fresh.ironIndexCount);
  });

  it("the output views alias the SAME scratch buffers (no fresh allocation)", () => {
    const g = createGrid(16, 16, 16);
    g.set(0, 0, 0, OAK);
    const scratch = createMeshScratch();
    const out = meshChunk(g, 0, 0, 0, undefined, scratch)!;
    // subarray() shares the underlying ArrayBuffer with the source it was sliced from.
    expect(out.positions.buffer).toBe(scratch.positions.buffer);
    expect(out.indices.buffer).toBe(scratch.indices.buffer);
  });

  it("a later, SMALLER chunk reuses the same (already-grown) capacity without shrinking it", () => {
    const g = createGrid(16, 16, 16);
    for (let x = 0; x < 8; x++) g.set(x, 0, 0, OAK); // a wide bar → several quads
    const scratch = createMeshScratch(1, 1); // start tiny so growth is exercised
    const big = meshChunk(g, 0, 0, 0, undefined, scratch)!;
    const grownPositions = scratch.positions;
    expect(grownPositions.length).toBeGreaterThanOrEqual(big.positions.length);

    const g2 = createGrid(16, 16, 16);
    g2.set(0, 0, 0, OAK); // a single cube — far fewer verts/indices
    const small = meshChunk(g2, 0, 0, 0, undefined, scratch)!;
    expect(small.positions.length).toBe(6 * 4 * 3);
    expect(scratch.positions).toBe(grownPositions); // capacity kept, not reallocated smaller
  });

  it("re-meshing a GROWN chunk correctly enlarges the scratch (grow-only, 1.5× slack)", () => {
    const scratch = createMeshScratch(1, 1); // deliberately undersized
    const g1 = createGrid(16, 16, 16);
    g1.set(0, 0, 0, OAK);
    const small = meshChunk(g1, 0, 0, 0, undefined, scratch)!;
    expect(small.positions.length / 3).toBe(6 * 4);

    const g2 = createGrid(16, 16, 16);
    // several disconnected cubes: greedy merge can't collapse them into one big quad run, so this
    // reliably produces MORE faces (not just bigger merged ones) than the single small cube above.
    for (let i = 0; i < 6; i++) g2.set(i * 2, 0, 0, OAK);
    const big = meshChunk(g2, 0, 0, 0, undefined, scratch)!;
    // the grown result must still be internally consistent — no truncation from a stale capacity.
    expect(big.indices.length).toBeGreaterThan(small.indices.length);
    for (const idx of big.indices) expect(idx).toBeLessThan(big.positions.length / 3);
  });

  it("debris/character/island callers (no `into`) still get FRESH, non-shared arrays", () => {
    const g = createGrid(16, 16, 16);
    g.set(0, 0, 0, OAK);
    const a = meshChunk(g, 0, 0, 0)!;
    const b = meshChunk(g, 0, 0, 0)!;
    expect(a.positions).not.toBe(b.positions); // each call owns its own buffer
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
  });
});
