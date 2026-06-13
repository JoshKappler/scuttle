import { G } from "../core/constants";
import type { Rng } from "../core/rng";
import { ifft2d } from "./fft";
import { PHYSICS_MIN_WAVELENGTH } from "./gerstner";

/** The FFT covers ONLY the chop band; the swell stays the analytic Gerstner
 *  field (so physics is untouched). Equal to the physics cutoff: every wave the
 *  hull feels comes from Gerstner, everything shorter from the FFT. */
export const CHOP_MAX_WAVELENGTH = PHYSICS_MIN_WAVELENGTH; // 14 m

export interface SpectrumOptions {
  N: number; // grid resolution (power of two)
  L: number; // tile size (m)
  windSpeed: number; // m/s
  windDirX?: number;
  windDirZ?: number;
  /** Visual height multiplier on the chop. The Phillips spectrum here is
   *  UNCALIBRATED (it returns tiny relative values), so without this the chop
   *  comes out ~1 cm — invisible against the ~0.6 m swell. This scales the
   *  band-limited chop up to a visible, deliberately-exaggerated-for-game-feel
   *  height. VISUAL ONLY — physics never samples the FFT chop. Default 1. */
  amplitude?: number;
}

export interface OceanSpectrum {
  N: number;
  L: number;
  h0Re: Float32Array;
  h0Im: Float32Array;
  heightField(t: number): Float32Array;
}

/** Deep-water angular frequency. */
export function dispersion(k: number): number {
  return Math.sqrt(G * k);
}

/** Phillips spectrum with a directional term and a small-wave cutoff. */
function phillips(kx: number, kz: number, windSpeed: number, wDirX: number, wDirZ: number): number {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-12) return 0;
  const k4 = k2 * k2;
  const Lw = (windSpeed * windSpeed) / G;
  const kHat = [kx / Math.sqrt(k2), kz / Math.sqrt(k2)];
  const wDot = kHat[0] * wDirX + kHat[1] * wDirZ;
  const dir = wDot * wDot;
  const damp = Math.exp(-k2 * (Lw * 0.0015) * (Lw * 0.0015));
  return (Math.exp(-1 / (k2 * Lw * Lw)) / k4) * dir * damp;
}

/** Box–Muller standard normal from two uniforms. */
function gauss(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng.next();
  while (v === 0) v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function makeOceanSpectrum(rng: Rng, opts: SpectrumOptions): OceanSpectrum {
  const { N, L, windSpeed } = opts;
  const wDirX = opts.windDirX ?? 1;
  const wDirZ = opts.windDirZ ?? 0;
  const A = opts.amplitude ?? 1;
  const h0Re = new Float32Array(N * N);
  const h0Im = new Float32Array(N * N);

  for (let m = 0; m < N; m++) {
    for (let n = 0; n < N; n++) {
      const kx = (2 * Math.PI * (m - N / 2)) / L;
      const kz = (2 * Math.PI * (n - N / 2)) / L;
      const kLen = Math.hypot(kx, kz);
      let amp = 0;
      if (kLen > 1e-6) {
        const lambda = (2 * Math.PI) / kLen;
        if (lambda < CHOP_MAX_WAVELENGTH) {
          amp = A * Math.sqrt(phillips(kx, kz, windSpeed, wDirX, wDirZ) / 2);
        }
      }
      const idx = m * N + n;
      h0Re[idx] = amp * gauss(rng);
      h0Im[idx] = amp * gauss(rng);
    }
  }

  function heightField(t: number): Float32Array {
    const re = new Float32Array(N * N);
    const im = new Float32Array(N * N);
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (m - N / 2)) / L;
        const kz = (2 * Math.PI * (n - N / 2)) / L;
        const kLen = Math.hypot(kx, kz);
        const idx = m * N + n;
        if (kLen < 1e-6) continue;
        const w = dispersion(kLen) * t;
        const c = Math.cos(w);
        const s = Math.sin(w);
        const j = ((N - m) % N) * N + ((N - n) % N);
        const aRe = h0Re[idx];
        const aIm = h0Im[idx];
        const bRe = h0Re[j];
        const bIm = -h0Im[j];
        re[idx] = (aRe * c - aIm * s) + (bRe * c + bIm * s);
        im[idx] = (aRe * s + aIm * c) + (-bRe * s + bIm * c);
      }
    }
    return ifft2d(re, im, N);
  }

  return { N, L, h0Re, h0Im, heightField };
}
