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
  /** Band window (round 14 cascades): keep ONLY wavelengths in [min,max] m. A
   *  multi-cascade ocean runs several spectra, each windowed to its own band
   *  (e.g. ~12–40 / 5–18 / 2–7 m) at a non-commensurate tile size, so the sea
   *  carries swell-mid + chop + fine detail without one tile's grid showing.
   *  Defaults: min 0, max = CHOP_MAX_WAVELENGTH (the legacy single-band cap). */
  minWavelength?: number;
  maxWavelength?: number;
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

/** Broadband chop spectrum with a directional term and a small-wave cutoff.
 *  A textbook Phillips falls off as 1/k⁴, which — once the field is band-limited
 *  to the 2–14 m chop band — buries almost all the energy at the long (14 m)
 *  edge. The result is a near-single-wavelength surface that reads as a repeating
 *  GRID, not open-sea chaos. Two changes broaden it:
 *   • 1/k² rolloff (not 1/k⁴) spreads energy across the whole band, so every
 *     wavelength from 2 m to 14 m contributes → rough, never-repeating chop.
 *   • the directional term keeps a 0.35 omni floor, so the chop arrives from
 *     every angle ("unpredictable"), not collimated along one axis. */
function phillips(kx: number, kz: number, windSpeed: number, wDirX: number, wDirZ: number): number {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-12) return 0;
  const Lw = (windSpeed * windSpeed) / G;
  const kHat = [kx / Math.sqrt(k2), kz / Math.sqrt(k2)];
  const wDot = kHat[0] * wDirX + kHat[1] * wDirZ;
  // Round 14: each cascade is band-windowed by makeOceanSpectrum, so the spectrum
  // here is just the clean Phillips SHAPE within that band — no single-band kCut
  // hack any more. Sharper directionality (0.2 omni floor + cos²) so the crossing
  // cascade trains read as distinct seas rather than one collimated wall. 1/k²
  // (not 1/k⁴) keeps energy spread across the band so a cascade is rough, not a
  // single wavelength. A tiny small-wave damp keeps the band's top off the Nyquist
  // fizz that aliases into shimmer.
  const dir = 0.2 + 0.8 * wDot * wDot;
  const smallLen = 0.4; // m — Tessendorf small-wave suppression
  const damp = Math.exp(-k2 * smallLen * smallLen);
  return (Math.exp(-1 / (k2 * Lw * Lw)) / k2) * dir * damp;
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
  const minWL = opts.minWavelength ?? 0;
  const maxWL = opts.maxWavelength ?? CHOP_MAX_WAVELENGTH;
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
        if (lambda >= minWL && lambda <= maxWL) {
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
