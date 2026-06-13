import { describe, it, expect } from "vitest";
import { wreckLift, WRECK_CELLS } from "../src/game/debris";
import { findSevered } from "../src/sim/connectivity";
import { createGrid } from "../src/sim/voxelGrid";
import { PINE } from "../src/sim/materials";

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
