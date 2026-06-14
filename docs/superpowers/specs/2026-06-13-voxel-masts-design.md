# Voxel Masts, Yards & Bowsprit — Design

> **STATUS 2026-06-13 — APPROVED.** Refines & implements the masts half of "Phase V3"
> from `2026-06-13-voxel-overhaul-design.md`. Scope agreed with the user: make the
> wooden poles real voxels (part of the main hull grid) so they're destructible like
> the hull and break off as physics debris. Sails, rudder, wheel, cannon barrels stay
> as separate models. Real spar mass + ballast re-tune. Both ships.

## Goal (plain language)
The ship *looks* like one solid chunk of voxels, but only the **body** is voxels (hull,
deck, rail, inner walls, iron ballast). The **masts** (tall poles), **yards** (the
horizontal cross-poles sails tie to), and the **bowsprit** (the pole off the bow) are
separate smooth tubes glued on top, with a *fake* damage model (hidden hit-points + a
canned tip-over). This makes those poles **real voxels in the same grid as the hull**, so
they chip, blast apart, and a destroyed mast genuinely **breaks off and falls into the sea**
as physics debris — exactly how the hull already behaves.

Out of scope (stay as separate models, by user decision): **sails** (cloth — already
destructible via puncture), **rudder** (rotating blade — revisit as a focused follow-up),
**steering wheel**, **cannon barrels/carriages**, **stern ladder**.

## Architecture: spars live in the existing hull `VoxelGrid`
Grow each ship's grid upward so the spars occupy real cells in the *same* grid as the hull.
This reuses the entire existing voxel pipeline, so the feature is mostly stamping cells +
deletions, not new systems:
- **Falling = the existing sever→debris path.** `applyDamage`→`findSevered` already detects
  a disconnected upper mast; `DebrisManager.spawn` already turns it into a floating/sinking
  physics body meshed from the same voxels. No new fall code.
- **Solid collision = the existing deck trimesh.** `rebuildDeckCollider` re-meshes the live
  grid into the character collider, so the voxel mast is automatically un-walk-through-able.
  The separate density-0 mast cylinder colliders are **deleted**.
- **Real mass + carving = the existing grid math.** `totalMass`/`centerOfMass` and
  `applyDamage` already act on cells → real spar weight and per-voxel damage for free.

Rejected alternative: separate per-part voxel objects. Would force re-implementing severing,
mass-coupling to the ship body, and hit-routing by hand. Main-grid is strictly less code.

## Grid sizing (VOXEL_SIZE = 0.25 m)
| Ship | mast feet | mast height(s) | mast top (voxel y) | `ny`: old → new |
|---|---|---|---|---|
| Sloop (`buildSloop`) | deckY=20, deckTop=21 | 15 m = 60 cells | 81 | 30 → **84** |
| Brig (`buildBrig`) | deckY=24, deckTop=25 (both masts foot on waist deck) | 21 m / 18 m = 84 / 72 cells | 109 / 97 | 42 → **112** |

Brig grid becomes 152×112×44 ≈ 749k `Int8` cells (~0.75 MB). Upper region is empty except
the thin spar columns, so meshing skips empty chunks; `findSevered`/`centerOfMass` run only
on damage events (a full-array scan there is sub-millisecond and acceptable).

## New material: `SPAR`
Add to `materials.ts` (id 4): weathered brown ~`[0.08, 0.05, 0.028]` linear, density ~**350
kg/m³** (light — lets us keep the rig from raising the COM much), `strength` 2. The greedy
mesher already colours by `MATERIALS[mat].color`, so no mesher change. `applyDamage` treats
it as ordinary timber (only IRON has the blast-fringe special-case).

## Single source of truth for spar geometry
Spar layout currently lives in the **render** layer (`shipVisual.addRig`). Move it into the
**builder** (`shipwright.ts`), which owns the grid, and expose a descriptor so the renderer
can hang the cloth sails at the matching spots and `ship.ts` can find the trunk for
fell-detection. Extend `ShipBuild`:

```ts
masts: {
  x: number; z: number; h: number;           // (existing) foot cell + rig height (m)
  footY: number;                              // deck-top voxel y the mast steps on
  yards: { yM: number; halfSpanM: number }[]; // each cross-pole: height above foot (m) + half-width (m)
}[];
bowsprit: { rootX, rootZ, rootY, lengthM, steeve }; // angled pole geometry
```

Stamping (in each builder, AFTER compartments/leak-audit/ports so hull flooding & buoyancy
are untouched):
- **Mast:** vertical column of `SPAR` from `footY` up `h/VOXEL_SIZE` cells. Cross-section
  2×2 for the lower ~40%, 1×1 above (matches today's ~0.25–0.5 m tapered tube).
- **Yards:** 1×1 horizontal `SPAR` rows at each `yards[i].yM`, spanning `±halfSpanM` across
  the beam (z), centred on the mast.
- **Bowsprit:** stair-stepped diagonal `SPAR` (≈2×2 tapering to 1×1) from a root cell in the
  foredeck, rising at `steeve`, for `lengthM`.

Yard levels & widths keep today's proportions (course/topsail/topgallant at 0.17/0.56/0.88·h,
spans 0.71/0.57/0.43·h) so the sails sit where they do now.

## Render layer (`shipVisual.ts`)
- **Delete** the mast trunk, yard, and bowsprit *meshes* (the `CylinderGeometry` tubes) and
  the per-mast topple animation (`mastRigs`, the fall loop in `animate`).
- **Keep & re-anchor** the cloth sails: build them from `build.masts[i].yards` (positions
  now come from the descriptor, not local mesh math). Keep the billow shader and puncture.
- **Keep** the wheel and ladder meshes unchanged.
- **Sail drop on fell:** group each mast's sails under a `sailGroup`. On `fellMast(mi)`,
  reparent that group to the scene at its current world transform and run a short
  fall+fade (~6 s) before removal. (Cloth and the voxel timber descend on slightly
  different paths — acceptable; both clearly come down.)

## Damage path (`ship.ts`, `cannons.ts`)
Masts now take damage through the **normal voxel path**: a ball tears any cloth it crosses
(kept), flies on, and `marchGrid`→`applyDamage` carves the `SPAR` voxel behind it.
- `rigImpacts`: **remove** the mast-cylinder ray test (`segmentMastHit`) and the analytic
  mast stop. **Keep** sail puncture (gated on `mastAlive`) and the rudder box test.
- **Remove** the analytic mast HP system: `hitMast`, `mastHp`, `mastFootCount`/`mastFootInit`,
  `mastColliders`. (`cannons.ts` no longer calls `hitMast`.)
- **Fell detection (new):** record each mast's lower-trunk cells at build. After every
  `applyDamage`, if a mast's surviving lower-trunk cells drop below ~50%, call `fellMast(mi)`:
  set `mastAlive=false`, `sailIntegrity=0`, drop its sails, fire `onMastFelled`. The severed
  upper voxels are already handled by `findSevered`→debris in the same `applyDamage` call.
- `hitSail`/`sailIntegrity` and the sailing drive contribution stay as-is.

## Two correctness fixes forced by growing `ny`
Both currently derive height from `ny * VOXEL_SIZE`; growing `ny` would break them:
1. **Coarse ship-ship collider** (`Ship` ctor): height must come from the **hull deck**
   height (`(quarterdeck?.deckY ?? deckY) + ~5`), not `ny`. Otherwise ships collide through
   each other's empty rigging space.
2. **Box inertia** (`ixx/iyy/izz`): same — base the box height on the hull deck height, not
   `ny`, or pitch/roll inertia inflates ~2.7× and the ships feel sluggish. Re-tune handles
   the masts' real (modest) contribution.

## Hydrostatic vs structural: the one rule that keeps buoyancy honest
SPAR cells are **solid for structure** but **skipped for buoyancy**:
- **Solid (no change — `isSolid` includes SPAR):** greedy mesh, deck/character collider,
  `findSevered` connectivity, `totalMass`, `centerOfMass`, `applyDamage` carving.
- **Skipped for displacement:** `makeProbes`, `makeVoxelColumns`, and `buildHullProfile`
  must treat SPAR as non-displacing (a helper `isHull = isSolid(x,y,z) && mat !== SPAR`).

Why this matters: those builders span each column from its lowest to highest solid cell. If
masts counted, a mast column would "displace" water up to the masthead (~27 m) — phantom lift
and a broken waterline. Skipping SPAR means the rig adds **mass** (raising the COM, as
intended) but **no displacement** — physically correct (a mast is dense timber mostly above
water). This single rule also makes the ocean-cutout concern moot: `buildHullProfile`'s
per-column deck stays at the real deck, so the waterline cut is byte-for-byte unchanged. No
separate clamp needed.

Consequence for re-tune: with rig mass in the COM but no rig buoyancy, `stability.test.ts`
(GM ≥ 0.15) and `draft.test.ts` will tighten/fail until the ballast is re-tuned — they are
the regression gate (see below).

## Stability & re-tune (user chose real mass + re-tune)
Slender spars at ~350 kg/m³ add roughly 1–1.5 t per mast, high up, against ~500 t of ballast
— a COM rise of ~0.1–0.2 m. The sloop's single forward mast adds bow trim; the brig's two
masts roughly balance. Plan: after the spars are in, **re-tune the iron ballast** (chiefly
the fore/aft `AFT` shift and tier extents in each builder) and **verify in-browser** (the
readback/Playwright approach) that both ships: float at the intended draft (~0.45), sit level
(no persistent bow/stern trim), and do **not** capsize under full sail in a turn. This is the
acceptance gate before "done".

## Files touched
- `src/sim/materials.ts` — add `SPAR`.
- `src/sim/shipwright.ts` — stamp spar voxels into both grids; grow `ny`; extend `ShipBuild`
  with the spar descriptor + bowsprit; ballast re-tune.
- `src/render/shipVisual.ts` — delete spar meshes + topple anim; re-anchor sails to the
  descriptor; sail-drop-on-fell; keep wheel/ladder.
- `src/game/ship.ts` — drop mast cylinder colliders & analytic mast HP; new trunk-cell fell
  detection; decouple collider/inertia height from `ny`.
- `src/sim/rigDamage.ts` — `segmentMastHit` no longer used by the mast path (keep the pure
  fn or remove if unreferenced; keep sail/box helpers).
- `src/game/cannons.ts` — drop the `hitMast` call; sail/rudder handling unchanged.
- `src/sim/buoyancy.ts` — `makeProbes`, `makeVoxelColumns`, `buildHullProfile` skip SPAR
  cells (the `isHull` rule above).
- Tests: extend/adjust any mast-HP unit tests to the new model; stability regression must
  still pass after re-tune.

## Acceptance criteria
1. On both ships, the masts/yards/bowsprit render as voxels continuous with the hull.
2. Cannon fire chips and blasts the spars per-voxel; a mast shot through/at the base breaks
   off and falls into the sea as debris (not a canned animation); its sails drop and its
   drive dies.
3. You cannot walk through a standing voxel mast.
4. Both ships float level at the intended draft and do not capsize under sail (verified
   in-browser); existing stability regression passes.
5. `tsc` + unit tests green.
