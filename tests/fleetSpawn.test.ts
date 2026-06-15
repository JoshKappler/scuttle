import { describe, it, expect } from "vitest";
import { tierWeights, pickEnemyTier } from "../src/sim/fleetSpawn";

describe("fleetSpawn — tierWeights", () => {
  it("low notoriety favours small ships", () => {
    const w = tierWeights(0, "cutter");
    expect(w.cutter).toBeGreaterThan(w.frigate);
    expect(w.cutter).toBeGreaterThan(w.brig);
  });
  it("high notoriety raises the big-ship weight", () => {
    const lo = tierWeights(0, "cutter");
    const hi = tierWeights(120, "frigate");
    expect(hi.frigate).toBeGreaterThan(lo.frigate);
    expect(hi.frigate).toBeGreaterThan(hi.cutter);
  });
  it("keeps deep-water tiers rare in the opening", () => {
    const w = tierWeights(0, "cutter");
    expect(w.frigate).toBeLessThan(0.1);
  });
});

describe("fleetSpawn — pickEnemyTier", () => {
  it("is deterministic for a given rand draw", () => {
    expect(pickEnemyTier(0, "cutter", () => 0)).toBe("cutter");
    expect(pickEnemyTier(0, "cutter", () => 0)).toBe("cutter");
  });
  it("returns a valid tier across the draw range and notoriety levels", () => {
    const valid = new Set(["cutter", "sloop", "brig", "frigate"]);
    for (const n of [0, 30, 60, 120]) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        expect(valid.has(pickEnemyTier(n, "cutter", () => r))).toBe(true);
      }
    }
  });
});
