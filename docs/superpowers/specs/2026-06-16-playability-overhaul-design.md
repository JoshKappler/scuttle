# Playability Overhaul Batch — Design / Spec

**Date:** 2026-06-16
**Author:** lead-engineer pass (Opus subagent team)
**Status:** APPROVED for execution (user spec'd the items directly + answered the scoping questions; "steam through the whole thing").

A single batch of fixes/reworks the user dumped in one go. This doc is the **durable source of truth** for the batch — recon was done by 5 read-only Opus agents and every root cause below is verified against live source (file:line). When this doc disagrees with the code, the code wins (per CLAUDE.md).

## North Star (unchanged)
Simple rule → emergent realistic behavior. Voxel-first. Physics rides the **one** Gerstner swell (`sim/gerstner.ts surfaceHeight`). One destruction primitive (`ship.crush` / the ½μv² break). Stay OUT of Rapier's rigid solver for ship-ship/ship-terrain (deformable carve). Be cheap: don't compute per-voxel what you can summarize per-compartment.

## Decisions locked (from the user)
- **Controls:** a single **Esc goes straight to the pause menu**. Today the browser pointer-lock eats the first Esc (frees the cursor) and only the second Esc opens the menu — kill that middle step.
- **Sails:** **REVERT** the voxel-cloth sails to the previous working solid sail + alphaMap shot-hole. (The proper "keep the sail shape, tear a section that flaps" redo is a *separate future pass*, not this one.)
- **Flooding:** **~10 single-deck compartments now** + the realistic inside-water + the perf fix. **Stacked multi-deck (room-by-room) is DEFERRED** to a focused follow-up.

---

## The 9 work items

Risk legend: 🟢 low · 🟡 medium · 🔴 high (touches shared render/physics hot paths).

### 1. Esc → straight to menu 🟢
- **Symptom:** in-game, 1st Esc only frees the mouse cursor (browser pointer-lock default), 2nd Esc opens the menu. The free-cursor middle step is unwanted.
- **Approach:** treat the pointer-lock *exit* that Esc triggers as "open the pause menu" directly. Find the pointer-lock + pause-menu handling (player.ts / main.ts), and on `pointerlockchange` → unlocked while in-game, open the menu (and re-acquire lock on resume). Net: one Esc = menu.
- **Files:** `src/game/player.ts`, `src/main.ts` (pointer-lock listeners + pause/menu open). Implementer to locate the exact handlers.
- **North Star:** n/a (UX).

### 2. Flooding rework — inside-water look + perf + ~10 compartments 🔴
Three sub-fixes, two of which converge.
- **2a. Inside water looks like a red/teal "heat map" (img 1).** Root: `render/compartmentFluid.ts` draws the pool as a `MeshStandardMaterial` `roughness 0.1` (near-mirror), base teal `WATER_COLOR 0x1a6a72` (`:24`,`:69-79`). The warm sun (`sky.ts:119` `0xffd9b0` @ 2.6) blows a hot specular on the glossy teal → ACES+bloom tonemaps it to orange/red blobs. It is NOT a heatmap/debug viz (none exists). Also the teal no longer matches the now-navy ocean (`ocean.ts:826-827` `uDeepColor 0x02060e`, `uShallowColor 0x07223a`).
  - **Fix:** render inside water as the ocean continuing in — an **unlit** material (so the sun can't tint it) using the **ocean's own deep/shallow colors**, and drive the **pool surface plane from the same Gerstner sea level** (`surfaceHeight(waves, shipX, shipZ, t)`) clamped to the compartment's fill, instead of the independent per-cell top.
- **2c. Perf: sinking @30fps.** Root: `game/ship.ts:543-579 updateFloodGeom()` rotates + **sorts every interior cell's world-Y** (~60k cells/compartment on a big hull) just to find `poolY` (the free surface), throttled to ~10 Hz; mirrored on the render side (`compartmentFluid.ts:206-227`). The wet-centroid was already summarized away (`floodBallastLocal`).
  - **Fix (converges with 2a):** stop ranking cells. Either (i) precompute once per compartment a static **volume→height curve** and invert `waterVolume`→height in O(log n), or (ii) since flooding equilibrates to the sea waterline, sample `surfaceHeight` once per compartment (O(1)) and clamp to filled height. Use (ii) as the primary, (i) as the geometry source for "filled height." Removes the hot loop on BOTH physics and render sides.
- **2b. Only 3 compartments → too easy to sink; want ~10.** Root: each hull has exactly **two transverse bulkheads at L/3, 2L/3** (`sim/shipwright.ts:157,457,661,886`, + Man-o'-War ~1050) → 3 holds. `findCompartments` (`sim/compartments.ts:158`) auto-produces one compartment per gap.
  - **Fix:** add bulkhead stations per hull (~9 → ~10 compartments). `findCompartments` handles the count for free. **Invariant to preserve:** `equalizeFlooding`/seepage assume consecutive ids are fore-aft neighbors (`compartments.ts:128-133`) — more transverse bulkheads keep the 1-D bow→stern chain, so seepage still works. Watch: added OAK mass/draft → re-check trim/ballast per hull; hatch assignment (`hatchArea`) should only apply to compartments that have a hatch.
- **Risk:** 🔴 touches `ship.ts` (flood hot path), `compartmentFluid.ts`, `shipwright.ts` (all hulls → trim), and reuses `gerstner.ts`. Verify ships still float/trim correctly and don't capsize.
- **North Star:** inside water = the same swell continuing in; summarize per-compartment not per-voxel. Squarely on-philosophy.

### 3. Sail revert (kill the beige confetti, img 2) 🟢
- **Symptom:** shot sails explode into floating tan tiles that lose the sail shape. Root: P4 voxel-cloth (`game/rig.ts tearSail :160-203 / stepTears :207-231`) drawn as loose per-node tiles (`render/rigVisual.ts:71-78`), blown apart by `windForce`.
- **Approach:** revert to the intact pre-voxel path. The old `ShipVisual.puncture` (`render/shipVisual.ts:222-239` + alphaMap wiring `:412-415,:494-497`) is **fully present** — sails keep their shape, a shot paints a ragged hole into the alphaMap canvas.
  - Minimal core: in `game/cannons.ts:191-196` always call `ship.visual.puncture(s.rec, s.y, s.z)` (drop the `if (ship.onSailHit) … else …` branch).
  - Cleanup (remove dead code introduced by P4 `5724764` / P5 `071e6d6`, **keep** P2 bowsprit + P3 mast): `tearSail`/`stepTears`/`TearSail`/`tears` map + its `stepTears` call + tear-cleanup in `spawnFallingMast`/`refresh` (`game/rig.ts`); the `onSailHit?` hook (`game/ship.ts:75-77`); the 3 `onSailHit=…tearSail` wirings (`main.ts:453,569,613`); `TUN.rig.{sails,windForce,clothBreak,severRadius}` (`tunables.ts:238-247`) + their 3-4 dev-panel rows (`main.ts:1714-1730`). KEEP `render/rigVisual.ts` (mast fall uses it) and all mast/bowsprit knobs.
- **Risk:** 🟢 it's a revert; the target path is intact.

### 4. Underwater void: white → deep navy (img 1, img 3) 🟡
- **Symptom:** a sinking/forward-tilting bow shows **bright white** through hull gaps — a "portal to the void." Root: the white is the **sky dome's below-horizon `HORIZON_COLOR`** (`sky.ts:24,101`, linear ~(0.64,0.74,0.81)) left in the framebuffer (`post.ts:145-165` renders sky → clearDepth → scene), showing through wherever the ocean surface is discarded/translucent. The existing mitigation — a flat `MeshBasicMaterial` backdrop **disc at y=-8** (`ocean.ts:886-902`) — only seals near-vertical downward views; an angled sightline through a hull gap passes *over* it and hits the sky haze.
- **Approach:** below the surface must **always** read deep navy. Make the underwater backdrop a **sealed volume** (an inverted dome / box / much deeper+curved shell) rather than one flat plane, OR guarantee an opaque navy fragment behind any view ray that crosses y<0. Use the ocean's deep navy (`0x02060e`/`0x08182b`), keep it fogged. Do NOT recolor the sky dome's below-horizon band (shared with the seamless sea↔sky horizon — would darken the horizon). The user is sensitive to ANY white at the seam (the white foam ring was already removed `ocean.ts:636-641`).
- **Files:** `src/render/ocean.ts` (backdrop disc `:886-902`, its camera-follow `:1022-1024`). Possibly `post.ts` render order if a sealed volume needs different ordering.
- **Risk:** 🟡 must not reintroduce the horizon "void box" / floating-island ring (`sky.ts`/fog history) — verify horizon still seamless.

### 5. Cutout only where a hole meets the waterline 🔴 (most complex)
- **Symptom:** the ocean is cut away over the *entire* hull footprint so the deck never looks flooded; the user wants the cut **only where an actual hole in the hull meets the water**. Fully-submerged holes (bow going under) just submerge — no cut. While sinking, the cut must follow the **U-shaped hole/waterline intersection** (closing across the deck between the tips of the U).
- **Root:** TWO cut systems, both keyed to the whole footprint:
  - (A) **Stencil seam-mask** (`render/seamMask.ts`) writes the full above-water hull silhouette; ocean rejects sea where stencil==1. Its submersion gate uses `uSeaLevel` stuck at **0.0** (`seamMask.ts:15`, never set) — should track the real surface.
  - (B) **Per-voxel profile cut** in the ocean FRAG (`ocean.ts:474-496`) from `uProfileAtlas`, whose shape comes from `buildHullProfile` (`sim/buoyancy.ts:254-280`): a column is "cut" if it has **any** solid voxel. The profile is **cached and never rebuilt on damage** (`main.ts:1379-1391` `profileCache` WeakMap, re-stamped only when the slot's occupant changes).
- **Approach:** add a per-column **open-breach signal** to `buildHullProfile` (a column is an open hole when no solid seals it at/near the waterline), **invalidate the profile cache on carve** (wire into `ship.crush`/`flushDamage`), restrict BOTH cut systems to breach-columns intersecting the surface, and gate the sinking **U-shape** in the FRAG profile loop on `deckWY`/`floorY` vs the live surface. Set `uSeaLevel` from the real Gerstner surface so waterline logic is correct.
- **Risk:** 🔴 highest. Touches stencil + ocean FRAG + profile build + cache + carve path. Do it AFTER #2 and #4 so the sea-level/surface plumbing is already in place. Heavy in-browser verification (intact hull shows timber, holed hull shows ocean through the hole at the waterline, submerged bow has no cut and no void).

### 6a. Unstuck the player — reverse + seaward spawn 🟢 (CRITICAL: can't play)
- **Symptom:** spawns docked facing the island with **no reverse** → can only push forward into the island → stuck.
- **Root:** `sailSet` clamped `[0,1]` (`game/player.ts:155-162` S only lowers sail to 0); thrust only applied forward, no astern branch (`game/sailing.ts:16,82-120`); docked/respawn spawn sets bow toward town (`main.ts:334,601`, `?at=harbor`).
- **Approach:** (1) allow a negative throttle (e.g. clamp `[-0.5,1]`) in `player.ts:157` + an **astern thrust branch** in `sailing.ts` (backing sails/sweeps, reduced power, rudder sense handled at low/negative way); AND (2) spawn the docked ship **bow seaward** (drop the `setRotation({0,1,0,0})` at `main.ts:334` & `:601`). Both, so the player is never trapped.
- **Risk:** 🟢 small, isolated (player/sailing/main-spawn).

### 6b–e. Village / dock visuals (img 3) 🟢 (cleanly isolated — parallelizable)
All in `src/sim/islandwright.ts` (baked at world-gen; needs reload, not a live knob). Island voxels are 1 m (`ISLAND_VOXEL_SCALE 4 × 0.25`); frigate ≈ 34 m.
- **6b Scale up 3–4×:** town/dock read tiny (dock ~½ a ship). Multiply town-local dims: `townR 26` (`:492`), pier length `+44` (`:517`), pier width 5 (`dz -2..2`, `:519`), building lot `w/d/h` (`:541-547`), lighthouse h `26` (`:552`). Prefer scaling town-locals over the global `ISLAND_VOXEL_SCALE` (which would also resize the island mass). Keep dock proportionate to the Man-o'-War (~34 m).
- **6c Roof tops/flat faces missing:** `stampBuilding` roof loop (`:593-613`) only lays the two sloping eave strips, skips the apex when `span%2==0` (`:599`), and never fills the roof plane or the triangular **gable-end** walls. Fix: fill the full roof plane between eaves each row, always lay the ridge, add gable-end triangle infill.
- **6d No doors:** `:585-589` computes a door opening but emits no frame/leaf and it can collide with the OAK sill row. Fix: emit a real door (distinct frame + darker leaf) on the street-facing wall, clear of the sill.
- **6e Trees clip buildings:** `scatterPalms` (`:661-707`) runs (`:377`) before the town is stamped, with no exclusion zone. Fix: exclude the town bench radius from palm/bush placement (or strip trees in the bench-clear loop `:504-509`).
- **Risk:** 🟢 isolated to islandwright.ts (+ maybe islandField.ts scale). No overlap with ship/water/rig code → safe to run in parallel.

### 7. Mast destruction: rigid chunk, not noodle 🟡
- **Symptom:** felled masts go floppy/spaghetti and shed pieces. Want: hit mid-mast → top half falls as ONE stiff object; hit low → whole mast falls stiff. Emergent, voxel-based.
- **Root:** the trunk is a pure 1-D chain of distance links with **no bending/shear stiffness** (`sim/rigBuild.ts:61-68`) → hinges at every node; only **4 relax iters** (`game/rig.ts:308`); `WOOD_BREAK 0.06` sheds links under bending tension. No rigid-sub-body concept exists.
- **Approach:** on severance, identify the broken-off component via the existing connectivity flood (`sim/rigLattice.ts:159-179`) and integrate that component as **one rigid chunk** (freeze each node's offset from the chunk centroid; integrate a single position+orientation under gravity/buoyancy/topple torque; re-derive node positions from the rigid transform each frame). Render is unchanged (`RigPieceVisual.update` just reads node positions). "Break in half" = two components after the severing link is gone, each frozen rigid. KEEP the P3 fall/hinge/crush/waterlog/despawn flow.
- **Files:** `game/rig.ts:235-317` (spawnFallingMast/stepFalling/crushFalling), reuse `rigLattice.ts:159-179`.
- **Risk:** 🟡 rig physics; verify a mid-mast hit drops a rigid top half that crushes deck and sinks, no NaN, stays aboard a moving ship.

### 8. Cannons fall off when their mount is destroyed 🟡
- **Symptom:** when a cannon's hull section is carved away, the gun floats midair, still tethered + fireable. Root: cannon meshes are parented to the ship group at a fixed ship-local offset computed once from `port.x/y/z` (`render/shipVisual.ts:635-725`), never re-validated against the grid; firing only checks bearing+reload, never mount solidity.
- **Approach:** mirror the mast pattern.
  - **Detect:** add `cannonAlive[]` to `Ship` + a `cannonMountCount(port)` (sample `grid.isSolid` at the port anchor + the deck cell(s) under the carriage), snapshot initial count; in `flushDamage` (`ship.ts:1021`, beside the mast loop) when it drops below threshold call `loseCannon(i)`.
  - **Disable firing:** `if (!ship.cannonAlive[p]) continue;` in `fireBroadside` (`cannons.ts:119-120`), `sideReadiness` (`cannons.ts:77`), and the player gun-count (`main.ts:1168`) — covers player + AI.
  - **Visual fall-off + sink:** add `portIndex` to the `barrels[]` record (`shipVisual.ts:687`) + `hideCannon(i)`; poll `cannonAlive[]` in `RigManager.stepAll` (like `mastAlive`, `rig.ts:120-126`) and spawn a lightweight gravity+buoyancy falling body (model on `spawnFallingMast` / `DebrisManager`) at the gun's world pose with ship velocity + an outboard kick along `port.side`, then waterlog/sink.
- **Files:** `game/ship.ts`, `game/cannons.ts`, `render/shipVisual.ts`, `game/rig.ts`, `main.ts`, `core/tunables.ts` (new mount-toughness / fall knobs).
- **Risk:** 🟡 touches rig.ts (shared with #3/#7) + ship.ts/cannons.ts/main.ts; sequence after #3 and #7.

---

## Conflict map & execution order

**Hot shared files:** `ocean.ts` (#2,#4,#5) · `ship.ts` (#2,#5,#8) · `rig.ts` (#3,#7,#8) · `cannons.ts` (#3,#8) · `main.ts` (everything) · `tunables.ts` (#2,#3,#8) · `shipwright.ts` (#2). Parallel edits to these would corrupt each other (subagents share one working tree).

**Strategy:** execute the conflict-prone items **serially on `main`** (one Opus implementer at a time, full self-contained context, in-browser verify, commit+push each). Run the **one cleanly-isolated chunk (#6b–e village visuals, islandwright.ts only) in parallel** in a worktree, merged when done. Scale review rigor to risk (🔴 items get a spec/quality review pass; 🟢 items get implementer + my verification).

**Order (serial queue on main):**
1. **#6a — unstuck the player** (CRITICAL, can't play; small, isolated)
2. **#3 — sail revert** (high annoyance, low risk; clears rig.ts of dead sail code before #7/#8 touch it)
3. **#1 — Esc → menu** (small QoL)
4. **#4 — underwater void → navy** (ocean.ts, before #5 touches the same file)
5. **#2 — flooding rework** (inside-water=sea level + perf + ~10 compartments; lays the surface plumbing)
6. **#5 — cutout only at waterline holes** (riskiest; after #2/#4 surface work is in)
7. **#7 — mast rigid chunk** (rig.ts; after #3 cleaned it)
8. **#8 — cannons fall off** (rig.ts + ship.ts + cannons.ts; after #3 and #7)

**In parallel (worktree, any time):** #6b–e village visuals → merge.

## Verification protocol (per item)
- Build gate: `npx tsc --noEmit -p .` (vitest does NOT type-check) + `npm run test` for touched sim modules.
- In-browser at :5173 via Playwright: Sandbox → pick ship/enemies → Set Sail. Single-step physics with `DEBUG.world.step(1/60)` and read back `DEBUG.*` (sloop/world/rig/cannons/oceanField). Screenshots for visual items.
- Commit+push each verified item to `main` (commit only my own paths; never blanket-stage — untracked audio WAVs are the audio agent's WIP). One commit per item, descriptive message.

## Out of scope (explicitly deferred)
- Stacked multi-deck / room-by-room flooding (architectural; the proper redo).
- The "keep the sail's shape, tear a flapping section" sail redo (revert now, redo later).
- Re-tuning enemy AI to use reverse.
