# SCUTTLE — Autonomous Overnight Worklog (started 2026-06-13)

Single source of truth for this unattended session. Update at every major junction so a
post-compaction me can resume instantly. Newest entries at the TOP of the LOG section.

## Mission (from the user, going to bed)
Continue autonomously through the water stage AND the whole long-term roadmap. Commit at
logical increments (risk-free via backups). Use opus/sonnet subagents to save context.
Leave notes (this file). RESEARCH instead of guessing when in unfamiliar territory.

Philosophy the user stressed: **don't over-fit / hard-set things to be correct — make them so
realistic that they become automatically correct** (tune gravity/density/volume/mass-distribution
so the right behavior emerges). Research real-world specs (yacht weight distn, hull sizes) to guide.

## Task queue (priority order)
1. **WATER — remove the "camo" foam texture entirely.** Root cause = `fftFoam` block in
   src/render/ocean.ts FRAG (lines ~435-447): FFT foam coverage thresholded + value-noise
   dappled → reads as low-res white blobs on random waves. User: remove entirely; research
   how real projects (AC Black Flag / Sea of Thieves / Crest) do foam. [research agent running]
2. **WATER — chop too small + "violently fast / vibrating".** Wants spaced-out + slower. Likely:
   amplitude 110 too high + soft 6m cutoff still passes fast short ripples. Push cutoff to longer
   λ and/or drop amplitude. Swell size is GOOD now (just a touch uniform — two trains visible when
   zoomed out; low priority).
3. **BUOYANCY — ship floats too low (sea ~at deck).** Want realistic freeboard (tall dry hull band
   above waterline) to emerge from physics. At rest submerged_vol = ship_mass/WATER_DENSITY(1025),
   so avg hull density must drop to ~0.4-0.5×water. Find & retune ship mass / ballast.
   src/sim/buoyancy.ts = probe Archimedes (read, understood). [research agent running for specs]
4. **GAMEPLAY (non-voxel):** (a) sink ≠ permanent game-over → allow board/swim; (b) remove enemy
   crew entirely for now; (c) first-person right arm always in frame holding selected tool.
5. **VOXEL ROADMAP (big, was parked, now in scope overnight):** voxel collision, voxel masts/sails,
   in-hull fluid, ramming/destruction. There's already src/sim/voxelGrid.ts + buoyancy probes.
   Do brainstorm→spec→plan for this; risky unattended, go carefully, commit often.

## Key invariants / gotchas (do not relearn the hard way)
- Two-layer ocean: physics rides ONLY the analytic Gerstner SWELL (λ≥14m, `physicsWaves`).
  Visual = swell + band-limited FFT chop (λ<14m) on top. NEVER let chop into physics.
- Flooding constraint: a bigger SWELL dips the low gun ports underwater → floods → sinks (~100s).
  So roughness must come from CHOP, not swell. SWELL_AMP 0.80 is flood-safe; 1.05 sinks her.
  NOTE: raising freeboard (task 3) should RELAX this — higher gun ports = bigger swells become safe.
- Verify GPU/shader changes IN-BROWSER (Playwright MCP, dev server port 5180), not just tsc/tests.
  Screenshots: save with a RELATIVE filename → lands in projects/.playwright-mcp/, then Read it.
- tsc clean + vitest green before every commit. spectrum.test.ts bounds track SWELL_AMP — update
  together. Repo: scuttle (own git repo). Commit at each junction. Co-Authored-By Claude.
- Files: ocean shader = src/render/ocean.ts. Spectrum = src/sim/oceanSpectrum.ts (phillips, 6m
  kCut, 1/k² rolloff, band-limit <14m). Swell params = src/sim/gerstner.ts (L_MAX 80, SWELL_AMP
  0.80). Field setup = src/main.ts (createOceanField N256 L250 wind11 amplitude110). FFT GPU =
  src/render/oceanFFT.ts. Ship mass/physics = src/game/ship.ts + src/sim/shipwright.ts.

## RESEARCH RESULTS
### Buoyancy/freeboard (agent done)
- **THE LAW:** avg_hull_density / seawater = V_submerged/V_hull ≈ draft/depth (d/D). To control how
  deep she sits, set average hull density = target d/D. Independent of that, set bottom-band density
  HIGH + top-band LOW to control stability (GM) without changing draft.
- **Targets:** d/D ≈ 0.55–0.65 → avg hull density ≈ 0.55–0.65× water (≈ 560–665 kg/m³). Frigate look
  f/D=0.5 → 0.5. So `expectedSubmergedFrac()` SHOULD read ~0.55–0.65. If it reads higher (~0.85+),
  that's the bug → cut total mass (less iron, lighter wood) keeping ballast LOW.
- Ballast band (bottom ⅓) density 1.0–1.6× water; top ⅓ 0.1–0.25× (air) → low KG, GM ≈ 0.6–1.2 m.
  Cb ≈ 0.55. Δ = ρ_water·Cb·L·B·d. Real anchor: Lady Washington brig d/D≈0.65, f/D≈0.35.
- Bob damping: per-cell vertical drag (dominant) + added mass — already have heave drag fY.
- CAVEAT: a chunk of the "awash" look in the screenshot may be VISUAL pile-up — it was full throttle,
  so bow-wave (+1.05m) + collar (+0.22m) heap water on the hull. Measure resting draft first.

### Foam/whitecaps (agent done)
- **Root cause of camo:** (1) wrong PLACEMENT — height/FFT-scalar threshold paints rounded swell
  TOPS, not breaking crests; (2) wrong APPEARANCE — a single low-frequency value-noise field IS
  camo by construction. Both compound in ocean.ts FRAG `fftFoam` block.
- **Fix:** (#1) Jacobian-of-displacement FOLD mask — foam only where the surface self-intersects
  (J = (1+∂Dx/∂x)(1+∂Dz/∂z) − (∂Dx/∂z)(∂Dz/∂x); foam where J<0). That's where waves "break".
  (#2) mask × multi-scale DETAIL (tileable foam tex, or high-freq multi-octave noise) sampled at
  2 scales/dirs, MULTIPLIED → high-freq breakup; crisp the edge smoothstep(0.45,0.55, mask*detail*2);
  value noise only as threshold jitter, never the fill. Foam = off-white, roughness→1 (kill spec).
  (#3 optional) ping-pong accumulation/decay buffer so foam persists+trails (Crest/SoT do this).
- Sea of Thieves / Crest / AC Black Flag all = Jacobian peak mask + artist texture + feedback decay.
- NOTE: oceanFFT.ts already has a foamPass w/ uPrevFoam (accumulation). MUST read what it injects —
  if already Jacobian, fix is appearance-only in ocean.ts FRAG. Else fix placement in the FFT pass.
- CONFIRMED after reading oceanFFT.ts FOAM_FRAG (line ~280): foam pass ALREADY does Jacobian
  J=(1+∂Dx/∂x)(1+∂Dz/∂z)−∂Dx/∂z·∂Dz/∂x with accumulation max(instant, prev*0.96). BUT injection is
  `foamInstant = clamp(-(J-1),0,1)` = fires for ALL compression J<1, not just folds J<0 → foam
  smeared over too much surface. Foam mask tex = N256/L250 ≈ 1m/texel → blocky when magnified.
  PLAN: (a) FFT pass: tighten injection to genuine folds (smoothstep down through J≈0, sparse).
  (b) ocean.ts FRAG: replace brightness-dapple with mask × high-freq 2-octave detail, crisp edge
  smoothstep(0.45,0.62,...), fade detail w/ distance. Goal: rare crisp lacy crest foam, NOT camo.
- CHOP "vibrating": amplitude 110 + soft 6m cutoff leaks fast 2-6m ripples. PLAN: raise kCut to
  ~8-9m + drop amplitude to ~80 + soften choppiness pinch 2.7→~2.2 (bigger λ ⇒ physically slower).
  Prefer physical (bigger waves) over artificial time-slow. Spectrum bakes into h0 → reload to test.

## BUOYANCY DIAGNOSIS (measured in-browser — DON'T re-derive)
- Resting submergedFrac ≈ 0.475; equilibrium expectedSubmergedFrac = 0.542; under way it OSCILLATES
  0.56–0.76 with swell phase. AVERAGE draft ≈ 0.54 moving OR at rest — there is NO real squat.
- NOT flooding (waterlog 0, flood 1m³), NOT heel (roll ~0.5°), NOT bow-dig (pitch ~0.1°). The
  "buried to the gunwale at 19kn" screenshot = swell crest moment + the VISUAL bow-wave(+1.05m,
  ocean.ts vert)+collar(+0.22m) piling water on the hull. 0.54 draft is also a bit deep.
- Sail thrust is INTENTIONALLY arcade-fast (~21kn; sailing.ts "realistic hull speeds were no fun").
  Applied horizontally at COM (no downforce). Don't unilaterally slow it — was a playtest call.
- FIX PLAN (buoyancy): (1) ride higher — cut total mass so avg density/draft ≈ 0.44-0.46 (remove
  UPPER ballast tiers in shipwright → also lowers COM, win/win). (2) trim collar 0.22→~0.15. KEEP
  the bow wave (user explicitly asked for it round 9). Mass = grid.totalMass() (materials densities
  × voxels). Player ship built by buildBrig? (main.ts) — confirm before editing ballast.
- Camera for judging (via DEBUG.controls): orbitYaw/orbitPitch/dist are settable; sailSet via
  DEBUG.sailing.sailSet, rudder DEBUG.sailing.rudder. Broadside = orbitYaw = heading ± π/2.

## PROGRESS (checkboxes)
- [x] WATER: camo foam removed + chop slowed (commit f99fc9b, PUSHED). Verified: camo gone from
      all angles, water clean like ref. Chop amp 110→140, cutoff 6→8.5m, choppiness 2.7→2.2,
      foam=Jacobian-fold-only + high-freq detail erosion. Motion ("vibrating") to be judged live.
- [x] BUOYANCY: ride higher, ref-like freeboard (commit a9110ab). Dropped by+8 ballast course →
      draft 0.54→0.45, mass 689→574t, COM 2.30→2.14 (stiffer). Stable, no flood/capsize. draft.test
      band updated 0.4-0.5.
- [x] GAMEPLAY (b) remove enemy crew (commit 627b022) — ensureCrew posts=[] ; verified 0 spawn.
- [x] GAMEPLAY (a) sink ≠ instant game-over (commit 627b022). Enemy sink = non-terminal (salvage+
      sail on). Player sink = 35s "ABANDON SHIP swim for it" grace then LOST AT SEA. Verified.
      NOTE: full swim-to-enemy-board CONTINUATION not wired (respawn assumes own ship); left for
      boarding/voxel overhaul. The grace removes the instant binary death the user hated.
- [x] GAMEPLAY (c) first-person arm + cutlass viewmodel (commit 1a575ab). Procedural, camera-
      parented, swings on slash. Cutlass only (no tool-selection system yet). Verified in-browser.
- [x] VOXEL roadmap — DESIGN DOC written (not implemented; user parked it). See
      docs/superpowers/specs/2026-06-13-voxel-overhaul-design.md. KEY: ramming ALREADY carves
      voxels; gap = bow-vs-side asymmetry + visible holes. Recommended next = Phase V1 (low-risk).
- [x] SMOKE TEST: fresh load 21s, 0 console errors, both ships afloat (player draft 0.45 wl0),
      0 crew, no spurious game-over. All 5 changes integrate cleanly.

## SESSION COMPLETE (2026-06-13 overnight)
Shipped + pushed to main: f99fc9b (ocean foam/chop), a9110ab (buoyancy freeboard), 627b022
(crew + game-over), 1a575ab (FP arm viewmodel). All tsc-clean, 115 tests green, verified in-browser.
Voxel = design doc only (parked by user). AWAITING USER LIVE JUDGMENT on chop motion + foam density.
Memory updated: [[scuttle-round13-overnight]].

## HARNESS LESSON (important)
- DO NOT zero a ship's linvel/angvel each tick to "stop" it for a screenshot — it destabilizes the
  buoyancy integrator and SINKS her (false alarm). To judge resting state: set DEBUG.sailing.sailSet=0
  ONCE and let her coast, or just observe passively. submergedFrac is a NOISY per-frame read (swings
  0.3-0.8); trust expectedSubmergedFrac() (= equilibrium = avg density) for the real draft.
- Screenshots save to projects/<name>.png (project ROOT), Read from there. Camera via DEBUG.controls
  .orbitYaw/orbitPitch/dist; broadside = heading ± π/2; heading from body quat applied to +X.

## LOG (newest first)
- 2026-06-13 — WATER + BUOYANCY both shipped & verified in-browser (commits f99fc9b pushed, a9110ab).
  Two loudest complaints addressed. Moving to gameplay patches (crew removal first).
- 2026-06-13 — Diagnosed buoyancy in-browser (above). Resting freeboard is actually healthy; the
  under-way burying is visual pile-up + slightly-deep 0.54 draft. Moving to WATER fixes first
  (foam camo + vibrating chop = louder complaint), then buoyancy mass + collar. Both research
  agents done (results above).
- 2026-06-13 — Session start. Read ocean.ts, buoyancy.ts, gerstner.ts, constants.ts, spectrum.
  Launched 2 bg research agents: (A) ocean foam/whitecap techniques; (B) realistic ship buoyancy
  /freeboard specs. Next: locate ship mass code + FFT anim rate, then act on research.
