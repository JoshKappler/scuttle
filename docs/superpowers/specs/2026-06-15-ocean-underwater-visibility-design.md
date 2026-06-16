# Ocean underwater visibility (depth murk) — design

_2026-06-15_

## Goal

Make the sea read as a **translucent body with depth** instead of a flat opaque sheet:
you can see a short way *into* the water, with a "fog-of-war" visibility drop-off as it
deepens. A submerged deck or sinking bow then **dissolves into the water** as it goes
under, instead of hard-clipping to a void — solving the deck-submersion artifact a second,
more natural way.

Scope picked with the user: **moderate murk** — see ~a couple metres down everywhere a
solid sits just below the surface; beyond that the sea is opaque. Done **analytically in
the existing ocean fragment shader**, reusing data it already samples. No new render pass.

## Current state (what exists in `render/ocean.ts`)

- The ocean is one `ShaderMaterial` surface (`transparent: true`, `depthWrite: true`,
  `DoubleSide`), tuned **dark + matte**: `uDeepColor 0x030f17`, `uShallowColor 0x09303a`,
  Fresnel sky-cube sheen at `reflStrength 0.22`.
- A **narrow** submersion fade already exists: the frag computes `submrg` (metres of water
  over a submerged deck) only inside a hull's footprint, then
  `seaAlpha = submrg >= 0 ? clamp(0.12 + submrg*0.4, 0.12, 1.0) : 1.0`. So translucent-over-
  sunk-deck already works — it's just special-cased to submerged decks and surface-only.
- The frag **already samples**, per fragment, everything a depth-murk model needs:
  - each ship's voxel **keel/deck profile atlas** (`uProfileAtlas` + `uProfileOn`/`InvRot`/
    `Trans`/`Size`), from which it derives a column's **deck-top world-Y** (`deckWY`);
  - the island **seabed height field** (`uLandTex`/`uLandMin`/`uLandSize`/`uLandOn`),
    decoded as `landY = tex.r * 160.0 - 100.0` (deep sea ≈ −100 m).
- Render path: an MSAA `EffectComposer` (`render/post.ts`). This is *why* we go analytic —
  a true scene-depth texture would have to thread through that composer (deferred; see
  Out of scope).

## Design

### 1. Per-fragment water column

Compute, in the frag shader, the **world-Y of the shallowest solid beneath this fragment**
(`floorY`) from the candidates already on hand:

- **Submerged ship hull/deck** — where a profile column exists beneath the fragment, its
  visible top is `deckWY` (already computed in the in-hull cut loop). Candidate `floorY = deckWY`.
- **Seabed near islands** — `floorY = landY` from the land-field decode.
- **Open deep water** — no hull column and `landY ≈ −100`: no candidate within range.

`floorY = max(candidates)` (topmost/shallowest solid). Then:

```
columnDepth = vWorldPos.y - floorY          // metres of water above the solid
visFrac     = clamp(columnDepth / visibility, 0, 1)   // 0 = solid grazes surface, 1 = at/under murk depth
```

When **no candidate is in range** (open water), skip the whole block: `seaAlpha = 1`,
colour unchanged → open ocean is **byte-identical to today**. The feature only ever
touches fragments with a solid within `visibility` metres below the surface.

### 2. Opacity + tint from depth

```
shallowAlpha = mix(1.0, ~0.08, clarity)        // clarity 0 ⇒ 1 (opaque), 1 ⇒ very see-through
murk         = clarity * (1.0 - visFrac)        // murk veil: 0 when clarity 0 OR water is deep
seaAlpha     = mix(shallowAlpha, 1.0, visFrac)  // shallow → translucent, deep → opaque
cFinal       = mix(col, uMurkColor, murk)       // thin shallow water = light murk veil; deep = normal sea
```

- `col` is today's fully-lit surface colour (reflection/spec/wash all unchanged); it stays
  the **opaque/deep** end.
- **Palette: deep navy blue descending to black.** `uMurkColor` is a new **tuned constant** —
  a **deep navy blue** (e.g. ~`0x0a1f3a`), handled like `uDeepColor`/`uShallowColor` (a uniform
  in `ocean.ts`, not a dev slider). The shallow see-into-water band reads navy and, as the
  column deepens (`visFrac → 1`), `cFinal` returns to the opaque deep sea, which we nudge toward
  **near-black** (`uDeepColor`, currently `0x030f17` — fine, or push toward `~0x01060d` for a
  truer black). Net gradient looking down into the water: deep navy → black. (Drop the teal
  `uShallowColor` influence in the look if it fights the navy; starting hexes are feel-tune.)
- **`clarity 0` is an exact no-op:** `shallowAlpha → 1` and `murk → 0`, so `seaAlpha → 1`
  and `cFinal → col` for every fragment — byte-identical to today. `clarity 1` = maximally
  see-through, murk-tinted shallows. (Both the alpha *and* the tint are gated by `clarity`,
  so the off switch is genuinely off.)

Because alpha ramps to opaque *with* depth, deep parts of a sloping seabed/hull are naturally
hidden behind opaque water while near-surface parts show clearly — a cheap volumetric-absorption
approximation that reads as "limited visibility" without a scene-depth tap.

### 3. Submersion fix falls out for free

The narrow `submrg`/`seaAlpha` special-case is **replaced** by the general column model: a
submerged deck is just one `floorY` candidate. A sinking bow/awash deck dissolves into the
murk as `columnDepth` grows. The **dry-deck discard stays exactly as is** (an intact dry hull
still cuts the sea so the hold shows timber, not water/sky) — only submerged columns
(`deckWY ≤ 0.3`) feed the depth-fade.

### 4. Knobs (`src/core/tunables.ts` → `TUN.gfx`)

Add, following the sibling `reflection: {...}` pattern:

```
water: { visibility: 2.5, clarity: 0.85 }
```

- `visibility` (m): column depth at which the sea reaches full opacity. Larger = see deeper.
- `clarity` (0..1): how translucent the shallowest band gets. **0 = feature off** (safety
  floor / current look).

Wire via a new `Ocean.setWaterDepth(visibility, clarity)` method (mirroring `setChop` /
`setReflStrength`), pushed from `main.ts` in the same place the other live `TUN.gfx` knobs
are fed to the ocean each frame. `uMurkColor` is a fixed tuned uniform (no slider), matching
the existing water-colour constants.

## Perf

A few extra fragment taps/ALU in a shader that **already** samples the land field and the
profile atlas — no new texture, no new pass. Cost is negligible next to the fill-bound
post-FX chain. Confirm with the fps HUD (`TUN.gfx.auto.hud`) on the user's real GPU; `clarity 0`
is a zero-cost off switch if ever needed.

## Correctness & invariants

- **THE LAW #1 (visual-only):** pure fragment shading; physics still rides the analytic
  swell. No visual field feeds physics. ✓
- **Seam-mask stencil + `X` cutaway:** unchanged. Final alpha stays `min(cutAlpha, seaAlpha)`
  so the cutaway glass still composes. The submerged-deck reveal already survives the stencil
  today (same path as `submrg`).
- **Open water unchanged:** no-candidate fragments keep `alpha 1` and today's colour.

## Testing / verification

- `npm run build` (tsc) **and** `npm run test` (vitest) green. Note vitest does **not**
  type-check or run GLSL, so:
- **In-browser verify at `:5173`** (Playwright MCP + screenshots; screenshots land in the
  projects ROOT). Check three cases: (a) a sinking/awash ship — deck dissolves smoothly,
  no void; (b) a ship in the island shallows — water lightens/reveals by depth; (c) open
  deep water — visually unchanged. Toggle `TUN.gfx.water.clarity` 0↔0.85 to A/B.
- fps HUD before/after to confirm no regression.

## Out of scope (YAGNI — possible follow-ups)

- **True scene-depth "soft water"** (depth texture through the MSAA composer), screen-space
  **refraction**, **caustics**, underwater **god-shafts**. The analytic model is structured
  so a depth-texture upgrade could later replace the `floorY` estimate for arbitrary
  underwater geometry — that's the "dramatic / see the bottom" tier.
- **Depth-fogging loose underwater objects** (drifting debris, far ships' submerged hulls
  beyond their own profile reveal). The model covers ship profiles + seabed; that's
  sufficient for "moderate".
- **Underwater camera treatment** (camera below the surface). `DoubleSide` already shows the
  surface from beneath; no change here.

### 5. Seeing sand in the shallows (required)

The murk model reveals whatever solid sits beneath the surface; the seabed geometry to reveal
**already exists**. `sim/islandwright.ts` builds a seafloor base below sea level
(`SEABED_Y = 2`, `WATERLINE_Y = 3`; `if (y < SEABED_Y) mat = ROCK`) and the hydraulic-erosion
pass deposits sand at the coast — so each island carries a shallowly-submerged shelf out to its
local grid extent (open ocean beyond has no seabed mesh, which is correct → opaque deep there).

So sand-through-the-shallows comes mostly **for free** once the surface is translucent over it.
The one refinement to make it read as **sand, not rock**: extend the coastal **sand** material
a row or two **below** the waterline (around `WATERLINE_Y`/`SEABED_Y` in `islandwright.ts`'s
column loop) so the shallow shelf band is sand-coloured rather than the `ROCK` seafloor base.
Confirm the submerged shelf actually renders (not back-face/again-cull removed) during the
in-browser verify.
