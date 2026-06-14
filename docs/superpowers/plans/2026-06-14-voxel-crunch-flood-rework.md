# Voxel Crunch + Flood Rework — Implementation Plan

> **For agentic workers:** executed inline this session with live Playwright verification at :5173 (these fixes are runtime/visual; `tsc` + vitest are blind to them). Spec: `docs/superpowers/specs/2026-06-14-voxel-crunch-flood-rework-design.md`.

**Goal:** Ramming damages only what it touches, voxel-by-voxel and gradual; ships flood and sink slowly; flooded water renders as interior voxels — fixing the post-overhaul regressions.

**Architecture:** Cure the connectivity landmine (hull must be one 6-connected solid; `findSevered` then only sheds real cuts), then rate-limit the contact carve, then verify/soften flooding, then replace the clipped-plane flood viz with voxel water.

**Merge discipline:** additive `TUN` keys only (no removals/renames); keep public APIs stable (`ShipVisual.updateWater`, `CompartmentFluid` ctor/`update`/`group`/`dispose`, `findSevered` callers); minimal churn in `main.ts`; stage only touched paths; branch `dev/multi-ship-fleet`, no destructive git.

---

### Task 1: Weld every hull to a single 6-connected component

**Files:** Create `src/sim/weld.ts`; Modify `src/sim/shipwright.ts` (call in `buildSloop` + `buildBrig` after rasterise/ballast/bulkheads, before `findCompartments`); Test `tests/weld.test.ts`, extend `tests/shipwright.test.ts`.

- [ ] **Failing test:** `buildBrig().grid` and `buildSloop().grid` each form exactly ONE 6-connected solid component. (Currently 27 / many.)
- [ ] **Implement `weldToSingleComponent(grid, anchor)`** in `weld.ts`: BFS 6-connected components; keep the anchor's (or largest if anchor empty) as main; for each other component, find the cell pair (member↔main) with the smallest gap and fill the straight EMPTY run between them with a bridge voxel (member's material; OAK fallback). Repeat until one component. Deterministic (sorted iteration).
- [ ] **Call it** in both builders right before `findCompartments` so compartment volumes include bridges.
- [ ] **Tests pass** + existing shipwright tests (3 compartments, watertight shell, density bounds, symmetric, RAM prow) still green.
- [ ] **Commit.**

### Task 2: `findSevered` only sheds real cuts; tiny chips dust (no rigid sliver)

**Files:** Modify `src/game/ship.ts` (`flushDamage`); optionally `src/sim/connectivity.ts`.

- [ ] With the hull welded, keep `findSevered` semantics but gate **debris-body spawn** by a min island size (`onSevered` only for islands ≥ ~8 cells); smaller islands are still removed from the grid (they vanish as dust). Keep the anchor-destroyed→largest-component fallback.
- [ ] **Live-verify:** ram → rammer loses only contact-region cells; **0** disconnected bottom/stern cells vanish. (Re-run the instrumented before/after diff: `severRemoved.count` ≈ 0.)
- [ ] **Commit.**

### Task 3: Gradual, local crunch + emergent bow imprint

**Files:** Modify `src/game/voxelContact.ts`, `src/core/tunables.ts` (additive: `crush.maxCellsPerStep`).

- [ ] Add `TUN.crush.maxCellsPerStep` (start ~6). In `stepPair`, after computing the carve energy, cap the cells removed **per hull per step** to this (cheapest/most-penetrating first) by trimming the candidate list or capping energy to `maxCellsPerStep × medianBreakEnergy`. The capped spring holds contact so sustained rams grind deeper across steps.
- [ ] Re-scale carve energy so toughness bites (RAM bow loses few; struck oak caves). Tune `STRENGTH_TO_JOULES` / `crush.yield` live; keep cannon `crushEfficiency` consistent.
- [ ] **Live-verify:** sustained sail-driven ram eats a bow-shaped pocket voxel-by-voxel; rammer bow light damage; side-by-side raft = 0 damage; no NaN; force ≤ `fMax`.
- [ ] **Commit.**

### Task 4: Gradual flooding & sinking

**Files:** Verify-first; if needed `src/core/tunables.ts` (additive `flood`/`founder` knobs), `src/game/ship.ts`, `src/sim/compartments.ts`.

- [ ] **Live-verify** post-Task-1: hole a ship at the waterline → it should settle and founder over tens of seconds, listing toward the breach; undamaged ship never floods.
- [ ] Only if still too fast: expose + slow `breachInflow` discharge and/or the `waterlog` ramp (`0.015/s` today) as additive tunables; do NOT change the deterministic test oracle defaults that vitest asserts.
- [ ] **Commit** (or note "no change needed — gradual once breaches are real").

### Task 5: Per-voxel interior fluid (replace the "blue rectangles")

**Files:** Rewrite internals of `src/render/compartmentFluid.ts` (keep class API: `constructor(compartments)`, `update(compartments, cameraPos, dt)`, `group`, `dispose`); wire grid/ship-quat access via `src/render/shipVisual.ts` (keep `updateWater` signature) and `src/game/ship.ts` only if extra data is needed.

- [ ] Render flood water as **voxels**: for each compartment, fill its interior **air cells** whose centre world-Y is below the world-horizontal water level (level from `waterVolume`/fill). Greedy/instanced cubes, translucent water shading keyed to ocean palette. Bound to interior by construction.
- [ ] Rebuild the water mesh only when the level crosses a cell boundary (throttled, step-counted/deterministic-friendly); orient level by world-up each frame so it pools to the low side.
- [ ] **Live-verify:** flooded water shows as cubes inside the hull, never slabs through the shell; rises while flooding; drains with the pump; no perf cliff.
- [ ] **Commit.**

### Final
- [ ] Full `npm run test` green; `npm run build` clean.
- [ ] Update `CLAUDE.md` GONE/architecture notes if behavior changed (keep edits minimal for merge).
- [ ] Save a memory documenting the `findSevered` + disconnected-internals landmine and its cure.
