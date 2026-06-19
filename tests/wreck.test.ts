import { describe, it, expect } from "vitest";
import { wreckLift, WRECK_CELLS, BIG_SEVER, routeIsland, islandHasRig } from "../src/game/debris";
import { findSevered, type Island } from "../src/sim/connectivity";
import { createGrid } from "../src/sim/voxelGrid";
import { PINE, OAK, SPAR, CANVAS } from "../src/sim/materials";

/** Build a synthetic severed island of `n` cells, all of material `mat`. */
const island = (n: number, mat: number): Island => ({
  cells: Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: 0, mat })),
});

describe("ship splitting (round 7)", () => {
  it("cutting a hull's waist clean through severs the far end as one island", () => {
    // a 40×6×8 solid bar, keel-anchored at one end
    const grid = createGrid(40, 6, 8);
    for (let x = 0; x < 40; x++)
      for (let y = 0; y < 6; y++) for (let z = 0; z < 8; z++) grid.set(x, y, z, PINE);
    // the "ram": remove a full transverse slab at x 18..20
    for (let x = 18; x <= 20; x++)
      for (let y = 0; y < 6; y++) for (let z = 0; z < 8; z++) grid.remove(x, y, z);

    const islands = findSevered(grid, [2, 0, 4]); // anchor in the low-x half
    expect(islands).toHaveLength(1);
    // the severed bow half: 19 stations × 6 × 8
    expect(islands[0].cells.length).toBe(19 * 6 * 8);
    // …and it is emphatically wreck-sized, not flotsam
    expect(islands[0].cells.length).toBeGreaterThanOrEqual(WRECK_CELLS);
  });

  it("fresh wreckage floats (entrained air), then waterlogs past floating", () => {
    expect(wreckLift(0)).toBeGreaterThan(1); // rides high at first
    // pine needs ≈×0.5 of full-displacement lift; by 60 s she can't have it
    expect(wreckLift(60)).toBeLessThan(0.5);
    // monotonic decay, floored above zero so the descent stays gentle
    expect(wreckLift(30)).toBeLessThan(wreckLift(10));
    expect(wreckLift(500)).toBeGreaterThan(0);
  });
});

describe("severed-island routing (BUG-4: shot masts must FALL, not vanish)", () => {
  it("a small SPAR (mast) island routes to a floating BODY, not dust", () => {
    // a felled mast is only ~150 cells — far below BIG_SEVER — but it carries SPAR, so it must
    // become a persistent floating body instead of a one-shot dust puff (the disappear bug).
    const mast = island(150, SPAR);
    expect(mast.cells.length).toBeLessThan(BIG_SEVER);
    expect(islandHasRig(mast)).toBe(true);
    expect(routeIsland(mast)).toBe("mast");
  });

  it("a small NON-spar hull fragment still DUSTS (no floating beams)", () => {
    // the design keeps small destroyed hull chips as loose voxels/dust — gating on SPAR CONTENT
    // (not a lowered global threshold) is what preserves that.
    const chip = island(150, OAK);
    expect(islandHasRig(chip)).toBe(false);
    expect(routeIsland(chip)).toBe("dust");
  });

  it("a hull torn clean in half (≥ BIG_SEVER) is still a WRECK", () => {
    expect(routeIsland(island(BIG_SEVER, OAK))).toBe("wreck");
    // and a BIG piece that happens to include spar (whole mast + the deck around it) is a wreck too
    // (the big-body path already meshes any material), so wreck takes precedence over mast.
    expect(routeIsland(island(BIG_SEVER, SPAR))).toBe("wreck");
  });

  it("a mixed island with even ONE spar voxel routes to the mast body", () => {
    const mixed: Island = {
      cells: [
        ...Array.from({ length: 80 }, (_, i) => ({ x: i, y: 0, z: 0, mat: OAK })),
        { x: 0, y: 1, z: 0, mat: SPAR },
      ],
    };
    expect(islandHasRig(mixed)).toBe(true);
    expect(routeIsland(mixed)).toBe("mast");
  });

  it("pine flotsam (no spar, sub-BIG) is unaffected — still dust", () => {
    expect(routeIsland(island(300, PINE))).toBe("dust");
  });
});

describe("debris routing keeps rig pieces afloat", () => {
  const isl = (mat: number, n = 20) =>
    ({ cells: Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: 0, mat })) });
  it("a pure-CANVAS severed island floats (route 'mast'), not dust", () => {
    expect(routeIsland(isl(CANVAS))).toBe("mast");
  });
  it("a SPAR island still floats", () => {
    expect(routeIsland(isl(SPAR))).toBe("mast");
  });
  it("a small plain-OAK chip still dusts", () => {
    expect(routeIsland(isl(OAK))).toBe("dust");
  });
});
