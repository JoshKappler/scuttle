import { describe, it, expect } from "vitest";
import { buildBrig } from "../src/sim/shipwright";
import { WATER_DENSITY } from "../src/core/constants";

// Density ratio = expected resting submerged fraction of the ENVELOPE volume.
// Deep and realistic (most of the hull wetted, waterline up at the near-vertical
// belt) but with real freeboard so she is NOT awash at spawn and a modest swell
// does not put the deck under (round 11: "the middle of the ship is already well
// beneath the waves"). Target band tuned live in this task.
describe("brig draft (round 11 re-tune)", () => {
  const brig = buildBrig();
  const ratio = brig.grid.totalMass() / (WATER_DENSITY * brig.envelopeVolume);

  it("floats deep but with freeboard (not awash)", () => {
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.6);
  });
});
