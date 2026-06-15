import { describe, it, expect } from "vitest";
import { orificeFlow, floodStep, type Compartment, type BreachInput, type Opening } from "../src/sim/compartments";

function comp(volume: number, waterVolume: number, id = 0): Compartment {
  return {
    id,
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

function breach(compartmentId: number, area: number, extHead: number, intHead: number): BreachInput {
  return { compartmentId, area, extHead, intHead };
}

// The breach is a SUBMERGED ORIFICE between two reservoirs: the sea (extHead = how far the
// sea surface is above the hole) and the compartment's own pool (intHead = how far the
// internal pool is above the hole). The signed flow seeks equilibrium and reverses to drain.
describe("orifice flow (two-reservoir breach)", () => {
  it("inflow grows with the external head", () => {
    expect(orificeFlow(0.1, 3, 0)).toBeGreaterThan(orificeFlow(0.1, 1, 0));
  });

  it("equal heads on both sides → zero net flow (equilibrium at the waterline)", () => {
    expect(orificeFlow(0.1, 2, 2)).toBe(0);
  });

  it("internal pool above the sea → flow reverses (drains out)", () => {
    expect(orificeFlow(0.1, 1, 3)).toBeLessThan(0);
  });

  it("a hole above both surfaces admits nothing", () => {
    expect(orificeFlow(0.1, -0.5, -0.2)).toBe(0);
  });

  it("inflow scales with breach area", () => {
    expect(orificeFlow(0.2, 2, 0)).toBeCloseTo(2 * orificeFlow(0.1, 2, 0), 9);
  });
});

describe("floodStep", () => {
  it("a submerged breach with a dry interior takes on water", () => {
    const c = comp(10, 0);
    floodStep([c], [], [breach(0, 1, 3, 0)], 0.1);
    expect(c.waterVolume).toBeGreaterThan(0);
  });

  it("compartment never exceeds capacity", () => {
    const c = comp(10, 9.99);
    floodStep([c], [], [breach(0, 1, 5, 0)], 1.0);
    expect(c.waterVolume).toBeLessThanOrEqual(10);
  });

  it("drains out when the pool tops the sea, never below zero", () => {
    const c = comp(10, 2);
    // strong outward head over a long step would overshoot past 0 if unclamped
    floodStep([c], [], [breach(0, 5, 0, 5)], 5.0);
    expect(c.waterVolume).toBe(0);
  });

  it("holds its level at equilibrium (equal heads)", () => {
    const c = comp(10, 4);
    floodStep([c], [], [breach(0, 1, 2, 2)], 1.0);
    expect(c.waterVolume).toBeCloseTo(4, 9);
  });

  it("a sealed compartment with no breach stays dry", () => {
    const c = comp(10, 0);
    floodStep([c], [], [], 1.0);
    expect(c.waterVolume).toBe(0);
  });

  it("water equalizes through an opening between connected compartments", () => {
    const a = comp(10, 8, 0);
    const b = comp(10, 0, 1);
    const openings: Opening[] = [{ a: 0, b: 1, area: 0.5 }];
    for (let i = 0; i < 1200; i++) floodStep([a, b], openings, [], 1 / 60);
    expect(a.waterVolume).toBeCloseTo(b.waterVolume, 0);
    // mass conserved
    expect(a.waterVolume + b.waterVolume).toBeCloseTo(8, 6);
  });

  it("flow through an opening follows the fuller compartment", () => {
    const a = comp(10, 1, 0);
    const b = comp(10, 6, 1);
    const openings: Opening[] = [{ a: 0, b: 1, area: 0.5 }];
    floodStep([a, b], openings, [], 0.5);
    expect(a.waterVolume).toBeGreaterThan(1); // gained from b
    expect(b.waterVolume).toBeLessThan(6);
  });
});
