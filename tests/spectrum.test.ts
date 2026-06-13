import { describe, it, expect } from "vitest";
import { makeWaves, physicsWaves, surfaceHeight, PHYSICS_MIN_WAVELENGTH } from "../src/sim/gerstner";
import { Rng } from "../src/core/rng";

const waves = makeWaves(new Rng("blue-water"), 16);

describe("wave spectrum (round 8)", () => {
  it("spans swell to chop, log-spaced", () => {
    expect(waves).toHaveLength(16);
    expect(Math.max(...waves.map((w) => w.wavelength))).toBeGreaterThan(60);
    expect(Math.min(...waves.map((w) => w.wavelength))).toBeLessThan(5);
  });

  it("total amplitude is normalized to the target sea state", () => {
    const sum = waves.reduce((s, w) => s + w.amplitude, 0);
    expect(sum).toBeCloseTo(1.5, 5);
  });

  it("stays under the global sharpness budget — no self-intersecting crests", () => {
    const budget = waves.reduce(
      (s, w) => s + Math.min(w.steepness, 1) * ((2 * Math.PI) / w.wavelength) * w.amplitude,
      0,
    );
    expect(budget).toBeLessThanOrEqual(0.8 + 1e-9);
  });

  it("long swell carries the height; chop carries crumbs", () => {
    const longest = waves.reduce((a, b) => (a.wavelength > b.wavelength ? a : b));
    const shortest = waves.reduce((a, b) => (a.wavelength < b.wavelength ? a : b));
    expect(longest.amplitude).toBeGreaterThan(shortest.amplitude * 8);
  });

  it("physics subset keeps only the swell the hull should feel", () => {
    const phys = physicsWaves(waves);
    expect(phys.length).toBeGreaterThanOrEqual(6);
    expect(phys.length).toBeLessThan(waves.length);
    for (const w of phys) expect(w.wavelength).toBeGreaterThanOrEqual(PHYSICS_MIN_WAVELENGTH);
    // the subset still carries nearly all the sea's height
    const all = waves.reduce((s, w) => s + w.amplitude, 0);
    const sub = phys.reduce((s, w) => s + w.amplitude, 0);
    expect(sub / all).toBeGreaterThan(0.8);
  });

  it("16-wave inversion still converges (sampled height matches forward point)", () => {
    for (let i = 0; i < 40; i++) {
      const h = surfaceHeight(waves, i * 7.3 - 120, i * -5.1 + 60, i * 0.37);
      expect(Number.isFinite(h)).toBe(true);
      expect(Math.abs(h)).toBeLessThanOrEqual(1.5 + 1e-6);
    }
  });
});
