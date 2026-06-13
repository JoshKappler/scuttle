/** Minimal radix-2 Cooley–Tukey complex FFT, plus a 2D inverse that returns the
 *  real part. N must be a power of two. The GPU backend (oceanFFT.ts) implements
 *  the identical butterfly so its output can be checked against these. */

export interface Complex {
  re: Float32Array;
  im: Float32Array;
}

/** In-place bit-reversal permutation. */
function bitReverse(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
}

/** 1D FFT (inverse = true applies +sign twiddles, UNNORMALIZED). */
export function fft1d(reIn: ArrayLike<number>, imIn: ArrayLike<number>, inverse: boolean): Complex {
  const n = reIn.length;
  const re = Float32Array.from(reIn);
  const im = Float32Array.from(imIn);
  bitReverse(re, im);
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe;
        im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  return { re, im };
}

/** Inverse FFT (normalized by 1/n). */
export function ifft1d(reIn: ArrayLike<number>, imIn: ArrayLike<number>): Complex {
  const out = fft1d(reIn, imIn, true);
  const n = out.re.length;
  for (let i = 0; i < n; i++) {
    out.re[i] /= n;
    out.im[i] /= n;
  }
  return out;
}

/** 2D inverse FFT of an N×N complex field (row-major). Returns the real part,
 *  normalized by 1/N² — the spatial-domain field. */
export function ifft2d(re: Float32Array, im: Float32Array, N: number): Float32Array {
  const rRe = Float32Array.from(re);
  const rIm = Float32Array.from(im);
  const rowRe = new Float32Array(N);
  const rowIm = new Float32Array(N);
  // rows
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      rowRe[x] = rRe[y * N + x];
      rowIm[x] = rIm[y * N + x];
    }
    const f = fft1d(rowRe, rowIm, true);
    for (let x = 0; x < N; x++) {
      rRe[y * N + x] = f.re[x];
      rIm[y * N + x] = f.im[x];
    }
  }
  // columns
  const colRe = new Float32Array(N);
  const colIm = new Float32Array(N);
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) {
      colRe[y] = rRe[y * N + x];
      colIm[y] = rIm[y * N + x];
    }
    const f = fft1d(colRe, colIm, true);
    for (let y = 0; y < N; y++) {
      rRe[y * N + x] = f.re[y];
    }
  }
  const out = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) out[i] = rRe[i] / (N * N);
  return out;
}
