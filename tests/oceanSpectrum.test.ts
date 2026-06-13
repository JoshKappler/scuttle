import { describe, it, expect } from "vitest";
import { makeOceanSpectrum, dispersion, CHOP_MAX_WAVELENGTH } from "../src/sim/oceanSpectrum";
import { PHYSICS_MIN_WAVELENGTH } from "../src/sim/gerstner";
import { G } from "../src/core/constants";
import { Rng } from "../src/core/rng";

describe("ocean FFT spectrum", () => {
  it("deep-water dispersion ω = sqrt(g·k)", () => {
    for (const k of [0.1, 0.5, 1.3, 4.0]) {
      expect(dispersion(k)).toBeCloseTo(Math.sqrt(G * k), 6);
    }
  });

  it("is band-limited to the chop band (no energy at swell wavelengths ≥14 m)", () => {
    const N = 64;
    const L = 80; // m tile
    const spec = makeOceanSpectrum(new Rng("chop"), { N, L, windSpeed: 9 });
    let swellEnergy = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (m - N / 2)) / L;
        const kz = (2 * Math.PI * (n - N / 2)) / L;
        const kLen = Math.hypot(kx, kz);
        if (kLen < 1e-6) continue;
        const lambda = (2 * Math.PI) / kLen;
        const a = spec.h0Re[m * N + n] ** 2 + spec.h0Im[m * N + n] ** 2;
        if (lambda >= PHYSICS_MIN_WAVELENGTH) swellEnergy += a;
      }
    }
    expect(swellEnergy).toBeLessThan(1e-6);
    expect(CHOP_MAX_WAVELENGTH).toBeLessThanOrEqual(PHYSICS_MIN_WAVELENGTH);
  });

  it("is deterministic for a seed", () => {
    const a = makeOceanSpectrum(new Rng("s"), { N: 32, L: 64, windSpeed: 8 });
    const b = makeOceanSpectrum(new Rng("s"), { N: 32, L: 64, windSpeed: 8 });
    expect(Array.from(a.h0Re)).toEqual(Array.from(b.h0Re));
  });

  it("produces a finite, non-flat spatial height field", () => {
    const spec = makeOceanSpectrum(new Rng("sea"), { N: 64, L: 80, windSpeed: 9 });
    const h = spec.heightField(2.0); // t = 2 s
    expect(h).toHaveLength(64 * 64);
    let min = Infinity, max = -Infinity, finite = true;
    for (const v of h) {
      if (!Number.isFinite(v)) finite = false;
      min = Math.min(min, v); max = Math.max(max, v);
    }
    expect(finite).toBe(true);
    expect(max - min).toBeGreaterThan(0.01); // genuinely choppy, not flat
  });
});
