import { describe, it, expect } from "vitest";
import { makeWaves, surfaceHeight, surfaceNormal, displace, surfaceVelocity } from "../src/sim/gerstner";
import { Rng } from "../src/core/rng";
import { G } from "../src/core/constants";

const waves = makeWaves(new Rng("sea"), 4);

describe("gerstner surface", () => {
  it("flat sea when amplitudes are zero", () => {
    const flat = waves.map((w) => ({ ...w, amplitude: 0 }));
    expect(surfaceHeight(flat, 12.3, -7.7, 5)).toBeCloseTo(0, 6);
  });

  it("height stays within total amplitude bound", () => {
    const bound = waves.reduce((s, w) => s + w.amplitude, 0) + 1e-6;
    for (let i = 0; i < 200; i++) {
      const h = surfaceHeight(waves, i * 1.7, i * -2.3, i * 0.13);
      expect(Math.abs(h)).toBeLessThanOrEqual(bound);
    }
  });

  it("surface moves over time", () => {
    expect(surfaceHeight(waves, 5, 5, 0)).not.toBeCloseTo(surfaceHeight(waves, 5, 5, 2), 3);
  });

  it("deep-water dispersion: phaseSpeed = sqrt(g·λ/2π)", () => {
    for (const w of waves) {
      expect(w.phaseSpeed).toBeCloseTo(Math.sqrt((G * w.wavelength) / (2 * Math.PI)), 6);
    }
  });

  it("inversion converges: sampled height matches forward-displaced point", () => {
    for (let i = 0; i < 50; i++) {
      const x0 = i * 3.1 - 70;
      const z0 = i * -2.7 + 40;
      const t = i * 0.21;
      const [xd, yd, zd] = displace(waves, x0, z0, t);
      // height sampled at the displaced horizontal position should match the
      // displaced vertical position (the point that ended up there)
      expect(surfaceHeight(waves, xd, zd, t)).toBeCloseTo(yd, 2);
    }
  });

  it("normal points generally up", () => {
    const n = surfaceNormal(waves, 3, 9, 1);
    expect(n[1]).toBeGreaterThan(0.5);
    // unit length
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5);
  });

  it("waves are deterministic for a given seed", () => {
    const again = makeWaves(new Rng("sea"), 4);
    expect(again).toEqual(waves);
  });

  it("surfaceVelocity equals the time-derivative of displace (central difference)", () => {
    const e = 1e-4;
    for (let i = 0; i < 40; i++) {
      const x0 = i * 2.3 - 30;
      const z0 = i * -1.9 + 25;
      const t = i * 0.17 + 0.05;
      const [xp, yp, zp] = displace(waves, x0, z0, t + e);
      const [xm, ym, zm] = displace(waves, x0, z0, t - e);
      const fd: [number, number, number] = [(xp - xm) / (2 * e), (yp - ym) / (2 * e), (zp - zm) / (2 * e)];
      const v = surfaceVelocity(waves, x0, z0, t);
      expect(v[0]).toBeCloseTo(fd[0], 3);
      expect(v[1]).toBeCloseTo(fd[1], 3);
      expect(v[2]).toBeCloseTo(fd[2], 3);
    }
  });

  it("surfaceVelocity is zero on a flat (zero-amplitude) sea", () => {
    const flat = waves.map((w) => ({ ...w, amplitude: 0 }));
    const v = surfaceVelocity(flat, 4.4, -8.8, 3.3);
    expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(0, 6);
  });
});
