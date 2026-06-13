# Round 14 — Ocean & Water Rebuild (worklog)

Autonomous build per the user's directive ("scrap the chop, build a AAA GPU ocean like
Black Flag / Sea of Thieves, stronger buoyancy, voxel-accurate height-sensitive void,
real flood fluid, GPU bow-spray/side-bulge/stern-wake; go all out, no approval stops").
Driven by an 11-agent research + codebase-map workflow → design at
`docs/superpowers/specs/2026-06-13-ocean-rebuild-design.md`. Every visual change verified
in-browser (Playwright on :5180 + numeric readback) because GLSL bugs pass tsc/unit tests.
(Note: the dev server actually runs on **:5173** — vite's default; the 5180 above was wrong.)

## Round 17 — voxel-centric physics + chasers + cleanup (commits `f9c313e`, `0095390`, `befd1c1`, `c1a6c04`, `a3ee5c4`)

Directive: "tune the voxels, not the knobs — mechanical interference with the dynamic voxel
system just convolutes." Ran a 7-agent opus discovery workflow (2 physics-research + 5 code-map),
then implemented + verified each piece in-browser. Five commits, all pushed to main:

- **`f9c313e` voxel-emergent hull dynamics.** Deleted the six hand-tuned levers (pitchDamp,
  rollDamp, trim, keelDepth, heelVelCap, turnHeelArm). Heave + pitch + roll damping now emerge
  from ONE coefficient — per-column vertical drag distributed over the wet waterplane's
  area-moments (a provably-dissipative `Σ area·u·uᵀ`, u=[1,−rz,rx]). Turn-heel, sail-heel
  righting and the turn's centripetal pull all emerge from applying the leeway force at the
  live **centre of buoyancy** (below the COM). Trim emerges from the per-voxel mass (static
  trim measured −0.8° = level). **Capsize gotcha (cost one iteration): applying the leeway
  force at the COM deletes the keel's righting against sail heel → she capsizes under full
  sail; apply it at the CB and do NOT also add an explicit m·v·ω·h torque (double-count).**
  Verified: full sail ~6° stable heel, hard turn +9.6° outward bank, never swamps, waterlog 0.
  Defaults: buoyancy 1.5, heave ζ 0.2, chop 1 / choppiness 1.5. Dev panel → "Hull physics" (4
  real coefficients only).
- **`0095390` removed the LOST-AT-SEA / PRIZE-TAKEN end-game.** A sinking ship just continues
  the voyage now — no banner, no freeze, no reload. Kept isSunk, enemy salvage, respawn.
- **`befd1c1` constant bow spray + a short displacement wake.** Spray is a steady ~16 Hz sheet
  off both cutwater shoulders (was crest-gated, cut in/out). Wake spacing 2.4→1.2 m, retention
  16→7 s, faster foam fade + tighter width spread → a ~1-hull-length feathering wake, not a
  3-boat-length speedboat tail. (Foam outline still centreline-trail; voxel-shaped outline deferred.)
- **`c1a6c04` bow & stern chasers.** Axial guns that fire forward/aft (the player: "so hard to
  line up shots"). `cannonPorts.facing` ("fore"/"aft"), gunnery/shipVisual/cannons generalized,
  `aimBearing()` routes fire to the battery the camera bears toward. Guns depress now (−8..16°).
- **`a3ee5c4` character.** Rebuilt the FP cutlass (curved extruded blade + brass knuckle-bow +
  fist, was a flat box on a ball); restored the 3P head (rigged head bone was stuck at scale
  0.001 from the FP-hide) and moved the sword arm outboard so it clears the torso.

## Round 16 — the big reassessment (commits `76fa66c`, `332e7bf`, `a4c39c3`, `bda6c83`)

The player asked for a full step-back ("we keep coming back to this… something is fundamentally
wrong with the wave or chop"), parallel opus agents + a research agent. Ran an 8-agent workflow
(3 research, 4 code-analysis, 1 synthesis) for theory/code-map AND did my own empirical in-browser
diagnosis. The synthesis *deduced* the jitter was the swell (reasoning "physics only reads the
swell") — a **deduction error**; my instrument proved otherwise.

- **THE JITTER = a structural FFT bug, found empirically** (`76fa66c`). Read back the cascade
  height field and measured it: `oppositeSignAdjacentFraction 0.98`, `hiFrac 1.0` — i.e. every
  adjacent texel flips sign while the *magnitude* varies smoothly → the field was the real surface
  **× (−1)^(x+y)**, a per-texel CHECKERBOARD. Cause: `oceanFFT.ts` centers k at index N/2
  (`kx=2π(m−N/2)/L`) but the inverse-DFT sums the RAW index `i·m`, omitting the `(−1)^(i+j)` the
  −N/2 offset implies (the file even *says* "There is NO fftshift"). The mesh bilinear-samples that
  checkerboard → the "vibrating sand" jitter we'd tuned amplitude/damping/foam around for ~5 rounds.
  Fix = multiply the IDFT output by `(−1)^(i+j)`. Verified live: `oppSign 0.98→0.016`,
  `hiFrac 1.0→0.002`; the sea is now smooth coherent waves. The big-wave shapes (the swell base)
  were never the problem and are untouched.
- **TRUE per-voxel buoyancy** (`332e7bf`). Replaced the per-column probe model (a fully-wet column's
  stiffness collapses to 0 → ±3 m wander + bounce) with `makeVoxelColumns`: every displacing cell
  pushes up `ρg·V_cell·(its own submerged fraction)` at its own height; wave surface sampled ONCE
  per (x,z) column, net force+couple accumulated and applied once (rigid-body-identical, **4 ms
  median frame**). Stiffness is now exactly `ρg·waterplaneArea` and CONSTANT with draft → she holds
  a near-fixed waterline (measured heave span **1.6 m**, was ±3 m; **2 zero-crossings/6 s** = no
  bounce). Heave damping is now `c=2ζ√(km)` off the LIVE stiffness, so she settles the same at any
  buoyancy. Defaults: buoyancy **1.5** (the player's pick), heave **ζ 0.8**. `makeProbes` kept for
  the hydrostatic tests. Hard turn still 8.8° heel, waterlog 0.
- **Removed far-field particles + the foam mechanic** (`a4c39c3`). Deleted `ambientSpray` (the
  camera-ring crest plumes = the "random white bursts a few ship-lengths away") and dropped both
  open-water foam paths (`crestFoam` + `dynFoam`) from the ocean foam mix — only the ship WASH
  (wake) whitens the sea now. Bow spray + wake kept; `crestSpray`/foam left dormant for later.
- **Chop dev sliders + bulletproof fullscreen** (`bda6c83`). New "Waves / Chop" panel group
  (`chop` strength + `choppiness`) → `ocean.setChop` via `uChopScale`/`uChoppiness`; chop=0 = pure
  swell (the player's "play with the chop" + a jitter-bisect tool). Fullscreen: the API itself is
  verified working (F entered fullscreen in Playwright), so the failure is most likely **already
  being in browser F11** — hardened anyway (webkit fallback, dropped the options dict, try/catch,
  on-screen failure text incl. an "already in F11?" hint). Swell-iteration "insurance" (3→5) was
  SKIPPED — the swell measured fine; the jitter was the FFT.

## Round 15 — playtest fixes (commit `abba186`)

Feedback after r14 hit the water at sea level: voxel cut good, large waves good, but
(1) constant white spatter, (2) violent jagged surface vibration, (3) broken wake,
(4) hull "rises and falls uniformly" with no pitch/roll to the water under it AND
"goes completely underwater under max speed + turn", (5) F-fullscreen dead. Plus the
headline ask: **"just give me a dev panel where I can adjust these variables myself."**

- **Voxel-buoyancy attitude (`game/ship.ts`, `game/sailing.ts`).** Root cause was NOT
  the buoyancy model — `stability.test` proves the probe model already has GM>0.15m
  righting. `ship.ts` was *suppressing* it: pitch damped at `4.2×iz` + a `vF²`
  trim-to-level term froze the wave-following the per-column torques produce. Slashed
  pitch/roll damping to 1.3/0.9 and cut trim to 3 → she now pitches/rolls to the swell
  (measured: pitch ±3°, heel ±9°, oscillating about level; settles to the designed 0.45
  draft, waterlog 0). The capsize-in-a-turn was three heel sources stacking, the worst an
  *uncapped* lateral-drag-at-keel couple that grew without bound as she skidded — decoupled
  the lateral *resistance* (now at COM) from the *bank* couple, which rides off a CAPPED
  skid velocity. Measured: full sail + hard rudder at 23 kn peaks at **8.3° heel**, never
  founders (was a knock-down).
- **Dev panel (`render/devPanel.ts`, `core/tunables.ts`).** Dependency-free slider/checkbox
  overlay, backtick to toggle, frees the mouse on open, live readout (pitch/heel/submerged/
  waterlog/speed). Writes into a shared mutable `TUN` that physics + render read every step,
  so the subjective sea/boat feel is tunable with no reload. Groups: Buoyancy/Attitude,
  Dynamic Waves (wake), Spray.
- **Clean ocean (`render/dynamicWaves.ts`, `render/ocean.ts`, `main.ts`).** The spatter was
  the spray splash-down foam discs + field foam; the jagged shaking was the FDTD injection.
  New `dynWaves.setTunables(damping, inject, foam)` + ocean `uDynScale`; defaults foam 0,
  damping 1.8, height 0.45 → clean sea out of the box, wake/spray dialable back up. Spray
  emission now gated on `TUN.spray`.
- **F-key (`main.ts`).** Chrome silently rejects `requestFullscreen` issued while pointer
  lock is held — and you're locked while sailing, so F did nothing. Release the lock first,
  then request, then re-grab. (Couldn't auto-verify true fullscreen — needs a real gesture
  Playwright won't forge — but the root cause is addressed and the handler runs clean.)

Verified in-browser: 0 console errors on a fresh load, panel renders + sliders live, all
the numeric checks above. tsc clean, 117 tests green.

## Shipped (committed + pushed to main)

| Phase | Commit | What |
|---|---|---|
| P1 | `4d94717` | **Multi-cascade Tessendorf surface.** 3 non-commensurate FFT tiles (bands 12-40 / 5-18 / 2-7 m, tiles 40/18/7 m, crossing winds) replace the single <14 m chop that could only shimmer + tile + camo. New `oceanCascade.ts` behind the `OceanField` seam; per-cascade band window in `oceanSpectrum.ts`; `ocean.ts` sums cascades + consumes the real cascade normal (fixes the value-noise grid) and Jacobian foam via a black-point tiling fade (fixes camo). **Gotcha:** ANGLE/Windows rejects loop-indexed sampler arrays → the whole ocean program silently invalidated (sea vanished); fixed by UNROLLING to constant indices. |
| P3 | `30f5be9` | **Stronger buoyancy.** Root cause was over-damped heave (round-9 `fY=-mass*4.5*vY`) + visual chop towering over a hull that only rode the 1.5 m swell. Heave drag 4.5→2.8 (she tracks crests); cascade chop pulled to ~1.4 m but choppiness λ bumped (stays sharp). Measured: heave ±1.5→±2.08 m rest / ±1.68 m full sail, waterlog 0, sub-frac 0.28-0.65 (no porpoise, no flood). Analytic/deterministic — physics never reads the GPU field. |
| P4 | `2fe4ff2` | **Voxel-accurate + attitude-aware in-hull cut** (player hull). `buoyancy.buildHullProfile` bakes a per-column keel/deck height-field; `ocean.ts` inverse-transforms each sea fragment into the hull's LOCAL frame and discards only sea between that column's keel/deck (+2 m clearance). Folds in heave/pitch/roll at once → no void on bob, follows the pointed bow. Verified top-down (no void crescent) + low-angle under sail. Enemy still uses the analytic ellipse (TODO: extend). |
| P6 | `0755f8c` | **Real flood fluid** (deleted the blue cubes). `shipVisual` `addWaterPlanes/updateWater` (emissive blue boxes) → new `compartmentFluid.ts`: clipped, world-leveled (pools to the low side), sloshing free surface per compartment. Verified in cutaway: no blue cubes, translucent water surface. **TODO polish:** thread `camera.position` from main.ts into `world.step`/`updateWater` for true fresnel (currently overhead-shaded → a bit dark). |

Also folded in from round-13 cleanup: cannon-debris cap 250, enemy sloop bow-down trim fix.

| P5 | `dc032f0` | **GPU ship-water interaction.** Crest/Atlas dynamic-wave field: 2× RGBA-float ping-pong RTs (R=height, G=velocity, B=foam) over a 256 m camera-window (texel-snapped → no scroll-shimmer), FDTD wave-equation + semi-Lagrangian advection so disturbances TRAIL; each ship's voxel footprint (reusing `buildHullProfile`) stamped as velocity → bow push-up + beam bulge + stern suck. New `spray.ts` = GPU-instanced ballistic droplets on a physical bow-crash trigger (`gerstner.surfaceVelocity`, +2 tests). `ocean.ts` ADD-ONLY: sums the dynamic height after the cascades, cross-fades the analytic collar/bow down (`aMix=1−dynMix`), folds `dynFoam` into the foam mix. I REVIEWED the diff (cascade unroll + P4 profile discard untouched) and verified in-browser: ocean renders 0 program errors, prominent **trailing wake** (curves with the path), bow wave + spray, flank foam, **waterlog 0** (no flood regression), 117 tests. |

## Verified result
All SIX user asks delivered: sharp choppy crossing waves (P1), rides the sea (P3), voxel+bob-proof void cut (P4), real flood fluid / no blue cubes (P6), bow-spray/side-bulge/stern-wake (P5), GPU-heavy throughout. From a top-down at 21 kn: choppy crossing sea + a long Kelvin-style wake trailing the hull + bow/flank foam + spray.

## Remaining / TODO (optional polish — core vision delivered)
- **P2 — perf (low priority; user wants GPU-heavy):** swap the O(N²) inner DFT for a butterfly
  FFT (N=256, log₂N ping-pong passes), verified texel-for-texel against the CPU oracle; add
  normal MIPMAPS to kill the faint crosshatch still visible at extreme grazing foreground.
- **Rudder authority** (pre-existing, flagged by the P5 agent; NOT a flood regression — waterlog
  stays 0): she's sluggish to answer the helm at sustained sail. Separate gameplay-balance item,
  out of the ocean-rebuild scope, worth a look.
- Push the chop MORE dramatic now P3/P4 let her ride + clear bigger seas (raise cascade amps,
  re-verify no deck-clip). Extend the voxel cut to the enemy. P6 camera-fresnel plumbing.
- Make the chop MORE dramatic now P3 lets the hull ride bigger seas (raise cascade
  amplitudes once P4's clearance + P3's ride are confirmed together).
- Extend the voxel cut (P4) to the enemy hull (2nd profile + pose).
- P6 camera-fresnel plumbing (above).

## Verification harness notes
- DEBUG globals: `sloop`/`enemy` (`.body`, `.build.compartments`, `.submergedFrac`,
  `.waterlog`), `oceanField` (`.cascades`, `.__fields[c].readbackHeight()` — the per-cascade
  GPU-vs-CPU oracle), `controls` (`orbitYaw/orbitPitch/dist`, `keys['d']`), `sailing.sailSet`.
- Cutaway = **X** key (`dispatchEvent(KeyboardEvent {code:'KeyX'})`); flood = set
  `compartments[i].waterVolume`.
- Playwright screenshots land in the projects ROOT, not the repo.
- Vite has NO `import.meta.hot` for ShaderMaterial → FULL reload after every GLSL edit.
