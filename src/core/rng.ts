/** Deterministic seeded RNG: xmur3 string hash feeding mulberry32. */
function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private fn: () => number;

  constructor(seed: string) {
    this.fn = mulberry32(xmur3(seed)());
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.fn();
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.fn() * (max - min);
  }

  /** Uniform integer in [min, maxExcl). */
  int(min: number, maxExcl: number): number {
    return min + Math.floor(this.fn() * (maxExcl - min));
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length)];
  }
}
