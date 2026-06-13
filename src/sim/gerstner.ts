import { G } from "../core/constants";
import type { Rng } from "../core/rng";

/**
 * Gerstner (trochoidal) wave math. This module is the single source of truth
 * for the water surface: the ocean vertex shader evaluates the same equations
 * on the GPU from the same parameters, and physics samples it here on the CPU.
 */
export interface Wave {
  dirX: number; // unit direction of travel (horizontal)
  dirZ: number;
  amplitude: number; // m
  wavelength: number; // m
  steepness: number; // Q factor, 0..1 (sharpness of crests)
  phaseSpeed: number; // m/s, deep-water dispersion
}

/**
 * Generate a seeded wave SPECTRUM (round 8 rebuild): wavelengths log-spaced
 * from ocean swell down to wind chop, amplitudes set from the swell scale and
 * falling off toward the chop, directions tight around the wind for the long
 * waves and scattered for the short ones. Four waves read as "the same waves
 * repeating over and over" (round 8); sixteen with scattered directions
 * never visibly repeat.
 *
 * Amplitude is keyed to the LONGEST wave (SWELL_AMP), not normalized to a
 * fixed total — spreading a fixed sum over 16 waves starved the swell to
 * ~0.27 m and "the ship barely bobs up and down on them" (round 8 v2). The
 * long waves now keep the height that actually heaves a 500-tonne hull;
 * shorter components fall off as `(λ/L_MAX)^AMP_FALLOFF` for surface texture.
 *
 * `steepness` here is the per-wave crest-sharpness Q (0..1): the horizontal
 * trochoid displacement is Q·amplitude. The set is generated under a global
 * Σ(Q·k·a) ≤ 0.8 budget so the surface can never self-intersect and the
 * fixed-point inversion in surfaceHeight stays convergent.
 */
export function makeWaves(rng: Rng, count = 16): Wave[] {
  const primary = rng.range(0, Math.PI * 2);
  // 70 m, not 90: the 90 m swell's phase speed (~23 kn) matched the brig's
  // full-sail speed and she'd LOCK ONTO a wave back, parked bow-up for
  // minutes (real surfing, bad game feel). At 70 m she overtakes the sea.
  const L_MAX = 70; // m — long ocean swell
  const L_MIN = 3.5; // m — wind chop
  const SWELL_AMP = 0.62; // m — amplitude of the longest wave (the bob driver)
  const AMP_FALLOFF = 1.3; // higher → more height concentrated in the swell
  const waves: Wave[] = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0 : i / (count - 1);
    const wavelength = Math.max(L_MAX * Math.pow(L_MIN / L_MAX, f) * (1 + rng.range(-0.12, 0.12)), 2.2);
    // long swell now crosses too (round 11: "ripples all going the exact same
    // direction"): the longest waves fan ~±0.45 rad around two swell trains
    // ~0.7 rad apart, short chop scatters wider. Physics rides the result.
    const train = i % 2 === 0 ? 0 : 0.7; // two interleaved swell systems
    const spreadHalf = 0.45 + 0.7 * f * f;
    const angle = primary + train + rng.range(-spreadHalf, spreadHalf);
    // chop: lift the SHORT components (λ < the physics cutoff, which the hull
    // never feels) so the sea reads as wind chop riding the swell rather than
    // long rolling waves (round 9: "I wanted … chop instead of just long,
    // rolling waves"). Tapers to 0 at the swell cutoff, so physicsWaves and
    // the ship's motion are completely untouched.
    const chop = 0.06 * Math.max(0, (PHYSICS_MIN_WAVELENGTH - wavelength) / PHYSICS_MIN_WAVELENGTH);
    waves.push({
      dirX: Math.cos(angle),
      dirZ: Math.sin(angle),
      amplitude: SWELL_AMP * Math.pow(wavelength / L_MAX, AMP_FALLOFF) + chop,
      wavelength,
      steepness: 0, // filled below under the sharpness budget
      phaseSpeed: 0, // filled below from dispersion
    });
  }
  const SHARPNESS = 0.8; // Σ(Q·k·a) budget — crests can't self-intersect
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    w.steepness = Math.min(SHARPNESS / (count * k * w.amplitude), 1);
    w.phaseSpeed = Math.sqrt((G * w.wavelength) / (2 * Math.PI));
  }
  return waves;
}

/** Physics rides the SWELL, not the chop: only wavelengths long enough to
 *  move hundreds of tons get to push the hull around. This is what makes the
 *  ship feel massive without faking inertia (round 8: "less influenced by
 *  bumps in the waves while also making it float realistic and have some
 *  amount of undulation"). The visual surface keeps the full set. */
export const PHYSICS_MIN_WAVELENGTH = 14; // m

export function physicsWaves(waves: Wave[]): Wave[] {
  return waves.filter((w) => w.wavelength >= PHYSICS_MIN_WAVELENGTH);
}

/**
 * Forward Gerstner displacement of a rest-position point (x0, z0) at time t.
 * Returns the displaced world position [x, y, z].
 */
export function displace(waves: Wave[], x0: number, z0: number, t: number): [number, number, number] {
  let x = x0;
  let y = 0;
  let z = z0;
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    const phase = k * (w.dirX * x0 + w.dirZ * z0) - k * w.phaseSpeed * t;
    // steepness IS the per-wave Q (see makeWaves) — qa is the trochoid's
    // horizontal radius. The GPU evaluates the identical expression.
    const qa = Math.min(w.steepness, 1) * w.amplitude;
    x += w.dirX * qa * Math.cos(phase);
    z += w.dirZ * qa * Math.cos(phase);
    y += w.amplitude * Math.sin(phase);
  }
  return [x, y, z];
}

/**
 * Water surface height at a fixed horizontal world position (x, z).
 * Gerstner displaces points horizontally, so we invert that displacement with
 * a few fixed-point iterations (Crest-style); 3 iterations is ample at game
 * steepness values.
 */
export function surfaceHeight(waves: Wave[], x: number, z: number, t: number): number {
  let px = x;
  let pz = z;
  for (let i = 0; i < 3; i++) {
    const [dx, , dz] = displace(waves, px, pz, t);
    px += x - dx;
    pz += z - dz;
  }
  return displace(waves, px, pz, t)[1];
}

/** Approximate surface normal at (x, z) via central differences. */
export function surfaceNormal(waves: Wave[], x: number, z: number, t: number): [number, number, number] {
  const e = 0.1;
  const hx1 = surfaceHeight(waves, x + e, z, t);
  const hx0 = surfaceHeight(waves, x - e, z, t);
  const hz1 = surfaceHeight(waves, x, z + e, t);
  const hz0 = surfaceHeight(waves, x, z - e, t);
  const nx = (hx0 - hx1) / (2 * e);
  const nz = (hz0 - hz1) / (2 * e);
  const len = Math.hypot(nx, 1, nz);
  return [nx / len, 1 / len, nz / len];
}
