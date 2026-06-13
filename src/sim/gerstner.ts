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
  // Round 13: the playtest wants the sea "10x slower, 10x wider, 10x taller" — it
  // read as fast tiny vibrating chop. The band-limited FFT chop (≤14 m) is
  // PHYSICALLY incapable of slow/wide: short waves oscillate fast (ω=√(gk)) and
  // their slope shimmers. The big, slow, WIDE waves must come from this analytic
  // swell, which can be any wavelength and moves at a realistic, slow speed. So
  // the swell goes long and tall: L_MAX 80→150 m. A 150 m swell's phase speed is
  // ~30 kn (was ~21.7 at 80 m) — still well above an 18 kn ship, so no surf-lock,
  // and a crest now takes ~10 s to roll past: the slow majestic heave asked for.
  const L_MAX = 150; // m — long ocean swell (wide + slow)
  const L_MIN = 3.5; // m — wind chop
  // Taller, but on a MUCH longer wave so the SLOPE stays gentle: steepness is
  // amp/λ ≈ 1.3/150 = 0.0087, below the old 0.8/80 = 0.010 that floated dry — so
  // a 1.3 m swell here pitches the hull LESS than the old 0.8 m did, and won't sit
  // the gun ports awash. The visual surface relief comes from the (now calmed)
  // FFT chop on top; this swell is the big slow roll under it.
  const SWELL_AMP = 1.5; // m — amplitude of the longest wave (the bob driver)
  const AMP_FALLOFF = 1.3; // higher → more height concentrated in the swell
  const waves: Wave[] = [];
  for (let i = 0; i < count; i++) {
    const f = count === 1 ? 0 : i / (count - 1);
    const wavelength = Math.max(L_MAX * Math.pow(L_MIN / L_MAX, f) * (1 + rng.range(-0.12, 0.12)), 2.2);
    // long swell now crosses too (round 11: "ripples all going the exact same
    // direction"; round 13: "still just 2 sets of waves rolling from 2
    // directions … a less uniform pattern should be our target"): the longest
    // waves fan around THREE interleaved swell trains spanning ~1.9 rad (~110°)
    // instead of two ~0.7 rad apart, and each wave jitters wider. Three crossing
    // systems never line up into a readable "two-train" pattern — the sea reads
    // as confused open ocean. Physics rides the result (still band-limited to the
    // swell, just from more directions, which is more realistic, not less stable).
    const train = [0.0, 0.85, 1.9][i % 3]; // three interleaved swell systems
    const spreadHalf = 0.6 + 0.8 * f * f;
    const angle = primary + train + rng.range(-spreadHalf, spreadHalf);
    // No short-wave lift any more: the old chop-lift fed the fast small analytic
    // ripples that (with the FFT chop) made the sea "vibrate like sand". The short
    // analytic components now stay near-flat under the AMP_FALLOFF, so the analytic
    // field is a clean big slow swell; surface relief is the FFT's job alone.
    const chop = 0;
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
 * Velocity of the water surface (m/s) at a rest point (x0, z0): the partial time
 * derivative ∂/∂t of {@link displace}. Used by P5's bow-crash spray trigger — the
 * cutwater throws spray in proportion to how hard the HULL drives into the water
 * RELATIVE to the water's own orbital motion (vHull − vOrbital). Because Gerstner
 * orbits are circular, the vertical component leads the horizontal by 90°.
 *
 *   phase   = k·(dir·x0) − ω·t,  ω = k·phaseSpeed
 *   ∂x/∂t   = Σ dirX·(Q·a)·ω·sin(phase)
 *   ∂y/∂t   = −Σ a·ω·cos(phase)
 *   ∂z/∂t   = Σ dirZ·(Q·a)·ω·sin(phase)
 */
export function surfaceVelocity(waves: Wave[], x0: number, z0: number, t: number): [number, number, number] {
  let vx = 0;
  let vy = 0;
  let vz = 0;
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    const omega = k * w.phaseSpeed;
    const phase = k * (w.dirX * x0 + w.dirZ * z0) - omega * t;
    const qa = Math.min(w.steepness, 1) * w.amplitude;
    const s = Math.sin(phase);
    vx += w.dirX * qa * omega * s;
    vz += w.dirZ * qa * omega * s;
    vy += -w.amplitude * omega * Math.cos(phase);
  }
  return [vx, vy, vz];
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
