import { describe, it, expect } from "vitest";
import { buildIsland } from "../src/sim/islandwright";
import { EMPTY, SAND, GRASS, ROCK, DARKROCK, PALMWOOD, FOLIAGE } from "../src/sim/materials";

const opts = { seed: 42, radiusVox: 40, peakVox: 34, cliffiness: 0.6 };

describe("buildIsland", () => {
  it("is deterministic", () => {
    const a = buildIsland(opts);
    const b = buildIsland(opts);
    expect(a.grid.data).toEqual(b.grid.data);
  });
  it("rises out of the water and is sea-ringed (empty at the grid edge columns)", () => {
    const { grid, meta } = buildIsland(opts);
    const [nx, ny, nz] = grid.dims;
    let aboveWater = 0;
    for (let y = meta.waterlineY; y < ny; y++)
      if (grid.isSolid(Math.floor(nx / 2), y, Math.floor(nz / 2))) aboveWater++;
    expect(aboveWater).toBeGreaterThan(0);
    let edgeSolids = 0;
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ny; y++) {
        if (grid.isSolid(x, y, 0)) edgeSolids++;
        if (grid.isSolid(x, y, nz - 1)) edgeSolids++;
      }
    expect(edgeSolids).toBe(0);
  });
  it("has a sand beach band, highland grass, and rock cliffs", () => {
    const { grid } = buildIsland(opts);
    const counts: Record<number, number> = {};
    grid.forEachSolid((_x, _y, _z, m) => (counts[m] = (counts[m] ?? 0) + 1));
    expect(counts[SAND] ?? 0).toBeGreaterThan(0);
    expect(counts[GRASS] ?? 0).toBeGreaterThan(0);
    expect((counts[ROCK] ?? 0) + (counts[DARKROCK] ?? 0)).toBeGreaterThan(0);
    expect(counts[EMPTY]).toBeUndefined();
  });
  it("scatters palms (trunk + canopy) on the highland", () => {
    const { grid } = buildIsland({ seed: 3, radiusVox: 40, peakVox: 34, cliffiness: 0.4 });
    const counts: Record<number, number> = {};
    grid.forEachSolid((_x, _y, _z, m) => (counts[m] = (counts[m] ?? 0) + 1));
    expect(counts[PALMWOOD] ?? 0).toBeGreaterThan(0);
    expect(counts[FOLIAGE] ?? 0).toBeGreaterThan(0);
  });
});
