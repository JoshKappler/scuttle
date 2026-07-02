# Round 12 — Agent B: SP1 cloth sails over voxel truth (+ SP4 shipVisual buffer pooling)

**Spec:** `docs/superpowers/specs/2026-07-01-round-12-overhaul-design.md` (SP1 + SP4 item 4, shipVisual part).
**Orchestration:** `docs/superpowers/plans/2026-07-01-round12-master-orchestration.md`. Baseline here: `3bb27b1` (wave-1 A/C landed).
**Owned files:** `render/sailMath.ts` (new), `render/sailVisual.ts` (new), `render/shipVisual.ts`, `render/voxelMesher.ts`,
`game/debris.ts`, `src/main.ts` (minimal additive wiring only), tests for these. FROZEN: `game/ship.ts`, `game/sailing.ts`,
`core/tunables.ts`, all `sim/`.

## Verified anchors (2026-07-01, at 3bb27b1)

- `render/voxelMesher.meshChunk(grid, cx, cy, cz, visible?)` — optional ship-local cull predicate (cutaway). **Gotcha:**
  `game/ship.ts:639` (FROZEN) calls `meshChunk` with **no predicate** for the walkable deck-collider trimesh → the CANVAS
  exclusion must live in the *predicate at my render call sites*, NOT in meshChunk's default behavior (else the captain's
  collider silently changes — a frozen-file behavior change).
- `sim/materials.ts`: `CANVAS = 14` (density 8, strength 0.4), `SPAR = 13`.
- `sim/shipwright.stampRig`: sails = 1-thin CANVAS sheets at `x = m.x` (mast x-plane), spanning z between yard levels,
  tapered per bay; `build.sailVoxels[mi]` = per-mast cell list (ALL bays concatenated). Yard rows are SPAR (no canvas).
- `game/ship.ts` (read-only): `sailIntegrity[mi] = sailIntegrityValue(survivingFraction(grid, sailCells[mi], CANVAS))`,
  0 when mast down (`updateMastState`, called from throttled `flushDamage`). A felled mast's CANVAS cells leave the ship
  grid via the sever → render can derive everything from the live grid + `build.sailVoxels` (no Ship hook needed).
- Damage → render notification: `world.ts:136` calls `ship.visual.refresh()` per frame; `grid.set()` marks
  `grid.dirtyChunks` (voxelGrid.ts:43) → refresh() folds them into `pendingRemesh`. Sails hook the same dirty-key stream.
- Old billow shader recovered from `git show 9411ce9^:src/render/shipVisual.ts` (square-rig version, supersedes 079e06d's
  gaff version): `yardPin = sin(uv.y·π)`; `belly = yardPin·(0.35+0.65·sin(uv.x·π))·aBelly·uFill`; flutter
  `sin(uTime·4.6+uv.x·8+uv.y·5)·(0.04+aBelly·0.03)·uFill·yardPin`; displaced along the sheet normal; backlit emissive
  `uSailSun·(uSailTrans·pow(backlit,0.8)·(0.45+0.55·texL))` with `vSailWN`, `uSunDirW`. `TUN.gfx.sail.glow = 0.6` still
  live (tunables:432); `SUN_DIR` exported from `render/sky.ts:79`; `public/assets/textures/sail.jpg` still shipped.
- `main.ts`: `wind` object at :433 (`Wind` from game/sailing — dirX/dirZ = blows TOWARD, speed); player animate at :2213
  (passes `sailing.sailSet` + aim), fleet animate at :2222 (passes AI sailSet); `debris.update(dt, t, waves, [...])` :864.
- `game/debris.ts`: `spawnMast` greedy-meshes the island (SPAR+CANVAS cubes), body pulled from the ship solver
  (`physics.debrisBodies`), floats via probes + `liftMul` decay; `update(dt, simTime, waves, targets)` computes `wet`
  per piece. Pieces carry no source-ship tag yet. `routeIsland`/`islandHasRig` pure + tested (tests/wreck.test.ts).
- `render/shipVisual.remeshChunk` (:436-471): dispose + `new BufferGeometry` + 4 `new BufferAttribute` per chunk remesh,
  wood/iron split via tail-packed iron indices + geometry groups. `refresh()` budget = 3 chunks/frame.

## Design decisions

1. **CANVAS hiding:** compose the predicate in `shipVisual.remeshChunk`:
   `vis(x,y,z) = grid.get(x,y,z) !== CANVAS && (cutawayPredicate?.(x,y,z) ?? true)` — cutaway keeps working; deck
   collider (frozen ship.ts, no predicate) unchanged. Debris rig meshes exclude CANVAS the same way. voxelMesher.ts
   itself: no semantic change (pooling scratch only, see 7).
2. **Sheet model:** per mast, split `sailVoxels[mi]` into y-contiguous runs (= bays/sheets; yard rows are the natural
   separators). One plane mesh per sheet (~16×12 segs), vertices baked in ship-local meters (no mesh transform, like
   chunk meshes): x = (bx+0.5)·VOX, y∈[y0,y1+1]·VOX (v), z∈[z0,z1+1]·VOX (u). Normal ±x; belly displaces local +x.
3. **Occupancy mask (R8 DataTexture, one texel per sheet cell):** 255 = alive CANVAS, 128 = stamped-but-dead (torn),
   0 = never cloth (taper margin of the bounding rect). Fragment: hard-discard occ<0.2 (taper), noise-warped sample
   discard <0.72 (jagged tears). Vertex: belly ×= smoothstep(0.45,0.95,occ) → local sag. Sheet `mesh.visible = alive>0`
   (matches thrust: integrity 0 ⇒ hidden; felled mast ⇒ cells left the grid ⇒ hidden). Mask rebuilt only when a dirty
   chunk overlaps that sheet's AABB (10 Hz worst case, damage-flush driven).
4. **Wind (visual-only):** pure `billowFactor(windDirX, windDirZ, fwdX, fwdZ) → {fill, luff}` in sailMath — following
   wind fill→1, head-to-wind fill→0 + luff→1 (flutter amplitude up). CPU-side per frame: `uFill = (0.35+0.65·sailSet)
   ·fill`, `uLuff`. Ship forward = local +x via `group.quaternion`. `ShipVisual.animate` gains optional 5th param
   `wind?: {dirX,dirZ,speed}`; main.ts passes `wind` at both call sites (2-line diff).
5. **Debris:** (a) spawnMast meshes exclude CANVAS + adds a limp draped sheet variant (droop baked into geometry,
   darker waterlogged tint, no shader) via a builder exported from sailVisual; (b) wind drag: pure
   `rigDriftForce(areaM2, exposedFrac, windSpeed, downwindSpeed)` (cap: force→0 once downwind drift ≥ ~2 m/s, well
   under vBreak 4) applied at COM for mast pieces; `update` gains optional `wind` 5th param (main.ts 1-line);
   (c) **CONTRACT:** `removeRigFor(ship: Ship): void` on DebrisManager — despawns mast/rig pieces whose new
   `source` tag === ship (scene.remove + debrisBodies.delete + removeRigidBody, mirroring the lifetime path).
6. **Shader:** MeshStandardMaterial + onBeforeCompile (house pattern, hullMaterial does the same) — lighting/tonemap
   free. Per-sheet material instance (own uOcc/uBelly/uTexel), shared uniform objects for uTime/uFill/uLuff/uSailTrans;
   `customProgramCacheKey` pinned so all sheets share one program. Backlit term reuses SUN_DIR + TUN.gfx.sail.glow.
   Cutaway: forward the clip plane to sail materials (same as cannons). castShadow on (depth pass won't billow — the
   old rig had the same limitation).
7. **SP4 pooling (shipVisual + voxelMesher scratch):** (a) meshChunk gains an optional `into?: MeshScratch` — output
   returned as subarray views over grow-only scratch (only shipVisual passes it; debris/character/islands keep fresh
   arrays — no aliasing); accumulator number[]s become module-level reset-per-call. (b) remeshChunk keeps the geometry
   when new data fits attribute capacity: `attr.array.set(view)` + needsUpdate + re-built groups (always material array
   [hull, iron], groups define draw counts); manual boundingSphere from the chunk AABB (skips computeBoundingSphere over
   stale tail). Capacity overflow → dispose + realloc with 1.5× slack (existing dispose path respected).

## Task list (one commit each, build+test green before every commit)

- [x] **T1** this plan (docs commit).
- [x] **T2** `render/sailMath.ts` + `tests/sailMath.test.ts` (TDD): `splitSheets`, `sheetBounds`, `buildOccupancy`
      (3-state mask + alive count, vs a real `buildCutter` grid: intact → all alive; `grid.set(EMPTY)` some cells →
      dead flagged), `billowFactor` (range/sign/monotonicity), `sheetTouchesChunk` (dirty-key overlap).
- [x] **T3** `render/sailVisual.ts` + shipVisual integration + main.ts wind wiring: hide CANVAS cubes (predicate),
      billowing sheets w/ occupancy-shaped taper, wind fill/luff, cutaway clip parity. Gate: build + browser.
- [x] **T4** damage path: dirty-chunk → mask refresh in `ShipVisual.refresh()`/`remeshAll()`, tear discard + sag +
      hide-at-zero (shader bits land in T3; this wires the live refresh). Gate: build + browser console carve check.
- [x] **T5** debris: draped canvas variant + `rigDriftForce` (+ test) + wind param + `removeRigFor(ship)` (+ routing
      tests extended in tests/wreck.test.ts or new tests/debrisRig.test.ts). Landed as `tests/debrisRig.test.ts`.
- [x] **T6** SP4 pooling (voxelMesher scratch views + shipVisual geometry pool). Tests: existing voxelMesher suite must
      stay green + a view-reuse unit test; behavior identical in browser.
- [x] **T7** in-browser verification (Playwright at :5173) + screenshots to projects root (`scuttle-r12b-*.png`):
      billow at sea; W/S inflates/deflates; carve CANVAS from console (`DEBUG.sloop.build.grid` + carve cells +
      `DEBUG.sloop.flushDamage()`) → jagged holes + sag; trunk-base carve → felled mast drapes + drifts downwind;
      cutaway X solid; no z-fighting; no new console errors. All confirmed — see the executor's final report
      (session b3712cea) for the full screenshot list and findings (e.g. the felled-mast debris piece sank near a
      nearby island's collider mid-drift-test — plausible incidental terrain contact from the synthetic teleport
      setup, not reproduced as a code defect; not chased further given no debris↔terrain code was touched).

## Handoff notes (wave 2)

- `DebrisManager.removeRigFor(ship: Ship): void` lands in T5 — agent D wires `ship.repairSails` → `Ship.onRigRepair`
  → this (orchestrator tail-wires per master plan §2).
- Drift/drape constants are module-level in debris.ts/sailVisual.ts (tunables.ts frozen for B) — candidates for
  `TUN.rig` promotion by D if feel-tuning wants sliders.
- meshChunk's internal accumulators are module-scratch now, but its no-scratch callers (debris, character, islands)
  still allocate output arrays per call — fine (spawn-time only), noted for a future perf round.
