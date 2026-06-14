# Voxel Islands — Generation Rebuild Implementation Plan

> **For agentic workers:** implement task-by-task; keep `npm run test` + `npm run build` green; commit per task.

**Goal:** Replace the hand-rolled island height brain with Red Blob coast-distance elevation + hydraulic erosion, feeding the existing voxel rasterizer; make the harbor the biggest organic island with a bench town + real dock pylons + varied buildings.

**Architecture:** `sim/islandwright.ts` builds a `Float32Array` heightfield (organic mask → chamfer coast-distance elevation → cliff/crag fields → droplet erosion), then rasterizes with slope/height/noise material banding. `game/islandField.ts` sizes the harbor biggest and caps wild radii.

**Tech Stack:** TypeScript, simplex-noise, deterministic `core/rng`, vitest. No new deps.

---

### Task 1: Generator core — coast-distance + cliff fields + erosion

**Files:** Modify `src/sim/islandwright.ts`; Test `tests/islandwright.test.ts`.

- [ ] Add `coastDistance(land: Uint8Array, nx, nz): Float32Array` (two-pass chamfer DT, ortho 1 / diag √2).
- [ ] Add `erode(hf: Float32Array, nx, nz, land: Uint8Array, rng, opts)` drop-based hydraulic erosion (bilinear height+grad, inertia, capacity, erode/deposit, evaporation; deterministic from `rng`).
- [ ] Rewrite `makeHeightField` → returns `Float32Array`: organic mask (edge-moat), `hBase` from coast distance, `cliff` shore-bump field, `crag` ridged inland, then `erode`.
- [ ] Tests: deterministic; aboveWater > 500; sea-ring edges == 0; **beach band** (SAND surface columns exist in quantity); not a single central spike (≥2 local height maxima OR height spread sane).
- [ ] Run `npm run test`; commit.

### Task 2: Material banding for cliff variation

**Files:** Modify `src/sim/islandwright.ts` (rasterize loop in `buildIsland`); Test `tests/islandwright.test.ts`.

- [ ] Slope+height+noise banding: ROCK seabed; varied ROCK/DARKROCK cliffs where `slope ≥ cliffThresh(x,z)`; SAND beach where low+gentle; GRASS gentle inland; bare ROCK alpine peaks; DIRT subsoil.
- [ ] `cliffThresh` jittered by low-freq noise so cliffs are uneven.
- [ ] Tests: SAND + GRASS + (ROCK|DARKROCK) all present; no EMPTY in counts; palms+foliage present.
- [ ] Run tests; commit.

### Task 3: Harbor biggest + bench town + dock pylons

**Files:** Modify `src/sim/islandwright.ts` (`buildHarborIsland`), `src/game/islandField.ts`; Test both test files.

- [ ] `islandField`: `HARBOR_R` big; wild `radiusVox ≤ HARBOR_R/1.6`; harbor `peakVox`/`landBias` for a solid landmass.
- [ ] `buildHarborIsland`: same pipeline at `HARBOR_R`; replace circular shelf with an **irregular coastal bench** (coastal anchor + height cap, level just that footprint).
- [ ] Rewrite pier: visible OAK support pylons on a lattice down to the seabed + cross-braces.
- [ ] Tests: pier planks > 20; **pylons present** (support voxels below deck over water > N); harbor land extent ≥ 1.5× largest wild (in `islandField.test.ts`); determinism.
- [ ] Run tests; commit.

### Task 4: Varied building templates

**Files:** Modify `src/sim/islandwright.ts` (`stampBuilding`); Test `tests/islandwright.test.ts`.

- [ ] Parameterized house: framed door/windows, **gabled/hipped roof with eave overhang**, optional chimney/porch, rotation, size jitter (per-building `Rng`).
- [ ] Tests: building walls (OAK/PINE) > 40; ROOFTILE present; eave overhang voxels exist beyond wall footprint.
- [ ] Run tests; commit.

### Task 5: In-browser verify + tune

**Files:** none (or palette tweaks in `materials.ts`, erosion knobs in `islandwright.ts`).

- [ ] `npm run dev`; Playwright to `/?at=harbor` and `/`; verify organic coasts, gradual beaches, varied cliffs, visible-but-not-dominant erosion, bench town + dock pylons + varied houses, harbor clearly biggest.
- [ ] Screenshot to projects root; tune erosion strength / palette / cliff amount.
- [ ] `npm run build` green; commit + push to `origin/dev/voxel-islands` (PR #1).
