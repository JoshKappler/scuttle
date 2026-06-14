import { describe, it, expect } from "vitest";
import { buildIsland, buildHarborIsland } from "../src/sim/islandwright";
import {
  EMPTY,
  SAND,
  GRASS,
  ROCK,
  DARKROCK,
  PALMWOOD,
  FOLIAGE,
  PINE,
  OAK,
} from "../src/sim/materials";

const opts = { seed: 42, radiusVox: 70, peakVox: 50, ruggedness: 0.5 };

/** Cheap order-sensitive checksum over the voxel data — comparing two ~1.6M-element
 *  Int8Arrays with toEqual is pathologically slow, a number compare is instant. */
function checksum(d: Int8Array): number {
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) h = Math.imul(h ^ (d[i] & 0xff), 16777619);
  return h >>> 0;
}

describe("buildIsland", () => {
  it("is deterministic", () => {
    const a = buildIsland(opts);
    const b = buildIsland(opts);
    expect(a.grid.data.length).toBe(b.grid.data.length);
    expect(checksum(a.grid.data)).toBe(checksum(b.grid.data));
  });
  it("rises out of the water and is sea-ringed (empty at the grid edge columns)", () => {
    const { grid, meta } = buildIsland(opts);
    const [nx, ny, nz] = grid.dims;
    // a substantial landmass pokes above the waterline somewhere
    let aboveWater = 0;
    grid.forEachSolid((_x, y) => {
      if (y > meta.waterlineY) aboveWater++;
    });
    expect(aboveWater).toBeGreaterThan(500);
    // the grid edge rings are open water (no land touches the boundary)
    let edgeSolids = 0;
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ny; y++) {
        if (grid.isSolid(x, y, 0)) edgeSolids++;
        if (grid.isSolid(x, y, nz - 1)) edgeSolids++;
      }
    expect(edgeSolids).toBe(0);
  });
  it("has a real sand beach band, highland grass, and rock cliffs", () => {
    const { grid } = buildIsland(opts);
    const counts: Record<number, number> = {};
    grid.forEachSolid((_x, _y, _z, m) => (counts[m] = (counts[m] ?? 0) + 1));
    expect(counts[SAND] ?? 0).toBeGreaterThan(40); // a gradual beach ring, not a token cell
    expect(counts[GRASS] ?? 0).toBeGreaterThan(0);
    expect((counts[ROCK] ?? 0) + (counts[DARKROCK] ?? 0)).toBeGreaterThan(0);
    expect(counts[EMPTY]).toBeUndefined();
  });
  it("scatters palms (trunk + canopy) on the highland", () => {
    const { grid } = buildIsland({ seed: 3, radiusVox: 70, peakVox: 45, ruggedness: 0.4 });
    const counts: Record<number, number> = {};
    grid.forEachSolid((_x, _y, _z, m) => (counts[m] = (counts[m] ?? 0) + 1));
    expect(counts[PALMWOOD] ?? 0).toBeGreaterThan(0);
    expect(counts[FOLIAGE] ?? 0).toBeGreaterThan(0);
  });
});

describe("buildHarborIsland", () => {
  it("adds a wooden dock above the waterline and exposes a dock anchor", () => {
    const { grid, meta } = buildHarborIsland({ seed: 5 });
    expect(meta.dock).not.toBeNull();
    let plankCount = 0;
    grid.forEachSolid((_x, y, _z, m) => {
      if (m === PINE && y > meta.waterlineY) plankCount++;
    });
    expect(plankCount).toBeGreaterThan(20); // a real pier, not a stub
  });
  it("drops visible OAK support pylons below the deck", () => {
    const { grid, meta } = buildHarborIsland({ seed: 5 });
    const shelfY = meta.waterlineY + 3; // deck level; pylons run from the seabed up to here
    let pylons = 0;
    grid.forEachSolid((_x, y, _z, m) => {
      if (m === OAK && y >= 2 && y < shelfY) pylons++;
    });
    expect(pylons).toBeGreaterThan(20); // the dock is actually supported
  });
  it("places at least one building (walls of OAK/PINE above the beach)", () => {
    const { grid, meta } = buildHarborIsland({ seed: 5 });
    let walls = 0;
    grid.forEachSolid((_x, y, _z, m) => {
      if ((m === OAK || m === PINE) && y > meta.waterlineY + 2) walls++;
    });
    expect(walls).toBeGreaterThan(40);
  });
  it("is deterministic", () => {
    expect(checksum(buildHarborIsland({ seed: 5 }).grid.data)).toBe(
      checksum(buildHarborIsland({ seed: 5 }).grid.data),
    );
  });
});
