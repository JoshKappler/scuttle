# Round 12 Overhaul — Master Orchestration Plan

**Spec:** `docs/superpowers/specs/2026-07-01-round-12-overhaul-design.md` (approved by Josh 2026-07-01).
**Execution model:** one executor agent per sub-plan, all in the ONE shared working dir (no worktrees — the standing SCUTTLE wave pattern), disjoint file ownership, each agent commits its own files only and NEVER pushes; the orchestrator pushes per wave and runs the wave-gate verification. Baseline commit at planning time: `3316ef4` (plans committed on top).

## Sub-plans

| Agent | Plan file | Sub-project | Wave |
|---|---|---|---|
| A | `2026-07-01-round12-a-collision.md` | SP2 collision correctness + carve pooling | 1 |
| B | `2026-07-01-round12-b-sails.md` | SP1 cloth sails over voxel truth + shipVisual buffer pooling | 1 |
| C | `2026-07-01-round12-c-shipcore.md` | SP4 ship-core perf caches + SP5 buoyancy decoupling | 1 |
| D | `2026-07-01-round12-d-handling.md` | SP3 handling retune + pacing + felled-mast repair (ship side) | 2 (first) |
| E | `2026-07-01-round12-e-cleanup.md` | Cleanup: main.ts extractions + dead code + CLAUDE.md | 2 (after D) |

## File ownership (enforced; executors must not cross lines)

**Wave 1 (A ∥ B ∥ C, concurrent):**
- **A:** `src/game/voxelContact.ts`, `src/sim/voxelOverlap.ts`, `src/sim/crush.ts` (verified no-change), `src/sim/carve.ts`, `src/sim/surfaceSet.ts` (if needed), tests: `voxelContactRegression` (new), `voxelOverlap`, `carve`.
- **B:** `src/render/sailVisual.ts` (new), `src/render/sailMath.ts` (new), `src/render/shipVisual.ts`, `src/render/voxelMesher.ts`, `src/game/debris.ts`, `src/main.ts` (minimal ADDITIVE wiring only — B is the sole main.ts editor in wave 1), tests for these.
- **C:** `src/game/ship.ts`, `src/sim/buoyancy.ts` (verified no-change), `src/render/ocean.ts` (verified no-change), `CLAUDE.md` (LAW #3 + heaveDamp lines only), `src/core/tunables.ts` (ONE exception: the `heaveDamp` recalibration commit), tests: `heaveResponse`, `trim`, `waveFieldCache` (new).

**Wave 2 (STRICTLY sequential: D, then E — both touch `tunables.ts` + `CLAUDE.md`, and E's main.ts anchors assume D landed):**
- **D:** `src/game/ship.ts`, `src/game/sailing.ts`, `src/core/tunables.ts`, tests: `turnRate`, `turnHeel`, `repairSails` (new) + `helpers/yawHarness.ts`, `sailing` (fake gains grid.dims), plus `docs/superpowers/plans/2026-07-01-round12-pacing-report.md`.
- **E:** `src/main.ts`, `src/render/aimUI.ts` (new), `src/render/cutawayController.ts` (new), `src/game/shipSwap.ts` (new), `src/core/tunables.ts` (dead flood.render knobs only), `src/sim/islandCollider.ts` (delete), `CLAUDE.md` (round-12 note), tests: `aimUI` (new), `islandCollider` (delete).

## Cross-plan interface contracts

1. **B produces → D consumes:** `DebrisManager.removeRigFor(ship: Ship): void` in `game/debris.ts` (despawn a ship's floating rig-debris islands). D treats it as existing and verifies the exact exported name/signature at execution.
2. **D produces → orchestrator wires (wave-2 tail):** `Ship.onRigRepair?: (ship: Ship) => void`. Wiring is deliberately NOT in D's or E's plan (main.ts ownership + ordering): **after E completes**, the ORCHESTRATOR lands one small commit: `fresh.onRigRepair = (s) => d.debris.removeRigFor(s);` inside `game/shipSwap.ts rebuildPlayerShip` (next to the other `fresh.on*` callbacks) + the same line at the initial player-ship build site in `main.ts`. Until wired, felled-mast repair still works; the stale floating rig self-despawns in ~40 s (graceful degradation by design).
3. **A produces (internal):** `ContactScratch.normals?: Float32Array` in `sim/voxelOverlap.ts` — optional, only A's `voxelContact.ts` consumes it. Semantic note for the dev panel: `ContactDebug.vClose` becomes the RMS of per-contact closing speeds in the BREAK regime (≡ old value for a clean head-on).
4. **A handoff (optional, wave 2+):** `SCRAPE_FRICTION = 0.02` module constant in `voxelContact.ts` — candidate for promotion to `TUN.crush.scrapeFriction` (D owns tunables in wave 2; not required this round). Also: `Ship.carve()` discovered to have zero call sites (dead-code candidate for a FUTURE round — do NOT delete this round; C's perf-baseline browser snippet calls it from the console).
5. **C exception:** the single `TUN.phys.heaveDamp` `0.2 → 0.2*Math.sqrt(1.5)` recalibration is the ONE wave-1 tunables edit, atomic with the ship.ts formula change, guarded by the step-response characterization test.
6. **D new knob:** `TUN.phys.rudderLeverExp = 0.35` (+ `rudderLever`/`RUDDER_LEVER_L0` exports in sailing.ts). Optional dev-panel slider deferred (main.ts owner; note only).

## Wave gates (orchestrator)

**Gate 1 (after A, B, C all report done):**
1. `git status` — no cross-ownership edits, no uncommitted stragglers.
2. `npm run build` + `npm run test` on the merged tree (executors tested concurrently — the merged state needs one clean serial pass; re-run brig/frigate isolated on timeout flake).
3. In-browser pass at :5173 — sails billow/deflate with W/S, cannon holes tear + sag, felled rig drapes + drifts downwind, cutaway X intact; T-bone ram bites, side-by-side scrape separates without shredding; timing HUD `buoy`/`flood` down vs C's recorded baseline; no new console errors.
4. Push to `main` (Vercel deploy) — Josh can playtest wave 1.

**Gate 2 (after D, then E, then the tail wiring):**
1. Same build/test/status discipline.
2. In-browser: per-tier turn stopwatch vs D's table (Cutter ~2.5 s, Frigate ~5.5 s to 90°), hard-turn bank ≤ ~45° no capsize, low-speed pivot check; full-dismast → port repair → rig restored + debris despawned; aim-arc ≡ shots, cutaway, hull swap + re-dock (E's extractions); Esc pause.
3. Push to `main`. Final wrap: CLAUDE.md round-12 header is E's; orchestrator sanity-reads it against what actually landed.

## Execution rules (repeated for every executor)

- Work directly in the shared dir; stage ONLY owned paths via explicit `git add`; NEVER `git add -A`/`.`; never checkout/reset/stash/rebase; do NOT push.
- `npm run build` AND `npm run test` green before every commit (vitest does not type-check).
- Plans cite line anchors at `3316ef4` — locate every edit by the quoted code (siblings shift lines).
- Port 5173: one dev server serves the shared tree; if taken, use the running one. The tree may contain siblings' uncommitted work — browser verification of YOUR feature is still valid; whole-scene perf totals may drift.
- Known flake: brig/frigate symmetric tests false-fail under CPU load (three executors run tests concurrently!) — ALWAYS re-run a red physics test isolated before investigating.
- If blocked on another agent's file: record a handoff note and continue; do not edit across the line.
