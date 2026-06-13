import * as THREE from "three";
import type { Rng } from "../core/rng";
import type { SpectrumOptions } from "../sim/oceanSpectrum";
import { createOceanFFT } from "./oceanFFT";

/** The portability seam. Route 1 (WebGL2) and a future Route 2 (WebGPU) both
 *  implement THIS — three textures the ocean material samples. Swapping
 *  backends never touches the mesh, physics, or game. */
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
  dispose(): void;
}

export interface OceanFieldOptions extends SpectrumOptions {
  rng: Rng;
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
  return createOceanFFT(renderer, opts);
}
