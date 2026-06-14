import { describe, it, expect } from "vitest";
import { planIslandPlacements } from "../src/game/islandField";

describe("planIslandPlacements", () => {
  const plan = planIslandPlacements("scuttle-dev");
  it("is deterministic for a seed", () => {
    expect(planIslandPlacements("scuttle-dev")).toEqual(plan);
  });
  it("always includes exactly one reachable harbor island", () => {
    const harbors = plan.filter((p) => p.kind === "harbor");
    expect(harbors).toHaveLength(1);
    const d = Math.hypot(harbors[0].x, harbors[0].z);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(480);
  });
  it("keeps a clear lagoon around spawn and no overlaps", () => {
    for (const p of plan) expect(Math.hypot(p.x, p.z)).toBeGreaterThan(150);
    for (let i = 0; i < plan.length; i++)
      for (let j = i + 1; j < plan.length; j++) {
        const d = Math.hypot(plan[i].x - plan[j].x, plan[i].z - plan[j].z);
        expect(d).toBeGreaterThan(plan[i].radiusM + plan[j].radiusM);
      }
  });
  it("places several wild islands", () => {
    expect(plan.filter((p) => p.kind === "wild").length).toBeGreaterThanOrEqual(5);
  });
});
