import * as THREE from "three";
import type { Rng } from "../core/rng";
import type { SpectrumOptions } from "../sim/oceanSpectrum";
import { createOceanFFT } from "./oceanFFT";
import { createOceanCascades } from "./oceanCascade";

/** The portability seam. Route 1 (WebGL2) and a future Route 2 (WebGPU) both
 *  implement THIS — textures the ocean material samples. Swapping backends never
 *  touches the mesh, physics, or game. Round 14 adds `cascades` for the
 *  multi-band surface; the singleton displacement/normal/foam mirror cascade 0 so
 *  legacy consumers and the null fallback keep working. */
export interface OceanField {
  /** Advance the GPU sim to time t (seconds). Call once per frame. */
  update(t: number): void;
  /** xyz choppy displacement (RGB = Dx, height, Dz), tiled over `tileSize`. */
  readonly displacement: THREE.Texture | null;
  /** surface normal (RGB) for lighting. */
  readonly normal: THREE.Texture | null;
  /** foam coverage (R) from the displacement Jacobian. */
  readonly foam: THREE.Texture | null;
  /** world-space tile size in meters (uv = worldXZ / tileSize). */
  readonly tileSize: number;
  /** true if the GPU backend is live; false = caller uses Gerstner-only look. */
  readonly active: boolean;
  /** Round 14: the multi-band cascade layers summed by the ocean shader. Absent
   *  on the null/legacy single-field path (caller falls back to a 1-layer view). */
  readonly cascades?: CascadeLayer[];
  dispose(): void;
}

/** One band of the multi-cascade surface — its own FFT tile + choppiness. */
export interface CascadeLayer {
  displacement: THREE.Texture; // RGB = Dx, height, Dz
  normal: THREE.Texture; // RGB = normal*0.5+0.5
  foam: THREE.Texture; // R = Jacobian foam
  tileSize: number; // m (uv = worldXZ / tileSize)
  choppiness: number; // horizontal-displacement λ applied in the ocean vertex shader
}

export interface CascadeOceanField extends OceanField {
  cascades: CascadeLayer[];
}

/** Per-cascade config: tile size, the wavelength band it carries, its own wind
 *  direction (crossing trains), visual amplitude, and choppiness λ. */
export interface CascadeConfig {
  L: number; // tile size (m)
  band: [number, number]; // [minWavelength, maxWavelength] (m) kept in this cascade
  windDirX: number;
  windDirZ: number;
  amplitude: number; // visual height scale for this band (Phillips is uncalibrated)
  choppiness: number; // horizontal trochoid pinch λ (sharp crashing crests)
}

export interface OceanFieldOptions extends SpectrumOptions {
  rng: Rng;
  /** Round 14: if present (and float RTs are supported), build a multi-cascade
   *  surface instead of the single band-limited tile. */
  cascades?: CascadeConfig[];
}

/** A no-op field: textures null, active=false. The ocean material treats a
 *  null displacement as "add nothing" and renders the Gerstner-only look. */
export function nullOceanField(): OceanField {
  return {
    update() {},
    displacement: null,
    normal: null,
    foam: null,
    tileSize: 1,
    active: false,
    dispose() {},
  };
}

/** Returns the WebGL2 FFT backend if float render targets are supported, else a
 *  null field (graceful fallback — the browser build still runs everywhere). */
export function createOceanField(renderer: THREE.WebGLRenderer, opts: OceanFieldOptions): OceanField {
  const gl = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const hasFloatRT = isWebGL2 && !!gl.getExtension("EXT_color_buffer_float");
  if (!hasFloatRT) return nullOceanField();
  if (opts.cascades && opts.cascades.length > 0) {
    return createOceanCascades(renderer, opts.rng, opts.N, opts.windSpeed, opts.cascades);
  }
  return createOceanFFT(renderer, opts);
}
