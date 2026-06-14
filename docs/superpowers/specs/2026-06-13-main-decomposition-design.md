# Design: Decomposing `src/main.ts`

_Date: 2026-06-13 · Status: approved-for-planning · Branch context: `dev/kaykit-character`_

## Problem

`src/main.ts` is a single 1,315-line `async function main()`. It is the game's
composition root (legitimate) but has also accreted five self-contained
subsystems as inline closures: the HUD, the first-person viewmodel, the
aiming/aim-arc system, the ship↔water feeders (wake + dynamic-wave injection +
bow spray), and a dev-only ram-test harness. These bury the entry file's real
job — wire the systems, run the loop — under ~520 lines of subsystem internals.

This is a **behaviour-preserving structural refactor**. No gameplay, physics,
render, or timing changes. Goal: `main.ts` drops to ~800 lines and reads as a
composition root + fixed-step + animation loop.

## Guiding decisions (settled during brainstorming)

- **Scope: targeted.** Extract the five fattest, most self-contained concerns.
  `main.ts` remains the orchestrator.
- **Boundary mechanism: factory + update handle.** Each module exports
  `createX(deps)` returning a small handle (`{ update(...) }` and/or named
  methods), matching the codebase's existing idiom (`createSky`, `createOcean`,
  `createDynamicWaves`, `createSpray`, `createDevPanel`). No new global state,
  no god-object, each unit independently importable and reasoned about.

## The core principle: deps vs. frame-state

Two kinds of captured state exist in `main()`, and they are treated differently:

- **Stable systems** built once during setup — `sloop`, `enemy`, `world`,
  `ocean`, `effects`, `cannons`, `scene`, `camera`, `controls`, `boarding`,
  `sailing`, `waves`, `wind`, `sloopProfile`, `enemyProfile`. These are passed
  **once** as the factory's `deps`.
- **Mutable per-frame game flags** mutated inside `world.onFixedStep` —
  `onFoot`, `plugChannel`, `firstPerson`. These are **never captured**; they
  flow into `update()` as **call-time arguments** each frame.

Rule of thumb: `deps` = nouns built once; `update` args = state that changes per
frame. A module must never reach back into a moving local in `main`.

## The five modules

### 1. `src/game/aiming.ts` — `createAiming(deps)`

Built **first** among the five: its `aimBearing`/`gunBears` are consumed by the
fixed-step (firing), the HUD, and the animation loop. One shared instance is
injected into the HUD as a dep and used directly by `main`.

- **Owns:** the per-gun aim-arc `THREE.Line` pool + `Float32Array` buffers,
  `ARC_PTS`/`ARC_SUB` constants, `arcMuzzle`/`lookV` scratch, the `Bearing` type.
- **deps:** `{ scene, sloop, camera, controls, waves, world }` (module imports
  `muzzleWorld`, `surfaceHeight`, `TUN`, `G`, `FIXED_DT` stay as imports).
- **Exposes:** `aimBearing(): Bearing`, `gunBears(p, b): boolean`,
  `updateAimArc(): void`, `sideSign(b): 1 | -1` (the screen-relative traverse
  sign currently inlined at loop line ~1186).
- **From:** lines 735–848 (+ the `aimSideSign` derivation at 1178–1186).

### 2. `src/hud/hud.ts` — `createHud(deps)`

- **Owns:** `hudEls` (all `getElementById` refs), toast lifecycle
  (`lastToast`/`toastTimer`), compass/heading temporaries (`hdgQ`/`hdgV`),
  `hudTimer` throttle.
- **deps:** `{ sloop, enemy, world, cannons, sailing, boarding, controls, wind,
  aiming }` — `aiming` is the handle from module 1.
- **Exposes:** `update(dt, tr, frame)` where
  `frame = { onFoot: boolean, plugChannel: number }`.
- **From:** lines 623–733.
- **Boundary note:** the underwater-fog toggle (`scene.fog`, `wasUnder`,
  `underFog`) and the spyglass FOV easing in the loop (1246–1263) touch
  `scene.fog`/`camera.fov` and are **camera/render concerns** — they stay in
  `main`. Only the `hudEls.underwater`/`hudEls.spyglass` *class/opacity* writes
  that are pure HUD-DOM can optionally move into `hud.update`; if moved, the
  driving booleans (`controls.spyglass`, `camUnder`) pass through `frame`.
  Default: keep them in `main` to avoid widening the frame struct. Decide during
  implementation; either is behaviour-equivalent.

### 3. `src/render/viewmodel.ts` — `createViewmodel(scene)`

- **Owns:** the procedural FP arm + cutlass mesh (`viewModel` group, `vmArm`,
  all materials/geometry), `vmOffset`/`vmBob` state.
- **deps:** `scene` (adds the group on construction).
- **Exposes:** `group` (for any external reference) and
  `update(dt, camera, player, firstPerson)` — applies visibility, camera-parented
  position, bob, and the swing pose. `player` is `boarding.player` (may be null).
- **From:** construction 552–621; per-frame update folded from loop 1223–1235
  and the visibility writes at 1225/1237.

### 4. `src/render/wakeSpray.ts` — `createWakeSpray(deps)`

The ship↔water feeders, grouped because they share scratch buffers and the
two-ship (`slot 0/1`) iteration.

- **Owns:** `hullSpan`/`spans`, all pose scratch (`_poseQuat`/`_poseM4`/
  `_poseInvRot`/`_poseTrans`, `wakeV`/`wakeF`), the pre-allocated `_dynShips`
  `DynShip[]` + `_dynQuat`/`_dynM4`/`_dynFwd`, spray cooldown state
  (`sprayState`, `sprayQ`/`sprayF`).
- **deps:** `{ ocean, sloop, enemy, world, waves, effects, sloopProfile,
  enemyProfile }`.
- **Exposes:** `feedWake(slot, ship)`, `buildDynShips(): DynShip[]`,
  `checkBowSpray(slot, ship, dt)`.
- **From:** lines 850–1002.

### 5. `src/dev/ramTest.ts` — `createRamTest(sloop, enemy)`

Dev-only T-bone harness; belongs in `src/dev/` alongside `voxelSpike.ts`.

- **Owns:** the `rotV` quaternion helper, placement math, the
  `requestAnimationFrame` `drive()` charge loop.
- **deps:** `sloop`, `enemy`.
- **Exposes:** `ramTest(): void`. `main` keeps the `window.ramTest` assignment
  and the dev-panel button wiring.
- **From:** lines 1018–1079.

## What stays in `main.ts`

The composition root and run loop, by design:

- renderer / scene / camera bootstrap + the `?spike=1` gate;
- all system construction & wiring (~lines 50–261) — including the
  `onMastFelled`/`onRudderHit` callbacks and `isSunk`;
- the `world.onFixedStep` gameplay step (263–406);
- the `?spike=char` character gate (408–419);
- `fitViewport`/resize observers, `toggleFullscreen`, the `keydown` bindings
  (V/F/X), the cutaway state + `abyss` + `updateHole`;
- `window.DEBUG`;
- the `dev panel` definition + `updateDevReadout` (it reads many `TUN`/system
  refs and is cheap to leave);
- the `renderer.setAnimationLoop` body, now calling the five handles.

### Explicitly out of scope (flagged, not extracted)

- **`world.onFixedStep`** — the gameplay step is knotted into mutable flags
  (`atWheel`, `onFoot`, `manOverboard`, `plugChannel`, `ladderHinted`,
  `enemyScuttled`). Cleanly extracting it needs a shared state object; that's a
  larger, riskier change than this pass should take.
- **Window/input bindings** (fullscreen, resize, keydown, cutaway) — same
  reasoning; coupled to `firstPerson`/`cutaway`/`boarding.player`. Future pass.

## Behaviour-preservation contract

- **No logic changes, no reordering of side effects.** The per-frame call order
  in the animation loop stays identical:
  `feedWake(0) → feedWake(1) → checkBowSpray(0) → checkBowSpray(1) →
  effects.update → player.postPose → aimBearing → sideSign → updateAimArc →
  visuals.animate → camera/viewmodel → spyglass → underwater → cutaway → sky →
  oceanField.update → dynWaves → ocean → render → updateHud → updateDevReadout`.
- **Zero-per-frame-allocation preserved.** Every pre-allocated scratch temporary
  moves *with* its function into the owning module's closure; none are
  re-created per frame.
- **Same field reads at the same point.** `checkBowSpray` reads `ship.bowSpray`
  / `ship.waterline*` (recomputed in the buoyancy pass) at the same loop
  position, so timing is unchanged.

## Verification

The vitest suite (~115 tests) covers `sim/`, **not** `main.ts` — it proves
physics is untouched but cannot catch a wiring regression. Gate is therefore:

1. `npm run build` (`tsc --noEmit && vite build`) — types prove the dep wiring
   connects; the build must pass clean.
2. `npm run test` — stays green (confirms `sim/` untouched).
3. **Browser smoke at `http://localhost:5173` via Playwright MCP**, compared
   against the same pass on pre-refactor `main.ts`:
   - sail (W/A/D) — wake + bow spray render;
   - hold RMB — per-gun aim arcs render; LMB fires; the shot lands where the arc
     predicted (broadside *and* a bow/stern chaser, to exercise `sideSign`);
   - V — first-person viewmodel arm/cutlass in frame; slash swings it;
   - X — cutaway clips the hull, ocean trench tracks;
   - `` ` `` — dev panel opens, readout updates, **Ram Test** button fires the
     T-bone;
   - HUD: speed/compass/gun-status/flooding bars update.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Aiming consumed before built | Build `aiming` first; inject into `hud`; `main` holds the handle. Enforced by construction order + types. |
| Frame-state captured instead of passed | `onFoot`/`plugChannel`/`firstPerson` only appear in `update()` signatures, never in `deps`. |
| Lost zero-alloc property | Move scratch temporaries into module closures verbatim; no `new` in any `update`/feeder path. |
| Hidden timing coupling (`bowSpray`/`waterline`) | Same reads, same loop position; no reordering. |
| Accidentally sweeping unrelated branch deletions into the commit | Commit only the new module files + edited `main.ts`; never `git add -A`. |

## Out-of-scope (do not touch)

`sim/` physics (LAW invariants — emergent per-voxel attitude; casual changes
capsize her), the ocean module set (all wired, intentional architecture), the
three character models behind `?char` (a separate user A/B decision).
