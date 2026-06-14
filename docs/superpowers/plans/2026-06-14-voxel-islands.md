# Voxel Archipelago & Harbor Town Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stationary, fully-voxel islands & cliffs (seeded-procedural archipelago) with solid static collision and one harbor island carrying a voxel dock + town.

**Architecture:** Mirror the existing ship modules. A pure deterministic generator (`islandwright`, like `shipwright`) builds voxel grids; the existing greedy mesher (`voxelMesher`) turns a whole grid into one merged geometry; `islandVisual` wraps that in a scaled `THREE.Group` with a terrain material; `IslandField` (like `fleet`) places islands deterministically and builds static Rapier trimesh colliders. Islands are built once and never remeshed.

**Tech Stack:** TypeScript, Three.js, Rapier3D (`@dimforge/rapier3d-compat`), Vite, Vitest.

**Key facts verified against `origin/main`:**
- `meshChunk(grid, cx, cy, cz)` (`src/render/voxelMesher.ts`) is **pure** (no THREE import) and emits positions in ship-local meters (× `VOXEL_SIZE`), with vertex colors = `MATERIALS[mat].color × AO`.
- Ship hull collider is a **cuboid** with collision groups `0x0002ffff` (`src/game/ship.ts:150`). A trimesh collider with **default** groups collides with it (trimesh-vs-cuboid generates contacts in Rapier; trimesh-vs-trimesh does not).
- `Rng` (`src/core/rng.ts`) exposes `next()/range(min,max)/int(min,maxExcl)/pick()` — no noise primitive.
- Rapier access is `physics.world` + `physics.RAPIER` (`src/game/physics.ts`). Static body = `RAPIER.RigidBodyDesc.fixed()`; trimesh = `RAPIER.ColliderDesc.trimesh(Float32Array, Uint32Array)`.
- Materials are `Record<number, Material>` with `{name, density, color:[r,g,b], strength}`; grid stores ids in an `Int8Array` (ids must stay ≤ 127).

---

## Task 1: Terrain materials

**Files:**
- Modify: `src/sim/materials.ts`
- Test: `src/sim/materials.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { MATERIALS, SAND, ROCK, DARKROCK, GRASS, DIRT, PALMWOOD, FOLIAGE, OAK } from "./materials";

describe("terrain materials", () => {
  it("defines the seven tropical terrain materials with valid colors", () => {
    for (const id of [SAND, ROCK, DARKROCK, GRASS, DIRT, PALMWOOD, FOLIAGE]) {
      const m = MATERIALS[id];
      expect(m, `material ${id}`).toBeDefined();
      expect(m.color).toHaveLength(3);
      for (const c of m.color) expect(c).toBeGreaterThanOrEqual(0);
      expect(m.density).toBeGreaterThan(0);
    }
  });
  it("leaves the ship materials untouched", () => {
    expect(MATERIALS[OAK].name).toBe("oak");
    expect(MATERIALS[OAK].density).toBe(430);
  });
  it("keeps every material id within Int8 range", () => {
    for (const k of Object.keys(MATERIALS)) expect(Number(k)).toBeLessThanOrEqual(127);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/materials.test.ts`
Expected: FAIL — `SAND` etc. not exported.

- [ ] **Step 3: Add the materials**

In `src/sim/materials.ts`, after `export const RAM = 4;` add:

```ts
export const SAND = 5;
export const ROCK = 6;
export const DARKROCK = 7;
export const GRASS = 8;
export const DIRT = 9;
export const PALMWOOD = 10;
export const FOLIAGE = 11;
```

And add these entries to the `MATERIALS` object (linear-RGB starting palette; tuned in-browser later):

```ts
  [SAND]: { name: "sand", density: 1600, color: [0.62, 0.54, 0.36], strength: 1 },
  [ROCK]: { name: "rock", density: 2600, color: [0.34, 0.34, 0.37], strength: 20 },
  [DARKROCK]: { name: "darkrock", density: 2900, color: [0.19, 0.2, 0.23], strength: 30 },
  [GRASS]: { name: "grass", density: 1500, color: [0.15, 0.33, 0.12], strength: 1 },
  [DIRT]: { name: "dirt", density: 1500, color: [0.2, 0.13, 0.07], strength: 1 },
  [PALMWOOD]: { name: "palmwood", density: 350, color: [0.2, 0.12, 0.05], strength: 2 },
  [FOLIAGE]: { name: "foliage", density: 100, color: [0.1, 0.3, 0.1], strength: 1 },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/materials.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sim/materials.ts src/sim/materials.test.ts
git commit -m "feat(islands): add tropical terrain materials"
```

---

## Task 2: Deterministic value noise

**Files:**
- Create: `src/sim/noise.ts`
- Test: `src/sim/noise.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { fbm2 } from "./noise";

describe("fbm2 value noise", () => {
  it("is deterministic for a given seed", () => {
    expect(fbm2(123, 4.2, -1.7)).toBe(fbm2(123, 4.2, -1.7));
  });
  it("differs across seeds and across space", () => {
    expect(fbm2(1, 0.5, 0.5)).not.toBe(fbm2(2, 0.5, 0.5));
    expect(fbm2(1, 0.5, 0.5)).not.toBe(fbm2(1, 9.5, 3.5));
  });
  it("stays within [0,1]", () => {
    for (let i = 0; i < 200; i++) {
      const v = fbm2(7, i * 0.37, i * -0.21);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/noise.test.ts`
Expected: FAIL — `fbm2` not defined.

- [ ] **Step 3: Implement value noise**

```ts
/** Deterministic 2D value-noise fBm in [0,1]. Hash-lattice + smoothstep
 *  interpolation, summed over octaves. Pure: same (seed,x,z) → same value. */
function hash2(seed: number, ix: number, iz: number): number {
  let h = (seed | 0) ^ Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // [0,1)
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function value2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = smooth(x - ix), fz = smooth(z - iz);
  const a = hash2(seed, ix, iz), b = hash2(seed, ix + 1, iz);
  const c = hash2(seed, ix, iz + 1), d = hash2(seed, ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

export function fbm2(seed: number, x: number, z: number, octaves = 4): number {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * value2(seed + o * 1013, x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/noise.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sim/noise.ts src/sim/noise.test.ts
git commit -m "feat(islands): deterministic 2D value-noise fbm"
```

---

## Task 3: islandwright — `buildIsland`

**Files:**
- Create: `src/sim/islandwright.ts`
- Test: `src/sim/islandwright.test.ts`

The generator works in voxel space. `meta.waterlineY` is the grid row that sits at sea level; columns rising above it poke out of the water. `opts` is deterministic input.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildIsland } from "./islandwright";
import { EMPTY, SAND, GRASS, ROCK, DARKROCK } from "./materials";

const opts = { seed: 42, radiusVox: 40, peakVox: 34, cliffiness: 0.6 };

describe("buildIsland", () => {
  it("is deterministic", () => {
    const a = buildIsland(opts), b = buildIsland(opts);
    expect(a.grid.data).toEqual(b.grid.data);
  });
  it("rises out of the water and is sea-ringed (empty at the grid edge columns)", () => {
    const { grid, meta } = buildIsland(opts);
    const [nx, , nz] = grid.dims;
    // centre column has solid above the waterline
    let aboveWater = 0;
    for (let y = meta.waterlineY; y < grid.dims[1]; y++)
      if (grid.isSolid(Math.floor(nx / 2), y, Math.floor(nz / 2))) aboveWater++;
    expect(aboveWater).toBeGreaterThan(0);
    // the outermost ring is open sea (no land touching the grid boundary)
    let edgeSolids = 0;
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < grid.dims[1]; y++) {
        if (grid.isSolid(x, y, 0)) edgeSolids++;
        if (grid.isSolid(x, y, nz - 1)) edgeSolids++;
      }
    expect(edgeSolids).toBe(0);
  });
  it("has a sand beach band, highland grass, and rock cliffs", () => {
    const { grid } = buildIsland(opts);
    const counts: Record<number, number> = {};
    grid.forEachSolid((_x, _y, _z, m) => (counts[m] = (counts[m] ?? 0) + 1));
    expect(counts[SAND] ?? 0).toBeGreaterThan(0);
    expect(counts[GRASS] ?? 0).toBeGreaterThan(0);
    expect((counts[ROCK] ?? 0) + (counts[DARKROCK] ?? 0)).toBeGreaterThan(0);
    expect(counts[EMPTY]).toBeUndefined(); // forEachSolid never yields empty
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sim/islandwright.test.ts`
Expected: FAIL — `buildIsland` not defined.

- [ ] **Step 3: Implement `buildIsland`**

```ts
import { createGrid, type VoxelGrid } from "./voxelGrid";
import { fbm2 } from "./noise";
import { DARKROCK, DIRT, EMPTY, GRASS, ROCK, SAND } from "./materials";

export interface IslandOpts {
  seed: number;
  radiusVox: number;   // plan-view island radius in voxels
  peakVox: number;     // max terrain height above seabed in voxels
  cliffiness: number;  // 0..1 — how sheer the rock falloff is
}

export interface IslandMeta {
  waterlineY: number;  // grid row that maps to sea level (world y≈0)
  radiusVox: number;
  peakVox: number;
  dock: { x: number; y: number; z: number; bearing: number } | null; // harbor only
}

export interface IslandModel {
  grid: VoxelGrid;
  meta: IslandMeta;
}

const SEABED_Y = 2;          // a couple of rock rows for the seafloor base
const WATERLINE_FRAC = 0.18; // waterline sits this far up the height range

/** Height (voxel rows above SEABED_Y) of the terrain column at (x,z), or 0 for open sea. */
function heightAt(o: IslandOpts, cx: number, cz: number, x: number, z: number): number {
  const dx = (x - cx) / o.radiusVox;
  const dz = (z - cz) / o.radiusVox;
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r >= 1) return 0;
  // radial falloff: gentle dome, steepened near the rim by cliffiness → sheer walls
  const falloff = Math.pow(1 - r, 1 + o.cliffiness * 3);
  const n = fbm2(o.seed, x * 0.06, z * 0.06);   // rolling terrain
  const ridge = fbm2(o.seed + 99, x * 0.13, z * 0.13); // finer detail
  const h = o.peakVox * falloff * (0.55 + 0.45 * n) * (0.7 + 0.3 * ridge);
  return Math.max(0, Math.floor(h));
}

export function buildIsland(o: IslandOpts): IslandModel {
  const margin = 4;
  const nx = o.radiusVox * 2 + margin * 2;
  const nz = o.radiusVox * 2 + margin * 2;
  const ny = SEABED_Y + o.peakVox + 2;
  const grid = createGrid(nx, ny, nz);
  const cx = nx / 2, cz = nz / 2;
  const waterlineY = SEABED_Y + Math.floor(o.peakVox * WATERLINE_FRAC);

  const hgt: number[] = new Array(nx * nz).fill(0);
  for (let x = 0; x < nx; x++)
    for (let z = 0; z < nz; z++) hgt[x + z * nx] = heightAt(o, cx, cz, x, z);

  for (let x = 1; x < nx - 1; x++) {
    for (let z = 1; z < nz - 1; z++) {
      const h = hgt[x + z * nx];
      if (h <= 0) continue;
      const topY = SEABED_Y + h;
      // slope = max height drop to a 4-neighbour → steep means a cliff face
      const slope = Math.max(
        h - hgt[x - 1 + z * nx], h - hgt[x + 1 + z * nx],
        h - hgt[x + (z - 1) * nx], h - hgt[x + (z + 1) * nx], 0,
      );
      for (let y = 0; y <= topY && y < ny; y++) {
        let mat: number;
        if (y < SEABED_Y) mat = ROCK;                      // seafloor base
        else if (slope >= 3) mat = y > topY - 2 ? ROCK : DARKROCK; // cliff face
        else if (y === topY && topY <= waterlineY + 2) mat = SAND;  // beach band
        else if (y === topY) mat = GRASS;                  // highland surface
        else if (y >= topY - 2) mat = DIRT;                // subsoil
        else mat = ROCK;                                   // core
        if (mat !== EMPTY) grid.set(x, y, z, mat);
      }
    }
  }
  return { grid, meta: { waterlineY, radiusVox: o.radiusVox, peakVox: o.peakVox, dock: null } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sim/islandwright.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sim/islandwright.ts src/sim/islandwright.test.ts
git commit -m "feat(islands): procedural heightfield island generator"
```

---

## Task 4: Palms

**Files:**
- Modify: `src/sim/islandwright.ts`
- Test: `src/sim/islandwright.test.ts` (add a case)

- [ ] **Step 1: Add the failing test**

```ts
import { PALMWOOD, FOLIAGE } from "./materials";

it("scatters palms (trunk + canopy) on the highland", () => {
  const { grid } = buildIsland({ seed: 3, radiusVox: 40, peakVox: 34, cliffiness: 0.4 });
  const counts: Record<number, number> = {};
  grid.forEachSolid((_x, _y, _z, m) => (counts[m] = (counts[m] ?? 0) + 1));
  expect(counts[PALMWOOD] ?? 0).toBeGreaterThan(0);
  expect(counts[FOLIAGE] ?? 0).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/sim/islandwright.test.ts`
Expected: FAIL — no palm voxels.

- [ ] **Step 3: Implement palms**

Add to `islandwright.ts` and call `scatterPalms(grid, o, hgt, waterlineY)` at the end of `buildIsland` (before `return`). Uses the seeded `Rng` so placement is deterministic.

```ts
import { Rng } from "../core/rng";

function scatterPalms(grid: VoxelGrid, o: IslandOpts, hgt: number[], waterlineY: number): void {
  const [nx, ny, nz] = grid.dims;
  const rng = new Rng(`palms-${o.seed}`);
  const count = Math.round(o.radiusVox / 6);
  for (let i = 0; i < count; i++) {
    const x = rng.int(2, nx - 2), z = rng.int(2, nz - 2);
    const topY = SEABED_Y + hgt[x + z * nx];
    if (hgt[x + z * nx] <= 0) continue;
    if (grid.get(x, topY, z) !== GRASS) continue;        // palms only on grass
    const trunk = rng.int(5, 9);
    for (let t = 1; t <= trunk && topY + t < ny; t++) grid.set(x, topY + t, z, PALMWOOD);
    const cy = topY + trunk;
    for (let dx = -2; dx <= 2; dx++)                      // a + shaped frond canopy
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 2) continue;
        const px = x + dx, pz = z + dz;
        if (px > 0 && px < nx && pz > 0 && pz < nz && cy < ny && grid.get(px, cy, pz) === EMPTY)
          grid.set(px, cy, pz, FOLIAGE);
      }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/sim/islandwright.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sim/islandwright.ts src/sim/islandwright.test.ts
git commit -m "feat(islands): scatter palm trees on the highland"
```

---

## Task 5: `buildHarborIsland` — dock + town

**Files:**
- Modify: `src/sim/islandwright.ts`
- Test: `src/sim/islandwright.test.ts` (add cases)

- [ ] **Step 1: Add the failing test**

```ts
import { buildHarborIsland } from "./islandwright";
import { PINE, OAK } from "./materials";

describe("buildHarborIsland", () => {
  it("adds a wooden dock above the waterline and exposes a dock anchor", () => {
    const { grid, meta } = buildHarborIsland({ seed: 5 });
    expect(meta.dock).not.toBeNull();
    let plankCount = 0;
    grid.forEachSolid((_x, y, _z, m) => {
      if (m === PINE && y > meta.waterlineY) plankCount++;
    });
    expect(plankCount).toBeGreaterThan(20); // a real pier, not a stub
  });
  it("places at least one building (walls of OAK/PINE above the beach)", () => {
    const { grid, meta } = buildHarborIsland({ seed: 5 });
    let walls = 0;
    grid.forEachSolid((_x, y, _z, m) => {
      if ((m === OAK || m === PINE) && y > meta.waterlineY + 2) walls++;
    });
    expect(walls).toBeGreaterThan(40);
  });
  it("is deterministic", () => {
    expect(buildHarborIsland({ seed: 5 }).grid.data).toEqual(buildHarborIsland({ seed: 5 }).grid.data);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/sim/islandwright.test.ts`
Expected: FAIL — `buildHarborIsland` not defined.

- [ ] **Step 3: Implement `buildHarborIsland`**

Builds a flatter island via `buildIsland`, then carves a flat harbor shelf, stamps a pier of `PINE` planks on `OAK` pylons reaching out over the water, and places a few voxel buildings. Returns the same `IslandModel` shape with `meta.dock` set.

```ts
import { OAK, PINE } from "./materials";

export function buildHarborIsland(opts: { seed: number }): IslandModel {
  // flatter + lower than a wild island so the town sits on gentle ground
  const model = buildIsland({ seed: opts.seed, radiusVox: 46, peakVox: 20, cliffiness: 0.25 });
  const { grid, meta } = model;
  const [nx, ny, nz] = grid.dims;
  const cx = Math.floor(nx / 2), cz = Math.floor(nz / 2);
  const shelfY = meta.waterlineY + 2; // town/dock deck level (a touch above the sea)

  // flatten a circular town shelf near the centre: clear above shelfY, fill to shelfY
  const townR = 16;
  for (let x = cx - townR; x <= cx + townR; x++)
    for (let z = cz - townR; z <= cz + townR; z++) {
      if (x < 1 || z < 1 || x >= nx - 1 || z >= nz - 1) continue;
      if ((x - cx) ** 2 + (z - cz) ** 2 > townR * townR) continue;
      for (let y = shelfY + 1; y < ny; y++) grid.remove(x, y, z);
      for (let y = SEABED_Y; y <= shelfY; y++)
        if (grid.get(x, y, z) === EMPTY) grid.set(x, y, z, y === shelfY ? DIRT : ROCK);
    }

  // pier: a plank run marching out +x from the shelf edge across the water on pylons
  const pierZ = cz;
  const pierStartX = cx + townR - 2;
  const pierLen = 26;
  for (let i = 0; i < pierLen; i++) {
    const x = pierStartX + i;
    if (x >= nx - 1) break;
    for (let dz = -1; dz <= 1; dz++) grid.set(x, shelfY, pierTz(pierZ, dz, nz), PINE); // deck (3 wide)
    if (i % 3 === 0)                                                                   // pylons every 3 m
      for (const dz of [-1, 1]) for (let y = SEABED_Y; y < shelfY; y++) grid.set(x, y, pierTz(pierZ, dz, nz), OAK);
  }
  meta.dock = { x: pierStartX + pierLen, y: shelfY, z: pierZ, bearing: 0 }; // +x end, faces +x

  // buildings: a few huts + a tavern around the shelf
  const rng = new Rng(`town-${opts.seed}`);
  const lots = [
    { x: cx - 8, z: cz - 7, w: 7, d: 6, h: 6 }, // tavern (bigger)
    { x: cx + 4, z: cz - 8, w: 5, d: 5, h: 5 },
    { x: cx - 9, z: cz + 5, w: 5, d: 5, h: 5 },
    { x: cx + 6, z: cz + 6, w: 5, d: 4, h: 4 }, // harbormaster's shack
  ];
  for (const lot of lots) stampBuilding(grid, lot, shelfY, rng);
  return model;
}

function pierTz(pierZ: number, dz: number, nz: number): number {
  return Math.min(Math.max(pierZ + dz, 0), nz - 1);
}

/** A hollow voxel hut: OAK corner posts + PINE walls, a doorway, a pitched roof. */
function stampBuilding(
  grid: VoxelGrid,
  lot: { x: number; z: number; w: number; d: number; h: number },
  floorY: number,
  rng: Rng,
): void {
  const { x: x0, z: z0, w, d, h } = lot;
  for (let dx = 0; dx < w; dx++)
    for (let dz = 0; dz < d; dz++)
      for (let dy = 1; dy <= h; dy++) {
        const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
        if (!edge) continue;
        const corner = (dx === 0 || dx === w - 1) && (dz === 0 || dz === d - 1);
        const isDoor = dz === 0 && dx === ((w / 2) | 0) && dy <= 2;
        const isWindow = !corner && dy === 3 && (dx + dz) % 2 === 0;
        if (isDoor || isWindow) continue;
        grid.set(x0 + dx, floorY + dy, z0 + dz, corner ? OAK : PINE);
      }
  // pitched roof: shrinking PINE rings stepping up toward the ridge
  for (let r = 0; r <= Math.ceil(Math.min(w, d) / 2); r++) {
    const ry = floorY + h + 1 + r;
    for (let dx = r; dx < w - r; dx++) for (let dz = r; dz < d - r; dz++)
      if (dx === r || dx === w - 1 - r || dz === r || dz === d - 1 - r)
        grid.set(x0 + dx, ry, z0 + dz, PINE);
  }
  void rng; // reserved for future per-building variation
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/sim/islandwright.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/sim/islandwright.ts src/sim/islandwright.test.ts
git commit -m "feat(islands): harbor island with voxel dock + town"
```

---

## Task 6: `meshGrid` — merge a whole grid to one geometry (pure)

**Files:**
- Modify: `src/render/voxelMesher.ts`
- Test: `src/render/voxelMesher.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { meshGrid } from "./voxelMesher";
import { createGrid } from "../sim/voxelGrid";
import { ROCK } from "../sim/materials";
import { VOXEL_SIZE } from "../core/constants";

describe("meshGrid", () => {
  it("meshes a single voxel into a closed box (24 verts, 12 tris)", () => {
    const g = createGrid(4, 4, 4);
    g.set(1, 1, 1, ROCK);
    const m = meshGrid(g);
    expect(m.positions.length / 3).toBe(24); // 6 faces × 4 verts
    expect(m.indices.length).toBe(36);       // 6 faces × 2 tris × 3
    for (let i = 0; i < m.positions.length; i++) {
      expect(m.positions[i]).toBeGreaterThanOrEqual(0);
      expect(m.positions[i]).toBeLessThanOrEqual(4 * VOXEL_SIZE);
    }
  });
  it("returns empty arrays for an empty grid", () => {
    const m = meshGrid(createGrid(2, 2, 2));
    expect(m.positions.length).toBe(0);
    expect(m.indices.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/render/voxelMesher.test.ts`
Expected: FAIL — `meshGrid` not exported.

- [ ] **Step 3: Implement `meshGrid`**

Append to `src/render/voxelMesher.ts`:

```ts
/** Mesh an ENTIRE grid into one merged geometry by concatenating every chunk's
 *  greedy mesh (re-basing indices). Pure; reused by islandVisual + the collider. */
export function meshGrid(grid: VoxelGrid): ChunkMesh {
  const [nx, ny, nz] = grid.dims;
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], indices: number[] = [];
  for (let cx = 0; cx <= Math.floor((nx - 1) / CHUNK_SIZE); cx++)
    for (let cy = 0; cy <= Math.floor((ny - 1) / CHUNK_SIZE); cy++)
      for (let cz = 0; cz <= Math.floor((nz - 1) / CHUNK_SIZE); cz++) {
        const m = meshChunk(grid, cx, cy, cz);
        if (!m) continue;
        const base = positions.length / 3;
        positions.push(...m.positions);
        normals.push(...m.normals);
        colors.push(...m.colors);
        for (let i = 0; i < m.indices.length; i++) indices.push(m.indices[i] + base);
      }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/render/voxelMesher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/render/voxelMesher.ts src/render/voxelMesher.test.ts
git commit -m "feat(islands): meshGrid — merge a whole voxel grid to one geometry"
```

---

## Task 7: Island placement planner (pure)

**Files:**
- Create: `src/game/islandField.ts` (planner + types; the scene/physics class follows in Task 9)
- Test: `src/game/islandField.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { planIslandPlacements } from "./islandField";

describe("planIslandPlacements", () => {
  const plan = planIslandPlacements("scuttle-dev");
  it("is deterministic for a seed", () => {
    expect(planIslandPlacements("scuttle-dev")).toEqual(plan);
  });
  it("always includes exactly one reachable harbor island", () => {
    const harbors = plan.filter((p) => p.kind === "harbor");
    expect(harbors).toHaveLength(1);
    const d = Math.hypot(harbors[0].x, harbors[0].z);
    expect(d).toBeGreaterThan(200);
    expect(d).toBeLessThan(450);
  });
  it("keeps a clear lagoon around spawn and no overlaps", () => {
    for (const p of plan) expect(Math.hypot(p.x, p.z)).toBeGreaterThan(120);
    for (let i = 0; i < plan.length; i++)
      for (let j = i + 1; j < plan.length; j++) {
        const d = Math.hypot(plan[i].x - plan[j].x, plan[i].z - plan[j].z);
        expect(d).toBeGreaterThan(plan[i].radiusM + plan[j].radiusM);
      }
  });
  it("places several wild islands", () => {
    expect(plan.filter((p) => p.kind === "wild").length).toBeGreaterThanOrEqual(5);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/game/islandField.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the planner**

```ts
import { Rng } from "../core/rng";
import { VOXEL_SIZE } from "../core/constants";

export const ISLAND_VOXEL_SCALE = 2; // terrain voxels render at 0.5 m (0.25 × 2)
const M_PER_VOX = VOXEL_SIZE * ISLAND_VOXEL_SCALE;

export interface IslandPlacement {
  kind: "harbor" | "wild";
  seed: number;
  x: number; z: number;     // world metres (spawn ≈ origin)
  radiusVox: number;
  radiusM: number;          // plan-view collision radius in metres (for spacing)
  peakVox: number;
  cliffiness: number;
}

const LAGOON_M = 120;       // clear water around spawn
const FIELD_M = 700;        // archipelago radius
const HARBOR_MIN = 240, HARBOR_MAX = 420;

export function planIslandPlacements(seed: string): IslandPlacement[] {
  const rng = new Rng(`islands-${seed}`);
  const out: IslandPlacement[] = [];

  // guaranteed harbor island at a deterministic bearing + reachable distance
  const ha = rng.range(0, Math.PI * 2);
  const hd = rng.range(HARBOR_MIN, HARBOR_MAX);
  const harborR = 46;
  out.push({
    kind: "harbor", seed: rng.int(1, 1e9),
    x: Math.cos(ha) * hd, z: Math.sin(ha) * hd,
    radiusVox: harborR, radiusM: harborR * M_PER_VOX, peakVox: 20, cliffiness: 0.25,
  });

  // scatter wild islands via rejection sampling (spacing + lagoon)
  const wanted = 7;
  let tries = 0;
  while (out.filter((p) => p.kind === "wild").length < wanted && tries < 400) {
    tries++;
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(LAGOON_M + 40, FIELD_M);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const radiusVox = rng.int(22, 52);
    const radiusM = radiusVox * M_PER_VOX;
    if (Math.hypot(x, z) < LAGOON_M + radiusM) continue;
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < p.radiusM + radiusM + 20)) continue;
    out.push({
      kind: "wild", seed: rng.int(1, 1e9), x, z,
      radiusVox, radiusM, peakVox: rng.int(24, 46), cliffiness: rng.range(0.2, 0.85),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/game/islandField.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/game/islandField.ts src/game/islandField.test.ts
git commit -m "feat(islands): deterministic archipelago placement planner"
```

---

## Task 8: `IslandVisual` — grid → scaled THREE group + collider data

**Files:**
- Create: `src/render/islandVisual.ts`

No vitest (constructs THREE objects; verified in-browser). Keep it small and correct.

- [ ] **Step 1: Implement**

```ts
import * as THREE from "three";
import { meshGrid } from "./voxelMesher";
import type { VoxelGrid } from "../sim/voxelGrid";

/** Static voxel terrain: one merged mesh under a scaled group at a world position.
 *  Exposes the (scaled) merged vertices/indices for a Rapier trimesh collider. */
export class IslandVisual {
  readonly group = new THREE.Group();
  readonly colliderVerts: Float32Array; // local metres, already × scale
  readonly colliderIndices: Uint32Array;

  constructor(grid: VoxelGrid, world: { x: number; y: number; z: number }, scale: number) {
    const mesh = meshGrid(grid);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
    this.group.position.set(world.x, world.y, world.z);
    this.group.scale.setScalar(scale);

    // collider geometry: same verts pre-scaled (Rapier body carries the translation)
    this.colliderVerts = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i++) this.colliderVerts[i] = mesh.positions[i] * scale;
    this.colliderIndices = mesh.indices;
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/render/islandVisual.ts
git commit -m "feat(islands): IslandVisual — scaled static terrain mesh + collider data"
```

---

## Task 9: `IslandField` — build, place, collide

**Files:**
- Modify: `src/game/islandField.ts` (add the `IslandField` class)

- [ ] **Step 1: Implement the class**

```ts
import * as THREE from "three";
import type { Physics } from "./physics";
import { buildHarborIsland, buildIsland, type IslandModel } from "../sim/islandwright";
import { IslandVisual } from "../render/islandVisual";

export interface IslandInstance {
  placement: IslandPlacement;
  model: IslandModel;
  visual: IslandVisual;
  dockWorld: THREE.Vector3 | null; // harbor dock anchor in world space (future docking hook)
}

export class IslandField {
  readonly islands: IslandInstance[] = [];

  constructor(seed: string, physics: Physics, scene: THREE.Scene) {
    const R = physics.RAPIER;
    for (const p of planIslandPlacements(seed)) {
      const model = p.kind === "harbor"
        ? buildHarborIsland({ seed: p.seed })
        : buildIsland({ seed: p.seed, radiusVox: p.radiusVox, peakVox: p.peakVox, cliffiness: p.cliffiness });

      // sit the grid so its waterline row lands at world y≈0
      const worldY = -model.meta.waterlineY * VOXEL_SIZE * ISLAND_VOXEL_SCALE;
      const visual = new IslandVisual(model.grid, { x: p.x, y: worldY, z: p.z }, ISLAND_VOXEL_SCALE);
      scene.add(visual.group);

      // static trimesh collider (default groups → collides with the ship hull cuboid)
      const body = physics.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(p.x, worldY, p.z),
      );
      if (visual.colliderIndices.length > 0)
        physics.world.createCollider(
          R.ColliderDesc.trimesh(visual.colliderVerts, visual.colliderIndices), body,
        );

      let dockWorld: THREE.Vector3 | null = null;
      if (model.meta.dock) {
        const d = model.meta.dock;
        dockWorld = new THREE.Vector3(
          p.x + d.x * VOXEL_SIZE * ISLAND_VOXEL_SCALE,
          worldY + d.y * VOXEL_SIZE * ISLAND_VOXEL_SCALE,
          p.z + d.z * VOXEL_SIZE * ISLAND_VOXEL_SCALE,
        );
      }
      this.islands.push({ placement: p, model, visual, dockWorld });
    }
  }

  /** Nearest harbor dock anchor to a world point (future docking interaction). */
  nearestDock(x: number, z: number): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null, bd = Infinity;
    for (const i of this.islands) {
      if (!i.dockWorld) continue;
      const d = Math.hypot(i.dockWorld.x - x, i.dockWorld.z - z);
      if (d < bd) { bd = d; best = i.dockWorld; }
    }
    return best;
  }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Add the `import { VOXEL_SIZE }` / `ISLAND_VOXEL_SCALE` already in-file.)

- [ ] **Step 3: Commit**

```bash
git add src/game/islandField.ts
git commit -m "feat(islands): IslandField — place islands, build static colliders"
```

---

## Task 10: Wire into `main.ts`

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Construct the field after physics init**

After `const world = new GameWorld(physics, waves, scene);` (≈ line 124), add:

```ts
  // ---- static voxel archipelago (game/islandField.ts) ----
  // seeded islands & cliffs with solid collision; one harbor island carries the
  // voxel dock + town. Built once, never remeshed; islands aren't in any ship
  // list so they never trip ship-vs-ship carving.
  const { IslandField } = await import("./game/islandField");
  const islands = new IslandField(seed, physics, scene);
```

- [ ] **Step 2: Expose on DEBUG**

In the `window.DEBUG` object (≈ line 559) add `islands,` to the property list.

- [ ] **Step 3: Type-check + build**

Run: `npx tsc --noEmit && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: all prior tests + the new island tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(islands): spawn the archipelago in the world"
```

---

## Task 11: In-browser verification (Playwright @ :5173)

**Files:** none (verification only). Screenshots land in the **projects ROOT** (`projects/<name>.png`).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (background). Confirm http://localhost:5173 serves.

- [ ] **Step 2: Archipelago renders**

Navigate Playwright to `:5173`. Via `DEBUG.islands.islands.length` confirm ≥ 6 islands. Lift the camera (or read positions) and screenshot the sea — expect visible islands/cliffs with beaches + green tops. Save `projects/islands-overview.png`.

- [ ] **Step 3: Town & dock**

Teleport the player ship near `DEBUG.islands.nearestDock(...)` (set `DEBUG.sloop.body.setTranslation`), point the camera at the harbor, screenshot `projects/islands-town.png`. Confirm the pier, buildings, and palms read correctly.

- [ ] **Step 4: Collision**

Drive the brig bow-first into a cliff (set linvel toward an island for ~2 s), then read `DEBUG.sloop.body.translation()` before/after — confirm it stops at the shore instead of passing through. Screenshot `projects/islands-collision.png`.

- [ ] **Step 5: Tune the palette/scale if needed**

If sand/rock/greens read wrong under the tonemap, adjust `MATERIALS` colors (Task 1) and/or `ISLAND_VOXEL_SCALE`; re-screenshot. Commit any tuning:

```bash
git add -A && git commit -m "tune(islands): palette/scale from in-browser review"
```

---

## Self-Review

**Spec coverage:**
- Terrain materials → Task 1 ✓
- Deterministic generator (heightfield, slope/elevation materials, cliffs) → Tasks 2–3 ✓
- Palms → Task 4 ✓
- Harbor island + dock + town + dock anchor meta → Task 5 ✓
- Whole-grid meshing → Task 6 ✓
- Seeded placement w/ guaranteed harbor + lagoon + no overlap → Task 7 ✓
- Scaled static visual + collider data → Task 8 ✓
- Placement→scene→physics, dock anchor in world space → Task 9 ✓
- main.ts integration + DEBUG → Task 10 ✓
- build/test/Playwright verification → Tasks 10–11 ✓

**Type consistency:** `IslandModel { grid, meta }`, `IslandMeta { waterlineY, radiusVox, peakVox, dock }`, `IslandPlacement { kind, seed, x, z, radiusVox, radiusM, peakVox, cliffiness }`, `IslandOpts { seed, radiusVox, peakVox, cliffiness }` are used consistently across Tasks 3/5/7/8/9. `meshGrid` returns the existing `ChunkMesh` type. `ISLAND_VOXEL_SCALE` defined once in `islandField.ts` and reused.

**Placeholders:** none — every code step is concrete. `stampBuilding`'s `rng` is intentionally reserved (`void rng`) for future variation; behavior is fully defined without it.

**Risks / watch items during execution:**
- Trimesh-vs-cuboid contact must actually fire — verify in Task 11 Step 4; if a fast hull tunnels through, enable CCD on the ship body or thicken the collider (note only, not expected at sail speeds).
- `meshGrid` on big harbor grids (≈100³) allocates large arrays via spread `push(...)`; if call-stack limits bite on huge geometries, switch the concat to a loop. Islands here stay well under that.
- Palette reads differently after ACESFilmic tonemapping — expect Task 11 Step 5 tuning.
