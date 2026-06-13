# Round 14 — Ocean & Water Rebuild (worklog)

Autonomous build per the user's directive ("scrap the chop, build a AAA GPU ocean like
Black Flag / Sea of Thieves, stronger buoyancy, voxel-accurate height-sensitive void,
real flood fluid, GPU bow-spray/side-bulge/stern-wake; go all out, no approval stops").
Driven by an 11-agent research + codebase-map workflow → design at
`docs/superpowers/specs/2026-06-13-ocean-rebuild-design.md`. Every visual change verified
in-browser (Playwright on :5180 + numeric readback) because GLSL bugs pass tsc/unit tests.

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
