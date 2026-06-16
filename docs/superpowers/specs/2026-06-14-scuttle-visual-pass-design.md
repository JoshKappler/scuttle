# Scuttle Visual Pass 1 — "Sea, Sky & Stone"

_Design spec — 2026-06-14 — branch `dev/gfx-visual-pass`_

## Goal

Layer cinematic visual quality over Scuttle's existing renderer without touching
physics. Four player-facing asks, settled with the user:

1. **Reflective, silky water** — the sea should reflect the real sky, sun and
   clouds, not a flat constant color.
2. **Real sun & clouds + sun rays** — a believable sky with cloud cover, a glowing
   sun, and light shafts.
3. **Darker, gritty, textured islands** — kill the "early-Minecraft" flat bright
   voxels; weathered tones with surface grit, crisp silhouettes preserved.
4. **Generally better** — a post-processing polish layer (bloom, god rays, grade).

**Art direction:** grounded realism with punch (AC: Black Flag mood, not muddy;
voxel silhouettes stay crisp). **Reflections:** sky/sun/cloud env reflection now,
clean hook for planar ship/island reflections later. **Perf:** GPU-forward for the
"wow", with dev-panel quality knobs so the browser demo scales down.

## Non-goals (this pass)

- Planar (ship/island) reflections — leave a hook, don't build it.
- Volumetric raymarched clouds or true volumetric god rays — use a procedural
  cloud dome and a screen-space light-shaft pass instead.
- Any change to ship-wood materials, physics, crush/flood/wake, or the deck-walk.

## Invariants honored (THE LAW)

- **#1 Physics rides only the analytic Gerstner swell.** This pass adds only
  *visual* uniforms (a sky env cube, post-FX). **Nothing flows into physics.**
- **Ship wood tones unchanged** — only the terrain materials (SAND/ROCK/DARKROCK/
  GRASS/DIRT/PALMWOOD/FOLIAGE/ROOFTILE) are darkened; OAK/PINE/IRON/RAM untouched.
- Crush / flood / wake / cutaway / seam-mask behavior unchanged in meaning.

## Current state (verified against code 2026-06-14)

- **Renderer** (`main.ts`): ACESFilmic tonemap, exposure 1.0, PCFSoft shadows,
  single `renderer.render(scene, camera)` — **no post-processing**. A stencil
  **seam-mask pre-pass** (`render/seamMask.ts`) runs before it; the ocean is
  `transparent`, `DoubleSide`, and stencil-tested (`stencilRef 1`,
  `NotEqualStencilFunc`).
- **Sky** (`render/sky.ts`): three.js `Sky` (atmospheric scattering), late-
  afternoon sun (elev 14°, az 155°), one `DirectionalLight` + `HemisphereLight`
  fill + a deliberately tiny IBL bake (`environmentIntensity 0.05` — higher
  bleached the oak in round 8). **No clouds, no light shafts.**
- **Ocean** (`render/ocean.ts`): custom `ShaderMaterial` on a camera-centered
  polar grid. Gerstner swell + 3-cascade FFT chop, sun glints, SSS, ship wake.
  **Reflection is a flat `uSkyColor` constant** mixed by Fresnel — the gap.
  Colors: `uDeepColor 0x0a3340`, `uShallowColor 0x1a6a72`, `uSkyColor 0x9fc4d4`.
- **Islands** (`render/islandVisual.ts`, `render/voxelMesher.ts`): one merged
  greedy mesh, plain vertex-color `MeshStandardMaterial` (`roughness 0.95`,
  `metalness 0`). AO baked into vertex colors. **No texture / normal / grit.**
  Palette in `sim/materials.ts` is deliberately bright (sand 0.62, rock 0.34).

## Architecture

Five work areas. Each is independently buildable and in-browser verifiable.

### A. Post-processing spine — `render/post.ts` (new), `main.ts`

Introduce an `EffectComposer`:

```
RenderPass → UnrealBloomPass (mild) → GodRayPass → GradePass → screen
```

- **Stencil preservation is the critical risk.** The `RenderPass` render target
  must be created with `stencilBuffer: true`, and the seam-mask pre-pass must
  write into the buffer the `RenderPass` uses (or run as a composer pass before
  it). Acceptance: with the composer active, the ocean still does NOT render onto
  the deck / into open holds / as a bow void. Verify in-browser FIRST, before
  layering bloom/god rays.
- **Bloom**: mild `UnrealBloomPass` — glows the sun disc, sun-glint path, and
  bright foam. Threshold tuned so the wood/sea body don't bloom.
- **Grade**: a tiny final `ShaderPass` — contrast + saturation + optional subtle
  vignette for "punch". Cheap, keeps ACES tonemap upstream.
- Resize: composer + all passes `setSize` on window resize (mirror existing
  `renderer.setSize` path in `main.ts`).
- Fallback: a `TUN.gfx.post.enabled` master switch falls back to the plain
  `renderer.render` path (safety valve + perf floor for weak hardware).

### B. Sky & clouds — `render/sky.ts`, `render/clouds.ts` (new)

- Keep the atmospheric `Sky`; retune turbidity/rayleigh/mie for a richer late
  afternoon to match the grade.
- **Procedural cloud dome** (`render/clouds.ts`): a large inward-facing
  dome/sphere with an FBM-noise fragment shader producing soft cumulus, lit by
  `sunDir`, drifting slowly with time. `coverage`, `density`, `speed` uniforms.
  Renders inside the sky, before the scene.
- **Sky+cloud env cube**: render the sky dome + clouds into a `WebGLCubeRenderTarget`
  (modest size, e.g. 256, mipmapped), **re-rendered periodically** (~2 Hz — clouds
  drift slowly, so this is cheap). Exposed from `SkySetup` as `envCube` for the
  ocean to sample. This is the reflection source. (Camera position is irrelevant —
  sky is at infinity — so the cube only changes as clouds animate.)

### C. Water reflections & color — `render/ocean.ts`

- Add `uSkyEnv` (samplerCube) + `uReflStrength` uniforms.
- Replace the flat-`uSkyColor` Fresnel term with a real reflected-environment
  sample: `R = reflect(-V, Nd); refl = textureCube(uSkyEnv, R).rgb;` then
  `col = mix(water, refl, fresnelSchlick * uReflStrength)`. Sun + clouds now
  smear across the swells.
- **Deepen the palette** to teal→navy per art direction (tune `uDeepColor`,
  `uShallowColor`); keep the depth-by-facing blend. Retune the sun-glint
  exponents so bloom turns the highlight to glow rather than a hard dot.
- Keep `uSkyColor` as a cheap fallback (used when the env cube is unbound).
- **Untouched:** Gerstner/cascade displacement, wake, cutaway, profile cut,
  stencil, double-side. Physics still samples only the analytic swell.

### D. God rays — `render/post.ts` (GodRayPass)

- Screen-space radial-blur light-shaft pass (GPU-Gems "light scattering")
  anchored at the **sun's projected screen position** (compute each frame from
  `sunDir` + camera; pass as a uniform). Occlusion is free: dark ship/island
  pixels block the rays. Active only when the sun is on-screen and above the
  horizon; fades out otherwise to avoid artifacts.
- Knobs: `strength`, `decay`, `density`, `samples` in `TUN.gfx.godrays`.

### E. Islands — darker + grit — `sim/materials.ts`, `render/islandVisual.ts`, `render/voxelMesher.ts`

- **Darken the terrain palette** in `sim/materials.ts` (terrain indices only).
  Weathered tones: sand toward wet/khaki, rock toward slate, grass toward deep
  olive, etc. Ship woods untouched (separate indices).
- **Triplanar procedural grit** on the island material via `material.onBeforeCompile`
  (the mesh has no UVs): world-position FBM that (a) modulates albedo — darkens
  crevices, adds per-face tonal variation so flat voxel faces aren't uniform —
  and (b) optionally perturbs the normal slightly for matte micro-relief.
  Triplanar in world space; **crisp voxel silhouettes preserved** (we only vary
  surface shade, never geometry). Strength via `TUN.gfx.islandGrit`.
- Optional: cheap per-face color jitter in `voxelMesher.emitQuad` (hash of face
  position) for extra large-scale variation. Low risk; include if it reads well.

### F. Tunables & dev panel — `core/tunables.ts`, `render/devPanel.ts`

New `TUN.gfx` block, all live-editable:

```ts
gfx: {
  post:       { enabled: true },
  bloom:      { enabled: true, strength: 0.6, radius: 0.4, threshold: 0.85 },
  godrays:    { enabled: true, strength: 0.5, decay: 0.95, density: 0.8, samples: 60 },
  grade:      { contrast: 1.06, saturation: 1.08, vignette: 0.15 },
  reflection: { strength: 0.9, rebakeHz: 2 },
  clouds:     { coverage: 0.5, density: 0.7, speed: 0.6 },
  islandGrit: { strength: 0.6 },
}
```

A quality scale (or per-effect `enabled`) lets the browser demo dial down while
the Steam build runs full.

## Data flow

```
sunDir ──┬─→ DirectionalLight (existing)
         ├─→ Sky uniforms (existing) ─┐
         ├─→ Clouds shader (sunDir)  ─┤→ render to envCube (~2 Hz)
         └─→ GodRayPass screen-pos    │
                                       └─→ ocean uSkyEnv (reflection)
camera ──→ ocean (uCameraPos, existing) ; GodRayPass (sun projection)
```

Physics inputs are unchanged — `sim/gerstner.physicsWaves()` only.

## Testing & verification

- `npm run build` (tsc + vite) green — **required**, since vitest strips types and
  GLSL bugs pass tsc + tests and fail only at runtime.
- `npm run test` (vitest) green — no physics/sim files change, so the oracle
  should stay green; confirm.
- **In-browser via Playwright at `:5173`** with before/after screenshots for each
  area (water, sky/clouds, islands, god rays). Watch for:
  - stencil regressions (ocean leaking onto deck / into holds / bow void),
  - shader compile failures (whole ocean vanishing — the classic symptom),
  - frame time via `window.DEBUG` (perf budget),
  - the IBL-bleach trap: confirm the oak hull tone is unchanged.
- Screenshots land in the **projects ROOT** (`projects/<name>.png`).

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Composer breaks the stencil seam-mask (ocean on deck) | Phase A proves stencil with `stencilBuffer:true` RT before anything else; master `post.enabled` fallback to `renderer.render`. |
| Env-cube reflection re-introduces IBL oak-bleach | Ocean samples its OWN `uSkyEnv`; `scene.environmentIntensity` stays 0.05. Verify oak tone. |
| GLSL runtime failure (sea vanishes) | In-browser verify after each shader change; keep `uSkyColor` fallback. |
| God rays artifact when sun off-screen / behind camera | Gate the pass on sun on-screen + above horizon; fade out. |
| Perf regression in browser | Per-effect `enabled` + quality knobs; half-res where applicable; cube at 2 Hz. |

## Phasing (each independently verifiable, committed separately)

A. Composer + bloom (prove stencil survives) →
B. Sky + clouds + env cube →
C. Ocean env reflection + deepened color →
D. God rays →
E. Island darken + triplanar grit →
F. Dev-panel knobs + in-browser tuning pass.

## Integration / merge

All work stays on `dev/gfx-visual-pass` in the isolated worktree
`.claude/worktrees/gfx-visual-pass`. **Not merged to main** — the user feel-tests
at home, then we do a proper PR. Never `git add -A` (the worktree shares the
parent's `.claude/`); stage only this branch's own source paths.
