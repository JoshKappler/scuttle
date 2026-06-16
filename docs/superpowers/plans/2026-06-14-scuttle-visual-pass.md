# Scuttle Visual Pass 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add cinematic graphics to Scuttle — reflective water (sky/sun/cloud env
reflection), a real cloudy sky, god rays, bloom, and darker gritty islands —
without touching physics.

**Architecture:** A post-processing `EffectComposer` spine that preserves the
stencil seam-mask via a custom scene pass; a procedural cloud dome baked into a
sky env cube the ocean reflects; triplanar procedural grit on islands. All effects
are gated behind a `TUN.gfx` block with dev-panel knobs.

**Tech Stack:** Three.js (+ `three/addons` postprocessing), custom GLSL, Rapier
(untouched), Vite, TypeScript, Vitest (sim oracle, untouched).

**Verification model:** Shaders/visuals are NOT unit-tested (GLSL fails only at
runtime). Per task the gates are: (1) `npm run build` green — tsc catches type
errors that vitest's type-stripping hides; (2) `npm run test` green — proves no
sim regression; (3) in-browser Playwright at `:5173` with a screenshot to the
projects ROOT, checked by eye + against the named acceptance criteria.

**Worktree:** `.claude/worktrees/gfx-visual-pass`, branch `dev/gfx-visual-pass`.
Run all commands there. **Never `git add -A`** (shared `.claude/`); stage only the
listed source paths. **Do not merge to main.**

---

## Task 1: Post-processing spine + bloom (prove stencil survives)

**Files:**
- Create: `src/render/post.ts`
- Modify: `src/core/tunables.ts` (add `gfx` block)
- Modify: `src/main.ts` (render loop ~1511-1517; resize ~518; construction near sky)

- [ ] **Step 1: Add the `TUN.gfx` block** to `src/core/tunables.ts`:

```ts
gfx: {
  post: { enabled: true },
  bloom: { enabled: true, strength: 0.6, radius: 0.4, threshold: 0.85 },
  godrays: { enabled: true, strength: 0.55, decay: 0.96, density: 0.85, weight: 0.4, samples: 60 },
  grade: { contrast: 1.06, saturation: 1.09, vignette: 0.18 },
  reflection: { strength: 0.9, rebakeHz: 2 },
  clouds: { coverage: 0.5, density: 0.7, speed: 0.6 },
  islandGrit: { strength: 0.6 },
},
```

- [ ] **Step 2: Create `src/render/post.ts`** with a `Post` class wrapping
`EffectComposer`. Key points:
  - Custom `WebGLRenderTarget(w, h, { stencilBuffer: true, depthBuffer: true, samples: 4 })`
    passed to `new EffectComposer(renderer, rt)` (keeps MSAA + stencil).
  - A custom `ScenePass` (extends `Pass`, `needsSwap = true`) whose `render()`
    reproduces the working stencil dance INTO the write buffer:

```ts
render(renderer, writeBuffer) {
  renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
  renderer.autoClear = true;
  renderer.clear();            // color + depth + stencil
  renderer.autoClear = false;
  this.seam.write(renderer, this.scene, this.camera); // stencil = 1 on hulls
  renderer.render(this.scene, this.camera);           // ocean stencil-tested
  renderer.autoClear = true;
}
```
  - Then `UnrealBloomPass(resolution, strength, radius, threshold)`.
  - Expose `render()`, `setSize(w,h)`, and live setters reading `TUN.gfx`.
  - `Post.enabled` master: when false, caller uses the legacy `renderer.render`.

- [ ] **Step 3: Wire into `main.ts`.** Construct `Post` after sky/ocean exist
(it needs `scene`, `camera`, the `seam`). Replace the loop tail (lines ~1511-1517)
so that when `TUN.gfx.post.enabled` it calls `post.render()` (which owns the
clear/seam/scene/bloom), else falls back to the existing 5-step `renderer.render`
path verbatim. Update the resize handler (~518) to also call `post.setSize`.

- [ ] **Step 4: Build.** Run: `npm run build` — Expected: PASS (no tsc errors).

- [ ] **Step 5: In-browser verify.** Dev server at `:5173`; Playwright screenshot.
**Acceptance:** scene renders; bloom glows the sun/glints; **the ocean is NOT
drawn on the deck, in open holds, or as a bow void** (stencil intact). Toggle
`TUN.gfx.post.enabled=false` → identical-but-unbloomed scene (fallback works).

- [ ] **Step 6: Commit.**
```bash
git add src/render/post.ts src/core/tunables.ts src/main.ts
git commit -m "feat(gfx): post-processing spine + bloom, stencil-preserving"
```

---

## Task 2: Sky retune + procedural cloud dome + env cube

**Files:**
- Create: `src/render/clouds.ts`
- Modify: `src/render/sky.ts` (expose `envCube`, add clouds, `updateEnv()`)
- Modify: `src/main.ts` (construct clouds, periodic `skySetup.updateEnv()`)

- [ ] **Step 1: Create `src/render/clouds.ts`** — `CloudDome` class: a large
inward-facing `SphereGeometry` (`BackSide`) with a `ShaderMaterial`. Fragment:
FBM (4-5 octaves of value noise over the view direction + scrolling time)
producing soft cumulus; coverage/density/speed uniforms; lit by `uSunDir`
(brighten clouds facing the sun, darken undersides). `depthWrite:false`,
rendered as part of the sky. Expose `mesh`, `update(time)`, setters.

- [ ] **Step 2: Retune `Sky` uniforms** in `sky.ts` for a richer late afternoon
(slightly higher rayleigh/turbidity), to read well under the grade.

- [ ] **Step 3: Add env cube to `SkySetup`.** `WebGLCubeRenderTarget(256, {generateMipmaps:true, minFilter:LinearMipmapLinear})`
+ `CubeCamera`. Add `updateEnv(renderer, time)` that renders the sky dome + cloud
dome into the cube (an isolated env scene holding both, like the existing
`bakeEnvironment` borrow-and-return trick). Expose `envCube.texture`.

- [ ] **Step 4: Wire in `main.ts`.** Add the cloud dome to the scene; call
`clouds.update(time)` each frame; call `skySetup.updateEnv(...)` throttled to
`TUN.gfx.reflection.rebakeHz` (track last-bake sim time).

- [ ] **Step 5: Build.** Run: `npm run build` — Expected: PASS.

- [ ] **Step 6: In-browser verify.** Screenshot. **Acceptance:** soft clouds
visible in the sky, drifting over time; sun still reads; no z-fighting/ darkening
of the scene. (Reflection not wired yet — that's Task 3.)

- [ ] **Step 7: Commit.**
```bash
git add src/render/clouds.ts src/render/sky.ts src/main.ts
git commit -m "feat(gfx): procedural cloud dome + sky env cube"
```

---

## Task 3: Ocean env reflection + deepened color

**Files:**
- Modify: `src/render/ocean.ts` (uniforms, FRAG reflection term, palette, setter)
- Modify: `src/main.ts` (bind `ocean.setSkyEnv(skySetup.envCube.texture)`)

- [ ] **Step 1: Add uniforms** to the ocean material: `uSkyEnv` (samplerCube,
default a 1x1 dummy cube), `uReflStrength` (float, `TUN.gfx.reflection.strength`).
Add a `setSkyEnv(tex)` method and a `setReflStrength(s)` setter on the `Ocean`
interface + impl.

- [ ] **Step 2: Replace the flat-sky Fresnel term** in `FRAG`. Current:
```glsl
float fresnel = pow(1.0 - facing, 5.0);
vec3 col = mix(water, uSkyColor, clamp(fresnel * 0.85 + 0.05, 0.0, 1.0));
```
New — sample the reflected environment, fall back to `uSkyColor` when unbound:
```glsl
float fresnel = pow(1.0 - facing, 5.0);
vec3 R = reflect(-V, Nd);
vec3 sky = (uHasEnv > 0.5) ? textureCube(uSkyEnv, R).rgb : uSkyColor;
float reflF = clamp((fresnel * 0.85 + 0.05) * uReflStrength, 0.0, 1.0);
vec3 col = mix(water, sky, reflF);
```
(Add `uHasEnv` float uniform, set 1 in `setSkyEnv`.)

- [ ] **Step 3: Deepen the palette.** Tune `uDeepColor` toward navy
(`~0x06222e`) and `uShallowColor` toward rich teal (`~0x12565f`); retune the
sun-glint exponents so bloom turns the highlight to a glow path, not a dot.
(Exact values tuned by eye in Step 5.)

- [ ] **Step 4: Build.** Run: `npm run build` — Expected: PASS.

- [ ] **Step 5: In-browser verify + tune.** Screenshot. **Acceptance:** the water
reflects the sky gradient + sun + clouds, distorted by the swells ("silky,
reflective"); color reads teal→navy; **oak hull tone unchanged** (no IBL bleach).
Tune palette/reflStrength live via dev panel, then bake good values as defaults.

- [ ] **Step 6: Commit.**
```bash
git add src/render/ocean.ts src/main.ts
git commit -m "feat(gfx): real sky/sun/cloud reflection + deeper water palette"
```

---

## Task 4: God rays (light shafts)

**Files:**
- Modify: `src/render/post.ts` (add `GodRayPass` ShaderPass + insert in chain)
- Modify: `src/main.ts` (compute sun screen position each frame, pass to `post`)

- [ ] **Step 1: Add a `GodRayPass`** (a `ShaderPass` with a custom fragment) to
the composer chain, after bloom. The shader (GPU-Gems volumetric scattering as a
post-process): from `uSunScreen` (vec2 NDC→uv), march `samples` steps from each
pixel toward the sun, accumulating the input buffer's brightness with `density`/
`decay`/`weight`, then ADD `strength * accum` to the original color. Geometry
occludes for free (dark pixels contribute nothing).

- [ ] **Step 2: Gate it.** `uSunVisible` = 1 only when the sun is in front of the
camera and above the horizon; fade `strength` to 0 near screen edges to avoid
streak pop. Skip the pass entirely when `!TUN.gfx.godrays.enabled`.

- [ ] **Step 3: Feed sun screen pos** in `main.ts`: project
`camera.position + sunDir * large` to NDC each frame; pass to `post.setSun(...)`.

- [ ] **Step 4: Build.** Run: `npm run build` — Expected: PASS.

- [ ] **Step 5: In-browser verify.** Screenshot with sun in view. **Acceptance:**
visible light shafts from the sun, occluded by sails/hull/islands; no artifacts
when the sun is off-screen or behind the camera (turn the camera to check).

- [ ] **Step 6: Commit.**
```bash
git add src/render/post.ts src/main.ts
git commit -m "feat(gfx): screen-space god rays from the sun"
```

---

## Task 5: Islands — darker palette + triplanar grit

**Files:**
- Modify: `src/sim/materials.ts` (terrain indices only)
- Modify: `src/render/islandVisual.ts` (triplanar grit via `onBeforeCompile`)
- Modify: `src/render/voxelMesher.ts` (optional per-face color jitter)

- [ ] **Step 1: Guard test.** Run: `grep -rn "color" src --include=*.test.ts` (and
check `materials` usage in tests). If any test asserts terrain color values,
update it alongside Step 2. (Ship-wood colors are NOT changing.)

- [ ] **Step 2: Darken the terrain palette** in `materials.ts` — weathered tones,
e.g. sand `[0.62,0.54,0.36]→~[0.40,0.34,0.23]`, rock `[0.34,0.34,0.37]→~[0.20,0.20,0.23]`,
grass `[0.15,0.33,0.12]→~[0.09,0.20,0.08]`, dirt/darkrock/foliage/rooftile similarly.
**Do NOT touch OAK/PINE/IRON/RAM.** (Final values tuned in Step 6.)

- [ ] **Step 3: Triplanar grit** in `islandVisual.ts`. Set `mat.onBeforeCompile`:
inject a world-position FBM (varying `vWorldPos` from the vertex stage) that
modulates `diffuseColor.rgb` (darken crevices, add per-region tonal variation)
and optionally perturbs the normal slightly. Strength uniform from
`TUN.gfx.islandGrit.strength`. **No geometry change — silhouettes stay crisp.**

- [ ] **Step 4 (optional): Per-face jitter** in `voxelMesher.emitQuad` — a small
deterministic hash of the quad's world position scaling the emitted vertex color
(±~6%), for large-scale variation. Include only if it reads better in Step 6.

- [ ] **Step 5: Build + test.** Run: `npm run build` && `npm run test` —
Expected: both PASS.

- [ ] **Step 6: In-browser verify + tune.** Screenshot near an island.
**Acceptance:** islands read darker and weathered with surface grit/variation;
**voxel edges remain crisp**; no longer "flat bright Minecraft". Tune palette +
grit strength live, bake defaults.

- [ ] **Step 7: Commit.**
```bash
git add src/sim/materials.ts src/render/islandVisual.ts src/render/voxelMesher.ts
git commit -m "feat(gfx): darker weathered islands + triplanar grit"
```

---

## Task 6: Color grade + dev-panel knobs + final tuning

**Files:**
- Modify: `src/render/post.ts` (add `GradePass` at chain end)
- Modify: `src/render/devPanel.ts` (expose `TUN.gfx` knobs)
- Modify: `src/main.ts` (push live `TUN.gfx` values to `post`/`ocean`/`clouds` each frame)

- [ ] **Step 1: Add a `GradePass`** (final `ShaderPass`): contrast + saturation +
subtle vignette from `TUN.gfx.grade`. Cheap; runs after god rays.

- [ ] **Step 2: Expose `TUN.gfx`** in `devPanel.ts` — sliders/toggles for bloom,
godrays, grade, reflection strength, clouds, islandGrit, and the `post.enabled`
master, following the panel's existing pattern.

- [ ] **Step 3: Live-apply.** In `main.ts`, each frame (or on panel change) push
`TUN.gfx` values into `post`, `ocean.setReflStrength`, and `clouds` setters.

- [ ] **Step 4: Build + test.** Run: `npm run build` && `npm run test` —
Expected: both PASS.

- [ ] **Step 5: Full in-browser tuning pass.** Screenshots: open sea, sun-glint
path, an island, a broadside (bloom/god rays under muzzle flash). Tune all
`TUN.gfx` defaults for the "grounded realism with punch" look. Confirm frame time
via `window.DEBUG` is acceptable; confirm `post.enabled=false` still runs.

- [ ] **Step 6: Commit.**
```bash
git add src/render/post.ts src/render/devPanel.ts src/main.ts src/core/tunables.ts
git commit -m "feat(gfx): color grade + dev-panel quality knobs + tuning"
```

---

## Final verification (before handing back for feel-test)

- [ ] `npm run build` green, `npm run test` green.
- [ ] In-browser: water reflects sky/sun/clouds; clouds + god rays present; islands
  darker/gritty/crisp; oak hull tone unchanged; ocean still off the deck (stencil).
- [ ] `git -C <worktree> log --oneline` shows the per-task commits on
  `dev/gfx-visual-pass`; `git status` clean; **not merged to main.**
- [ ] Report branch + screenshots to the user for feel-testing; PR is their call.

## Self-review notes

- **Spec coverage:** water reflection (T3), silky/color (T3), sun+clouds (T2),
  sun rays (T4), island darken+grit (T5), general polish/bloom/grade (T1,T6),
  dev knobs (T1 block + T6 panel), stencil preservation (T1), invariants (no
  physics/ship-wood touched anywhere). All spec sections map to a task.
- **No placeholders:** key shader/integration code shown; values explicitly
  marked "tuned in Step N" are intentional (visual tuning is in-browser, not
  guessable up front).
- **Naming consistency:** `Post`, `post.render/setSize/setSun/setEnabled`,
  `ocean.setSkyEnv/setReflStrength`, `skySetup.envCube/updateEnv`,
  `clouds.update`, `TUN.gfx.*` — used consistently across tasks.
