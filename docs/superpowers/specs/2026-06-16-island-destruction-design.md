# Island destruction — design (2026-06-16, deferred from the ocean/sky/perf pass)

Hitting an island should damage the ship through the **same** voxel crush system as
ship-vs-ship, with island voxels **immovable + unbreakable**. The user's rule, verbatim:

> "All voxels are created equally in this game. The ones on the island just happen to be
> indestructible and unmovable, and that's the only thing that should be different."

This is **THE LAW #4** ("destruction is ONE rule") applied to terrain — the rest should fall out
for free (carving, flooding, debris, capsize all emerge from the existing crush path).

## Current behaviour (root-caused, the bug to fix)

Confirmed in code (file:line):
- **The crush path only runs ship-vs-ship.** `game/voxelContact.ts` `stepAll(ships, dt)` iterates
  `ships × ships` pairs only (`world.ts` calls it with the ship list). Islands have no `Ship` and
  never enter it → `detectContacts` / `carveCells` never fire for an island contact.
- **The contact filter only spares ship-vs-ship from Rapier's rigid solver.** `game/physics.ts`
  `filterContactPair` returns `null` (skip the rigid solver, let the deformable path own it) **only
  when BOTH bodies are in `shipBodies`**; otherwise it returns `COMPUTE_IMPULSE`. Islands are never
  in `shipBodies` (only `ship.ts:201` adds), so a ship↔island contact gets the **full rigid solve**.
- **Result:** the island is a `fixed()` body with a `Voxels` collider (`islandField.ts`, group
  `0x0002ffff`, from `e9b3da2`). Rapier resolves the overlap with a large one-sided impulse on the
  ship → the **"glitched against the island and flew into the air"** launch, and **zero carving** →
  no damage. (Verified live this session: a ship parked on the harbour shelf was shoved to y≈-5.5;
  the same hull floats at y≈-3.0 in open water.)

## The fix (approach)

Route ship↔island contacts into the deformable crush path, as a **one-sided** interaction.

### 1. Stop the rigid shove
Extend `filterContactPair` to also return `null` (skip the rigid solver) for a ship-hull ↔ island
pair, so Rapier no longer applies the explosive impulse. Two ways to recognise an island collider:
- give the island's `Voxels` collider a distinguishing collision-group / a `Set<islandColliderHandle>`
  on the physics struct (mirrors `shipBodies`), and null the pair when one body is a ship and the
  other is an island. Keep the character KCC path untouched (it filters bit 1 and walks the trimesh,
  not the island Voxels collider).

### 2. Island as an immovable crush participant
Teach the crush step to test each ship against each nearby island, reusing `voxelOverlap`/`crush`:
- Define a minimal **CrushBody** view: `{ grid, worldTransform, massInfinite: true, breakable: false }`.
  A ship satisfies it today; wrap each `IslandField` model (its `VoxelGrid` + fixed transform) as one.
- `stepAll` gains a second loop: for each ship, for each island whose AABB overlaps the ship, run the
  same per-voxel contact detection. Gate by AABB so it is ~free when not near land.
- **BREAK regime (closing > vBreak):** carve the **ship's** voxels only, bounded by the collision KE
  `½·μ·vClose²` cheapest-first (`carveWithinBudget` → `ship.carveCells`). The island is **never**
  carved (`breakable:false`) and **never** receives impulse (`massInfinite`). All the closing energy
  becomes **drag on the ship** (it spends its own speed grinding into rock) via the existing
  `distributeClosingDrag` with the island's share → 0 transfer. Because island rock is far tougher
  than oak (`materials.ts`: rock 100 kJ, darkRock 150 kJ vs oak 15 kJ/cell), the **ship** shatters
  against the island — exactly "indestructible island" with no special-case damage numbers.
- **REST regime (closing ≤ vBreak):** one-sided de-penetration — move **only the ship** out along the
  contact axis (the ship→island-surface normal, the immovable analogue of the COM→COM line), reusing
  `depen` / `maxDepenSpeed`, closing pre-zeroed so it can only shrink the overlap (no re-penetrate,
  no fling, no vertical shove → no launch).

### 3. What emerges for free
Carved hull cells flow straight into the existing flooding (`registerBreaches`), debris/dust
(`fling`), mass re-derivation (`recomputeMassProperties` → list/capsize), and the sink gate. No new
damage system.

## Tunables / risks
- Island toughness already makes the ship lose the exchange; if islands feel *too* unbreakable to be
  satisfying, that is a later call (the rule says unbreakable, so keep them so unless the user asks).
- Perf: gate ship↔island contact tests by AABB overlap so open-water steps pay nothing; the island
  grids are large (~150k surface band voxels) so reuse the existing surface/scratch structures.
- Keep the island trimesh for the character KCC (the on-foot captain must still walk the dock/island);
  only the ship-hull pair changes regime.
- The Voxels↔Voxels narrow-phase already produces contacts (that is what `e9b3da2` relied on), so the
  rigid collider can stay as the contact source; we just take it out of the rigid SOLVE and feed the
  manifold/overlap into `voxelContact`.

## Verification (TDD — this one IS unit-testable)
Unlike the visual pass, this is deterministic physics: drive it in the vitest oracle.
- Ram a gravity-free voxel chunk (or a ship) horizontally into an island above `vBreak`; assert the
  **ship loses cells** while the **island grid is byte-identical**, the ship's closing speed bleeds
  off (drag), and there is **no upward velocity** introduced (the anti-launch invariant).
- Below `vBreak`: assert the ship comes to rest against the island with the overlap shrinking
  monotonically and no vertical impulse.
- Single-step `DEBUG.world.step(1/60)` readbacks in-browser to confirm feel (immune to the headless
  time-compression that breaks sustained rams).

## Scope
One self-contained change across `game/physics.ts` (filter), `game/voxelContact.ts` (island loop +
CrushBody), a small island-collider registry, and `game/islandField.ts` (expose model grid/transform
as a CrushBody). No change to ship-vs-ship behaviour. Ships-vs-island and the existing crush share
one code path after this.
