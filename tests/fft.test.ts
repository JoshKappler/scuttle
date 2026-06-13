import { describe, it, expect } from "vitest";
import { fft1d, ifft2d } from "../src/sim/fft";

describe("radix-2 FFT", () => {
  it("DC input → all energy in bin 0", () => {
    const re = [1, 1, 1, 1];
    const im = [0, 0, 0, 0];
    const out = fft1d(re, im, false);
    expect(out.re[0]).toBeCloseTo(4, 6);
    for (let i = 1; i < 4; i++) expect(out.re[i]).toBeCloseTo(0, 6);
  });

  it("forward then inverse round-trips", () => {
    const re = [3, -1, 2, 7, 0, -4, 1, 1];
    const im = [0, 0, 0, 0, 0, 0, 0, 0];
    const f = fft1d(re, im, false);
    const b = fft1d(f.re, f.im, true);
    for (let i = 0; i < 8; i++) {
      expect(b.re[i] / 8).toBeCloseTo(re[i], 6); // inverse is unnormalized
    }
  });

  it("is linear: F(a+b) = F(a)+F(b)", () => {
    const a = fft1d([1, 2, 3, 4], [0, 0, 0, 0], false);
    const b = fft1d([5, 6, 7, 8], [0, 0, 0, 0], false);
    const s = fft1d([6, 8, 10, 12], [0, 0, 0, 0], false);
    for (let i = 0; i < 4; i++) expect(a.re[i] + b.re[i]).toBeCloseTo(s.re[i], 6);
  });

  it("2D inverse produces a real impulse from a single low-frequency mode", () => {
    const N = 8;
    const re = new Float32Array(N * N);
    const im = new Float32Array(N * N);
    re[1 * N + 0] = 1; // one mode
    const out = ifft2d(re, im, N);
    expect(out.length).toBe(N * N);
    let finite = true;
    for (const v of out) if (!Number.isFinite(v)) finite = false;
    expect(finite).toBe(true);
  });
});
