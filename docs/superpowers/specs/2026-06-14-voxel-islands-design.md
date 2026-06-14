# Voxel archipelago & harbor town — design

_Date: 2026-06-14 · branch `dev/voxel-islands` (worktree)_

## Goal

A system of **stationary, voxel-based islands and cliffs** dressed as a small tropical
pirate world, with one harbor island carrying a **voxel dock + town** where ships will
later be able to dock, repair, upgrade, and buy new ships. This pass delivers the static
world; the docking *interaction* is a future task (we leave an anchor hook for it).

## Decisions (locked with the user)

1. **Solid collision.** Islands get static Rapier colliders — hulls ground on beaches and
   stop at cliffs / the dock. They are otherwise "no physics": not buoyant, not simulated,
   never remeshed.
2. **Seeded-procedural archipelago**, with the harbor island *guaranteed* at a reachable
   spot so the town reliably shows in the demo.
3. **Fully voxel** terrain + dock + a few town buildings, matching the ship aesthetic.

## Aesthetic

Tropical: tan/white sand beaches, grey-ochre cliff rock, jungle-green highland, palms.
Cliffs are a first-class feature — some islands have sheer near-vertical rock faces
dropping into the sea.

## Architecture (mirrors existing ship modules)

| New file | Mirrors | Responsibility |
|---|---|---|
| `sim/materials.ts` (edit) | — | Add terrain material ids + tropical palette: `SAND, ROCK, DARKROCK, GRASS, DIRT, PALMWOOD, FOLIAGE`. Additive — ships keep `OAK/PINE/IRON/RAM`. |
| `sim/islandwright.ts` | `sim/shipwright.ts` | Pure, deterministic `buildIsland(rng, opts)` and `buildHarborIsland(rng, opts)` → `{ grid, meta }`. Heightfield voxelization, slope/elevation materials, cliff carving, palms, dock + buildings. |
| `render/islandVisual.ts` | `render/shipVisual.ts` | Grid → chunk meshes (`meshChunk`) under one `THREE.Group`; own vertex-color `MeshStandardMaterial` (no plank texture). Built once. Exposes merged geometry for the collider. |
| `game/islands.ts` | `game/fleet.ts` | `IslandField`: seeded placement of N islands + the guaranteed harbor island; owns instances; builds static trimesh colliders; adds visuals to scene. |
| `core/constants.ts` (edit) | — | `ISLAND_VOXEL_SCALE` (terrain group scale; ~2 → 0.5 m voxels). |
| `main.ts` (edit) | — | Construct `IslandField` after physics init; add to scene + physics. Expose `window.DEBUG.islands`. No render-loop change. |

## Generation detail (`islandwright`)

- **Heightfield** `h(x,z)`: layered value noise from the deterministic `Rng` (`core/rng.ts`)
  × a **radial falloff** so each landmass is sea-ringed. Fill each column seabed→`h`.
- **Materials by elevation + slope:** waterline band → `SAND`; steep gradient → `ROCK`/
  `DARKROCK` (cliffs, forced near-vertical); flatter highland → `GRASS` over `DIRT`;
  `ROCK` core beneath.
- **Palms** stamped into the same grid (trunk `PALMWOOD`, canopy `FOLIAGE`) at
  deterministic grass columns — stays one voxel mesh.
- **Harbor island:** flatter, with a bay; a `PINE` pier on pylons ~1.5–2 m above water;
  a handful of buildings (tavern, harbormaster's shack, huts — voxel boxes, sloped roofs,
  door/window cutouts); palms. `meta.dock` exposes world position + bearing for the
  future docking interaction.

## Coordinate / scale notes

- Terrain voxels are coarser than ship voxels: the global mesher bakes `VOXEL_SIZE`
  (0.25 m); the island `THREE.Group` and collider are scaled by `ISLAND_VOXEL_SCALE`
  (≈2 → 0.5 m terrain voxels). Keeps grids small/fast and gives clean blocky islands.
- Island grids sit with their base below the water plane (y≈0) and terrain rising through
  the surface. Water is the existing ocean mesh; islands simply intersect it (no footprint
  hole — that's a ship-only ocean feature).

## Placement (`IslandField`)

- Seeded from the world seed. **Always** place the harbor island ~250–400 m off spawn at a
  deterministic bearing. Scatter ~5–8 procedural islands within a ~700 m radius via
  rejection sampling (no overlaps; keep a **clear lagoon** ≥120 m around spawn so the run
  starts in open water).

## Collision

- One **fixed rigidbody + trimesh collider** per island from the merged greedy-mesh
  geometry (scaled). Trimesh-vs-ship-cuboid-hull collides in Rapier; islands are absent
  from the ship list `collisionDestruction` iterates, so they never trip ship-vs-ship
  carving. Verify ship collider shape in `game/hullCollider.ts` during planning.

## Testing & verification

- **Unit (vitest, deterministic):** `islandwright` produces solid columns up to the
  heightfield, assigns beach/cliff/highland materials in the right bands, includes a dock
  and ≥1 building on the harbor island; `IslandField` placement is deterministic for a
  seed, non-overlapping, and keeps the spawn lagoon clear.
- **In-browser (Playwright @ :5173 + screenshots to projects root):** archipelago renders;
  brig sailed into a cliff stops (collision); town/dock framed and looks right.
- `npm run build` (tsc) + `npm run test` green before commit.

## Out of scope (future)

Docking interaction (repairs, upgrades, buying ships), island destructibility, LOD/streaming
for very large worlds, town NPCs. The dock anchor metadata is the hook for the first of these.
