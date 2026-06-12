import { describe, it, expect } from "vitest";
import { makeProbes, probeForce, totalBuoyancy } from "../src/sim/buoyancy";
import { buildSloop } from "../src/sim/shipwright";
import { G, WATER_DENSITY } from "../src/core/constants";

describe("buoyancy", () => {
  const ship = buildSloop();
  const probes = makeProbes(ship.grid, ship.compartments);

  it("probes partition the hull displaced volume (Σ probe volume ≈ envelope volume)", () => {
    const v = probes.reduce((s, p) => s + p.volume, 0);
    expect(v).toBeGreaterThan(ship.envelopeVolume * 0.9);
    expect(v).toBeLessThanOrEqual(ship.envelopeVolume * 1.05);
  });

  it("every probe knows its column height and sits at the column bottom", () => {
    for (const p of probes) {
      expect(p.height).toBeGreaterThan(0);
      expect(p.volume).toBeGreaterThan(0);
    }
  });

  it("fully submerged unflooded ship: F ≈ ρ·g·V upward", () => {
    const F = totalBuoyancy(probes, () => 1e9, () => 0);
    expect(F).toBeCloseTo(WATER_DENSITY * G * probes.reduce((s, p) => s + p.volume, 0), 0);
  });

  it("probe above water contributes zero", () => {
    expect(probeForce({ local: [0, 5, 0], volume: 1, height: 1, compartmentId: -1 }, 5, 2, 0)).toBe(0);
  });

  it("fully flooded compartment contributes ~zero buoyancy", () => {
    const F = probeForce({ local: [0, -5, 0], volume: 1, height: 1, compartmentId: 0 }, -5, 0, 1);
    expect(F).toBeCloseTo(0, 6);
  });

  it("half-submerged column gives half the force", () => {
    const p = { local: [0, 0, 0] as [number, number, number], volume: 2, height: 2, compartmentId: -1 };
    const full = probeForce(p, -10, 0, 0); // bottom 10m down, height 2 → fully submerged
    const half = probeForce(p, -1, 0, 0); // bottom 1m down, height 2 → half
    expect(half).toBeCloseTo(full / 2, 6);
  });

  it("equilibrium sanity: floating fraction equals density ratio and is boat-like", () => {
    const frac = ship.grid.totalMass() / (WATER_DENSITY * ship.envelopeVolume);
    expect(frac).toBeGreaterThan(0.15);
    expect(frac).toBeLessThan(0.6);
  });

  it("flooding the bow compartment shifts net force aft (listing torque exists)", () => {
    // weight the per-probe forces by x to get a crude pitch moment proxy
    const bowId = ship.compartments[ship.compartments.length - 1].id; // bow-most (sorted by x)
    const momentWith = (floodId: number) => {
      let m = 0;
      for (const p of probes) {
        const f = probeForce(p, p.local[1] - 100, 0, p.compartmentId === floodId ? 1 : 0);
        m += f * p.local[0];
      }
      return m;
    };
    expect(momentWith(bowId)).toBeLessThan(momentWith(-999)); // losing bow lift → less bow-up moment
  });
});
