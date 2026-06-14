/** Deterministic 2D value-noise fBm in [0,1]. Hash-lattice + smoothstep
 *  interpolation, summed over octaves. Pure: same (seed,x,z) → same value.
 *  No allocation, no global state — safe to call per-voxel-column. */
function hash2(seed: number, ix: number, iz: number): number {
  let h = (seed | 0) ^ Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // [0,1)
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function value2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = hash2(seed, ix, iz);
  const b = hash2(seed, ix + 1, iz);
  const c = hash2(seed, ix, iz + 1);
  const d = hash2(seed, ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Fractal Brownian motion: octaves of value noise, halving amplitude / doubling
 *  frequency. Result is normalized back into [0,1]. */
export function fbm2(seed: number, x: number, z: number, octaves = 4): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * value2(seed + o * 1013, x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
