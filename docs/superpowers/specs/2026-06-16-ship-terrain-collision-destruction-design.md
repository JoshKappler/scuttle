# Ship↔Terrain Collision Destruction + Hazards — Design Spec

**Date:** 2026-06-16
**Status:** approved (in-chat). Branch: `worktree-man-o-war`.

**Goal:** make ship-vs-land collisions *destroy the ship* through the existing Teardown voxel-crush rule, by presenting terrain (islands, cliffs, sea stacks) to the crush as **an infinitely heavy, infinitely durable hull**. The land never breaks and never moves; only the ship's voxels break against it. Plus more cliffs and standalone sea stacks so there are things worth avoiding.

Today: ramming an island does nothing destructive — the ship is stopped rigidly by a static Rapier trimesh collider (`game/islandField.ts`) and no voxels break. Ship-vs-ship, by contrast, is pulled *out* of Rapier's solver (`game/physics.ts filterContactPair`) so the hulls interpenetrate and `game/voxelContact.ts` carves them per-voxel against an energy budget. This spec routes ship-vs-terrain down that same crush path.

This realizes **THE LAW invariant #4** ("destruction is ONE rule — cannons, ramming, ship-ship crunch and terrain all emerge from breaking voxels against an energy budget") literally in code: terrain is just another hull, with infinite mass and an empty carve list.

## The one rule (unchanged) applied to terrain

Per fixed step, for each ship overlapping a piece of terrain, run the **same two-regime crush** as ship-vs-ship (`voxelContact.stepPair`), with the terrain as **hull B**:

- **Closing faster than `vBreak` → BREAK.** Only the **ship's** overlapping voxels are carve candidates (terrain is never added). Destruction is bounded cheapest-first by the collision KE `½·μ·vClose²`; that fracture energy is removed from the closing motion and shed as **drag on the ship** (the aggressor driving in). The ship plows in, sheds speed per layer, erodes its bow, until closing drops under `vBreak`.
- **Closing ≤ `vBreak` → REST.** No destruction. Cancel the (small) closing and de-penetrate **by position** along the horizontal COM→COM line — moving **only the ship** (terrain is immovable). This is what grounds her offshore / stops her at the cliff face.

### Why "infinitely heavy + durable" gives the right behavior for free

With terrain as a **static** hull B (mass → ∞, velocity ≡ 0, carve list ≡ ∅):

- **Reduced mass `μ → mShip`**, so the impact energy budget is `½·mShip·vClose²` — the ship erodes in proportion to *its own* kinetic energy.
- **All destruction energy goes into the ship.** Terrain has no carve candidates, so every joule the collision can spend breaks the ship instead of the rock.
- **The land never moves.** The aggressor-drag and the de-penetration both act only on the ship; the transfer share that would shove a victim "lands on" the island, which ignores it. No impulse, no translation is ever applied to terrain.
- **She grounds / stops emergently.** The REST branch's horizontal COM→COM push-out shoves the ship away from the island centre — i.e. back toward open water — so she grounds ~offshore or pins against the cliff exactly as the existing rest path already behaves.
- **Slow approaches are safe.** Below `vBreak` (2 m/s) nothing breaks, so you can still ease up to the harbor pier to make port; only a real ram tears the hull.
- **Founders for free.** A breach below the waterline floods through the existing compartment system and she settles — no new flooding code.

The invariant-#4 test ("does the rest fall out for free?") passes: every downstream effect is existing crush/flood behavior fed a new kind of B.

## Architecture

In a ship-vs-terrain pair the **ship is always hull A** and terrain is always hull B — not as a size heuristic (a small sea stack may have fewer surface cells than a frigate) but by design: terrain is the **occupancy-only, static, non-carvable** side, and we want to walk the **ship's** surface cells (the cells we test for being inside the rock, and break). So `detectContacts` always walks the ship's surface against terrain occupancy, and only **B** varies between ship-vs-ship and ship-vs-terrain. We therefore abstract **only the B side**.

### 1. Voxel-size generalization — `sim/voxelOverlap.ts`

`detectContacts` currently assumes one `voxelSize` for both hulls. Terrain cells are 4× the ship's (`ISLAND_VOXEL_SCALE = 4`; ship 0.25 m, terrain 1 m). Add an **optional `voxelSizeB`** parameter:

- A's surface cell centres → world using `vsA` (= `voxelSize`).
- world → B-local occupancy lookup divides by `vsB` (= `voxelSizeB ?? voxelSize`).
- The neighbourhood `buffer` scan stays in B-cell units; the broad-reject pad and the depth "+ one cell" term use the relevant size. Default `voxelSizeB = voxelSize` ⇒ **ship-vs-ship is byte-identical** (regression-tested).

This is the only change to the pure geometry module; it stays the single tested overlap primitive.

### 2. A B-side `ContactTarget` interface — `game/voxelContact.ts`

Introduce a minimal interface describing **the other body** in a contact (everything `stepPair` currently reaches into `shipB` for):

- occupancy + dims + world pose + **its voxel size** (for `detectContacts`),
- `mass()`, `linvelAt`/`angvel` (or `isStatic`),
- world centre of mass,
- carve hook (`carveCells` or **null** if indestructible),
- impulse + translation setters (**no-ops if static**).

`Ship` implements `ContactTarget` as a thin pass-through ⇒ the ship-vs-ship path is unchanged. A new `IslandTarget` adapter implements it for terrain with `isStatic = true`, `voxelSize = M_PER_VOX`, carve hook `null`.

`stepPair(a: Ship, b: ContactTarget)` gets a **static-B special-case** (gated by `b.isStatic`) so we never do `Infinity` arithmetic:

- `μ = mShip`; the entire closing impulse becomes aggressor-drag on the ship; no impulse/translation on B.
- carve candidates exclude B (B's carve hook is null).
- de-penetration moves only the ship (`moveShip = corr`, `moveB = 0`).

(Considered & rejected: a separate `stepShipVsTerrain` method duplicating the branch logic — it would drift from the tuned ship-vs-ship math. The B-abstraction keeps the one rule in one place.)

`VoxelContact.stepAll` gains a terrain pass: for each ship × terrain target, AABB broad-cull then `stepPair(ship, target)`. Ship-vs-ship runs exactly as before.

### 3. Pull ship↔terrain out of the rigid solver — `game/physics.ts`

- Add `terrainBodies: Set<number>` to `Physics`.
- In `filterContactPair`, return `null` when **one body is a ship and the other is terrain** (so the hull interpenetrates and the crush owns the response). Two ships → `null` as today. Everything else (character↔terrain, debris↔terrain, hull↔player) still solves rigidly — so **the on-foot captain still walks the dock/island and debris still bounces off the rock**. Only ship↔terrain becomes deformable.
- Islands' trimesh colliders get `ActiveHooks.FILTER_CONTACT_PAIRS` so the hook fires.

The island trimesh collider **stays in the world** — it is now used only by non-ship bodies (character, debris).

### 4. Wiring — `game/islandField.ts`, `game/world.ts`

- `IslandField` registers each terrain body in `physics.terrainBodies`, flags its collider, and exposes an **`IslandTarget` per island** (occupancy = island grid `isSolid`, dims, world pos = island translation, identity quat, `voxelSize = M_PER_VOX`, COM = island centre, static).
- `GameWorld.step` calls the terrain pass (`contact.stepAll(ships, islandTargets, dt)`) **before** `world.step`, same ordering as ship-vs-ship, so its velocity + position fixes integrate that step.
- No terrain re-mesh ever needed — terrain never changes, so its visual + collider are built once at startup (as today).

## More cliffs + sea stacks

### Cliffier coasts — `sim/islandwright.ts` (pure tuning)

Widen the sea-cliff selection window (`cliffSel`'s `smoothstep(0.5, 0.9, …)`) and raise `cliffAmp` so more of each coastline is sheer rock instead of beach, with taller crags. **Beaches still exist** — the player needs some safe approaches and the harbor needs its town bench + pier corridor (verify the cliffier coast doesn't wall off the pier; the bench-leveling already clears its own footprint). Deterministic; no API change.

### Sea stacks — `sim/islandwright.ts` + `game/islandField.ts`

- `buildSeaStack(opts)` → a small voxel grid: a tall, narrow, jagged ROCK/DARKROCK pillar (few-voxel footprint, seabed base to an above-water peak, noise-irregular), reusing the grid + `meta.waterlineY` convention so it places like an island.
- A `planHazards` pass (sibling of `planIslandPlacements`) scatters several sea stacks in open water between islands — they may sit closer together than islands to form gauntlets, but must clear the spawn lagoon. Deterministic from the world seed.
- They register as terrain bodies and get an `IslandTarget` exactly like islands ⇒ ship-vs-stack destruction works with **zero new physics code**, and they render through the existing `IslandVisual` mesher (terrain palette) with **zero new render code**. Indestructible, like all terrain — ram one and it tears *your* bow.

## What breaks / what's spared

- **Breaks:** only the ship's grid voxels (hull, deck, quarterdeck, cabin, bulwark, bulkheads, ballast, bow armor) — via the existing `carveCells` path. Masts/cannons/wheel/sails are separate render meshes, never in the grid, so the carve can't touch them (same as ship-vs-ship).
- **Never breaks, never moves:** all terrain voxels (island rock/dirt/sand/grass/foliage, harbor town + pier, sea stacks).

## Performance

- Ship is always A → walk only the ship's few-hundred surface cells against terrain occupancy (O(1) array lookup); cheap.
- Broad-cull each ship × terrain pair by AABB first. Island AABBs are large (whole grid incl. water margin), so the AABB test passes for ships merely *near* an island; the per-cell occupancy reject then fast-rejects open-water cells. Acceptable; a tighter coast-distance broad-phase is a possible follow-up if profiling shows it.
- Reuse `voxelContact`'s existing scratch arrays; no new per-step allocation on the hot path.
- The ship's heavy post-damage recompute (`flushDamage`) keeps its existing ~10 Hz throttle.
- **Requirement:** hold 60 fps with the full fleet near the archipelago.

## Tunables

- Reuse `TUN.crush` unchanged — it is the **same rule** (`vBreak`, `toughness`, `buffer`, `depen`, `maxDepenSpeed`, `biteDvCap`, `transferFrac`, `maxStepEnergy`, `minDepth`, `fling`). No new lever for the destruction itself.
- Add at most `TUN.hazard.seaStacks` (integer count) for the dev panel.
- `detectContacts` may want a slightly larger effective `buffer` for the coarse terrain; tune in-browser if first-contact registration feels late. Note as a tuning knob, not a new design lever.

## Tests (pure, deterministic — Rapier dynamics + feel verified in-browser, not in vitest)

`sim/voxelOverlap.ts`:
- Mismatched voxel sizes: a fine hull A overlapping a coarse hull B reports the expected contacts at the right cells/points.
- **Regression:** equal `vsA == vsB` reproduces the current ship-vs-ship contacts exactly.

Ship-vs-static-terrain (the core):
- A ship driven into a static voxel wall at > `vBreak` loses voxels from its **leading face**; the wall keeps **all** its cells and its translation is **unchanged**; the ship's closing speed bleeds (it neither passes through nor flings).
- Below `vBreak`: the ship rests + de-penetrates with **zero** voxels removed; the wall stays put.
- Static target ⇒ the ship absorbs the full aggressor-drag; no impulse/translation reaches B.

Content:
- `planHazards` / `buildSeaStack`: deterministic for a seed; stacks clear the lagoon, don't overlap islands, and poke above `waterlineY` with a narrow footprint.

Plus `npm run build` (vitest strips types — tsc must pass) and `npm run test` green before merge.

### In-browser verification (Playwright at :5173)
- Sail the player into a cliff and into a sea stack: confirm the bow erodes and she grinds to a halt offshore (not phase-through, not a rigid bounce, not a fling).
- Confirm a slow drift into the harbor pier does **not** damage the ship (sub-`vBreak`) and you can still make port.

## Build order

1. **Section 1–4 (the core).** Generalize `detectContacts`; add `ContactTarget` + `IslandTarget`; static-B special-case in `stepPair`; terrain pass in `stepAll`; `terrainBodies` filter + wiring. This is the enabler and the bulk.
2. **Cliffs + sea stacks** on top.

## Out of scope (deliberately)

- Submerged reefs and scattered coastal rocks (considered, declined — hazards stay *visible*).
- Destructible terrain (terrain is indestructible by design; the `ContactTarget` carve hook *could* later enable breakable rock, but not now).
- A tighter terrain broad-phase (only if profiling demands it).
