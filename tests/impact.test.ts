import { describe, it, expect } from "vitest";
import { reducedMass, impactEnergy, KAPPA } from "../src/sim/impact";

describe("impact", () => {
  it("reduced mass of equal masses is m/2", () => { expect(reducedMass(100, 100)).toBeCloseTo(50); });
  it("energy scales with v^2 and with kappa", () => {
    const e1 = impactEnergy(1000, 1000, 4, KAPPA);
    const e2 = impactEnergy(1000, 1000, 8, KAPPA);
    expect(e2 / e1).toBeCloseTo(4);
    expect(e1).toBeGreaterThan(0);
  });
  it("zero closing speed yields zero energy", () => { expect(impactEnergy(1000, 500, 0, KAPPA)).toBe(0); });
  it("reduced mass of a galleon vs a dinghy is dominated by the small mass", () => {
    const rm = reducedMass(1_000_000, 1000);
    expect(rm).toBeGreaterThan(990); expect(rm).toBeLessThan(1000);
  });
});
