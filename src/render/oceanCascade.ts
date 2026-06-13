import * as THREE from "three";
import type { Rng } from "../core/rng";
import { createOceanFFT } from "./oceanFFT";
import type { CascadeConfig, CascadeLayer, CascadeOceanField, OceanField } from "./oceanField";

/**
 * Round-14 multi-cascade ocean surface (the AC4 / Sea of Thieves / Atlas recipe,
 * WebGL2 fragment passes — no compute).
 *
 * The scrapped chop was ONE band-limited 14 m FFT tile: it could only shimmer
 * (short waves oscillate fast), tile (one period), and camo (a ~1 m/texel mask
 * magnified). Instead we run SEVERAL independent Tessendorf fields, each one a
 * full `createOceanFFT` pipeline windowed to its own wavelength band at a
 * NON-COMMENSURATE tile size:
 *   - cascade 0  big chop / mid swell-back   (~12–40 m)  tile ~40 m
 *   - cascade 1  the working chop            (~5–18 m)   tile ~18 m
 *   - cascade 2  fine detail                 (~2–7 m)    tile ~7 m
 * Their tile sizes share no common multiple, so summed in the ocean shader they
 * never line up into a grid, and each band moves at its own (physically correct)
 * speed. Each cascade has its own wind direction so the trains CROSS and crash.
 *
 * The analytic Gerstner swell (gerstner.ts) stays the big slow waves AND the
 * deterministic physics truth; these cascades are sharp surface texture summed on
 * top, band-split BELOW the swell so they don't double-count it. The hull never
 * samples them (visual only), so physics/replays are untouched.
 *
 * All three share the one `rng` stream: each `createOceanFFT` draws its own
 * N²·2 Gaussians sequentially, so the fields are independent yet fully
 * deterministic for a given seed.
 */
export function createOceanCascades(
  renderer: THREE.WebGLRenderer,
  rng: Rng,
  N: number,
  windSpeed: number,
  configs: CascadeConfig[],
): CascadeOceanField {
  const fields: OceanField[] = configs.map((cfg) =>
    createOceanFFT(renderer, {
      rng,
      N,
      L: cfg.L,
      windSpeed,
      windDirX: cfg.windDirX,
      windDirZ: cfg.windDirZ,
      amplitude: cfg.amplitude,
      minWavelength: cfg.band[0],
      maxWavelength: cfg.band[1],
    }),
  );

  const cascades: CascadeLayer[] = fields.map((f, i) => ({
    // every cascade field is GPU-backed (createOceanFFT only returns live
    // textures); the non-null assertions are safe because createOceanField
    // guards the float-RT support BEFORE building cascades.
    displacement: f.displacement as THREE.Texture,
    normal: f.normal as THREE.Texture,
    foam: f.foam as THREE.Texture,
    tileSize: f.tileSize,
    choppiness: configs[i].choppiness,
  }));

  const result: CascadeOceanField = {
    update(t: number): void {
      for (const f of fields) f.update(t);
    },
    cascades,
    // singletons mirror cascade 0 so any legacy single-field consumer still works
    displacement: cascades[0].displacement,
    normal: cascades[0].normal,
    foam: cascades[0].foam,
    tileSize: cascades[0].tileSize,
    active: true,
    dispose(): void {
      for (const f of fields) f.dispose();
    },
  };
  // Verification hook (round 14): expose the underlying per-cascade FFT fields so
  // the in-browser oracle can read each cascade's height RT back and assert it
  // against the CPU spectrum.heightField — GLSL transform bugs are otherwise silent.
  (result as unknown as { __fields: OceanField[] }).__fields = fields;
  return result;
}
