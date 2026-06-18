# Dynamic Weather Implementation Plan

> **For agentic workers:** This plan is executed by a LEAD instance that owns the hubs
> (`tunables.ts`, `main.ts`, `weather.ts`) and integration, plus a wave of parallel Opus
> subagents that each own file-disjoint leaf modules. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the weather scale with sea roughness — clear at a regular sea, a full
thunderstorm nightmare at the wildest — with darkening clouds/sun, rain (visual+audio),
cinematic lightning (bolts + scene flash + distance-delayed thunder), plus a profile-first
collision-perf pass.

**Architecture:** One eased `storminess ∈ [0,1]` (a pure function of the existing sea-roughness
scalar; in Career a deterministic weather-front drift) owned by a `WeatherController` that fans
out to dumb leaf sinks (sky, clouds, ocean, rain, lightning, audio) through their own setters.
Pure math/curves live in `weatherMath.ts` (unit-tested). `sim/` stays pure (THE LAW #1); the only
physics touched is swell amplitude via the existing `applySeaScale` path.

**Tech Stack:** TypeScript, Three.js (ShaderMaterial uniforms, InstancedMesh), Rapier3D-compat,
Vite, Vitest. Web Audio via the existing `AudioManager`.

---

## Conventions for ALL workers (read first)

- **Shared working dir.** Many Claude instances share this one tree. **Stage only the files your
  task lists.** NEVER `git checkout/reset/stash/rebase` here. A sibling is mid-edit on
  `src/game/ship.ts`, `src/sim/crush.ts`, `tests/crush.test.ts` — **do not touch them.**
- **Subagents: no git, no dev server, no browser.** Write your file(s) and your test(s), run ONLY
  your own test file (`npx vitest run tests/<your>.test.ts`), and report. The LEAD integrates,
  runs the full `npm run build` + `npm run test`, verifies in-browser, and commits/pushes.
- **THE LAW #1:** nothing in `sim/` may change; weather is render/game only. The single physics
  input is swell amplitude, via `applySeaScale` (already supported).
- **Run a single test:** `npx vitest run tests/NAME.test.ts`
- **Full gate (lead):** `npm run build` (tsc + vite) AND `npm run test` must be green before push.
- Test files: `tests/NAME.test.ts`, `import { describe, it, expect } from "vitest";`, import source
  as `"../src/..."`.

## File structure

| File | New? | Owner | Responsibility |
|---|---|---|---|
| `src/render/weatherMath.ts` | new | sub A | pure mappings/curves (storminess, fronts, rain/lightning/thunder/wind) |
| `tests/weatherMath.test.ts` | new | sub A | unit tests for the above |
| `src/render/sky.ts` | mod | sub B | `setStorm`/`setFlash` + `uStorm`/`uFlash`; dim sun/fill lights |
| `src/render/clouds.ts` | mod | sub B | `setStorm` + `uStorm` darkening; storm-driven coverage/density/speed |
| `src/render/ocean.ts` | mod | sub C | `setStorm`/`setFlash` uniforms (storm water tint + rain dapple + flash glint) |
| `src/render/rain.ts` | new | sub D | instanced camera-locked rain streaks; `setIntensity`/`update` |
| `src/render/lightning.ts` | new | sub E | forked bolts + flash envelope; `spawnBolt`/`update`/`flash` |
| `src/render/audio.ts` | mod | sub F | rain bed + `thunder()`; manifest entries |
| `scripts/gen-audio.mjs` | mod | sub F | synth `rain_loop` + `thunder_*` placeholder WAVs |
| `src/render/weather.ts` | new | LEAD | `WeatherController` — owns storminess, fans out, schedules strikes |
| `tests/weather.test.ts` | new | LEAD | controller easing/mode/scheduling via fake sinks + injected rng |
| `src/core/tunables.ts` | mod | LEAD | `TUN.weather` block |
| `src/main.ts` | mod | LEAD | construct + wire controller; mode on Set Sail; per-frame update; audio hooks; `DEBUG.weather` |
| `src/render/devPanel.ts` *(via main.ts groups)* | mod | LEAD | `TUN.weather` sliders |

**Parallel wave:** subs A–F run concurrently (disjoint files). They depend only on the contracts
in this plan, not on each other. The LEAD pre-stages `TUN.weather` (Task 7) so any sub that wants a
knob can read it, then builds the controller (Task 8) + wiring (Task 9) once the wave returns.

---

## Task 1 (sub A): `weatherMath.ts` — pure curves (TDD)

**Files:** Create `src/render/weatherMath.ts`, `tests/weatherMath.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/weatherMath.test.ts
import { describe, it, expect } from "vitest";
import {
  clamp01, lerp, smoothstep,
  stormFromSeaScale, seaScaleFromStorm, weatherFront,
  rainIntensity, rainGain, lightningRatePerSec, thunderDelaySec, thunderVolume, windStormBoost,
  skyStormParams, cloudStormParams,
} from "../src/render/weatherMath";

describe("storminess mapping", () => {
  it("is clear through Moderate, full at Stormy", () => {
    expect(stormFromSeaScale(0.45)).toBe(0);          // Calm
    expect(stormFromSeaScale(1.0)).toBe(0);           // Moderate = "the regular one"
    expect(stormFromSeaScale(1.7)).toBeGreaterThan(0.3); // Rough = building
    expect(stormFromSeaScale(1.7)).toBeLessThan(0.6);
    expect(stormFromSeaScale(2.6)).toBe(1);           // Stormy
  });
  it("seaScaleFromStorm spans calm..full and is monotonic", () => {
    expect(seaScaleFromStorm(0)).toBeCloseTo(0.6, 5);
    expect(seaScaleFromStorm(1)).toBeCloseTo(2.6, 5);
    expect(seaScaleFromStorm(0.5)).toBeGreaterThan(seaScaleFromStorm(0.2));
  });
});

describe("weatherFront", () => {
  it("stays within [0,1] and is 0 at zero intensity", () => {
    for (let t = 0; t < 600; t += 7) {
      const v = weatherFront(t, { period: 140, intensity: 1 });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(weatherFront(t, { period: 140, intensity: 0 })).toBe(0);
    }
  });
});

describe("derived curves", () => {
  it("rain starts only once it's a bit stormy and saturates", () => {
    expect(rainIntensity(0.1)).toBe(0);
    expect(rainIntensity(1)).toBeCloseTo(1, 5);
    expect(rainGain(1)).toBeGreaterThan(rainGain(0.4));
  });
  it("lightning is none until mid-storm then grows ~quadratically", () => {
    expect(lightningRatePerSec(0.4)).toBe(0);
    expect(lightningRatePerSec(1)).toBeGreaterThan(lightningRatePerSec(0.7));
  });
  it("thunder delay is distance/speed-of-sound; volume falls with distance", () => {
    expect(thunderDelaySec(343)).toBeCloseTo(1, 3);
    expect(thunderVolume(0)).toBeGreaterThan(thunderVolume(1000));
  });
  it("wind boost rises with storm", () => {
    expect(windStormBoost(0)).toBe(0);
    expect(windStormBoost(1)).toBeGreaterThan(windStormBoost(0.5));
  });
  it("sky/cloud params darken with storm", () => {
    expect(skyStormParams(1).sunDim).toBeGreaterThan(skyStormParams(0).sunDim);
    expect(cloudStormParams(1).coverage).toBeGreaterThan(cloudStormParams(0).coverage);
    expect(cloudStormParams(1).darken).toBeGreaterThan(cloudStormParams(0).darken);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/weatherMath.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// src/render/weatherMath.ts
// Pure, Three-free weather decision logic so it is unit-testable (mirrors audioMath.ts).
// WeatherController (render/weather.ts) consumes these; nothing here touches sim/.

export const STORM_CLEAR = 1.0;  // seaScale at/below which it's fully clear ("the regular one")
export const STORM_FULL = 2.6;   // seaScale of a full nightmare (== the Stormy pill)
export const SEA_CALM = 0.6;     // swell scale at storminess 0 in Career (gentle, not glassy)
const RAIN_START = 0.25;         // storminess at which rain begins
const LIGHT_START = 0.55;        // storminess at which lightning begins
const THUNDER_REF = 250;         // m — thunder half-volume distance scale
const SOUND_MPS = 343;

export function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
export function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Sea-roughness scalar → storminess [0,1]. Clear through Moderate (≤1.0), full at Stormy (2.6). */
export function stormFromSeaScale(seaScale: number): number {
  return smoothstep(STORM_CLEAR, STORM_FULL, seaScale);
}
/** Career: storminess → swell-amplitude scale fed to applySeaScale. */
export function seaScaleFromStorm(storminess: number): number {
  return lerp(SEA_CALM, STORM_FULL, clamp01(storminess));
}

export interface FrontParams { period: number; intensity: number }
/** Deterministic smooth weather-front drift in [0,1]: mostly fair, occasional storms. */
export function weatherFront(t: number, p: FrontParams): number {
  const a = Math.sin((2 * Math.PI * t) / p.period);
  const b = Math.sin((2 * Math.PI * t) / (p.period * 0.37) + 1.3);
  const raw = 0.5 + 0.5 * (0.6 * a + 0.4 * b);     // wandering 0..1
  const shaped = Math.pow(clamp01(raw), 2.2);       // bias toward calm → storms are events
  return clamp01(shaped * p.intensity);
}

export function rainIntensity(s: number): number {
  return smoothstep(RAIN_START, 1.0, s);
}
export function rainGain(s: number): number {
  return clamp01(0.15 + 0.85 * rainIntensity(s));   // audible floor once raining
}
export function lightningRatePerSec(s: number): number {
  if (s <= LIGHT_START) return 0;
  const x = (s - LIGHT_START) / (1 - LIGHT_START);   // 0..1 above the threshold
  return 0.6 * x * x;                                 // up to ~1 strike / 1.7 s at full storm
}
export function thunderDelaySec(distanceM: number): number { return Math.max(0, distanceM) / SOUND_MPS; }
export function thunderVolume(distanceM: number): number { return clamp01(1 / (1 + Math.max(0, distanceM) / THUNDER_REF)); }
export function windStormBoost(s: number): number { return 3 * smoothstep(0.2, 1.0, s); }

export interface SkyStormParams { sunDim: number; darken: number; sunCrush: number }
export function skyStormParams(s: number): SkyStormParams {
  return { sunDim: smoothstep(0.1, 1.0, s), darken: smoothstep(0.1, 1.0, s), sunCrush: smoothstep(0.2, 0.9, s) };
}
export interface CloudStormParams { coverage: number; density: number; speed: number; darken: number }
export function cloudStormParams(s: number): CloudStormParams {
  return {
    coverage: lerp(0.5, 0.97, s),
    density: lerp(0.7, 1.0, s),
    speed: lerp(0.6, 1.8, s),
    darken: smoothstep(0.1, 1.0, s),
  };
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/weatherMath.test.ts` → PASS.
- [ ] **Step 5: Report to lead** (do NOT commit). List the exported names so the lead wires them.

---

## Task 2 (sub F): rain + thunder audio

**Files:** Modify `src/render/audio.ts`, `scripts/gen-audio.mjs`. (Do NOT edit `audioMath.ts` — weather
curves live in `weatherMath.ts`.)

- [ ] **Step 1: Add procedural rain + thunder to the generator.** In `scripts/gen-audio.mjs`, after the
existing SFX functions, add:

```js
// looping rain bed: dense filtered noise (lots of high-freq "hiss" + a little body), seamless loop.
function rainLoop() {
  const n = N(4.0), out = new Array(n);
  let lp = 0, hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const w = noise();
    lp += (w - lp) * 0.5;            // mild lowpass for body
    const hiss = w - lp;             // highpassed sparkle = "rain on water"
    hp = 0.92 * (hp + w - prev); prev = w;
    out[i] = (hiss * 0.8 + hp * 0.15) * 0.5;
  }
  return loopFade(out);
}
// thunder: a delayed low rumble with a crack, decaying over ~3-5s. `seed` varies the shape per take.
function thunder(seed = 0) {
  const n = N(4.5), out = new Array(n).fill(0);
  let r1 = 0, r2 = 0;
  const crackAt = 0.05 + 0.04 * seed;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    r1 += (noise() - r1) * 0.04;                   // deep rumble
    r2 += (noise() - r2) * 0.12;                   // mid body
    const crack = Math.exp(-90 * Math.abs(t - crackAt)) * noise(); // the initial CRACK
    const body = (r1 * 1.0 + r2 * 0.5) * Math.exp(-0.8 * t);       // rolling rumble
    out[i] = Math.tanh((crack * 0.8 + body * 1.4) * 1.2) * env(i, n, 0.002, 1.2);
  }
  return out;
}
```

And register them with the other `save(...)` calls:

```js
save("ambient/rain_loop.wav", rainLoop());
save("sfx/thunder_1.wav", thunder(0));
save("sfx/thunder_2.wav", thunder(1));
save("sfx/thunder_3.wav", thunder(2));
```

- [ ] **Step 2: Generate the assets** — `node scripts/gen-audio.mjs` → prints `wrote .../rain_loop.wav`
and the three thunder files. (These are placeholders; real CC0 drops in later.)

- [ ] **Step 3: Wire them into `AudioManager`** (`src/render/audio.ts`):
  - Add to `MANIFEST`:
    ```ts
    rain_loop: "ambient/rain_loop.wav",
    thunder: ["sfx/thunder_1.wav", "sfx/thunder_2.wav", "sfx/thunder_3.wav"],
    ```
  - Add a rain bed field next to `ocean`/`wind`: `private rain: THREE.Audio;` and in the constructor
    `this.rain = new THREE.Audio(listener);`
  - Generalize `ambient(which, on, gain)` to accept `"rain"`:
    ```ts
    ambient(which: "ocean" | "wind" | "rain", on: boolean, gain?: number): void {
      const v = which === "ocean" ? this.ocean : which === "wind" ? this.wind : this.rain;
      const id = which === "ocean" ? "ocean_loop" : which === "wind" ? "wind_loop" : "rain_loop";
      const dflt = which === "ocean" ? OCEAN_GAIN : which === "wind" ? WIND_BASE : 0.5;
      const buf = this.buffers.get(id)?.[0];
      if (!buf) return;
      if (on) {
        if (!v.buffer) { v.setBuffer(buf); v.setLoop(true); }
        v.setVolume(gain ?? dflt);
        if (!v.isPlaying) v.play();
      } else if (v.isPlaying) { v.setVolume(0); }
    }
    ```
  - Add a thunder one-shot (non-positional, enveloping):
    ```ts
    /** A thunderclap — 2D so it surrounds regardless of where the bolt struck. */
    thunder(volume: number): void { this.playUi("thunder", { volume: Math.max(0, Math.min(1, volume)) }); }
    ```

- [ ] **Step 4: Sanity check** — `npx tsc --noEmit -p tsconfig.json` is the lead's job; the sub just
re-reads the diff to confirm no `audioMath.ts` edit and the union type compiles. Report to lead.

---

## Task 3 (sub B): sky + clouds storm darkening

**Files:** Modify `src/render/sky.ts`, `src/render/clouds.ts`.

- [ ] **Step 1: `sky.ts` — add `uStorm` + `uFlash` to the dome shader.** In `DOME_FRAG`, add uniforms
and apply after the base color + sun are computed, before `gl_FragColor`:

```glsl
uniform float uStorm;   // 0..1
uniform float uFlash;   // 0..1 lightning flash
// ... existing color/sun code ...
  // STORM: drag the whole sky toward a dark slate and crush the sun disc/halo.
  vec3 slate = vec3(0.06, 0.08, 0.10);
  col = mix(col, slate, uStorm * 0.85);
  // FLASH: a brief desaturated brighten (lightning lights the cloud deck).
  col += vec3(0.9, 0.92, 1.0) * uFlash;
  gl_FragColor = vec4(col, 1.0);
```

Add the uniforms to `domeMat.uniforms`: `uStorm: { value: 0 }, uFlash: { value: 0 }`.

- [ ] **Step 2: `sky.ts` — sun crush in the disc/halo.** Multiply the sun contribution by
`(1.0 - uStorm)` so the sun fades out as the storm thickens:
```glsl
  col += uSunColor * halo * (1.0 - uStorm);
  col += uSunColor * disc * 8.0 * (1.0 - uStorm);
```
(Place these BEFORE the slate mix so the slate also covers the residual.)

- [ ] **Step 3: `sky.ts` — `setStorm`/`setFlash` on `SkySetup`.** Capture the base light intensities
in `createSky` (`const baseSun = sunLight.intensity, baseFill = fillLight.intensity;`) and add to the
returned object:

```ts
setStorm(s: number) {
  const k = Math.max(0, Math.min(1, s));
  domeMat.uniforms.uStorm.value = k;
  // dim + grey the direct + fill light so lit hulls go flat-overcast, not sunny.
  sunLight.intensity = baseSun * (1 - 0.85 * k);
  fillLight.intensity = baseFill * (1 - 0.45 * k);
  sunLight.shadow.needsUpdate = true;
},
setFlash(f: number) { domeMat.uniforms.uFlash.value = Math.max(0, f); },
```
Add `setStorm(s: number): void;` and `setFlash(f: number): void;` to the `SkySetup` interface.

- [ ] **Step 4: `clouds.ts` — `uStorm` darkening + storm-driven params.** Add `uniform float uStorm;`
to `FRAG`; after `col` is computed, before output:
```glsl
  // STORM: charcoal the bases and kill the bright sunlit tops so it reads as heavy overcast.
  vec3 storm = vec3(0.10, 0.11, 0.13);
  col = mix(col, storm, uStorm * 0.8);
```
Add `uStorm: { value: 0 }` to the uniforms. Store a storm field + a `setStorm`:
```ts
private storm = 0;
setStorm(s: number): void { this.storm = Math.max(0, Math.min(1, s)); }
```
In `update()`, blend the live TUN base toward storm targets by `this.storm` and push `uStorm`:
```ts
import { cloudStormParams } from "./weatherMath";
// inside update(), replacing the three direct TUN assignments:
const p = cloudStormParams(this.storm);
this.mat.uniforms.uCoverage.value = Math.max(TUN.gfx.clouds.coverage, p.coverage);
this.mat.uniforms.uDensity.value  = Math.max(TUN.gfx.clouds.density, p.density);
this.mat.uniforms.uSpeed.value    = Math.max(TUN.gfx.clouds.speed, p.speed);
this.mat.uniforms.uStorm.value    = p.darken;
```

- [ ] **Step 5: Report to lead.** No unit test (GLSL). The lead verifies in-browser at storminess
0/0.5/1.0. Confirm `setStorm`/`setFlash` signatures match this plan exactly.

---

## Task 4 (sub C): ocean storm hooks (scoped edit)

**Files:** Modify `src/render/ocean.ts` ONLY. Do not touch swell/physics; visual uniforms only.

- [ ] **Step 1: Extend the `Ocean` interface** (near line 77, by `setChop`):
```ts
/** Storminess 0..1 → darken/desaturate the body + add a rain dapple. VISUAL only. */
setStorm(s: number): void;
/** Lightning flash 0..1 from horizontal direction (dx,dz) → a brief specular brighten. */
setFlash(f: number, dx: number, dz: number): void;
```

- [ ] **Step 2: Add the uniforms** where the ocean ShaderMaterial uniforms are declared:
`uStorm: { value: 0 }, uFlash: { value: 0 }, uFlashDir: { value: new THREE.Vector2(0, 1) }`.

- [ ] **Step 3: In the ocean FRAGMENT shader**, after the final water color is composed and before
output, fold storm + flash in (adapt variable names to the file's existing color var):
```glsl
uniform float uStorm; uniform float uFlash; uniform vec2 uFlashDir;
  // STORM: darker, less saturated, choppier-looking body.
  vec3 stormCol = mix(color.rgb, vec3(0.02, 0.035, 0.05), uStorm * 0.6);
  color.rgb = stormCol;
  // RAIN DAPPLE: high-freq sparkle on the surface (cheap value noise on world xz + time), gated by storm.
  float dap = fract(sin(dot(floor(vWorldPos.xz * 6.0), vec2(12.99, 78.23))) * 43758.5);
  color.rgb += uStorm * 0.04 * smoothstep(0.92, 1.0, dap);
  // FLASH: a directional specular pop (the bolt lighting the sea from its side).
  float fd = max(0.0, dot(normalize(vec3(uFlashDir.x, 0.6, uFlashDir.y)), normalize(vNormal)));
  color.rgb += vec3(0.7, 0.75, 0.9) * uFlash * (0.3 + 0.7 * fd);
```
If the shader lacks a world-position/normal varying, reuse whatever it already has for reflection
(it computes a Fresnel + normal already); keep the dapple cheap.

- [ ] **Step 4: Implement the setters** in the returned `Ocean` object:
```ts
setStorm(s) { mat.uniforms.uStorm.value = Math.max(0, Math.min(1, s)); },
setFlash(f, dx, dz) { mat.uniforms.uFlash.value = Math.max(0, f); mat.uniforms.uFlashDir.value.set(dx, dz); },
```
(Use the actual material variable name in this file — likely `mat`/`surfaceMat`.)

- [ ] **Step 5: Report to lead** with the exact material var used + confirm the two signatures.

---

## Task 5 (sub D): rain system

**Files:** Create `src/render/rain.ts`.

- [ ] **Step 1: Implement an instanced, camera-locked rain volume.**

```ts
// src/render/rain.ts
import * as THREE from "three";

/**
 * Camera-locked GPU-instanced rain. A fixed pool of streak instances lives in a box around the
 * camera; each falls and recycles to the top. setIntensity scales how many are visible + their
 * opacity/length. VISUAL only (THE LAW #1). Heavy rain naturally cuts visibility (no fog mechanic).
 */
const BOX = 60;          // half-extent (m) of the rain box around the camera
const FALL = 26;         // m/s fall speed
export class RainSystem {
  readonly object: THREE.Group;
  private mesh: THREE.InstancedMesh;
  private max: number;
  private count = 0;
  private offs: Float32Array;     // per-instance [x,y,z] within the box
  private mat: THREE.MeshBasicMaterial;
  private dummy = new THREE.Object3D();
  private intensity = 0;

  constructor(max = 4000) {
    this.max = max;
    const geo = new THREE.PlaneGeometry(0.025, 1.4);     // a thin vertical streak
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xaebccc, transparent: true, opacity: 0.35, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.offs = new Float32Array(max * 3);
    for (let i = 0; i < max; i++) {
      this.offs[i * 3] = (Math.random() * 2 - 1) * BOX;
      this.offs[i * 3 + 1] = (Math.random() * 2 - 1) * BOX;
      this.offs[i * 3 + 2] = (Math.random() * 2 - 1) * BOX;
    }
    this.object = new THREE.Group();
    this.object.add(this.mesh);
    this.mesh.count = 0;
  }

  setIntensity(i: number): void { this.intensity = Math.max(0, Math.min(1, i)); }

  update(dt: number, cam: THREE.Vector3): void {
    const target = Math.floor(this.intensity * this.max);
    this.mesh.count = target;
    this.mat.opacity = 0.15 + 0.35 * this.intensity;
    const slant = 1.5 * this.intensity;                  // wind slant
    const sy = 0.6 + 1.2 * this.intensity;               // longer streaks in heavy rain
    for (let i = 0; i < target; i++) {
      let y = this.offs[i * 3 + 1] - FALL * dt;
      if (y < -BOX) y += 2 * BOX;                          // recycle to top
      this.offs[i * 3 + 1] = y;
      this.dummy.position.set(cam.x + this.offs[i * 3], cam.y + y, cam.z + this.offs[i * 3 + 2]);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, sy, 1);
      this.dummy.position.x += slant * 0.4;
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
```

- [ ] **Step 2: Report to lead.** No unit test (visual). Confirm the class shape:
`object`, `setIntensity(i)`, `update(dt, cam)`, `dispose()`. Lead adds `object` to the scene and
calls `update` each frame, verifies in-browser.

---

## Task 6 (sub E): lightning system

**Files:** Create `src/render/lightning.ts`.

- [ ] **Step 1: Implement forked bolts + a flash envelope.**

```ts
// src/render/lightning.ts
import * as THREE from "three";

/**
 * Cinematic lightning: forked bolts (midpoint-displaced polylines) that flash and fade, plus a
 * scene-wide flash envelope the WeatherController reads and pushes to sky/ocean (so the water and
 * hulls light from the strike side). Scheduling lives in the controller; this is a dumb visual.
 */
interface Bolt { line: THREE.LineSegments; mat: THREE.LineBasicMaterial; age: number; life: number; }
export class LightningSystem {
  readonly object: THREE.Group;
  private bolts: Bolt[] = [];
  private flashEnv = 0;            // current 0..1 flash
  private flashDecay = 0;
  private dir: [number, number] = [0, 1];

  constructor() { this.object = new THREE.Group(); }

  /** dx,dz = horizontal unit dir to the strike; distance in m; intensity 0..1. */
  spawnBolt(dx: number, dz: number, distance: number, intensity: number): void {
    const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
    this.dir = [dx, dz];
    // strike point on the horizon ring at `distance`, bolt from cloud height down to the sea.
    const sx = dx * distance, sz = dz * distance;
    const top = new THREE.Vector3(sx + (Math.random() - 0.5) * 40, 380, sz + (Math.random() - 0.5) * 40);
    const bottom = new THREE.Vector3(sx, 0, sz);
    const pts = this.fork(top, bottom, 6);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: 0xcfe0ff, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const line = new THREE.LineSegments(geo, mat);
    line.frustumCulled = false;
    this.object.add(line);
    this.bolts.push({ line, mat, age: 0, life: 0.18 });
    // flash envelope: bright, fast attack; nearer + stronger = brighter.
    const near = 1 / (1 + distance / 300);
    this.flashEnv = Math.min(1, 0.5 + 0.7 * intensity * near);
    this.flashDecay = 3.0;
  }

  /** Build a fork: a displaced main channel as LINE SEGMENTS, plus a couple of branches. */
  private fork(a: THREE.Vector3, b: THREE.Vector3, depth: number): THREE.Vector3[] {
    let path = [a, b];
    for (let d = 0; d < depth; d++) {
      const next: THREE.Vector3[] = [];
      for (let i = 0; i < path.length - 1; i++) {
        const p = path[i], q = path[i + 1];
        const m = p.clone().lerp(q, 0.5);
        const jitter = (q.y - p.y) * 0.18 * (Math.random() - 0.5);
        m.x += jitter; m.z += jitter * 0.5;
        next.push(p, m);
        if (d > 2 && Math.random() < 0.25) {              // a branch
          const bx = m.clone().add(new THREE.Vector3((Math.random() - 0.5) * 60, -40 - Math.random() * 60, (Math.random() - 0.5) * 60));
          next.push(m.clone(), bx);
        }
      }
      next.push(path[path.length - 1]);
      path = next;
    }
    // LineSegments wants pairs; expand the polyline into consecutive segment endpoints.
    const seg: THREE.Vector3[] = [];
    for (let i = 0; i < path.length - 1; i++) { seg.push(path[i], path[i + 1]); }
    return seg;
  }

  update(dt: number): void {
    if (this.flashEnv > 0) { this.flashEnv = Math.max(0, this.flashEnv - this.flashDecay * dt); }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.age += dt;
      const k = 1 - b.age / b.life;
      b.mat.opacity = Math.max(0, k) * (0.6 + 0.4 * Math.sin(b.age * 80)); // flicker
      if (b.age >= b.life) {
        this.object.remove(b.line);
        b.line.geometry.dispose(); b.mat.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  flash(): number { return this.flashEnv; }
  flashDir(): [number, number] { return this.dir; }
  dispose(): void { for (const b of this.bolts) { b.line.geometry.dispose(); b.mat.dispose(); } this.bolts.length = 0; }
}
```

- [ ] **Step 2: Report to lead.** No unit test (visual). Confirm the shape:
`object`, `spawnBolt(dx,dz,distance,intensity)`, `update(dt)`, `flash()`, `flashDir()`, `dispose()`.

---

## Task 7 (LEAD): `TUN.weather` knobs (pre-stage before the wave)

**Files:** Modify `src/core/tunables.ts`.

- [ ] **Step 1: Add the block** at the end of the `TUN` object (after `gfx`):
```ts
  /** Dynamic weather (render/weather.ts) — storms scale with sea roughness. Pure visuals/audio +
   *  swell amplitude (the only physics input, via applySeaScale). NOT read by the vitest oracle. */
  weather: {
    /** -1 = auto (sandbox: from the pill; career: weather fronts). 0..1 forces storminess for testing. */
    override: -1,
    /** storminess ease rate toward target (per second). */
    ease: 0.15,
    /** multipliers so the feel can be dialed live. */
    rain: 1, lightning: 1, cloudDark: 1, skyDark: 1, windBoost: 1,
    /** career weather-front shape. */
    frontPeriod: 140, frontIntensity: 1,
  },
```
- [ ] **Step 2:** `npx tsc --noEmit` clean. Commit (lead may commit hubs as it goes):
```bash
git add src/core/tunables.ts
git commit -m "feat(weather): TUN.weather live knobs"
```

---

## Task 8 (LEAD): `WeatherController` (TDD with fake sinks)

**Files:** Create `src/render/weather.ts`, `tests/weather.test.ts`. Depends on Task 1 (weatherMath).

- [ ] **Step 1: Write the failing test** (injected fake sinks + deterministic rng):
```ts
// tests/weather.test.ts
import { describe, it, expect } from "vitest";
import { WeatherController, type WeatherSinks } from "../src/render/weather";

function fakeSinks() {
  const calls: any = { storm: [], flash: [], rain: [], swell: [], bolts: 0, thunder: [] };
  const sinks: WeatherSinks = {
    sky: { setStorm: (s) => calls.storm.push(s), setFlash: (f) => calls.flash.push(f) },
    clouds: { setStorm: () => {} },
    ocean: { setStorm: () => {}, setFlash: () => {} },
    rain: { setIntensity: (i) => calls.rain.push(i), update: () => {} },
    lightning: { spawnBolt: () => { calls.bolts++; }, update: () => {}, flash: () => 0, flashDir: () => [0, 1] },
    audio: { ambient: () => {}, setWind: () => {}, thunder: (v) => calls.thunder.push(v) },
    applySwell: (s) => calls.swell.push(s),
    baseWind: () => 0,
  };
  return { sinks, calls };
}
const cam = { x: 0, y: 2, z: 0 } as any;

describe("WeatherController", () => {
  it("eases storminess toward the fixed target", () => {
    const { sinks } = fakeSinks();
    const w = new WeatherController(sinks);
    w.setMode("fixed", 1);
    for (let i = 0; i < 600; i++) w.update(0.1, i * 0.1, cam, true);
    expect(w.storminess).toBeGreaterThan(0.95);
  });
  it("dynamic mode drives the swell from the front", () => {
    const { sinks, calls } = fakeSinks();
    const w = new WeatherController(sinks, () => 0.99); // rng: never fires lightning
    w.setMode("dynamic");
    for (let i = 0; i < 50; i++) w.update(0.1, i * 0.1, cam, true);
    expect(calls.swell.length).toBeGreaterThan(0);
    for (const s of calls.swell) { expect(s).toBeGreaterThanOrEqual(0.6); expect(s).toBeLessThanOrEqual(2.6); }
  });
  it("fires bolts + schedules thunder at full storm, none when inactive", () => {
    const { sinks, calls } = fakeSinks();
    const w = new WeatherController(sinks, () => 0.0001); // rng: always fires when rate>0
    w.setMode("fixed", 1);
    for (let i = 0; i < 50; i++) w.update(0.1, i * 0.1, cam, true);
    expect(calls.bolts).toBeGreaterThan(0);
    const before = calls.bolts;
    for (let i = 0; i < 50; i++) w.update(0.1, i * 0.1, cam, false); // inactive (menu/pause)
    expect(calls.bolts).toBe(before);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/weather.test.ts` → FAIL.

- [ ] **Step 3: Implement** `src/render/weather.ts`:
```ts
import * as THREE from "three";
import { TUN } from "../core/tunables";
import {
  clamp01, stormFromSeaScale, seaScaleFromStorm, weatherFront,
  rainIntensity, rainGain, lightningRatePerSec, thunderDelaySec, thunderVolume, windStormBoost,
} from "./weatherMath";

export interface WeatherSinks {
  sky: { setStorm(s: number): void; setFlash(f: number): void };
  clouds: { setStorm(s: number): void };
  ocean: { setStorm(s: number): void; setFlash(f: number, dx: number, dz: number): void };
  rain: { setIntensity(i: number): void; update(dt: number, cam: THREE.Vector3): void };
  lightning: {
    spawnBolt(dx: number, dz: number, distance: number, intensity: number): void;
    update(dt: number): void; flash(): number; flashDir(): [number, number];
  };
  audio: { ambient(which: "ocean" | "wind" | "rain", on: boolean, gain?: number): void; setWind(i: number): void; thunder(volume: number): void };
  applySwell: (seaScale: number) => void;
  baseWind: () => number;
}

export class WeatherController {
  storminess = 0;
  private target = 0;
  private mode: "fixed" | "dynamic" = "fixed";
  private pending: { at: number; vol: number }[] = [];
  private clock = 0;
  private lastSwell = -1;
  private swellThrottle = 0;

  constructor(private s: WeatherSinks, private rng: () => number = Math.random) {}

  setMode(mode: "fixed" | "dynamic", fixedTarget = 0): void {
    this.mode = mode;
    if (mode === "fixed") this.target = clamp01(fixedTarget);
  }

  /** active = at sea (playing/port). In menu/pause we freeze schedules + mute rain. */
  update(dt: number, simTime: number, cam: THREE.Vector3, active: boolean): void {
    this.clock += dt;
    // target
    if (TUN.weather.override >= 0) this.target = clamp01(TUN.weather.override);
    else if (this.mode === "dynamic") this.target = weatherFront(simTime, { period: TUN.weather.frontPeriod, intensity: TUN.weather.frontIntensity });
    // ease
    const k = 1 - Math.exp(-TUN.weather.ease * dt * 6);
    this.storminess += (this.target - this.storminess) * k;
    const s = this.storminess;

    // career swell follows storminess (throttled GPU re-upload)
    this.swellThrottle -= dt;
    if (this.mode === "dynamic" && this.swellThrottle <= 0) {
      const sea = seaScaleFromStorm(s);
      if (Math.abs(sea - this.lastSwell) > 0.01) { this.s.applySwell(sea); this.lastSwell = sea; }
      this.swellThrottle = 0.25;
    }

    // fan out visuals
    this.s.sky.setStorm(s * TUN.weather.skyDark);
    this.s.clouds.setStorm(s * TUN.weather.cloudDark);
    this.s.ocean.setStorm(s);
    this.s.rain.setIntensity(active ? rainIntensity(s) * TUN.weather.rain : 0);
    this.s.rain.update(dt, cam);
    this.s.lightning.update(dt);

    // flash push (lightning lighting sky + sea)
    const f = this.s.lightning.flash();
    this.s.sky.setFlash(f);
    const fd = this.s.lightning.flashDir();
    this.s.ocean.setFlash(f, fd[0], fd[1]);

    // audio beds
    this.s.audio.ambient("rain", active && rainIntensity(s) > 0.02, rainGain(s) * TUN.weather.rain);
    this.s.audio.setWind(this.s.baseWind() + (active ? windStormBoost(s) * TUN.weather.windBoost : 0));

    if (active) {
      // schedule strikes (Poisson)
      const rate = lightningRatePerSec(s) * TUN.weather.lightning;
      if (rate > 0 && this.rng() < rate * dt) this.fireStrike(cam, s);
      // fire due thunder
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.clock >= this.pending[i].at) { this.s.audio.thunder(this.pending[i].vol); this.pending.splice(i, 1); }
      }
    }
  }

  private fireStrike(cam: THREE.Vector3, s: number): void {
    const ang = this.rng() * Math.PI * 2;
    const dist = 150 + this.rng() * 900;
    const dx = Math.cos(ang), dz = Math.sin(ang);
    this.s.lightning.spawnBolt(dx, dz, dist, s);
    this.pending.push({ at: this.clock + thunderDelaySec(dist), vol: thunderVolume(dist) });
  }

  triggerStrike(cam: THREE.Vector3): void { this.fireStrike(cam, Math.max(0.6, this.storminess)); }
}
```

- [ ] **Step 4: Run to verify it passes** — `npx vitest run tests/weather.test.ts` → PASS.
- [ ] **Step 5: Commit** (lead):
```bash
git add src/render/weather.ts tests/weather.test.ts
git commit -m "feat(weather): WeatherController + tests"
```

---

## Task 9 (LEAD): wire it into main.ts + dev panel + DEBUG

**Files:** Modify `src/main.ts` (+ the dev-panel group list it builds). Depends on subs A–F + Tasks 7–8.

- [ ] **Step 1: Import + construct.** Near the scene/sky/clouds/ocean/audio setup (~lines 231–276),
after those exist:
```ts
import { RainSystem } from "./render/rain";
import { LightningSystem } from "./render/lightning";
import { WeatherController } from "./render/weather";
import { stormFromSeaScale } from "./render/weatherMath";
import { applySeaScale } from "./sim/gerstner"; // already imported
// ...
const rain = new RainSystem();
const lightning = new LightningSystem();
scene.add(rain.object);
scene.add(lightning.object);
const weather = new WeatherController({
  sky: skySetup, clouds, ocean, rain, lightning, audio,
  applySwell: (sea) => { applySeaScale(waves, sea); ocean.refreshSwell(); },
  baseWind: () => Math.hypot(playerVel().x, playerVel().z), // use the same value the audio block uses
});
```
(Reuse whatever expression the existing audio block at ~1957 passes to `audio.setWind`; factor it
into a small `baseWindIntensity()` helper so both call sites share it — DRY.)

- [ ] **Step 2: Set mode on Set Sail** (~line 1902, the `applySeaScale` site):
```ts
if (choice.kind === "sandbox") {
  applySeaScale(waves, choice.cfg.seaRoughness);
  ocean.refreshSwell();
  weather.setMode("fixed", stormFromSeaScale(choice.cfg.seaRoughness));
} else {
  weather.setMode("dynamic"); // career: weather fronts drive the swell live
}
```

- [ ] **Step 3: Drive it each frame.** In the render loop near `clouds.update` / `ocean.setChop`
(~2202–2215), REMOVE the now-controller-owned `clouds.update` storminess concerns are internal; keep
`clouds.update(world.simTime, camera.position)` (clouds still self-update drift), and add:
```ts
const atSea = gs.phase === "playing" || gs.phase === "port";
weather.update(dtSeconds, world.simTime, camera.position, atSea);
```
(`dtSeconds` = the same real-frame dt used elsewhere in the loop; if the loop uses a clamped value,
reuse it.)

- [ ] **Step 4: Audio block (~1944–1992).** The controller now owns the rain bed + wind storm-boost +
thunder. Leave the ocean/wind beds + music/underwater as-is, but REMOVE the standalone
`audio.setWind(...)` at ~1957 (the controller now sets wind = base + storm). Keep underwater/music.

- [ ] **Step 5: Dev panel + DEBUG.** Add a "Weather" group to the `PanelGroup[]` passed to
`createDevPanel`:
```ts
{
  title: "Weather",
  controls: [
    { type: "slider", label: "override (-1=auto)", obj: TUN.weather, key: "override", min: -1, max: 1, step: 0.01 },
    { type: "slider", label: "ease", obj: TUN.weather, key: "ease", min: 0.02, max: 1, step: 0.01 },
    { type: "slider", label: "rain", obj: TUN.weather, key: "rain", min: 0, max: 2, step: 0.05 },
    { type: "slider", label: "lightning", obj: TUN.weather, key: "lightning", min: 0, max: 3, step: 0.05 },
    { type: "slider", label: "cloudDark", obj: TUN.weather, key: "cloudDark", min: 0, max: 1.5, step: 0.05 },
    { type: "slider", label: "skyDark", obj: TUN.weather, key: "skyDark", min: 0, max: 1.5, step: 0.05 },
    { type: "slider", label: "windBoost", obj: TUN.weather, key: "windBoost", min: 0, max: 2, step: 0.05 },
    { type: "slider", label: "frontPeriod", obj: TUN.weather, key: "frontPeriod", min: 30, max: 400, step: 5 },
    { type: "slider", label: "frontIntensity", obj: TUN.weather, key: "frontIntensity", min: 0, max: 1, step: 0.05 },
    { type: "button", label: "strike now", onClick: () => weather.triggerStrike(camera.position) },
  ],
},
```
And expose on `window.DEBUG`: add `weather,` to the DEBUG object literal.

- [ ] **Step 6: Full gate.** `npm run build` (tsc + vite) AND `npm run test` → green.
- [ ] **Step 7: Commit + push.**
```bash
git add src/main.ts src/core/tunables.ts src/render/weather.ts src/render/weatherMath.ts \
        src/render/sky.ts src/render/clouds.ts src/render/ocean.ts src/render/rain.ts \
        src/render/lightning.ts src/render/audio.ts scripts/gen-audio.mjs \
        public/assets/audio/ambient/rain_loop.wav public/assets/audio/sfx/thunder_1.wav \
        public/assets/audio/sfx/thunder_2.wav public/assets/audio/sfx/thunder_3.wav \
        tests/weatherMath.test.ts tests/weather.test.ts
git commit -m "feat(weather): dynamic storms tied to sea roughness (sky/cloud/sun, rain, lightning, thunder)"
git push origin main
```

---

## Task 10 (LEAD): in-browser verification

- [ ] **Step 1: Ensure the dev server is on 5173** (`npm run dev` if not already).
- [ ] **Step 2: Drive via Playwright MCP.** Boot, Sandbox, set Seas = Stormy, Set Sail. Then set
`DEBUG.TUN.weather.override` to 0, 0.5, 1.0 in turn and screenshot each; call
`DEBUG.weather.triggerStrike(DEBUG.camera.position)` and screenshot a flash + bolt. Save to the
projects root (`projects/weather-*.png`) and Read them.
- [ ] **Step 3: Verify:** clear at override 0 (sun visible); overcast + rain at 0.5; dark, sun blotted,
heavy rain + bolts/flash + thunder audible at 1.0. Career: leave override -1 and confirm the sky
drifts over ~1–2 front periods. Fix shader constants live via `TUN` then bake the good values.
- [ ] **Step 4: Confirm no perf regression** with `DEBUG.world.timing` open (rain instance count is the
lever; lower `RainSystem` `max` or gate by the governor if needed).

---

## Task 11 (LEAD): collision-perf pass (profile-first)

**Files:** TBD by measurement (likely `src/game/ship.ts` collider-rebuild path — coordinate with the
sibling editing it — `src/game/voxelContact.ts`, `src/game/world.ts`, `src/game/physics.ts`).

- [ ] **Step 1: Reproduce.** In-browser, ram an enemy / an island with `DEBUG.world.timing` shown.
Record the per-phase ms (`flood/buoy/contact/flush/rapier/visual`) during the hitch.
- [ ] **Step 2: Single-step readback** for a clean profile:
`for (let i=0;i<30;i++) DEBUG.world.step(1/60); JSON.stringify(DEBUG.world.timing)` right as the ram
lands (immune to headless time-compression).
- [ ] **Step 3: Attribute the spike.** Decision tree:
  - `flush` dominates → the deck-collider trimesh rebuild (`ship.flushDamage`/`rebuildDeckCollider`).
    Fix: widen the debounce window, build a cheaper/decimated collider, or skip the rebuild while
    carving is ongoing. (This is the real "Rapier is slow" cost — a Rapier trimesh build.)
  - `contact` dominates → carve cost. Fix: cap cells carved/step, reuse scratch, cheaper `findSevered`.
  - `buoy` dominates → buoyancy. Fix: coarser wave-sampling LOD for non-focus ships during contact.
  - `rapier` dominates → audit collider/contact counts; cap debris bodies; confirm ship-ship pairs are
    still filtered out of the solver (`physics.ts` hook + EventQueue present).
  - `visual` dominates → throttle the post-carve remesh.
- [ ] **Step 4: Apply ONE targeted fix**, re-measure, confirm a real drop. Repeat only if a second
phase now dominates. Do NOT speculatively rewrite.
- [ ] **Step 5: Coordinate writes.** If the fix is in `ship.ts` (sibling is mid-edit), either wait for
their push or make the change in a way that doesn't collide (e.g., `world.ts`/`physics.ts`); never
clobber their working copy.
- [ ] **Step 6: Build + test + commit + push** each fix separately with a measured before/after note.

---

## Self-review

**Spec coverage:**
- Storminess model + mapping → Task 1 (`weatherMath`) + Task 8 (controller easing/mode). ✓
- Sandbox fixed / Career dynamic + swell follow → Task 8 + Task 9 Step 2. ✓
- Sky/sun darkening → Task 3. ✓ Cloud thickening/darkening → Task 3. ✓
- Ocean storm tint + dapple + flash glint → Task 4. ✓
- Rain visual → Task 5. Rain audio bed → Task 2 + controller. ✓
- Cinematic lightning (bolts + flash lights scene + distance-delayed thunder) → Task 6 (bolts/flash) +
  Task 8 (schedule + thunder timing) + Task 4/3 (flash on sea/sky). ✓
- Atmospheric-only / no fog mechanic → no visibility clamp anywhere; rain density only. ✓
- Dev knobs `TUN.weather` + `DEBUG.weather` → Task 7 + Task 9 Step 5. ✓
- THE LAW / determinism → only `applySeaScale` swell touched; `sim/` untouched; pure helpers tested. ✓
- Testing (unit + in-browser) → Tasks 1, 8 (unit), 10 (browser). ✓
- Performance profile-first → Task 11. ✓

**Placeholder scan:** Task 11 files are intentionally "TBD by measurement" (a profiling task, not a
code task) — acceptable per the existing-codebase rule; every code task has concrete code. No other
TBDs.

**Type consistency:** `setStorm(s)`/`setFlash(f[,dx,dz])` identical across sky/clouds/ocean and the
`WeatherSinks` interface; `spawnBolt(dx,dz,distance,intensity)`, `flash()`, `flashDir()` match Task 6
↔ Task 8; `ambient("ocean"|"wind"|"rain", ...)` matches Task 2 ↔ Task 8; `RainSystem`
`setIntensity`/`update(dt,cam)` match Task 5 ↔ Task 8; `weatherMath` exports match Task 1 ↔ Task 8
usages. ✓
