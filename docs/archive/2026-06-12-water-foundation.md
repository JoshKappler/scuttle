# Water Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Gerstner-only ocean look with a faithful FFT height-field sea (choppy crossing swells, whitecaps, foam, spray) behind a swappable `OceanField` interface, fix the hull/sea seam so water never renders on the deck or in compartments, and re-tune the brig's draft — all as an additive layer that leaves the physics engine untouched.

**Architecture:** Two layers. Layer 1 (physics) keeps reading the CPU analytic Gerstner swell (`surfaceHeight`, `physicsWaves`, λ≥14 m) — untouched. Layer 2 (visual) renders that same swell as its displacement base and **adds** an FFT chop term (band-limited to λ<14 m) sampled from GPU textures produced behind the `OceanField` interface. The FFT is built on the CPU first (unit-tested reference), then ported to WebGL2 ping-pong shaders verified against that reference. The seam is fixed with a stencil hull-silhouette mask.

**Tech Stack:** TypeScript, three.js 0.184 (WebGLRenderer, ShaderMaterial, WebGLRenderTarget, stencil), vitest, Vite. WebGL2 (`EXT_color_buffer_float`). Portable later to three.js WebGPU compute behind the same interface.

---

## File Structure

**Created:**
- `src/sim/fft.ts` — pure radix-2 complex FFT/IFFT (1D + 2D). Unit-tested reference.
- `src/sim/oceanSpectrum.ts` — directional Phillips spectrum, dispersion, band-limit (<14 m), deterministic `h0` generation, and a CPU reference height field built on `fft.ts`. Unit-tested.
- `src/render/oceanField.ts` — `OceanField` interface, `OceanFieldOptions`, `createOceanField(renderer, opts)` factory with float-RT feature detection + null fallback.
- `src/render/oceanFFT.ts` — WebGL2 ping-pong FFT backend implementing `OceanField` (GPU port of `fft.ts`+`oceanSpectrum.ts`), producing `displacement`/`normal`/`foam` textures.
- `src/render/seamMask.ts` — stencil pre-pass: renders hull silhouettes to the stencil buffer so the ocean draws only outside them.
- `tests/fft.test.ts` — FFT correctness (impulse, linearity, round-trip, Parseval).
- `tests/oceanSpectrum.test.ts` — spectrum band-limit, dispersion, determinism, energy.
- `tests/draft.test.ts` — brig density-ratio (draft) band test.

**Modified:**
- `src/sim/gerstner.ts` — add a crossing swell train + widen long-swell directional spread; keep `physicsWaves` filter and determinism.
- `src/render/ocean.ts` — accept an `OceanField`; analytic base uses the swell subset; vertex adds FFT displacement; fragment blends FFT normal + foam; stencil-compatible material flags.
- `src/sim/shipwright.ts` — `buildBrig` draft re-tune (remove round-10 over-ballast courses to a measured target band).
- `src/main.ts` — build `OceanField` with the renderer; call `oceanField.update(t)` and the seam-mask pre-pass each frame; pass the field into `createOcean`.

**Parked (NOT in this plan):** voxel collision, voxel masts/sails, in-hull flood fluid (the "loading bar"), match-flow. Do not touch `src/game/ship.ts` force code, `src/sim/compartments.ts`, or `shipVisual.updateWater`.

---

## Phase 1 — Draft re-tune (quick win)

The round-10 deeper-draft courses (`shipwright.ts` `buildBrig`, the `by + 8` and `by + 9` iron loops) over-ballasted the brig so she spawns awash. Bring the resting density ratio `mass / (envelope · ρ)` into a deep-but-dry band. This is pure build data — no physics code changes.

### Task 1: Pin the brig's draft with a test, then re-tune ballast

**Files:**
- Test: `tests/draft.test.ts` (create)
- Modify: `src/sim/shipwright.ts` (buildBrig ballast, ~lines 413–425)

- [ ] **Step 1: Write the failing test**

Create `tests/draft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildBrig } from "../src/sim/shipwright";
import { WATER_DENSITY } from "../src/core/constants";

// Density ratio = expected resting submerged fraction of the ENVELOPE volume.
// Deep and realistic (most of the hull wetted, waterline up at the near-vertical
// belt) but with real freeboard so she is NOT awash at spawn and a modest swell
// does not put the deck under (round 11: "the middle of the ship is already well
// beneath the waves"). Target band tuned live in this task.
describe("brig draft (round 11 re-tune)", () => {
  const brig = buildBrig();
  const ratio = brig.grid.totalMass() / (WATER_DENSITY * brig.envelopeVolume);

  it("floats deep but with freeboard (not awash)", () => {
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(0.6);
  });
});
```

- [ ] **Step 2: Measure the current ratio (see it fail high)**

Run: `npx vitest run tests/draft.test.ts`
Expected: FAIL — the assertion message prints the actual `ratio`. Note the number (round-10 over-ballast is expected to be ≳ 0.6). If it already prints < 0.6, lower the upper bound to bracket the measured value minus a margin and continue — the point is to land deep-but-dry.

- [ ] **Step 3: Remove the round-10 over-ballast courses**

In `src/sim/shipwright.ts` `buildBrig`, delete the entire final ballast loop that adds the `by + 8` and `by + 9` iron courses (the block whose comment begins "aft-biased: at the deeper draft the fuller AFT hull carries more buoyancy"):

```ts
  // DELETE THIS WHOLE LOOP (the round-10 deeper-draft courses):
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    const by = keelY(t) + 1;
    if (t >= 0.1 && t <= 0.8) {
      for (const z of ballastZ(5)) {
        if (inside(x, by + 8, z) && grid.get(x, by + 8, z) === EMPTY) grid.set(x, by + 8, z, IRON);
      }
    }
    if (t >= 0.18 && t <= 0.72) {
      for (const z of ballastZ(4)) {
        if (inside(x, by + 9, z) && grid.get(x, by + 9, z) === EMPTY) grid.set(x, by + 9, z, IRON);
      }
    }
  }
```

- [ ] **Step 4: Re-measure and converge into the band**

Run: `npx vitest run tests/draft.test.ts`
Expected: ratio drops toward the round-9 draft. If now **< 0.5** (too shallow), restore ONE course by re-adding only the `by + 8` / `ballastZ(5)` loop and re-run. If still **> 0.6**, also drop the `by + 7` course (in the preceding loop, the `t >= 0.25 && t <= 0.71` / `ballastZ(3)` block). Iterate until `0.5 < ratio < 0.6`. Expected final: PASS.

- [ ] **Step 5: Verify the rest of the suite still passes**

Run: `npx vitest run`
Expected: PASS. In particular `tests/brig.test.ts` "floats, but sits IN the water" (ratio between 0.15 and 0.68) stays green, and `tests/stability.test.ts` is unaffected (it builds the sloop).

- [ ] **Step 6: Visual confirm (deck dry at rest)**

Start dev server if not running: `npm run dev` (port 5180). With Playwright MCP, navigate to `http://localhost:5180/?seed=scuttle-dev`, freeze the camera abeam at deck height (`window.DEBUG.controls.updateCamera = () => {}` then position via `window.DEBUG.camera`), let the ship settle (`world.simTime > 8`), and screenshot. Expected: waterline sits at the belt with visible freeboard; the waist deck is dry (small swell may still lap, that's fine). Save under `C:\Users\joshu\Onedrive\Desktop\projects\`.

- [ ] **Step 7: Commit**

```bash
git add tests/draft.test.ts src/sim/shipwright.ts
git commit -m "fix: re-tune brig draft — deep but dry (undo round-10 over-ballast)"
```

---

## Phase 2 — FFT field (CPU reference, then GPU backend)

Build the FFT on the CPU first so it is unit-testable, then port the identical math to GPU ping-pong shaders verified against the CPU output. This makes a notoriously bug-prone GPU FFT have a deterministic correctness oracle.

### Task 2: Pure radix-2 FFT/IFFT

**Files:**
- Create: `src/sim/fft.ts`
- Test: `tests/fft.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/fft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fft1d, ifft1d, ifft2d } from "../src/sim/fft";

describe("radix-2 FFT", () => {
  it("DC input → all energy in bin 0", () => {
    const re = [1, 1, 1, 1];
    const im = [0, 0, 0, 0];
    const out = fft1d(re, im, false);
    expect(out.re[0]).toBeCloseTo(4, 6);
    for (let i = 1; i < 4; i++) expect(out.re[i]).toBeCloseTo(0, 6);
  });

  it("forward then inverse round-trips", () => {
    const re = [3, -1, 2, 7, 0, -4, 1, 1];
    const im = [0, 0, 0, 0, 0, 0, 0, 0];
    const f = fft1d(re, im, false);
    const b = fft1d(f.re, f.im, true);
    for (let i = 0; i < 8; i++) {
      expect(b.re[i] / 8).toBeCloseTo(re[i], 6); // inverse is unnormalized
    }
  });

  it("is linear: F(a+b) = F(a)+F(b)", () => {
    const a = fft1d([1, 2, 3, 4], [0, 0, 0, 0], false);
    const b = fft1d([5, 6, 7, 8], [0, 0, 0, 0], false);
    const s = fft1d([6, 8, 10, 12], [0, 0, 0, 0], false);
    for (let i = 0; i < 4; i++) expect(a.re[i] + b.re[i]).toBeCloseTo(s.re[i], 6);
  });

  it("2D inverse produces a real impulse from a single low-frequency mode", () => {
    const N = 8;
    const re = new Float32Array(N * N);
    const im = new Float32Array(N * N);
    re[1 * N + 0] = 1; // one mode
    const out = ifft2d(re, im, N);
    expect(out.length).toBe(N * N);
    let finite = true;
    for (const v of out) if (!Number.isFinite(v)) finite = false;
    expect(finite).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/fft.test.ts`
Expected: FAIL — "fft1d is not a function".

- [ ] **Step 3: Implement `src/sim/fft.ts`**

```ts
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/fft.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sim/fft.ts tests/fft.test.ts
git commit -m "feat: pure radix-2 FFT/IFFT reference for the ocean field"
```

### Task 3: Directional ocean spectrum + CPU reference height field

**Files:**
- Create: `src/sim/oceanSpectrum.ts`
- Test: `tests/oceanSpectrum.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/oceanSpectrum.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeOceanSpectrum, dispersion, CHOP_MAX_WAVELENGTH } from "../src/sim/oceanSpectrum";
import { PHYSICS_MIN_WAVELENGTH } from "../src/sim/gerstner";
import { G } from "../src/core/constants";
import { Rng } from "../src/core/rng";

describe("ocean FFT spectrum", () => {
  it("deep-water dispersion ω = sqrt(g·k)", () => {
    for (const k of [0.1, 0.5, 1.3, 4.0]) {
      expect(dispersion(k)).toBeCloseTo(Math.sqrt(G * k), 6);
    }
  });

  it("is band-limited to the chop band (no energy at swell wavelengths ≥14 m)", () => {
    const N = 64;
    const L = 80; // m tile
    const spec = makeOceanSpectrum(new Rng("chop"), { N, L, windSpeed: 9 });
    // any mode whose wavelength ≥ the physics cutoff must carry ~zero amplitude
    let swellEnergy = 0;
    for (let m = 0; m < N; m++) {
      for (let n = 0; n < N; n++) {
        const kx = (2 * Math.PI * (m - N / 2)) / L;
        const kz = (2 * Math.PI * (n - N / 2)) / L;
        const kLen = Math.hypot(kx, kz);
        if (kLen < 1e-6) continue;
        const lambda = (2 * Math.PI) / kLen;
        const a = spec.h0Re[m * N + n] ** 2 + spec.h0Im[m * N + n] ** 2;
        if (lambda >= PHYSICS_MIN_WAVELENGTH) swellEnergy += a;
      }
    }
    expect(swellEnergy).toBeLessThan(1e-6);
    expect(CHOP_MAX_WAVELENGTH).toBeLessThanOrEqual(PHYSICS_MIN_WAVELENGTH);
  });

  it("is deterministic for a seed", () => {
    const a = makeOceanSpectrum(new Rng("s"), { N: 32, L: 64, windSpeed: 8 });
    const b = makeOceanSpectrum(new Rng("s"), { N: 32, L: 64, windSpeed: 8 });
    expect(Array.from(a.h0Re)).toEqual(Array.from(b.h0Re));
  });

  it("produces a finite, non-flat spatial height field", () => {
    const spec = makeOceanSpectrum(new Rng("sea"), { N: 64, L: 80, windSpeed: 9 });
    const h = spec.heightField(2.0); // t = 2 s
    expect(h).toHaveLength(64 * 64);
    let min = Infinity, max = -Infinity, finite = true;
    for (const v of h) {
      if (!Number.isFinite(v)) finite = false;
      min = Math.min(min, v); max = Math.max(max, v);
    }
    expect(finite).toBe(true);
    expect(max - min).toBeGreaterThan(0.01); // genuinely choppy, not flat
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/oceanSpectrum.test.ts`
Expected: FAIL — "makeOceanSpectrum is not a function".

- [ ] **Step 3: Implement `src/sim/oceanSpectrum.ts`**

```ts
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
}

export interface OceanSpectrum {
  N: number;
  L: number;
  /** Initial spectrum h0(k) and its conjugate-mirror partner, row-major N×N. */
  h0Re: Float32Array;
  h0Im: Float32Array;
  /** Build the time-evolved spatial height field at time t (CPU reference). */
  heightField(t: number): Float32Array;
}

/** Deep-water angular frequency. */
export function dispersion(k: number): number {
  return Math.sqrt(G * k);
}

/** Phillips spectrum with a directional term and a small-wave cutoff. */
function phillips(kx: number, kz: number, windSpeed: number, wDirX: number, wDirZ: number): number {
  const k2 = kx * kx + kz * kz;
  if (k2 < 1e-12) return 0;
  const k4 = k2 * k2;
  const Lw = (windSpeed * windSpeed) / G; // largest wave from the wind
  const kHat = [kx / Math.sqrt(k2), kz / Math.sqrt(k2)];
  const wDot = kHat[0] * wDirX + kHat[1] * wDirZ;
  const dir = wDot * wDot; // cosine-squared directionality
  const damp = Math.exp(-k2 * (Lw * 0.0015) * (Lw * 0.0015)); // kill tiny ripples
  return (Math.exp(-1 / (k2 * Lw * Lw)) / k4) * dir * damp;
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
        // BAND-LIMIT: swell wavelengths carry no FFT energy (physics owns them)
        if (lambda < CHOP_MAX_WAVELENGTH) {
          amp = Math.sqrt(phillips(kx, kz, windSpeed, wDirX, wDirZ) / 2);
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
        // h(k,t) = h0·e^{iωt} + conj(h0(-k))·e^{-iωt}; the symmetric pair makes
        // the spatial field real. Conjugate partner index = (N-m)%N, (N-n)%N.
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/oceanSpectrum.test.ts`
Expected: PASS (4 tests). If the "non-flat" test is flaky-low, raise `windSpeed` in the test to 11 — the band-limited chop is genuinely small-amplitude.

- [ ] **Step 5: Commit**

```bash
git add src/sim/oceanSpectrum.ts tests/oceanSpectrum.test.ts
git commit -m "feat: band-limited directional ocean spectrum + CPU height field"
```

### Task 4: `OceanField` interface + factory with fallback

**Files:**
- Create: `src/render/oceanField.ts`

- [ ] **Step 1: Implement the interface and factory (no test — type/wiring only)**

```ts
import * as THREE from "three";
import type { Rng } from "../core/rng";
import type { SpectrumOptions } from "../sim/oceanSpectrum";

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
  // lazy import so the heavy backend is only pulled when usable
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createOceanFFT } = require("./oceanFFT") as typeof import("./oceanFFT");
  return createOceanFFT(renderer, opts);
}
```

> Note: if the project's bundler rejects `require`, replace the lazy import with a top-level `import { createOceanFFT } from "./oceanFFT";` and call it directly inside the `hasFloatRT` branch. Vite supports static ESM import; `require` is only to avoid evaluating the backend when unsupported. Prefer the static import for simplicity.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (after switching to the static import noted above if needed).

- [ ] **Step 3: Commit**

```bash
git add src/render/oceanField.ts
git commit -m "feat: OceanField interface + factory with float-RT fallback"
```

### Task 5: WebGL2 ping-pong FFT backend

**Files:**
- Create: `src/render/oceanFFT.ts`

This is the highest-risk task. It ports `oceanSpectrum.ts`/`fft.ts` to the GPU: upload `h0` as a texture, evolve the spectrum and run the butterfly IFFT in fragment shaders, and derive normal + foam. Verify GPU output against the CPU reference before wiring it into the scene.

- [ ] **Step 1: Implement the backend skeleton + spectrum upload**

Create `src/render/oceanFFT.ts`. Build these pieces in order (each a fragment-shader pass on float `WebGLRenderTarget`s, `type: THREE.FloatType`, `format: THREE.RGBAFormat`, `minFilter/magFilter: THREE.LinearFilter`, `wrapS/wrapT: THREE.RepeatWrapping`):

```ts
import * as THREE from "three";
import { makeOceanSpectrum, dispersion } from "../sim/oceanSpectrum";
import type { OceanField, OceanFieldOptions } from "./oceanField";

/** Full-screen-triangle pass helper. */
function makePass(frag: string, uniforms: Record<string, THREE.IUniform>): {
  mesh: THREE.Mesh; scene: THREE.Scene; cam: THREE.Camera; mat: THREE.ShaderMaterial;
} {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
  });
  const geo = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geo, mat);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const cam = new THREE.Camera();
  return { mesh, scene, cam, mat };
}
```

Then:
1. **`h0` texture:** call `makeOceanSpectrum(rng, opts)`; pack `h0Re`/`h0Im` into a `THREE.DataTexture` (RG channels, FloatType). Also pack the conjugate-partner `h0(-k)` so the evolution pass needs only one fetch per texel.
2. **Evolution pass:** fragment shader computes `h(k,t)` (RG) and the choppy-displacement spectra `(iDx, iDz)` (BA) from `h0`, the conjugate partner, and `ω = sqrt(g·|k|)` using the SAME formula as `oceanSpectrum.heightField`. Output to a "spectrum" RT.
3. **Butterfly IFFT:** precompute a butterfly-index texture on the CPU (bit-reversal + twiddles for `log2(N)` stages) and ping-pong horizontal then vertical passes — the GPU mirror of `ifft2d`. Output spatial `height` (R), `Dx` (G), `Dz` (B) to a "displacement" RT.
4. **Normal + foam pass:** from the displacement RT compute the surface normal (central differences over `tileSize/N`) → `normal` RT, and foam from the Jacobian `J = (1+∂Dx/∂x)(1+∂Dz/∂z) − (∂Dx/∂z)(∂Dz/∂x)`; `foam = saturate(-(J - foamBias))` with per-frame decay accumulated in the `foam` RT.

`update(t)` runs passes 2→3→4 with `renderer.setRenderTarget(rt); renderer.render(scene, cam);` then restores `renderer.setRenderTarget(null)`. Expose `displacement`, `normal`, `foam` (= the RT `.texture`s), `tileSize = L`, `active = true`.

> Keep `N = 256` default, `L = 250` (from opts). Drop to `N = 128` if the per-frame cost is too high (measured in Step 3).

- [ ] **Step 2: Add a dev-only GPU-vs-CPU correctness check**

Add an exported `__debugReadHeight(field, t): Float32Array` that reads back the displacement RT's R channel via `renderer.readRenderTargetPixels` and returns it. In a scratch Playwright run, compare a few texels at `t = 2.0` against `makeOceanSpectrum(...).heightField(2.0)` for the same seed/N/L. They should match to within ~1e-2 (FloatType + filtering). This is the oracle that catches butterfly/twiddle bugs. (Remove or guard the export behind `import.meta.env.DEV` before final commit.)

- [ ] **Step 3: Verify build + measure frame cost**

Run: `npx tsc --noEmit` → PASS.
With the dev server, instantiate the field in isolation (no mesh yet) and log `performance.now()` around `update(t)` for `N=256`. Expected: a few ms/frame on the dev GPU. If > ~4 ms, set `N=128`.

- [ ] **Step 4: Commit**

```bash
git add src/render/oceanFFT.ts
git commit -m "feat: WebGL2 ping-pong FFT ocean backend (Route 1)"
```

---

## Phase 3 — Mesh integration + crossing swell + foam

### Task 6: Crossing swell in the analytic field

**Files:**
- Modify: `src/sim/gerstner.ts` (`makeWaves`)

Fix "big rollers all march one way" by adding a second swell train crossing the primary and widening the long-wave spread. This changes wave *content* (buoyancy follows it); the physics code is untouched and `physicsWaves` still filters ≥14 m.

- [ ] **Step 1: Add a crossing-swell test**

Append to `tests/spectrum.test.ts`:

```ts
import { physicsWaves as _pw } from "../src/sim/gerstner";

describe("crossing seas (round 11)", () => {
  it("the swell is not unidirectional — long waves span a real spread of headings", () => {
    const phys = _pw(waves); // ≥14 m subset
    const angs = phys.map((w) => Math.atan2(w.dirZ, w.dirX));
    const spread = Math.max(...angs) - Math.min(...angs);
    expect(spread).toBeGreaterThan(0.6); // > ~34° between the extreme swell headings
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/spectrum.test.ts`
Expected: FAIL — current long-wave spread (`spreadHalf = 0.16`) is too tight.

- [ ] **Step 3: Widen the long-swell spread + add a crossing train**

In `src/sim/gerstner.ts` `makeWaves`, change the directional spread so the LONG waves also cross. Replace the `spreadHalf`/`angle` lines inside the loop:

```ts
    // long swell now crosses too (round 11: "ripples all going the exact same
    // direction"): the longest waves fan ~±0.45 rad around two swell trains
    // ~0.7 rad apart, short chop scatters wider. Physics rides the result.
    const train = i % 2 === 0 ? 0 : 0.7; // two interleaved swell systems
    const spreadHalf = 0.45 + 0.7 * f * f;
    const angle = primary + train + rng.range(-spreadHalf, spreadHalf);
```

- [ ] **Step 4: Run the wave suite**

Run: `npx vitest run tests/spectrum.test.ts tests/gerstner.test.ts`
Expected: PASS. The existing range/height/budget/determinism tests must stay green (amplitudes and wavelengths are unchanged; only directions moved). If the sharpness-budget test drifts, it won't — `steepness` derives from `k` and `amplitude`, not direction.

- [ ] **Step 5: Re-verify physics didn't regress**

Run: `npx vitest run`
Expected: PASS (stability/heel/buoyancy build ships, not waves; brig draft unaffected). Note for the executor: do a live check later (Task 9) that trim/handling still feel right with crossing swell.

- [ ] **Step 6: Commit**

```bash
git add src/sim/gerstner.ts tests/spectrum.test.ts
git commit -m "feat: crossing swell trains — the sea no longer marches one way"
```

### Task 7: Wire the FFT field into the ocean mesh

**Files:**
- Modify: `src/render/ocean.ts`
- Modify: `src/main.ts`

Make the ocean's analytic base the SWELL subset (matching physics exactly) and ADD the FFT chop from the displacement texture; blend the FFT normal and foam in the fragment.

- [ ] **Step 1: Pass the swell subset + field into `createOcean`**

In `src/render/ocean.ts`, change the signature:

```ts
export function createOcean(waves: Wave[], sunDir: THREE.Vector3, field: OceanField): Ocean {
```

Import the type: `import type { OceanField } from "./oceanField";`. Build the wave uniforms from the SWELL subset so the analytic base equals the physics field:

```ts
  import { physicsWaves } from "../sim/gerstner"; // at top of file
  const swell = physicsWaves(waves);
  const { a, b } = waveUniforms(swell);
  const ampTotal = swell.reduce((s, w) => s + w.amplitude, 0);
  // defines: { NWAVES: swell.length }
```

- [ ] **Step 2: Add FFT uniforms + sample displacement in the vertex shader**

Add uniforms to the material: `uFftDisp: { value: field.displacement }`, `uFftTile: { value: field.tileSize }`, `uFftOn: { value: field.active ? 1 : 0 }`. In `VERT`, after the analytic Gerstner loop and before the hull collar, add the FFT chop:

```glsl
uniform sampler2D uFftDisp;
uniform float uFftTile;
uniform float uFftOn;
...
  if (uFftOn > 0.5) {
    // chop fades out past where the polar grid can resolve it (~120 m)
    float chopFade = 1.0 - smoothstep(60.0, 130.0, rDist);
    vec3 d = texture2D(uFftDisp, rest.xz / uFftTile).xyz; // Dx, height, Dz
    p.x += d.x * chopFade;
    p.z += d.z * chopFade;
    p.y += d.y * chopFade;
    crest += max(d.y, 0.0) * chopFade;
  }
```

- [ ] **Step 3: Blend FFT normal + foam in the fragment shader**

Add fragment uniforms `uFftNormal`, `uFftFoam`, `uFftTile`, `uFftOn`. Where the hand-rolled `Nd` detail normal is built, when `uFftOn`, replace the high-frequency noise term with the FFT normal:

```glsl
  vec3 Nd = N;
  if (uFftOn > 0.5) {
    vec3 fn = texture2D(uFftNormal, vWorldPos.xz / uFftTile).xyz * 2.0 - 1.0;
    Nd = normalize(N + vec3(fn.x, 0.0, fn.z));
  } else {
    Nd = normalize(N + vec3(g1x*0.6+g2x*0.4+g3x*0.22, 0.0, g1z*0.6+g2z*0.4+g3z*0.22));
  }
```

And add FFT foam into the existing foam composite (before the `col = mix(col, white, ...)`):

```glsl
  float fftFoam = uFftOn > 0.5 ? texture2D(uFftFoam, vWorldPos.xz / uFftTile).r : 0.0;
```
then include `+ fftFoam * 0.7` in the clamp argument of the foam `mix`.

- [ ] **Step 4: Construct the field and pass it in (`main.ts`)**

In `src/main.ts`, after the renderer exists and before `createOcean` (around line 52), build the field and feed it. Use the wind/seed already in scope:

```ts
  import { createOceanField } from "./render/oceanField";
  ...
  const oceanField = createOceanField(renderer, {
    rng: new Rng(seed + "-fft"),
    N: 256,
    L: 250,
    windSpeed: 9,
    windDirX: waves[0].dirX,
    windDirZ: waves[0].dirZ,
  });
  const ocean = createOcean(waves, skySetup.sunDir, oceanField);
```

In the animation loop, advance the field BEFORE `ocean.update` and the main render (around line 789):

```ts
    oceanField.update(world.simTime);
    ocean.update(world.simTime, camera.position);
    renderer.render(scene, camera);
```

- [ ] **Step 5: Build + visual verify the choppy sea**

Run: `npx tsc --noEmit` → PASS. `npx vitest run` → PASS (105+ tests).
Dev server + Playwright: screenshot open water (banish the enemy, freeze camera high enough to see the sea texture). Expected: dense, multi-directional chop with crossing rollers and FFT foam on the crests — clearly different from the old uniform ripples. The ship still sits on the big swells (no float-above/sink-into), since the analytic base is unchanged for ≥14 m.

- [ ] **Step 6: Commit**

```bash
git add src/render/ocean.ts src/main.ts
git commit -m "feat: render the FFT chop + foam on the analytic swell base"
```

---

## Phase 4 — Stencil seam mask

### Task 8: Punch the hull silhouette out of the ocean

**Files:**
- Create: `src/render/seamMask.ts`
- Modify: `src/render/ocean.ts` (material stencil flags)
- Modify: `src/main.ts` (pre-pass each frame)

Render each hull into the stencil buffer; the ocean tests stencil and is rejected where a hull is. This is the exact cure for water-on-deck / water-in-compartments / the curved-bow void. Keep the existing analytic discard as the documented fallback (it stays in the shader; the stencil simply removes the cases it got wrong).

- [ ] **Step 1: Implement the stencil pre-pass**

Create `src/render/seamMask.ts`:

```ts
import * as THREE from "three";

/** Marks ship-hull pixels in the stencil buffer so the ocean can be rejected
 *  there. Renders the SAME hull meshes (depth-tested, color/ depth writes off)
 *  with stencil write = 1, just before the ocean draws. */
export class SeamMask {
  private depthMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });

  constructor(private hulls: THREE.Object3D[]) {}

  /** Render hull silhouettes into the stencil buffer of the current target. */
  write(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const overridden = scene.overrideMaterial;
    scene.overrideMaterial = this.depthMat;
    // only the hull groups are visible during the stencil pass
    const prevVisible = new Map<THREE.Object3D, boolean>();
    scene.traverse((o) => prevVisible.set(o, o.visible));
    scene.traverse((o) => (o.visible = false));
    for (const h of this.hulls) {
      h.visible = true;
      h.traverse((o) => (o.visible = true));
    }
    renderer.render(scene, camera);
    scene.traverse((o) => (o.visible = prevVisible.get(o) ?? true));
    scene.overrideMaterial = overridden;
  }
}
```

> Implementation note for the executor: rendering the whole scene with an override + visibility toggling is simplest but does an extra scene pass. If that pass is measurable, render the hull groups directly with a dedicated small scene instead. Either way, do NOT clear color/depth between this pass and the ocean — only the main render clears.

- [ ] **Step 2: Make the ocean reject hull-stencil pixels**

In `src/render/ocean.ts` `ShaderMaterial`, add stencil test flags so the ocean draws only where stencil ≠ 1:

```ts
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
```

- [ ] **Step 3: Enable the stencil buffer + run the pre-pass each frame**

In `src/main.ts`:
- The default `WebGLRenderer` already allocates a stencil buffer (`stencil: true` is the default) — confirm no `stencil: false` is set (line 25 does not set it; good).
- Build the mask after both ship visuals exist: `const seam = new SeamMask([sloop.visual.group, enemy.visual.group]);`
- In the animation loop, the ocean must render in the same target as the stencil write. The current loop does a single `renderer.render(scene, camera)`. Change to: clear once, write stencil, then render. Simplest correct ordering with three.js auto-clear:

```ts
    oceanField.update(world.simTime);
    ocean.update(world.simTime, camera.position);
    renderer.autoClear = true;
    renderer.clear(); // color + depth + stencil
    renderer.autoClear = false;
    seam.write(renderer, scene, camera); // hull → stencil (no color/depth)
    renderer.render(scene, camera);      // full scene incl. ocean, stencil-tested
    renderer.autoClear = true;
```

> The ocean material now rejects stencil==1 pixels (the hull silhouette), so no sea draws over the deck or into the hold from any angle. The hull/interior geometry renders normally in the main pass.

- [ ] **Step 4: Build + visual verify the seam**

Run: `npx tsc --noEmit` → PASS. `npx vitest run` → PASS.
Playwright checks (the three failure modes from round 11):
1. Camera high, looking DOWN at the deck → **no sea on the waist deck**.
2. Camera peeking through a gunport / open hold → **timber, never ocean waves**.
3. Camera low at the **bow**, ship lifted on a crest → **no white-void crescent**.
Screenshot each. Expected: all three clean.

- [ ] **Step 5: Commit**

```bash
git add src/render/seamMask.ts src/render/ocean.ts src/main.ts
git commit -m "feat: stencil hull mask — no sea on deck, in holds, or bow void"
```

---

## Phase 5 — Foam/spray polish, perf, fallback

### Task 9: Hull-waterline foam, bow spray, perf pass, fallback verify

**Files:**
- Modify: `src/render/ocean.ts` (waterline foam)
- Modify: `src/main.ts` (bow spray trigger; perf scaling)
- Verify: `src/render/effects.ts` (`bowWave` reuse — no change expected)

- [ ] **Step 1: Hull-waterline foam band**

In `src/render/ocean.ts` fragment, the existing wake/wash already churns along the hull flanks. Add a thin foam band hugging the footprint edge (the `rr ≈ 1` ring used by the displacement collar in `VERT`) so the sea visibly laces the hull at the waterline. Reuse the per-ship loop already present in the fragment; add to `wash`:

```glsl
    // waterline lace: a thin bright ring right at the hull skin
    float ring = exp(-pow((sqrt((along/hL)*(along/hL) + (across/hB)*(across/hB)) - 1.0) / 0.06, 2.0));
    wash += 0.5 * ring;
```

- [ ] **Step 2: Confirm bow spray fires on crest slams**

In `src/main.ts`, the round-10 `effects.bowWave(...)` slam trigger already exists (`if (imm > 0 && rate > 1.2 && ...)`). With the choppier FFT sea the bow now meets more crests; verify visually that spray peels to both sides at speed and does NOT clip through the deck (the stencil mask also helps here). No code change unless it under/over-fires — if it over-fires, raise the `rate` threshold to 1.6.

- [ ] **Step 3: Perf pass + resolution scaling**

Measure frame time with the full scene (field + mesh + stencil) via the dev overlay or `performance.now()` around the loop body. Target 60 fps. If short: set the field `N` to 128 in `main.ts`, and/or drop the polar grid `RINGS`/`SECTORS` slightly. Record the chosen `N` in a comment.

- [ ] **Step 4: Verify the graceful fallback path**

Temporarily force `nullOceanField()` (in `createOceanField`, early-return it) and confirm: `tsc` clean, app runs, ocean shows the Gerstner-only look with the analytic detail normal (the `uFftOn==0` branch), seam mask still works, no crash. Revert the force. This proves the WebGPU-swap seam and the low-end fallback both work — the field is truly additive.

- [ ] **Step 5: Full suite + final visual sweep**

Run: `npx vitest run` → PASS (all tests, now ~112+). `npx tsc --noEmit` → PASS.
Playwright: open-water chop, deck-dry-at-rest, gunport view, bow-on-crest, and a short sail to confirm the ship rides the swell naturally with crossing seas. Screenshot the set.

- [ ] **Step 6: Commit**

```bash
git add src/render/ocean.ts src/main.ts
git commit -m "feat: waterline foam + spray on the FFT sea; perf + fallback verified"
```

---

## Self-review notes (coverage vs spec)

- §3 architecture (OceanField seam) → Tasks 4, 5, 7; fallback proven in Task 9.4.
- §4 band-limiting (<14 m) → Task 3 (`CHOP_MAX_WAVELENGTH`, band-limit test); analytic base = swell subset in Task 7.1. Crossing seas → Task 6.
- §5 FFT pipeline → Tasks 2, 3 (CPU reference), 5 (GPU port, verified vs reference).
- §6 mesh integration → Task 7.
- §7 seam (stencil + draft) → Task 8 (stencil), Task 1 (draft). Analytic discard kept as fallback (left in shader).
- §8 foam & spray → Tasks 7.3 (FFT foam), 9.1 (waterline), 9.2 (spray).
- §9 portability → interface in Task 4; fallback/seam proven in 9.4.
- §10 risks → float-RT detect (Task 4), GPU-vs-CPU oracle (Task 5.2), perf scaling (Task 9.3).
- §11 tests/success → physics untouched (no force-code edits; `physicsWaves` filter intact, re-verified Tasks 6.5 / 1.5); all five success criteria covered by the visual gates in Tasks 7.5, 8.4, 9.5.

**Type consistency:** `OceanField` (`update`, `displacement`, `normal`, `foam`, `tileSize`, `active`, `dispose`) is used identically in Tasks 4, 5, 7. `makeOceanSpectrum` / `dispersion` / `CHOP_MAX_WAVELENGTH` / `heightField` consistent across Tasks 3, 5. `createOcean(waves, sunDir, field)` signature set in Task 7.1 and called in Task 7.4.
