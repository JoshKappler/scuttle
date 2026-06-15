# SCUTTLE — read this first

**SCUTTLE** is a pirate voxel naval game — a persistent **plunder-tycoon**: sail, fight, ram, board, plunder, make port, upgrade, sail on. Three.js + Rapier3D (compat) + Vite + TypeScript, with a deterministic vitest physics oracle. The browser build is the demo; the end-vision is a Steam desktop build. It was built fast by many concurrent Claude instances, so `docs/` is full of **dated worklogs and design specs from earlier rounds** — history, not marching orders.

> **THE RULE: when a doc disagrees with the code, the code wins.** Verify any file / flag / tunable in the source before relying on it. This file is the current-state index; keep it honest.

_Last verified against code: 2026-06-14 — **post-consolidation**: every active dev branch merged into `main`._

## What's in the build (consolidated 2026-06-14)
All the parallel dev branches were merged into `main` in one pass:
- **Per-voxel ship physics** — buoyancy, heel, trim, capsize and sinking all *emerge* from the voxel hull (no hand-tuned attitude levers).
- **Voxel destruction (one rule, Teardown-style)** — cannonballs bore clean holes; on a ram the two hulls (kept OUT of Rapier's rigid solver) interpenetrate and `voxelContact` branches PER voxel-contact on the closing speed: **above `vBreak`** both voxels are destroyed (bounded cheapest-first by the collision KE ½·μ·v², so a ram lodges when its energy is spent instead of clipping out the far side) and that fracture energy is taken out of the closing motion (`crush.breakImpulse`) but shed as a **DRAG on whichever hull is driving in** (`crush.distributeClosingDrag`) — the crumbling layer carries its momentum off as debris, so a heavy ram spends its OWN speed and does **not** shove a stationary victim up to ramming speed (the old equal-and-opposite bite did → both reached a common velocity, the closing differential vanished, breaking stopped, and the ram coasted on through lodged). The hull PLOWS into the cleared space next step — non-penetration is free because the voxel in the way is gone (no "jar"); **below `vBreak`** it rests — DELETE the closing and de-penetrate by POSITION along the **horizontal COM→COM line** (the geometric push-out axis FLIPS on engulf → it would shove a lodged ram *deeper*, the "nose rotates straight through" bug), strong enough to EXPEL a lodge but position-only + closing-pre-zeroed so it can never re-penetrate or fling; this is the ONLY place positional separation runs (HORIZONTAL-only so a hit never shoves a hull up/down). The drag is horizontal at COM height (off-centre → yaw, never roll); heavier = harder to shove (each hull sheds Δv = its drag-share/its mass); the keel's water drag bleeds the struck hull's lurch; breached compartments flood and she founders. After damage the hull's REAL per-axis inertia is re-derived from the voxels (`ship.recomputeMassProperties`; a mass-only rescale used to leave a holed hull falsely symmetric → it turtled). Everything on the ship is real grid voxels (hull, deck, quarterdeck, cabin, bulwark, ballast, bow armor — bow armor is only ~50% tougher than oak now); cannons/wheel/masts/sails are separate meshes, never in the grid, so the carve can't touch them.
- **Hostile fleet** — 0..6 enemies (dev-panel slider), sunk ships auto-replaced.
- **Voxel archipelago** — seeded islands + cliffs + a harbor town with a dock; solid static collision (hulls ground on the shore).
- **Plunder economy** — wallet / cargo / upgrades, a dock-triggered port screen, `localStorage` save.
- **On-foot character** — Quaternius Universal (default) with clothing; walk/board the deck in 1st or 3rd person.
- **AAA ocean** — 3-cascade GPU FFT + analytic swell + dynamic-wave FDTD.

## Run / build / test
- **Dev:** `npm run dev` → **http://localhost:5173** (pinned: `vite.config.ts` sets `server.port 5173` + `strictPort`, so it FAILS loudly if 5173 is taken instead of silently hopping to 5174+ and serving a stale build). The **desktop shortcut** runs `launch-scuttle.cmd` (= `npm run dev -- --open`). If a launch errors with "Port 5173 is in use", close the other SCUTTLE window / kill the old `vite` process.
- **⚠️ After pulling or switching branches, run `npm install`.** Deps drift between branches (e.g. `simplex-noise`, used by `sim/islandwright.ts`); a stale `node_modules` makes the dev server throw `Failed to resolve import "..."`.
- **Build:** `npm run build` (= `tsc --noEmit && vite build`). **Test:** `npm run test` (= `vitest run`); 33 files / ~195 tests, keep green before commit.
- **⚠️ `npm run test` (vitest) does NOT type-check** — it strips types. A red `tsc` hides behind green tests, so **run `npm run build` to catch type errors before merging.**
- **Dev panel:** backtick `` ` `` toggles it (releases pointer-lock). It live-edits `TUN` in `src/core/tunables.ts`.
- **In-browser verify (GPU/shaders):** GLSL bugs pass `tsc` + unit tests and fail only at runtime — verify shaders live via Playwright MCP at `:5173` + a readback oracle. Screenshots land in the **projects ROOT** (`projects/<name>.png`), Read them from there.
- `window.DEBUG` (set in `src/main.ts`) exposes: `sloop, fleet, world, cannons, boarding, controls, camera, sailing, contact, debris, oceanField, dynWaves, spray, islands, economy, port, TUN, character`. (Old docs say `enemy`/`hulk` — it's the `fleet` now.)
- **Repo:** `scuttle/` is its own git repo. The parent `projects/` is **not** a repo — never `git init` at root.
- **Concurrent instances share this ONE working dir.** Safe git = branch-create + push only; never `checkout`/`reset`/`stash`/`rebase` that clobbers a sibling mid-task. There is **NO CI** — verify big merges in your own *detached throwaway worktree* (build + test) and then `git push origin HEAD:main`.

## Controls
- **Helm (ship):** `W`/`S` sail set, `A`/`D` steer · `T` toggle helm ↔ on-foot.
- **On foot:** `W`/`A`/`S`/`D` move · `E` interact (also opens the **port** at a dock) · `C` kick · `G` grapple toggle.
- **Damage control:** `R` plug a breach (costs a plank) · `P` pump toggle.
- **Camera:** `V` cycles char-3rd / char-1st / ship-3rd person; mouse-wheel zoom in char follow-cam.
- `F` fullscreen · `X` cutaway clip-plane · `` ` `` dev panel.
- **URL:** `?char=u|bug|q|kk` picks the on-foot pack (default = Universal). `?spike=char` spawns the deck-walk spike.

## Tunables (`src/core/tunables.ts` → `TUN`) — live dev-panel knobs, NOT read by the vitest oracle
- `phys`: `buoyancy 1.5`, `heaveDamp 0.2` (ONE ζ damps heave+pitch+roll), `yawDamp 0.7`, `lateralDrag 1.7`.
- `dyn`: dynamic-wave FDTD field (`enabled, heightScale 0.45, inject 0.6, damping 1.8, foam 0`).
- `chop`: FFT surface detail (`strength 1, choppiness 1.5`). `spray`: bow spray (`enabled, bow 1`).
- `gun`: cannon ballistics (`muzzleSpeed 150, drag 0.0025, mass 4.3, boreRadiusVox 1, crushEfficiency 13`) — drives BOTH the live ball (`game/cannons.ts`) and the aim-arc preview (`main.ts`), so the rendered trajectory ≡ the real shot. (`crushEfficiency` dropped 40→13 when wood softened, see `STRENGTH_TO_JOULES`.)
- `crush`: ship-vs-ship deformable contact — the Teardown rule (`enabled, vBreak 2, toughness 1, buffer 0.4, depen 0.5, maxDepenSpeed 6, biteDvCap 6, maxStepEnergy 5e6, minDepth 0.04, fling 1`). Ship-ship is OUT of Rapier's solver (physics.ts) so the hulls interpenetrate; `voxelContact` reads the real per-voxel overlap (`sim/voxelOverlap.detectContacts`, allocation-light scratch + a `buffer`-voxel "close enough" tolerance) each step and branches PER CONTACT on the HORIZONTAL closing speed (so wave heave never reads as closing, and the drag at COM height yaws never rolls): **closing > `vBreak`** → BREAK both voxels, but only cheapest-first up to the collision KE `½·μ·vClose²` (× `toughness` cost) — destruction is BOUNDED by the energy, so a ram bites a hole and LODGES once spent instead of carving the whole overlap free and clipping out the far side. That spent energy is removed from the closing (`crush.breakImpulse`, cap `biteDvCap`) but shed as a **DRAG on whichever hull is driving in** (`crush.distributeClosingDrag`) → a heavy ram spends its OWN speed and does **not** accelerate a stationary victim (the old equal-and-opposite bite did → both reached a common velocity, the differential vanished, and the ram coasted through lodged). Heavier still = harder to shove (Δv = drag-share/mass). The carve clears the wood in the way → non-penetration is FREE here (no "jar"). **closing ≤ `vBreak`** → REST: DELETE the closing + de-penetrate by POSITION (`depth × depen`, capped `maxDepenSpeed`) along the **horizontal COM→COM line** (the geometric push-out axis FLIPS on engulf → it shoved a lodged ram *deeper*: the "nose rotates straight through the voxels" bug) — strong enough now (`depen` 0.3→0.5, cap 1→6) to actually EXPEL a metre-deep lodge in a few steps, yet position-only + closing-pre-zeroed so the overlap only ever shrinks (can't re-penetrate or fling). This is the ONLY place positional separation runs (the old design ran it every step EVEN while breaking — that WAS the jar; a vertical shove also pushed a holed victim under the "sunk" line → premature respawn, so it's HORIZONTAL only). `maxStepEnergy` is just an anti-vaporize clamp for a teleport-deep overlap. Capsize fix: after carving, `ship.recomputeMassProperties` re-derives the hull's real per-axis inertia from the voxels (`grid.massProperties`) instead of a mass-only rescale, so an asymmetrically-holed hull lists instead of turtling. Wreck/respawn (`fleet.ts isWreck`) now needs genuine foundering (`y<−12 && waterlog>0.05`, or `waterlog≥0.45`), not a transient deep dip. **Perf:** the carve's downstream `flushDamage` heavy recompute stays ~10 Hz, but the ~40 ms `rebuildDeckCollider` (walkable-deck trimesh) is now DEBOUNCED (rebuilds only once carving pauses, `ship.ts` COLLIDER_QUIET/MAX_STALE) — it was firing every 6 steps mid-ram, the impact-lag cause. Replaces the retired `ram` levers, the 3-part carve/cancel/de-penetrate-every-step rule, AND the Rapier-rigid-hull experiment (it starved the carve — hollow hulls barely overlap under a rigid solver). Wood: `sim/materials.ts STRENGTH_TO_JOULES = 5000` (oak 15 kJ/cell).
- `flood`: `inflowScale 0.15` (≈ −85% breach inflow so a holed hull founders over a minute, fightably). `fleet`: `enemyCount 1` (integer 0..`MAXVIS`=6).

## Architecture (source-of-truth modules)
- `src/core/` — `constants` (`MAXVIS 6`, `FIXED_DT`, `G`, `VOXEL_SIZE`), `rng` (deterministic), `tunables`.
- `src/sim/` — deterministic physics (the test oracle): `voxelGrid`, `shipwright` (hull voxels) + `weld`, `buoyancy` (TRUE per-voxel), `compartments` + `connectivity` (flooding), `gerstner` (swell), `oceanSpectrum`/`fft`, `ballistics`, `aiBrain`, `heel`, `materials`, `rigDamage`; **destruction:** `carve`, `crush`, `voxelOverlap`, `surfaceSet`; **world:** `islandwright` (islands; uses `simplex-noise`), `economy` (pure wallet/cargo/upgrades).
- `src/game/` — `ship`, `world` (fixed-step loop; owns `world.contact` = the deformable crunch), `physics` (Rapier + contact hooks), `voxelContact` (ship-vs-ship mutual crush), `hullCollider`, `crew` (+ FP viewmodel), `boarding`, `cannons`, `gunnery`, `player`, `sailing`, `ai`, `fleet` (FleetManager), `debris`, `character` (deck spike) + `characterPack`, `port` (PortController: dock proximity + sell/repair/buy + save), `islandField`.
- `src/render/` — ocean: `ocean` + `oceanCascade` + `oceanFFT` + `oceanField` + `dynamicWaves`; `shipVisual`, `compartmentFluid`, `voxelMesher`, `islandVisual`, `spray`, `seamMask`, `sky`, `effects`, `devPanel`, `portScreen`; character models: `universalModel` (default), `bugrimovModel`, `kaykitModel`, `pirateModel`.
- `src/main.ts` — entry / main loop / camera / FP viewmodel / `window.DEBUG`.

## THE LAW — invariants that must not be broken
1. **Two-layer ocean / physics determinism.** Physics rides **ONLY** the analytic Gerstner **swell** (λ≥14 m — `sim/gerstner.ts`, `PHYSICS_MIN_WAVELENGTH = 14`, `physicsWaves()`). The visual cascades (`render/oceanCascade.ts`) + FFT are **visual only — the hull never samples them.** This keeps physics deterministic for replays. **Never feed cascade/FFT height into physics.**
2. **Ship attitude is EMERGENT from the per-voxel hull.** Pitch / roll / trim / turn-heel come from real voxel physics, not clamps. Philosophy: *tune mass / density / volume so correct behavior emerges — don't reintroduce mechanical levers.*
3. **Leeway drag applies at the COM**, supplying the turn's centripetal pull; the bank is a separate emergent G-couple. Gotcha: moving force-application points casually flips righting and capsizes her under sail.
4. **Destruction is ONE rule.** Cannons, ramming, ship-ship crunch and terrain all emerge from breaking voxels against an energy budget (`sim/crush.ts` + `game/voxelContact.ts`), never preset damage amounts. Judge any change by *"does the rest fall out for free?"*

## GONE — intentionally removed, do NOT "restore"
- **Enemy crew** (`game/boarding.ts`) — `ensureCrew` posts `[]`.
- **LOST-AT-SEA / PRIZE end-game** — sinking is non-terminal; the voyage just continues, no banner.
- **The 6 physics levers** (`pitchDamp, rollDamp, trim, keelDepth, heelVelCap, turnHeelArm`) — replaced by per-voxel buoyancy + the one `heaveDamp` ζ.
- **The single band-limited 14 m FFT chop tile** — replaced by the 3-cascade Tessendorf ocean.
- **The emissive "blue cube" flood** — replaced by real, sloshing compartment fluid (`render/compartmentFluid.ts`).
- **The rigid-reaction ram path** (`game/ramming.ts`, `collisionDestruction`, `TUN.ram`) — retired for the deformable `voxelContact` crunch (`TUN.crush`, lives in `world.contact`).
- **The single `enemy`** — replaced by the `fleet` (`DEBUG.fleet`, `FleetManager`).

## Open follow-ups (left deliberately at consolidation)
- **Wire dock → port:** in `main.ts` the `PortController` has `// dock: islands` commented out; `IslandField.nearestDock` already satisfies the `DockProvider` interface — a one-line wire, left for a pass where the in-game flow can be verified in-browser.
- **Islands polish:** hulls ground ~1 ship-length offshore on the shoal; the harbor palette / cliff drama are starting values.
- **Character:** clothing is in; still open — a cutlass on the model, wall-clip collision, mast-climb to a crow's nest.

## Roadmap / North Star
`docs/superpowers/specs/2026-06-12-scuttle-design.md`: **M1 floats → M2 sinks → M3 fights back → M4 board her → M5 the run → M6 ship it.** M1–M4 are substantially in (float / sink / fight, fleet, boarding + on-foot, islands, economy framework); the persistent **plunder-tycoon** loop is the active framing.

## Doc map (what to trust)
- **Trust (current):** this file and the code. The `docs/` specs + worklogs (ocean rebuild, voxel destruction / masts, multi-ship-fleet, voxel-islands, plunder-economy designs) are dated history — good for the *why*, but the code wins on the *what*.
- **History → `docs/archive/`** (see its README) — executed records kept for hard-won findings, not TODO lists.
