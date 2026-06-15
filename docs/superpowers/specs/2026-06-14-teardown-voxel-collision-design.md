# Teardown-style Voxel Collision — Design Spec

**Date:** 2026-06-14
**Status:** approved (in-chat) — supersedes the 3-part `voxelContact` "carve / cancel / de-penetrate" rule and the older `docs/superpowers/plans/2026-06-14-deformable-voxel-collision.md`.

**Goal:** ship-vs-ship collisions that feel like Teardown — a moving hull *plows into* another, destroying both hulls' voxels along the contact and shedding a little speed per layer, until it's too slow to break, at which point the two simply can't share space. No "jar the other ship out of the way," no one-tick carve-then-shove, no phase-through.

## The one rule (per fixed step, per overlapping ship-pair)

Find the voxel-contacts: cells of hull A whose centre is within `buffer` voxels of a **solid** cell of hull B. For each contact compute the **closing speed at that point** using rigid-body velocity `v = vlin + ω × (p − com)` for both ships, projected onto the closing direction. Then branch **per contact**:

- **Closing faster than `vBreak` → BREAK.** Mark *both* voxels (the A cell and the B cell) for destruction. The fracture energy is removed from the closing motion (below). Because only the thin currently-overlapping layer exists each step, this is a *small* bite — the hull keeps most of its speed and **advances into the cleared space next step**, meeting the next layer. It plows in, shedding speed per layer, until closing speed drops under `vBreak`. Breaking then stops on its own.
- **Closing slower than `vBreak`, OR a break candidate we couldn't afford this step → REST.** No destruction. Cancel the closing (inelastic) and push the bodies apart by the overlap depth. **This is the only place positional separation runs.**

### Why this delivers each requirement

- **No phase-through, no jar.** Non-penetration is enforced *by regime*. Where it's breaking, the voxel in the way is destroyed → nothing to penetrate → no shove. Where it's not breaking, the rest-push handles it. The old bug was running the positional push **unconditionally, even while breaking** (`voxelContact.ts:162`) — that *was* the jar. It is gone from the breaking path.
- **Plows through, sheds speed, sustained.** Each step breaks one advance-layer and removes only that layer's energy → many steps of grinding, not one tick.
- **Heavier = more influence, hard to shove.** The momentum exchange is equal/opposite; each ship's Δv = impulse ÷ its own mass. A heavy hull barely moves and guts a light one. The keel's existing ~42×-sideways water drag (`TUN.phys.lateralDrag`) bleeds whatever the struck hull gains → "a lot holding them in place," emergent.
- **Buffer.** Contact registers within `buffer` voxels (these voxels are a coarse approximation of a real hull; "sufficiently close = touching").

## Momentum + energy coupling (the math)

Per step, per pair, over the cells actually destroyed this step:

- `E = Σ breakEnergy(cell) · toughness` — joules the broken wood absorbed.
- `μ = mA·mB / (mA+mB)` — reduced mass. `vc` = closing speed at the *breaking centroid* along the closing direction `d̂` (the relative-velocity direction — **never** the centre-to-centre or thin-overlap axis, which flip when a big hull engulfs a small one).
- New closing speed: `vc' = sqrt(max(vc² − 2E/μ, 0))` — the collision loses exactly `E` joules. Self-limiting: it can never remove more than the closing KE (`vc' ≥ 0`).
- Impulse `J = μ·(vc − vc')`, capped at `μ·biteDvCap` for stability. Apply `−J·d̂` to A and `+J·d̂` to B, **at the breaking centroid projected to each ship's own COM height** (zero vertical lever → an off-centre hit YAWS, never ROLLS — the sea holds her upright).

Destruction and deceleration are thus the same event: you slow by exactly the energy the wood you broke absorbed.

## Non-penetration for REST / un-broken contacts

Over the rest cells (sub-`vBreak` or unaffordable):
- **Cancel:** inelastic impulse `μ·min(vcRest, biteDvCap)` along the geometric push-out **axis** (thin-overlap axis — reliable for the *shallow* contacts this branch sees; deep engulfing overlap only happens while breaking, which uses `d̂` instead), at the rest centroid, COM height.
- **De-penetrate by position:** move the bodies apart by `depth · depen`, inverse-mass split, but **rate-capped at `maxDepenSpeed`** so even a pathological deep overlap (e.g. a teleport, or a ram that lodged then dropped below `vBreak`) eases apart gently instead of flinging. Re-solved from the fresh overlap each step → never accumulates.

## What is and isn't destructible (user requirement)

Satisfied by the existing architecture — **no exclusion code**:
- **Destructible (all grid voxels):** OAK hull shell, PINE deck / quarterdeck / cabin cap / bulwark / stairs, OAK bulkheads, IRON ballast, RAM bow armor. Deck and captain's quarters are voxels → already break.
- **Spared (not in the grid):** cannons, steering wheel, masts, sails — `cannonPorts` / `wheelM` / `masts` are coordinate metadata; the barrels/wheel/rigging are separate render meshes. The carve only touches `grid` via `carveCells`, so they can never be destroyed by collision. The implementation must keep using `carveCells` (it does).

## Performance (fix the "slowing down the whole game")

- Allocation-light: `voxelContact` owns reusable scratch typed arrays; the detector fills flat `Int32Array`/`Float32Array`, no per-cell tuple churn. Only the (bounded) set of cells that actually break is collected as tuples for `carveCells`.
- Narrow phase only on AABB-overlapping pairs (already culled); only walk A-surface cells inside the AABB intersection.
- Don't trigger the heavy per-ship recompute (`flushDamage` sever/buoyancy/deck rebuild) faster than its existing throttle.
- **Requirement:** hold 60 fps with the full fleet in contact. Confirm whether ships spawn already-overlapping (a constant-grind FPS sink) and fix if so.

## Modules

- `src/sim/voxelOverlap.ts` → refactor to a scratch-filling per-contact detector (flat `aCells`, `bCells`, world `points`, `count`) + aggregate `{depth, axis, centroid}`. Pure; keep it the single tested geometry module.
- `src/game/voxelContact.ts` → rewrite `stepPair` to the two-regime rule above. Keep `pushAtComHeight`, `velAtPoint`, AABB cull, the `ContactDebug` readback, `effects.impactDebris`.
- `src/game/physics.ts` → unchanged (ship-ship stays out of Rapier's solver; hook returns null).
- `src/core/tunables.ts` `crush` → `{ enabled, vBreak, toughness, buffer, depen, maxDepenSpeed, biteDvCap, maxStepEnergy, minDepth, fling }`. Replaces `yield`/`maxDvPerStep` semantics.
- `src/main.ts` dev panel → sliders for `vBreak`, `toughness`, `buffer`, `depen` (+ advanced: `biteDvCap`, `maxStepEnergy`, `minDepth`).

## Tests (pure, deterministic — Rapier dynamics verified in-browser, not in vitest)

- `tests/voxelOverlap.test.ts` (rewrite for new API): two blocks overlapping 1 voxel → correct contact count, cells, depth≈1, axis; disjoint → count 0; symmetric swap; **buffer**: blocks separated by a sub-`buffer` gap still register contact.
- Pure energy→velocity coupling helper test: `vc'` and `J` monotonic, `vc'≥0`, conserves momentum, heavier mass → smaller Δv.

## Verification

tsc clean + vitest green (mandatory). Then in-browser smoke on a freshly-restarted **5173** (`vite strictPort`): no phase-through and a sustained multi-step grind at low/med/high closing speeds; struck ship shoved ≤ impact speed (no fling); fps holds. **The user feel-tests at home** — ensure the dev server serves the new build.
