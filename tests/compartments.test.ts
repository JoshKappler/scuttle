import { describe, it, expect } from "vitest";
import { breachInflow, floodStep, type Compartment, type Opening } from "../src/sim/compartments";

function comp(volume: number, waterVolume: number): Compartment {
  return {
    id: 0,
    cells: new Set(),
    volume,
    waterVolume,
    centroid: [0, 0, 0],
    hatchArea: 0,
    floorY: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [4, 4, 4],
  };
}

describe("flooding dynamics", () => {
  it("Bernoulli inflow: deeper breach floods faster", () => {
    expect(breachInflow(0.1, 3)).toBeGreaterThan(breachInflow(0.1, 1));
  });

  it("breach above the waterline admits nothing", () => {
    expect(breachInflow(0.1, -0.5)).toBe(0);
  });

  it("inflow scales with breach area", () => {
    expect(breachInflow(0.2, 2)).toBeCloseTo(2 * breachInflow(0.1, 2), 9);
  });

  it("compartment never exceeds capacity", () => {
    const c = comp(10, 9.99);
    floodStep([c], [], [{ compartmentId: 0, area: 1, depth: 5 }], 1.0);
    expect(c.waterVolume).toBeLessThanOrEqual(10);
  });

  it("a sealed compartment with no breach stays dry", () => {
    const c = comp(10, 0);
    floodStep([c], [], [], 1.0);
    expect(c.waterVolume).toBe(0);
  });

  it("water equalizes through an opening between connected compartments", () => {
    const a = comp(10, 8);
    const b = { ...comp(10, 0), id: 1 };
    const openings: Opening[] = [{ a: 0, b: 1, area: 0.5 }];
    for (let i = 0; i < 1200; i++) floodStep([a, b], openings, [], 1 / 60);
    expect(a.waterVolume).toBeCloseTo(b.waterVolume, 0);
    // mass conserved
    expect(a.waterVolume + b.waterVolume).toBeCloseTo(8, 6);
  });

  it("flow direction follows the fuller compartment", () => {
    const a = comp(10, 1);
    const b = { ...comp(10, 6), id: 1 };
    const openings: Opening[] = [{ a: 0, b: 1, area: 0.5 }];
    floodStep([a, b], openings, [], 0.5);
    expect(a.waterVolume).toBeGreaterThan(1); // gained from b
    expect(b.waterVolume).toBeLessThan(6);
  });
});
