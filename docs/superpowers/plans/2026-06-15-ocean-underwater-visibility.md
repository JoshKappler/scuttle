# Ocean Underwater Visibility (Depth Murk) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sea read as a translucent body you can see a couple metres into — submerged decks/hulls dissolve into the water instead of clipping out, and the sandy shelf shows through the shallows — with a deep-navy-to-black palette.

**Architecture:** Pure analytic depth-murk in the existing ocean fragment shader (`render/ocean.ts`). Per fragment, compute the world-Y of the shallowest solid beneath it from data the shader *already* samples — each ship's voxel keel/deck profile atlas and the island seabed height field — then drive translucency + a navy murk tint from the water-column depth. Deep open water has no solid in range, so it stays fully opaque (today's look). No new render pass. One small companion change makes the island's submerged coastal shelf sand-coloured. Visual-only — physics still rides the analytic swell (THE LAW #1).

**Tech Stack:** TypeScript, Three.js `ShaderMaterial` (GLSL ES 1.00), Vite, Vitest (deterministic sim oracle), Playwright MCP for in-browser shader verification.

**Spec:** `docs/superpowers/specs/2026-06-15-ocean-underwater-visibility-design.md`

---

## Verification note (read first)

This feature is **mostly GLSL**. Per the repo's documented practice (`CLAUDE.md`: "GLSL bugs pass `tsc` + unit tests and fail only at runtime — verify shaders live via Playwright MCP at `:5173` + a readback oracle"), the shader tasks are verified **in-browser with screenshots**, not unit tests — `vitest` strips types and cannot run GLSL. So:

- **TS/config/plumbing tasks** are gated by `npm run build` (this is `tsc --noEmit && vite build` — the only thing that catches type errors *and* compiles the shader template strings; `npm run test` does NOT type-check).
- **The one sim-layer change** (island sand, Task 5) gets a real TDD red→green test, because `sim/` is the tested oracle.
- **Shader-behaviour tasks** (3, 4) are verified by Playwright screenshots at `http://localhost:5173`.

**GLSL gotcha (from `CLAUDE.md`):** a backtick inside a shader-template *comment* terminates the JS template string (`tsc` then errors "',' expected"). Don't put backticks in the GLSL you add.

**Git:** commit on `main` locally after each task; do **not** push unless asked (user preference). Stage only this feature's files. A PreToolUse hook blocks branch-switch ops in the primary worktree — plain commits are fine.

**Dev server:** start once, in the background, and leave it up for all the in-browser tasks:
`npm run dev` → serves `http://localhost:5173` (strict port). If it errors "Port 5173 is in use", a SCUTTLE window/old vite is already running — reuse it.

---

## Task 1: Add the `TUN.gfx.water` knob

**Files:**
- Modify: `src/core/tunables.ts` (the `gfx` block — `reflection` is around line 269)

- [ ] **Step 1: Add the `water` sub-object next to `reflection`**

In `src/core/tunables.ts`, inside `gfx: { ... }`, immediately after the `reflection: { ... },` line, add:

```ts
    /** underwater visibility / depth murk (render/ocean.ts). The sea becomes a
     *  translucent body you can see `visibility` metres into before it turns fully
     *  opaque, so a submerged deck dissolves into the water and the shallow seabed
     *  shows through. `clarity` 0 = OFF (exact current look); 1 = maximally see-through.
     *  The murk/deep COLOURS are tuned constants in ocean.ts (uMurkColor/uDeepColor),
     *  not sliders. */
    water: { visibility: 2.5, clarity: 0.85 },
```

- [ ] **Step 2: Verify it type-checks and builds**

Run: `npm run build`
Expected: completes with no TS errors (the shader still compiles; nothing reads `water` yet).

- [ ] **Step 3: Commit**

```bash
git add src/core/tunables.ts
git commit -m "feat(ocean): add TUN.gfx.water { visibility, clarity } knob"
```

---

## Task 2: Ocean plumbing — uniforms, `setWaterDepth`, and live wiring (no visual change yet)

Add the uniforms + setter + per-frame push + dev sliders. The shader does not *use* the uniforms yet, so the look is unchanged — this isolates the plumbing from the shader-math task.

**Files:**
- Modify: `src/render/ocean.ts` (interface ~L86, FRAG uniforms ~L334, material uniforms ~L833, returned object ~L962)
- Modify: `src/main.ts` (per-frame ocean knobs ~L1898; dev panel "Graphics" group ~L1559)

- [ ] **Step 1: Add `setWaterDepth` to the `Ocean` interface**

In `src/render/ocean.ts`, in the `export interface Ocean { ... }`, after the `setReflStrength(...)` declaration, add:

```ts
  /** dev-panel underwater-visibility controls: how many metres of water you can see
   *  down before the sea is fully opaque (`visibility`), and how see-through the
   *  shallow band gets (`clarity` 0 = off/current look, 1 = max). */
  setWaterDepth(visibility: number, clarity: number): void;
```

- [ ] **Step 2: Declare the new FRAG uniforms**

In `src/render/ocean.ts`, in the `FRAG` GLSL string, find the water-colour uniform block (it has `uniform vec3 uDeepColor;` and `uniform float uReflClamp;`). Right after `uniform float uReflClamp;`, add:

```glsl
uniform vec3 uMurkColor;     // shallow see-into-water tint (deep navy); deep end returns to col
uniform float uWaterVis;     // metres of water column visible before fully opaque
uniform float uWaterClarity; // 0 = depth-murk OFF (current look), 1 = maximally see-through
```

- [ ] **Step 3: Add the uniform values to the `ShaderMaterial`**

In `src/render/ocean.ts`, in the `uniforms: { ... }` object, right after the `uReflClamp: { value: 1.6 },` line, add:

```ts
      // underwater visibility (depth murk). Defaults match TUN.gfx.water; main.ts
      // overwrites uWaterVis/uWaterClarity every frame via setWaterDepth. uMurkColor
      // is a fixed tuned constant (deep navy) — Task 4 finalises the palette.
      uMurkColor: { value: new THREE.Color(0x0a1f3a) },
      uWaterVis: { value: 2.5 },
      uWaterClarity: { value: 0.85 },
```

- [ ] **Step 4: Implement `setWaterDepth` on the returned object**

In `src/render/ocean.ts`, in the object returned by `createOcean`, right after the `setReflStrength(...) { ... },` method, add:

```ts
    setWaterDepth(visibility, clarity) {
      mat.uniforms.uWaterVis.value = visibility;
      mat.uniforms.uWaterClarity.value = clarity;
    },
```

- [ ] **Step 5: Push the knob every frame from main.ts**

In `src/main.ts`, find the two lines (~L1897-1898):

```ts
    ocean.setChop(TUN.chop.strength, TUN.chop.choppiness);
    ocean.setReflStrength(TUN.gfx.reflection.strength, TUN.gfx.reflection.clamp);
```

Immediately after them, add:

```ts
    ocean.setWaterDepth(TUN.gfx.water.visibility, TUN.gfx.water.clarity);
```

- [ ] **Step 6: Add dev-panel sliders**

In `src/main.ts`, in the `createDevPanel([ ... ])` call, find the group `title: "✨ Graphics (visual pass)"`. After the `{ ... key: "clamp", ... }` reflection slider line (~L1560), add:

```ts
        { type: "slider", label: "see-depth", obj: TUN.gfx.water, key: "visibility", min: 0, max: 8, step: 0.25 },
        { type: "slider", label: "water clarity", obj: TUN.gfx.water, key: "clarity", min: 0, max: 1, step: 0.05 },
```

- [ ] **Step 7: Verify build + tests + unchanged render**

Run: `npm run build`
Expected: no TS errors, shader compiles.

Run: `npm run test`
Expected: all ~278 tests still pass (no behaviour changed).

In-browser smoke check (dev server already running): with Playwright MCP, `browser_navigate` to `http://localhost:5173`, start a game (Sandbox), open the dev panel (backtick) and confirm the new **see-depth** and **water clarity** sliders appear under Graphics. The sea should look **exactly as before** (uniforms declared but unused). `browser_take_screenshot` → save to the projects ROOT as `ocean-task2-unchanged.png`.

- [ ] **Step 8: Commit**

```bash
git add src/render/ocean.ts src/main.ts
git commit -m "feat(ocean): wire setWaterDepth uniforms + dev sliders (no shader use yet)"
```

---

## Task 3: Depth-murk in the fragment shader (the core)

Replace the narrow `submrg` special-case with a general per-fragment water-column model.

**Files:**
- Modify: `src/render/ocean.ts` (FRAG body: `submrg` decl ~L408, ellipse cut ~L446, profile cut ~L469, after profile loop ~L472, final alpha ~L703-707)

- [ ] **Step 1: Replace the `submrg` declaration with `floorY`**

In the `FRAG` `void main()`, find:

```glsl
  float submrg = -1.0;
```

Replace with:

```glsl
  // world-Y of the SHALLOWEST solid beneath this fragment (a submerged hull/deck from the
  // cut loops below, or the island seabed). Stays very low where nothing is in range (open
  // deep water) → the depth-murk at the end leaves those fragments fully opaque, unchanged.
  float floorY = -1000.0;
```

> Note: the big explanatory comment block above the original `float submrg = -1.0;` line describes the old behaviour. Update its last sentence or leave it — but the *declaration line itself* must become `floorY`.

- [ ] **Step 2: Feed the analytic-ellipse cut into `floorY`**

Still in `FRAG`, find (in the non-profiled fallback cut loop):

```glsl
      if (deckY > 0.3) discard;             // dry deck → cut the sea (no ocean in the hold)
      else submrg = max(submrg, 0.3 - deckY); // submerged → let the sea close over it, faded by depth
```

Replace the second line so it records the submerged deck-top world-Y as a floor:

```glsl
      if (deckY > 0.3) discard;             // dry deck → cut the sea (no ocean in the hold)
      else floorY = max(floorY, deckY);     // submerged → record the deck top as the column floor
```

- [ ] **Step 3: Feed the voxel-profile cut into `floorY`**

Find (in the profile cut loop):

```glsl
        if (deckWY > 0.3) discard;
        else submrg = max(submrg, 0.3 - deckWY);
```

Replace with:

```glsl
        if (deckWY > 0.3) discard;
        else floorY = max(floorY, deckWY); // submerged deck top → column floor
```

- [ ] **Step 4: Add the seabed contribution to `floorY`**

Find the end of the profile cut loop (the closing braces just before the `// cutaway:` comment / `float cutAlpha = 1.0;`). Immediately AFTER the profile loop's closing `}` and BEFORE the cutaway block, add:

```glsl
  // SEABED contributor to the water column: where the island land-field is bound and this
  // fragment sits over terrain, the seabed world-Y is a floor the sea can be seen down to.
  // Deep sea decodes to ~ -100 m → a huge column → opaque, so open water is untouched. One
  // texture tap (the surf-foam block below taps it again; the GPU texture cache makes that
  // ~free, and keeping them separate keeps this edit low-risk).
  if (uLandOn > 0.5) {
    vec2 fuv = (vWorldPos.xz - uLandMin) / uLandSize;
    if (fuv.x > 0.0 && fuv.x < 1.0 && fuv.y > 0.0 && fuv.y < 1.0) {
      float fLandY = texture2D(uLandTex, fuv).r * 160.0 - 100.0;
      floorY = max(floorY, fLandY);
    }
  }
```

- [ ] **Step 5: Replace the final alpha with the depth-murk model**

Find the end of `FRAG` (after the horizon-fog block):

```glsl
  // where the sea has closed over a SUBMERGED deck, fade from translucent (just awash) to opaque
  // (a couple of metres down) so the drowned hull dissolves into the murk instead of hard-clipping
  // to a void. Open water and dry hulls keep submrg<0 → full opacity, unchanged.
  float seaAlpha = submrg >= 0.0 ? clamp(0.12 + submrg * 0.4, 0.12, 1.0) : 1.0;
  gl_FragColor = vec4(col, min(cutAlpha, seaAlpha));
```

Replace that whole block with:

```glsl
  // UNDERWATER VISIBILITY (depth murk). columnDepth = metres of water over the shallowest solid
  // beneath this fragment. Shallow → translucent + navy-tinted (a sinking deck dissolves, the
  // sandy shelf shows through); deep / open water → floorY very low → visFrac 1 → fully opaque,
  // today's look. clarity 0 ⇒ shallowAlpha 1 AND murk 0 ⇒ EXACT no-op.
  float columnDepth = vWorldPos.y - floorY;
  float visFrac = clamp(columnDepth / max(uWaterVis, 0.05), 0.0, 1.0);
  float shallowAlpha = mix(1.0, 0.08, uWaterClarity); // shallowest band's opacity
  float murk = uWaterClarity * (1.0 - visFrac);        // navy veil, 0 when off OR deep
  float seaAlpha = mix(shallowAlpha, 1.0, visFrac);
  col = mix(col, uMurkColor, murk);
  gl_FragColor = vec4(col, min(cutAlpha, seaAlpha));
```

- [ ] **Step 6: Verify it still builds and tests stay green**

Run: `npm run build`
Expected: no TS errors; the shader template compiles (watch for the backtick-in-comment trap — there are none in the added GLSL).

Run: `npm run test`
Expected: all tests still pass (no TS behaviour changed).

- [ ] **Step 7: In-browser verification — the three cases**

Dev server running. With Playwright MCP at `http://localhost:5173`, start a game (Sandbox) and steer near an island (or use `browser_evaluate` to move the camera/ship via `window.DEBUG`).

A/B the effect deterministically by toggling clarity and screenshotting the same view:

1. `browser_evaluate`: `window.DEBUG.TUN.gfx.water.clarity = 0` → `browser_take_screenshot` → projects ROOT `ocean-task3-clarity0.png`.
2. `browser_evaluate`: `window.DEBUG.TUN.gfx.water.clarity = 0.85` → `browser_take_screenshot` → `ocean-task3-clarity85.png`.

Confirm by reading the two PNGs from the projects ROOT:
- **(a) Open deep water** looks identical between the two shots (no see-through, no sky-through-sea).
- **(b) Shallows by the island** turn translucent/navy in the clarity-0.85 shot — you can see into the water near the coast.
- **(c) Submerged geometry dissolves:** look at a hull's waterline / a low-riding or sinking deck — in the 0.85 shot it should fade into the water rather than show a hard cut/void. (If no sinkable hull is handy, this also reads on the shallow shelf in (b).)

Optional numeric oracle (`browser_evaluate`): read back a pixel over the island shelf vs open water and confirm the shelf pixel changed between clarity 0 and 0.85 while the open-water pixel did not — e.g. draw into a 1×1 readback via the renderer, or compare sampled canvas pixels. Screenshots are sufficient if this is fiddly.

If open water is NOT identical (e.g. tinting where it shouldn't), the `floorY` seabed guard or the `clarity 0` no-op is wrong — fix before committing.

- [ ] **Step 8: Commit**

```bash
git add src/render/ocean.ts
git commit -m "feat(ocean): analytic depth-murk — see into shallows, submerged decks dissolve"
```

---

## Task 4: Navy → black palette

Set the murk tint to deep navy and make the opaque deep end read near-black, so looking down into the water goes deep-navy → black. Values are feel-tune starting points — confirm by eye.

**Files:**
- Modify: `src/render/ocean.ts` (material uniforms: `uMurkColor` from Task 2 ~added near L833; `uDeepColor` L827; `uShallowColor` L828)

- [ ] **Step 1: Set the murk + deep palette**

In `src/render/ocean.ts` material `uniforms`, set the murk tint to a deep navy and nudge the deep colour toward near-black navy (leave `uShallowColor` unless it visibly fights the navy):

```ts
      uDeepColor: { value: new THREE.Color(0x02060e) },   // near-black navy (was 0x030f17) — the "descends to black" end
      uShallowColor: { value: new THREE.Color(0x07223a) }, // navy (was teal 0x09303a); drop teal so the body reads navy
```

And set the murk constant added in Task 2:

```ts
      uMurkColor: { value: new THREE.Color(0x0a1f3a) },    // deep navy seen INTO the shallow water
```

- [ ] **Step 2: Verify build**

Run: `npm run build`
Expected: no errors.

- [ ] **Step 3: Feel-test the palette in-browser**

Dev server running. Playwright at `:5173`, Sandbox, `DEBUG.TUN.gfx.water.clarity = 0.85`. Screenshot open water + a shallow shelf → projects ROOT `ocean-task4-palette.png`. Read it back and confirm: the deep sea reads navy→near-black, the shallow see-into band reads deep navy (not teal, not muddy black). Adjust the three hexes if needed and re-shoot. The sun glint / reflection sheen should still read (don't crush it to flat black).

- [ ] **Step 4: Commit**

```bash
git add src/render/ocean.ts
git commit -m "feat(ocean): deep-navy-to-black water palette"
```

---

## Task 5: Sand in the shallows (island seabed) — TDD

Make the island's submerged coastal shelf sand-coloured so it reads as sand through the now-translucent shallows, instead of the rock seafloor base. This is in the tested `sim/` layer, so it gets a real failing-test-first.

**Files:**
- Modify: `src/sim/islandwright.ts` (the column-material loop, ~L340-369)
- Test: `tests/islandwright.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/islandwright.test.ts`, inside the `describe("buildIsland", () => { ... })` block, add a new test (alongside the existing "has a real sand beach band" test):

```ts
  it("lays a sandy shelf BELOW the waterline so the submerged shallows read as sand", () => {
    const { grid, meta } = buildIsland(opts);
    let submergedSand = 0;
    grid.forEachSolid((_x, y, _z, m) => {
      if (m === SAND && y < meta.waterlineY) submergedSand++; // sand STRICTLY below sea level
    });
    expect(submergedSand).toBeGreaterThan(20);
  });
```

(`opts`, `SAND`, and `buildIsland` are already imported at the top of the file.)

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `npm run test -- islandwright`
Expected: the new test FAILS — today sand is only placed at a column's top voxel (`y === topY`, which is at/above `waterlineY`), so there is no sand strictly below the waterline (`submergedSand` is 0).

- [ ] **Step 3: Implement the sandy submerged shelf**

In `src/sim/islandwright.ts`, in the column-material loop, find:

```ts
      const colBase = x + nxny * z; // data idx = colBase + nx*y
      for (let y = 0; y <= topY; y++) {
        let mat: number;
        if (y < SEABED_Y) mat = ROCK; // seafloor base
        else if (isCliff)
```

Insert a `lowGentle` predicate before the loop and a sand branch right after the seafloor base:

```ts
      const colBase = x + nxny * z; // data idx = colBase + nx*y
      // a low, gently-sloped coastal column: its beach AND its submerged rim are sand, so the
      // shelf reads as sand through the translucent shallows (not the ROCK seafloor base).
      const lowGentle = topY <= WATERLINE_Y + beachBand && slope <= 1;
      for (let y = 0; y <= topY; y++) {
        let mat: number;
        if (y < SEABED_Y) mat = ROCK; // seafloor base
        else if (lowGentle && y <= WATERLINE_Y) mat = SAND; // submerged shelf + waterline rim = sand
        else if (isCliff)
```

(Everything below `else if (isCliff)` stays exactly as it was.)

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `npm run test -- islandwright`
Expected: the new test PASSES, and the existing island tests ("real sand beach band", "deterministic", "rises out of the water", harbor tests) all still pass (the change only adds sand at/below the waterline on low gentle columns; it never touches edges, above-water counts, or dock voxels).

- [ ] **Step 5: Run the full suite + build**

Run: `npm run test`
Expected: all ~279 tests pass.

Run: `npm run build`
Expected: no TS errors.

- [ ] **Step 6: In-browser — confirm sand shows through the shallows**

Dev server running. Playwright at `:5173`, Sandbox, steer close to an island with `DEBUG.TUN.gfx.water.clarity = 0.85`. Screenshot the coast → projects ROOT `ocean-task5-sand.png`. Read it back: the submerged coastal rim should read as **sand** through the shallow water (not grey rock). If the shelf isn't visible at all, confirm the island mesh isn't back-face-culled below water (it shouldn't be — `IslandVisual` uses a default `MeshStandardMaterial`, front-face, double-sided not required since the seabed faces up).

- [ ] **Step 7: Commit**

```bash
git add src/sim/islandwright.ts tests/islandwright.test.ts
git commit -m "feat(islands): sandy submerged shelf so shallows read as sand"
```

---

## Task 6: Final integration + perf pass

A focused wrap given the repo's perf history (it's fill-bound on post-FX; this change adds only a few fragment taps but verify on the real GPU).

**Files:** none expected (verification + any final tuning commit)

- [ ] **Step 1: Full build + test**

Run: `npm run build`
Expected: clean.

Run: `npm run test`
Expected: all green.

- [ ] **Step 2: Perf check on the real GPU**

Dev server running. Playwright at `:5173`, Sandbox with a fleet (set `DEBUG.fleet`/enemy count up, or use the sandbox config). Enable the HUD: `DEBUG.TUN.gfx.auto.hud = true`. Screenshot the fps/ms HUD with `clarity = 0` then `clarity = 0.85` (same scene) → projects ROOT `ocean-task6-perf0.png` / `ocean-task6-perf85.png`. Read both: the frame time should be within noise between the two (the murk is a few fragment taps). If clarity 0.85 measurably regresses, the suspect is the extra seabed `texture2D` tap under fill pressure — note it; the `clarity` slider remains a zero-cost off switch.

- [ ] **Step 3: Regression sweep of the systems this shader shares**

Still in-browser, confirm nothing the ocean shader also drives broke:
- **Cutaway (`X`)** still goes translucent-glass over the hold (the `min(cutAlpha, seaAlpha)` still composes).
- **Seam mask:** no sea bleeds onto the deck / into an open hold / as a bow void.
- **Wake/foam/waterline ring** still render around moving ships.
- **Sinking:** ram or flood a hull (or watch an enemy sink) and confirm the deck **dissolves** into the navy murk as it goes under — no hard clip to void (the original bug, now fixed the "second way").

Screenshot anything notable to the projects ROOT.

- [ ] **Step 4: Final commit (only if Step 2/3 prompted tuning)**

If you adjusted any `TUN.gfx.water` defaults or palette hexes during the perf/feel pass:

```bash
git add src/core/tunables.ts src/render/ocean.ts
git commit -m "tune(ocean): final depth-murk visibility/clarity/palette values"
```

Otherwise no commit — the feature is complete across Tasks 1-5.

---

## Self-review (completed by plan author)

- **Spec coverage:** depth-murk model → Task 3; opacity/tint + `clarity 0` no-op → Task 3 (formula matches spec §2); submersion fix as a consequence → Task 3 (replaces `submrg`); knobs `TUN.gfx.water{visibility,clarity}` → Tasks 1-2; `setWaterDepth` + main wiring → Task 2; navy→black palette → Task 4; **seeing sand (required §5)** → Task 5; perf → Task 6; invariants (visual-only, seam/cutaway intact) → Tasks 3 & 6. All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; every code step shows real code and exact find/replace anchors.
- **Type/name consistency:** `setWaterDepth(visibility, clarity)`, uniforms `uMurkColor`/`uWaterVis`/`uWaterClarity`, and `TUN.gfx.water.{visibility,clarity}` are used identically across Tasks 1-4; `floorY` introduced in Task 3 Step 1 is consumed in Steps 2-5; `lowGentle`/`WATERLINE_Y`/`SEABED_Y`/`beachBand`/`SAND` in Task 5 all exist in `islandwright.ts` scope.
- **Verification honesty:** GLSL tasks verify in-browser (repo practice); the one sim-layer change is real TDD red→green.
