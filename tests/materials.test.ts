import { describe, it, expect } from "vitest";
import { MATERIALS, breakEnergy, OAK, PINE, IRON, RAM, STRENGTH_TO_JOULES } from "../src/sim/materials";

describe("material break energy", () => {
  it("scales with strength", () => {
    expect(breakEnergy(PINE)).toBe(MATERIALS[PINE].strength * STRENGTH_TO_JOULES);
    expect(breakEnergy(IRON)).toBeGreaterThan(breakEnergy(OAK));
  });
  it("ram is the toughest hull material (so a bow-first ram wins)", () => {
    expect(MATERIALS[RAM].strength).toBeGreaterThan(MATERIALS[OAK].strength);
    expect(MATERIALS[RAM].strength).toBeGreaterThan(MATERIALS[IRON].strength);
  });
  it("empty / unknown material costs nothing to break", () => {
    expect(breakEnergy(0)).toBe(0);
  });
});
