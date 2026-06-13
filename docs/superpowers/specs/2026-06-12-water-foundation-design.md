# Water Foundation — Design Spec

**Date:** 2026-06-12
**Status:** Approved architecture (Section 1); full design pending user review
**Sub-project:** #3 + #4 fused — FFT ocean look + hull/sea seam + draft re-tune

---

## 1. Goal

Replace the current Gerstner-only ocean *look* with a faithful, AAA-style
height-field sea (Black Flag / Sea of Thieves lineage) — a **chaotic, choppy,
crossing mid-ocean sea with whitecaps, foam, and spray** — and fix the **seam**
so the ocean never renders across the deck or inside hull compartments. Undo the
spawn-awash draft introduced last round so the ship sits at a believable, deep,
consistent waterline.

This is the **foundation** the rest of the overhaul builds on. It is delivered as
an **additive modification on top of the existing engine**, not a rewrite.

### In scope
- FFT ocean displacement/normal/foam (Route 1: WebGL2 ping-pong fragment FFT).
- Stencil-based hull/sea seam mask (kills water-on-deck + water-in-compartments
  + the white-void crescent at the bow).
- One-time hull draft re-tune (correct freeboard + consistent waterline).
- Richer wave shading, foam, whitecaps, spray; keep + integrate the existing
  ship wake/wash.

### Out of scope (parked for future runs)
- #1 voxel-true collision, #2 voxel masts/sails, #5 in-hull flood fluid (the
  "blue loading bar"), #6 match-flow (sinking ≠ game over). These are
  acknowledged, designed-around, and explicitly deferred.

---

## 2. Constraints (non-negotiable)

1. **Physics is untouched.** Buoyancy, flooding, trim, handling, and AI keep
   reading the existing CPU analytic wave field (`surfaceHeight`,
   `physicsWaves`, λ≥14 m swell). No physics rework, no rebalance, no re-tune as
   a consequence of this work.
2. **Portable WebGL2 → WebGPU later** with no engine rework. The FFT lives behind
   a narrow interface; swapping backends replaces one module.
3. **The ship stays welded to the waves it visibly floats on.** Guaranteed by
   construction (see §4 band-limiting).
4. **60 fps** on the current dev machine; the **browser build keeps working** as
   the portfolio demo. End target is a **packaged Steam desktop build** (GPU may
   be assumed; Electron/Tauri wrapper; WebGPU is the later compute path).
5. Keep all 105 unit tests green; `tsc` clean.

---

## 3. Two-layer architecture (the portability guarantee)

**Layer 1 — physics wave field (CPU, analytic). Untouched.**
The existing Gerstner swell subset (λ≥14 m). `surfaceHeight(x,z,t)` keeps its
signature and callers. Shares no code with the FFT, so no render-backend change
can affect float/trim/handling.

**Layer 2 — visual ocean (GPU). The only thing that changes now and at WebGPU.**
The ocean mesh's vertex shader displaces by **the analytic swell** (matching
physics exactly) **plus an FFT chop term** read from a displacement texture. The
FFT textures come from one module behind a deliberately narrow interface:

```ts
interface OceanField {
  update(t: number): void;              // advance the sim one frame
  readonly displacement: THREE.Texture; // Dx, y, Dz  (choppy offset)
  readonly normal: THREE.Texture;       // surface slope for lighting
  readonly foam: THREE.Texture;         // Jacobian fold → whitecaps
}
```

This interface **is the portability seam.** Route 1 implements it with WebGL2
ping-pong fragment shaders; Route 2 (later) reimplements the *same three-texture
contract* with WebGPU compute. The mesh, water material, foam, seam mask,
physics, and game never know which backend is plugged in. Swapping = replacing
one file behind a stable interface.

---

## 4. Band-limiting: how perfect sync + portability are guaranteed

The FFT spectrum is **band-limited to the chop band (λ < `PHYSICS_MIN_WAVELENGTH`
= 14 m)**. It strictly *adds* the short waves the hull never feels. The big swell
(≥14 m) the ship actually rides stays the analytic Gerstner field — rendered in
the mesh as the displacement *base*, and sampled by physics on the CPU — so the
two are the **same field by construction**, at every scale physics cares about.

- No GPU→CPU readback is required for buoyancy.
- The FFT can be swapped (or fail/fallback) with zero effect on physics.
- Physically correct: waves much shorter than the hull don't heave it — exactly
  why the swell subset already exists.

**Crossing-sea richness** comes from two places working together:
1. Widen the **analytic swell directional spread** (today the long waves are
   tight around the wind, `spreadHalf = 0.16` — they march one way, which reads
   as "ripples all going the same direction"). Add 1–2 explicit crossing swell
   trains so the big waves genuinely cross.
2. The **FFT chop** supplies dense, chaotic, multi-directional short-wave detail
   + foam on top.

> Future option (WebGPU era): if we ever want the *big* waves to come from the
> FFT and drive physics, that's the async-readback / CPU-height-field upgrade —
> a deliberate later milestone, not part of this work.

---

## 5. FFT pipeline (Route 1 — WebGL2 ping-pong)

Standard Tessendorf-on-the-GPU recipe, all in fragment shaders on float render
targets (`EXT_color_buffer_float`, core in WebGL2):

1. **Initial spectrum `h0(k)`** — generated once (CPU → texture) from a
   directional ocean spectrum (Phillips/JONSWAP) given wind speed, wind
   direction, gravity, and domain size `L`. Band-limited to λ < 14 m.
2. **Time evolution** — one pass: `h(k,t)` from `h0`, `h0*` and dispersion
   `ω(k)=√(gk)`; also emits the choppy-displacement and slope frequency fields.
3. **Inverse FFT** — `2·log2(N)` butterfly passes (horizontal then vertical),
   ping-ponging two render targets, producing spatial-domain height `y`,
   horizontal displacement `Dx, Dz` (choppiness), and slope.
4. **Foam** — final pass: foam from the Jacobian of the displacement field
   (where the surface folds, it whitens), with decay.

**Outputs** = the three `OceanField` textures.

**Defaults:** `N = 256` (quality/perf sweet spot; `128` fallback for low-end),
tile `L ≈ 250 m`, world-space tiling `uv = worldXZ / L`. Tiling repetition is
mitigated by blending two scales (e.g. `L` and `L/4`); accept minor repetition in
v1 and refine later.

---

## 6. Ocean mesh integration

Keep the camera-centered polar grid (it's good — fine near the hull, fades waves
before they alias). Changes:

- **Vertex:** `p = rest + analyticSwell(rest, t) + sampleDisplacement(worldXZ/L)`.
  The analytic swell is the ≥14 m Gerstner set (physics-matching). FFT chop comes
  from the displacement texture.
- **Fragment:** surface normal blends the analytic-swell normal with the FFT
  normal texture; replace most of the hand-rolled scrolling-noise normal detail
  with the FFT normal (keep a touch of cheap detail past the FFT tile fade).
- **Keep** the ship wake/wash + bow-wave geometry and the stern-trail foam lacing
  — they're tied to live ship state and read well. Foam now also takes the FFT
  Jacobian whitecaps.

---

## 7. Seam fix (water on deck / in compartments / bow void)

**Primary: stencil mask.** Render each hull (the existing voxel mesh, or a
watertight proxy) into the **stencil buffer** before the ocean; the ocean draws
only where the hull silhouette is *absent*. This is geometrically exact — it
removes ocean from every pixel the hull covers (deck, bulwarks, and the interior
seen through open hatches/gunports), so you see timber, never sea, and it cures
the curved-bow void the analytic ellipse could never get right.

- **Fallback (kept):** the current analytic ellipse + vertical-gate discard,
  improved to a per-station hull cross-section so it degrades gracefully if the
  stencil path is unavailable or fights the transparent-ocean material.
- **Preserve** the existing boarding **cutaway** (translucent wedge) behavior.
- **Draft re-tune:** reduce the over-ballast from last round so the deck carries
  proper freeboard and the waterline sits consistently at the near-vertical belt
  (per the reference cutaways). With correct freeboard, gross on-deck flooding
  largely disappears; the stencil mask handles the residual seam bleed.

> Integration risk: stencil + a `transparent: true`, `DoubleSide` ShaderMaterial
> ocean can be fiddly in three.js. If it proves unstable, the improved analytic
> mask is the documented fallback. (See §10.)

---

## 8. Foam & spray

- **Whitecaps** from FFT Jacobian (real breaking-crest foam), plus the existing
  crest-coincidence whitecaps on the analytic swell.
- **Hull-waterline foam** where the sea meets the hull (cheap band along the
  stencil edge / footprint).
- **Spray particles** when the bow slams through a crest — reuse the existing
  `effects` particle system + the round-10 lateral `bowWave`.

---

## 9. Portability plan (WebGL2 → WebGPU, later)

When we package for Steam and want compute-driven extras:
- Reimplement `OceanField` with WebGPU compute shaders (real FFT + foam sim),
  same three-texture contract.
- Optionally migrate the three.js renderer to the WebGPU backend (renderer swap,
  still TypeScript/three.js scene graph — *not* a rewrite).
- Physics, mesh, materials, seam, game logic: **unchanged.**

---

## 10. Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Stencil + transparent ocean fiddly in three.js | Improved analytic per-station mask as documented fallback |
| Float render targets unsupported / imprecise | Feature-detect `EXT_color_buffer_float`; fall back to current Gerstner-only ocean (browser-safe) |
| FFT tile visibly repeats | Blend two scales; accept minor v1 repetition; refine later |
| Perf on low-end GPUs | Scale `N` (256→128), drop FFT octaves, or fall back to Gerstner |
| Visual swell vs physics swell drift | Eliminated by construction — band-limit FFT to <14 m; swell is the shared analytic field |

---

## 11. Testing & success criteria

**Tests:** keep 105 unit tests green; `tsc` clean. Add CPU-side unit tests for
any new pure math (spectrum generation, dispersion, band-limit cutoff). Assert
`physicsWaves` output is byte-for-byte unchanged. Visual verification via the
existing Playwright screenshot harness.

**Success = the user's complaints, resolved:**
1. At rest with correct draft, **no sea on the deck and none inside any
   compartment** — from any angle, including looking down into open holds.
2. The sea reads as a **chaotic, choppy, crossing mid-ocean** — not uniform
   ripples marching one way.
3. The ship stays **welded to the visible swell** (no float-above/sink-into).
4. Whitecaps, foam, and **spray** when crashing through crests.
5. **60 fps**; browser build still runs; FFT behind the swappable `OceanField`
   interface for the WebGPU future.

---

## 12. Phasing (within this sub-project)

1. **Draft re-tune** (quick): undo over-ballast; verify freeboard + consistent
   waterline; physics tests green.
2. **`OceanField` interface + WebGL2 FFT backend** producing the three textures.
3. **Mesh integration:** analytic swell base + FFT chop displacement/normal;
   widen swell crossing; fold in FFT foam.
4. **Stencil seam mask** (+ improved analytic fallback); preserve cutaway.
5. **Foam/spray polish** + perf pass + feature-detect fallback.
