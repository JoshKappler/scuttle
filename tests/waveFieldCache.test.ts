import { describe, it, expect } from "vitest";
import { WaveFieldCache, WAVE_FIELD_MAX_AGE_S } from "../src/game/ship";
import { makeWaves, physicsWaves, surfaceHeight } from "../src/sim/gerstner";
import { Rng } from "../src/core/rng";
import { FIXED_DT } from "../src/core/constants";

// ROUND-12 SP4-A: the per-ship buoyancy lattice is cached across substeps. These tests pin the
// cache CONTRACT: (1) sampling accuracy vs the exact inversion is the same as the SHIPPED inline
// lattice (bilinear on a 2.5 m grid over the λ≥14 m swell — the cache changes WHEN it fills, not
// HOW it interpolates); (2) refill triggers: first use, window move past a lattice cell, max age
// (~15 Hz); (3) reuse otherwise (this is the perf win); (4) refresh-on-first-use ⇒ step-1 identical.
const waves = physicsWaves(makeWaves(new Rng("sea"), 16));

describe("WaveFieldCache (round-12 SP4-A)", () => {
  it("bilinear sample tracks the exact Gerstner inversion (shipped-lattice accuracy)", () => {
    const c = new WaveFieldCache();
    c.ensure(waves, 3.7, -30, -20, 30, 20, 2.5);
    for (let i = 0; i < 200; i++) {
      const wx = -28 + (i % 20) * 2.9;
      const wz = -18 + Math.floor(i / 20) * 3.6;
      const exact = surfaceHeight(waves, wx, wz, 3.7);
      expect(Math.abs(c.sample(wx, wz) - exact)).toBeLessThan(0.1);
    }
  });

  it("lattice nodes are EXACT samples at the fill time", () => {
    const c = new WaveFieldCache();
    c.ensure(waves, 0, -10, -10, 10, 10, 2.5);
    expect(c.sample(c.x0, c.z0)).toBeCloseTo(surfaceHeight(waves, c.x0, c.z0, 0), 12);
    expect(c.sample(c.x0 + 2.5, c.z0 + 2.5)).toBeCloseTo(surfaceHeight(waves, c.x0 + 2.5, c.z0 + 2.5, 0), 12);
  });

  it("reuses the fill while the snapped window is unchanged and younger than the max age", () => {
    const c = new WaveFieldCache();
    c.ensure(waves, 0, -10, -10, 10, 10, 2.5);
    const t0 = c.filledT;
    c.ensure(waves, FIXED_DT, -10, -10, 10, 10, 2.5); // next substep, same window
    c.ensure(waves, 3 * FIXED_DT, -9.9, -9.9, 9.9, 9.9, 2.5); // small drift, SAME snapped window
    expect(c.filledT).toBe(t0); // cache hit — never refilled
  });

  it("refills at the max age (~15 Hz) and on a window shift past a lattice cell", () => {
    const c = new WaveFieldCache();
    c.ensure(waves, 0, -10, -10, 10, 10, 2.5);
    c.ensure(waves, WAVE_FIELD_MAX_AGE_S, -10, -10, 10, 10, 2.5); // age hit → refill
    expect(c.filledT).toBe(WAVE_FIELD_MAX_AGE_S);
    c.ensure(waves, WAVE_FIELD_MAX_AGE_S + FIXED_DT, -13, -10, 7, 10, 2.5); // moved ≥ a cell → refill
    expect(c.filledT).toBe(WAVE_FIELD_MAX_AGE_S + FIXED_DT);
  });

  it("first use always fills; invalid before (breach sampler falls back to exact then)", () => {
    const c = new WaveFieldCache();
    expect(c.valid(0)).toBe(false);
    c.ensure(waves, 0, -10, -10, 10, 10, 2.5);
    expect(c.valid(0)).toBe(true);
    expect(c.valid(WAVE_FIELD_MAX_AGE_S + 1)).toBe(false); // a long-stale fill is not trusted
  });
});
