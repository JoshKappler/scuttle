# SCUTTLE — read this first

**SCUTTLE** is a pirate voxel naval roguelite (Three.js + Rapier3D + Vite + TypeScript, vitest tests). The browser build is the demo; the end-vision is a Steam desktop build. It is ~48h old and built fast by many concurrent Claude instances, so the `docs/` tree is full of **dated worklogs and design specs that describe earlier rounds**. They are history, not marching orders.

> **THE RULE: when a doc disagrees with the code, the code wins.** Verify any file / flag / tunable in the source before relying on it. This file is the current-state index; keep it honest.

_Last verified against code: 2026-06-13 (round 17)._

## Run / build / test
- **Dev:** `npm run dev` → **http://localhost:5173** (Vite default). The "5180" in old worklogs was a typo — it has never been 5180.
- **Build:** `npm run build` (= `tsc --noEmit && vite build`). **Test:** `npm run test` (= `vitest run`); ~115 tests, keep green before commit.
- **Dev panel:** backtick `` ` `` toggles it (releases pointer-lock). It live-edits `TUN` in `src/core/tunables.ts`.
- **In-browser verify (GPU/shaders):** GLSL bugs pass `tsc` + unit tests and fail only at runtime — verify shaders live via Playwright MCP at `:5173` + a readback oracle. Screenshots land in the **projects ROOT** (`projects/<name>.png`), Read them from there.
- `window.DEBUG` (set in `src/main.ts`) exposes: `sloop, enemy, world, cannons, captain, boarding, controls, camera, sailing, ramming, debris, oceanField, dynWaves, spray, character`. (Old docs say `hulk` — it's `enemy` now.)
- **Repo:** `scuttle/` is its own git repo. The parent `projects/` is **not** a repo — never `git init` at root.

## Tunables (`src/core/tunables.ts` → `TUN`) — NOT read by the deterministic vitest oracle
- `phys`: `buoyancy 1.5`, `heaveDamp 0.2` (heave/pitch/roll damping ζ), `yawDamp 0.7`, `lateralDrag 1.7`.
- `dyn`: dynamic-wave FDTD field (`enabled, heightScale, inject, damping, foam`).
- `chop`: FFT surface detail (`strength 1, choppiness 1.5`). `spray`: bow spray (`enabled, bow 1`).
- `gun`: cannon ballistics (`muzzleSpeed 150, drag 0.0025, mass 4.3`) — drives BOTH the live ball (`game/cannons.ts`) and the aim-arc preview (`main.ts`), so the rendered trajectory ≡ the real shot. r18 retune off the round-8 arcade values (72 m/s / 0.006 → ~70 m at 5°); real 6-pdr ≈ 440 m/s / 0.0008. `mass` scales the hit's hull-shove impulse.

## Architecture (source-of-truth modules)
- `src/core/` — `constants`, `rng` (deterministic), `tunables`.
- `src/sim/` — deterministic physics (the test oracle): `buoyancy` (TRUE per-voxel), `compartments`, `connectivity`, `gerstner` (swell), `oceanSpectrum`/`fft`, `shipwright` (hull voxels), `ballistics`, `aiBrain`, `heel`, `materials`, `rigDamage`.
- `src/game/` — `ship`, `world` (fixed-step loop), `physics` (Rapier), `crew` (+ FP viewmodel), `boarding`, `cannons`, `gunnery`, `player`, `sailing`, `ai`, `ramming`, `debris`, `character`.
- `src/render/` — ocean: `ocean` + `oceanCascade` + `oceanFFT` + `oceanField` + `dynamicWaves`; plus `shipVisual`, `compartmentFluid`, `pirateModel`, `devPanel`, `voxelMesher`, `spray`, `seamMask`, `sky`, `effects`.
- `src/main.ts` — entry / main loop / camera / FP viewmodel / `window.DEBUG`.

## THE LAW — invariants that must not be broken
1. **Two-layer ocean / physics determinism.** Physics rides **ONLY** the analytic Gerstner **swell** (λ≥14 m — `sim/gerstner.ts`, `PHYSICS_MIN_WAVELENGTH = 14`, `physicsWaves()`). The visual cascades (`render/oceanCascade.ts`) and FFT are **visual only — the hull never samples them.** This is what keeps physics deterministic for replays. **Never feed cascade/FFT height into physics.**
2. **Ship attitude is EMERGENT from the per-voxel hull (r17).** Pitch / roll / trim / turn-heel come from real voxel physics, not hand-tuned clamps. The user's stated philosophy: *don't hard-set values — tune mass/density/volume so correct behavior emerges.* Don't reintroduce mechanical levers.
3. **Leeway drag applies at the COM**, supplying the turn's centripetal pull; the bank is a **separate emergent G-couple**. Gotcha (learned the hard way): moving force-application points casually (e.g. leeway to COM-vs-CB) flips righting and capsizes her under sail.

## GONE — intentionally removed, do NOT "restore"
- **Enemy crew** (`game/boarding.ts`) — removed r13 (`ensureCrew` posts `[]`).
- **LOST-AT-SEA / PRIZE end-game** — removed r17 (commit `0095390`). Sinking is **non-terminal**: the voyage just continues, no banner, no game-over.
- **The 6 physics levers** (`pitchDamp, rollDamp, trim, keelDepth, heelVelCap, turnHeelArm`) — replaced by per-voxel buoyancy + `heaveDamp` ζ.
- **The single band-limited 14 m FFT chop tile** — replaced by the 3-cascade Tessendorf ocean (`render/oceanCascade.ts`).
- **The emissive "blue cube" flood** — replaced by real, world-leveled, sloshing compartment fluid (`render/compartmentFluid.ts`).

## Ocean — the resolved story
The live ocean is the **"Ocean Rebuild" (rounds 14–17**, fully recorded in `docs/ROUND14_OCEAN_WORKLOG.md`): a 3-cascade GPU FFT + analytic swell + dynamic-wave FDTD + voxel-accurate hull void-cut + real flood fluid. **"Water Foundation"** was its shipped phase-1 predecessor; its only permanent legacy is LAW #1 above. **Both ocean design specs are now in `docs/archive/` and lag the code — treat them as history.** (The r15 jitter bug was a `(−1)^(x+y)` checkerboard from a missing fftshift in `render/oceanFFT.ts`; fixed.)

## Roadmap / North Star
`docs/superpowers/specs/2026-06-12-scuttle-design.md`: **M1 floats → M2 sinks → M3 fights back → M4 board her → M5 the run → M6 ship it.**
- **Shipped:** M1–M3, brig + broadsides + bow/stern chasers, the ocean rebuild, per-voxel physics.
- **Approved next physics direction:** voxel destruction core — `docs/superpowers/specs/2026-06-13-voxel-destruction-core-design.md` (+ its impl plan). Native Rapier voxel colliders + energy-budget carve (speed²·mass), no preset damage amounts.
- **In progress (concurrent):** voxel masts/yards/bowsprit — `docs/superpowers/specs/2026-06-13-voxel-masts-design.md` (+ plan). Approved: masts become real hull-grid voxels (destructible, break off as debris), **both ships**, with a ballast re-tune.
- **M4 (boarding / swim / melee):** a spike ran (`docs/superpowers/notes/char-spike.md`) but has **no implementation plan yet** — write one before building.

## Doc map (what to trust)
- **Trust (current):** this file; the code; `docs/ROUND14_OCEAN_WORKLOG.md` (r14–17 deletions w/ commit hashes); `docs/superpowers/specs/2026-06-12-scuttle-design.md` (North Star); the active `voxel-destruction-core` + `voxel-masts` specs/plans; `docs/superpowers/notes/char-spike.md`.
- **History → `docs/archive/`** (see its README): the round-13 `NIGHT_WORKLOG.md`, `overnight-progress.md` (M1–M2), the `m1`–`m11` plans, and the two ocean design specs. Executed records kept for hard-won findings — not TODO lists.
