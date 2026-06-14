# SCUTTLE Ocean & Water Rebuild — Design (round 14)

> Autonomous build per the user's directive: scrap the chop, build a AAA GPU ocean
> (AC4 / Sea of Thieves), stronger wave-following buoyancy, voxel-accurate +
> attitude-aware in-hull cut, real flood fluid (delete the blue cubes), GPU
> bow-spray / side-bulge / stern-contrail. Full autonomy — implement all phases,
> verify each in-browser, commit + push. Synthesized from an 11-agent research +
> codebase-mapping workflow (run wf_53d0f6d7-aa9).

> ✅ **SHIPPED (rounds 14–17) — but this DESIGN now lags the CODE.** The rebuild landed (3-cascade
> ocean, real flood fluid, voxel void cut, per-voxel buoyancy), recorded in `docs/ROUND14_OCEAN_WORKLOG.md`.
> Details below that did NOT ship as written: "drop the <14 m cap" (physics KEPT the ≥14 m swell-only rule
> for determinism); "un-damp heave `fY=−mass·4.5·vY`" (that constant was deleted in r17 — replaced by
> per-voxel buoyancy + the `heaveDamp` ζ in `core/tunables.ts`). **Read `CLAUDE.md` and the code, not this,
> for current values.**

## Root cause
The current chop is ONE band-limited FFT tile capped at <14 m. That can only
shimmer (short waves oscillate fast), tile (one period), and camo (a ~1 m/texel
mask magnified). Fix = the documented AC4/SoT/Atlas recipe ported to WebGL2
fragment passes (no compute): multi-cascade Tessendorf FFT surface, analytic
Gerstner swell kept as deterministic physics truth, Crest-style dynamic-wave
injection for ship interaction, voxel attitude-aware hull clip, clipped sloshing
flood fluid. Most pieces already exist in correct-but-single-tile form and are reused.

## Phases (each ships independently, verified in-browser — GLSL bugs pass tsc/units)
- **P1 — Cascaded chop on the existing DFT engine** (LOW). 2–3 non-commensurate
  cascades (~64/24/8 m bands), drop the <14 m cap, real choppiness λ, consume the
  cascade normal (fix the value-noise grid) + Jacobian foam via a tiling black-point
  fade (fix camo). Analytic swell + physics untouched. *Goal: SEE sharp crossing crests.*
- **P2 — Butterfly FFT** (MED). Replace O(N²) DFT with radix-2 butterfly so N=256×3
  fits desktop budget. Verified texel-for-texel vs the CPU oracle.
- **P3 — Stronger buoyancy** (MED). Un-starve the physics swell band + un-damp heave
  (ship.ts fY=−mass·4.5·vY). Analytic/deterministic; 115 tests stay the oracle.
- **P4 — Voxel + attitude-aware void cut** (MED). Per-column hull height-field from the
  voxel grid + live quaternion → hull-local discard. No void on bob.
- **P5 — Dynamic-wave interaction** (HIGH). Crest FDTD ping-pong field + voxel hull
  injection (bow push/spray, side bulge, stern contrail) + GPU-instanced ballistic spray.
- **P6 — Real flood fluid** (MED). Delete the blue cubes; clipped, world-leveled,
  sloshing surfaces per compartment.

## Key decisions (adopted)
1. Cascades: P1 on the existing DFT at N≈128–192 to validate; P2 → 3×256 butterfly. Config-exposed.
2. Physics gets wave height from the analytic CPU Gerstner mirror (deterministic, vitest-safe); GPU readback OFF by default (Steam-flag only).
3. Keep the analytic Gerstner swell as both visual swell + physics truth; FFT cascades are texture on top, band-split BELOW the swell so they don't double-count.
4. Flood = clipped world-leveled height-field + slosh spring first; optional slosh texture later; no particle fluid.

## Verification doctrine
Every visual phase: Playwright on :5180 (screenshot + the numeric readback oracle
`readbackHeight` vs `spectrum.heightField` per cascade) + tsc clean + 115 vitest green.
Vite does NOT hot-rebuild ShaderMaterial — full reload each GLSL edit.

(Full research dossiers + the complete design markdown live in the workflow result
for run wf_53d0f6d7-aa9; this is the working summary the build follows.)
