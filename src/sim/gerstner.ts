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

/** Generate a seeded wave set: wavelengths log-spaced, directions within a spread of the primary wind. */
export function makeWaves(rng: Rng, count = 4): Wave[] {
  const primary = rng.range(0, Math.PI * 2);
  const waves: Wave[] = [];
  for (let i = 0; i < count; i++) {
    // longest wave first; each subsequent wave roughly halves the wavelength
    const wavelength = 60 / Math.pow(1.8, i) + rng.range(-2, 2);
    const amplitude = 0.55 * Math.pow(0.62, i) + rng.range(-0.03, 0.03);
    const angle = primary + rng.range(-0.9, 0.9);
    waves.push({
      dirX: Math.cos(angle),
      dirZ: Math.sin(angle),
      amplitude: Math.max(0.05, amplitude),
      wavelength: Math.max(6, wavelength),
      // keep Σ(Q·k·a) < 1 across the set to avoid self-intersecting loops
      steepness: 0.7 / count,
      phaseSpeed: 0, // filled below from dispersion
    });
  }
  for (const w of waves) {
    w.phaseSpeed = Math.sqrt((G * w.wavelength) / (2 * Math.PI));
  }
  return waves;
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
    const q = w.steepness / (k * w.amplitude * waves.length || 1);
    const qa = Math.min(q, 1) * w.amplitude;
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
