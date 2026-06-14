# Voxel Islands — Generation Rebuild (design)

> **Status:** approved 2026-06-14, building autonomously on `dev/voxel-islands` (PR #1).
> Supersedes the *generation internals* of `2026-06-14-voxel-islands-design.md`; the
> module layout, collision model, and dock-anchor hook from that spec stand.

## Why

The first generation pass shipped but read wrong (user review, 2026-06-14):

1. **Islands rise too tall, too fast** — no gradual beach. Root cause: height = `relief × inland-noise`, and the noise is high right at the waterline, so land walls straight up out of the sea.
2. **The harbor island is "clearly a circle surrounded by blobs."** Root cause: the town sits on a literally-circular flattened `townR=30` disc, which *is* the whole visible island top.
3. **Every island is the same recipe** (noise threshold around a centre) → they all rhyme; sizes barely vary.
4. **Buildings are cubes with red roofs; the dock has no visible supports** (a pylon-generation bug).

The fix is to stop hand-rolling the shape brain and adopt two well-documented procedural-terrain *methods*, sampled into the **existing voxel rasterizer / Rapier trimesh / greedy mesher** (those stay):

- **Red Blob Games coast-distance elevation** (mapgen4 idea): elevation is a function of *distance from the coastline*, so land rises gently from the beach and mountains sit deep inland. The medial axis of a messy (non-convex) coast is a branching ridge — so irregular islands get mountain spines for free, not domes.
- **Drop-based hydraulic erosion** (Sebastian Lague / Job Talle): rain thousands of seeded droplets that carve gullies and deposit sand at the coast → natural ridges, valleys, and varied cliffs.

## Steering constraints (from the user)

- **Harbor is the biggest island, by ≥50%** over the largest wild island.
- **Mountainous erosion is visible but not dominant** — terrain, not a mountain-only skyline.
- **Cliff *variation* is the priority** — some shores are sheer rock, others broad sand beach; cliffs vary around and on each island.
- Build **autonomously in the worktree**; stay compatible with the sibling branches in flight (character-voxel, multi-ship-fleet, voxel-destruction-core, tycoon-progression). Keep all changes scoped to the island modules + **additive** material ids (id 4 stays reserved for RAM). No merge.

## Determinism (LAW)

Everything seeds from the deterministic `Rng` (`isle-${seed}`): simplex noise, the erosion droplet stream, building variation. Same opts → byte-identical grid. Islands never enter any ship list, so they never trip ship-vs-ship destruction; their collider is a static Rapier **trimesh** (trimesh-vs-hull-cuboid generates contacts).

## Pipeline (per island, `sim/islandwright.ts`)

Heightfield is a **`Float32Array` in voxel units** (`0` = open sea); rasterized to voxels at the end.

### 1. Organic land/water mask (kills circles)
- Continuous land field `L(x,z)` = domain-warped fBm.
- **Edge moat, not a radial disc:** `moat = smoothstep(0.72, 1.0, r)` where `r` = normalised distance to grid centre. It is ~0 across the interior and only forces sea at the rim, so the coastline is noise-defined almost everywhere (vs. the old falloff that started at `0.4·R` and dominated the shape into a centred blob).
- `mask = L + landBias − moat·2.0`; **land where `mask > 0`**. `landBias` sets island size → variety (small islets ↔ full landmasses). Strong domain warp → genuine bays, spits, multi-lobe shapes.

### 2. Coast distance → base elevation (the beach fix)
- **Chamfer distance transform** (two-pass, ortho 1 / diag √2) over the land mask → `coastDist` (voxels from the nearest water) for every land cell.
- `hBase = peakVox · smoothstep(0, 1, clamp(coastDist / mountainScale, 0, 1)) ^ 1.25` with `mountainScale ≈ radiusVox·0.85`. The `^1.25` makes slope → 0 at the shore (a true beach ramp) and steepen inland.

### 3. Cliff + relief variation (the priority)
- **Shore cliff field:** low-frequency `cliff01(x,z) ∈ [0,1]`; add `cliff01 · cliffAmp · shoreBump(coastDist)` where `shoreBump` peaks a few voxels in from the coast. Where `cliff01` is high a stretch of coast rises as a **sea-cliff**; where low it stays a **sand beach** → cliffs vary *around* the island.
- **Inland crags:** `ridged(x,z) · ruggedness · ridgeAmp · smoothstep(beachWidth, mid, coastDist)` → ridge lines and crags *on* the island, kept off the beaches.
- `h = clamp(hBase + cliff + crag, 0, 1.15·peakVox)`.

### 4. Hydraulic erosion (visible, not dominant)
- Drop-based sim over the float field: `N ≈ clamp(landArea · 0.12, 0, 60000)` droplets, seeded from `Rng`. Each droplet: bilinear height+gradient, `dir = dir·inertia − grad·(1−inertia)`, move, erode when capacity exceeds carried sediment, deposit when uphill / over-capacity, `speed = √(speed² + Δh·g)`, evaporate. Droplets that leave land deposit on the last land cell (builds the beach). Moderate `erodeRate`/`depositRate` so relief reads as terrain, not a spike-field.

### 5. Rasterize + material banding (cliff variation in colour)
For each land column (`h>0`): `topY = SEABED_Y + round(h)`, `slope = max neighbour height drop`.
- `y < SEABED_Y` → **ROCK** seabed.
- `slope ≥ cliffThresh(x,z)` → exposed **ROCK/DARKROCK** cliff face (DARKROCK low/steepest, ROCK higher; `cliffThresh` jittered by noise so cliffs form unevenly).
- surface `y==topY`: **SAND** if low & gentle (`topY ≤ waterline+beachBand` and `slope` low); else **ROCK/DARKROCK** if steep or alpine-high; else **GRASS**.
- just below surface → **DIRT**; core → **ROCK**.

Vegetation (`scatterPalms`) unchanged in spirit — two-tier palms + bushes on grass.

## Harbor island (`buildHarborIsland`) — biggest + organic

- Built by the **same pipeline**, sized **biggest**: `radiusVox = HARBOR_R` chosen so harbor land extent ≥ 1.5× the largest wild island. `islandField` caps wild `radiusVox ≤ HARBOR_R / 1.6`.
- **No circular shelf.** The town sits on an **irregular coastal bench**: pick a deterministic coastal anchor on one side, take land columns within `townRadius` of it whose *natural* height is below a cap (`waterline + maxTownRise`), and gently level just that footprint to `shelfY`. The height cap makes the footprint follow the low coastal land (irregular), and because the harbor island is large and organic, the town is a small bench on one shoulder — the island no longer reads as a disc.
- **Pier + real pylons (bug fix):** 5-wide boardwalk from the bench's seaward edge out over water. Under the deck, drop **visible support posts** to the seabed on a regular lattice (both rails + centre, every few cells) in OAK, with a couple of cross-braces — matching the Minecraft dock reference. `meta.dock` = seaward pier-end anchor (unchanged hook).
- Lighthouse/watch-tower landmark retained near the pier head.

## Buildings (`stampBuilding`) — varied, not cubes

One flexible template with per-building `Rng` variation:
- Footprint `w×d`, wall height, **rotation**.
- Walls PINE + OAK corner posts + an OAK sill/top-plate; **framed doorway**; **windows with lintels**.
- **Gabled or hipped ROOFTILE roof with a 1-cell eave overhang** (replaces the stepped pyramid — the key visual upgrade).
- Optional **chimney** (ROCK/DARKROCK stack) and, for the tavern, a small **porch** (posts + lean-to roof).
- Variation knobs (size jitter, roof type, rotation, chimney/porch) so the town reads as different buildings.

## Files

- `src/sim/islandwright.ts` — rewrite §1–§5, harbor bench, pylons, buildings. New helpers: `coastDistance()`, `erode()`.
- `src/game/islandField.ts` — `HARBOR_R` big; cap wild radii `≤ HARBOR_R/1.6`; pass new opts. Placement/collision unchanged.
- `src/sim/materials.ts` — unchanged (terrain ids 5–12 already additive).
- `tests/islandwright.test.ts`, `tests/islandField.test.ts` — add: beach band present, dock pylons present, harbor ≥1.5× largest wild; keep determinism + sea-ring tests.

## Risks / non-goals

- **Startup cost:** erosion runs once at world-build (~tens of ms/island). Droplet density is tunable; not per-frame. Acceptable; cache later if needed.
- **Convex-island dome risk:** mitigated by erosion + cliff/crag fields; most islands are non-convex so their medial axis is already a ridge.
- **Non-goals:** docking *interaction* (repairs/upgrades/buying — future, `nearestDock()` is the hook); WFC/Voronoi full port (overkill for a voxel harbor); rivers/biomes.
