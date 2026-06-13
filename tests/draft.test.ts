import { describe, it, expect } from "vitest";
import { buildBrig } from "../src/sim/shipwright";
import { WATER_DENSITY } from "../src/core/constants";

// Density ratio = expected resting submerged fraction of the ENVELOPE volume,
// which by Archimedes equals average hull density / seawater (buoyancy research).
// Round 13 (overnight): the round-11 deep 0.5–0.6 draft sat the waterline at the
// gunwale under way ("water basically all the way up to the deck … not realistic"
// — playtest, vs the tall dry topsides of real ships). Dropped the top ballast
// course so she rides at ~0.45 — a reference-like freeboard with a clear dry hull
// band — while a low COM keeps her stiff. Still deep enough not to look corky.
describe("brig draft (round 13 freeboard re-tune)", () => {
  const brig = buildBrig();
  const ratio = brig.grid.totalMass() / (WATER_DENSITY * brig.envelopeVolume);

  it("rides high with real freeboard (reference-like, not awash, not corky)", () => {
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.5);
  });
});
