# SCUTTLE M1+M2 ("It Floats" + "It Sinks") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser demo where a procedurally generated voxel sloop sails a Gerstner-wave ocean, takes cannon fire that removes real voxels, floods compartment by compartment, lists, and sinks emergently.

**Architecture:** Pure, engine-free simulation modules (`src/sim/`) hold all the math — voxel grids, Gerstner waves, buoyancy, compartment flooding — and are unit-tested with vitest. Rendering (`src/render/`) and game orchestration (`src/game/`) consume them. Each ship is ONE Rapier dynamic rigid body; buoyancy/flood forces are applied at probe points; sinking is never scripted. The GLSL ocean vertex shader and the CPU wave function evaluate the same math from shared parameters.

**Tech Stack:** TypeScript, Vite, vitest, three (WebGLRenderer + GLSL; WebGPU/TSL deferred to a later milestone per spec fallback clause), `@dimforge/rapier3d-compat` (embedded WASM build).

**Plan scope note:** This plan covers spec milestones M1+M2 only. M3–M6 (AI duels, boarding/melee, roguelite run, launch) get their own plan documents once this one lands — each milestone is independently demo-able software per the spec.

**Execution note (autonomous overnight run):** User granted full autonomy and is asleep. Execution is INLINE (superpowers:executing-plans) rather than subagent-per-task: the systems here are tightly coupled (sim ↔ physics ↔ render), the reviewer between tasks would be the same agent anyway, and a single coherent context produces more consistent code for a 3D game core. Commit after every passing task. Renderer tasks that can't be unit-tested are verified by launching the dev server and taking Playwright screenshots.

---

## Constants (single source of truth — `src/core/constants.ts`)

```ts
export const G = 9.81;                  // m/s²
export const WATER_DENSITY = 1025;      // kg/m³ (seawater)
export const VOXEL_SIZE = 0.25;         // m per voxel cell (spec: 20–25cm, fine/non-Minecraft)
export const VOXEL_VOLUME = VOXEL_SIZE ** 3;
export const CHUNK_SIZE = 16;           // voxels per chunk edge (render/remesh granularity)
export const FIXED_DT = 1 / 60;         // physics step (s)
```

Material densities (kg/m³) live in `src/sim/materials.ts`: oak ≈ 700, deck pine ≈ 500, iron (cannon mounts, fittings) ≈ 7800. A wooden ship averages well under 1025 → floats; that emerges from per-voxel mass, never hand-tuned.

## File structure

```
scuttle/
  index.html              — canvas mount, dark sea-toned loading state
  package.json / tsconfig.json / vite.config.ts / vitest (in vite config)
  src/
    core/
      constants.ts        — physical constants above
      rng.ts              — mulberry32 seeded RNG (string-seed hash + float ranges)
    sim/                  — PURE. No three, no rapier imports. Fully unit-tested.
      materials.ts        — material table: id, density, color, strength
      gerstner.ts         — wave param gen from seed; CPU surface height via fixed-point
                            inversion of horizontal displacement; normal estimate
      voxelGrid.ts        — dense Int8 grid per ship: get/set/remove, bounds, iteration,
                            mass & center-of-mass aggregation, dirty-chunk tracking
      shipwright.ts       — procedural voxel hull generation (sloop): hull curves → shell,
                            decks, bulkheads, mast sockets; returns grid + metadata
      connectivity.ts     — flood-fill from keel; severed-island detection → island cell lists
      compartments.ts     — interior-air flood-fill partitioning; runtime flood state:
                            breach registry, Bernoulli inflow, inter-compartment flow,
                            per-compartment water volume/level
      buoyancy.ts         — probe generation from hull bottom surface; per-probe Archimedes
                            force w/ per-compartment flood scaling; drag/damping forces
      ballistics.ts       — cannonball kinematics (analytic arc), spherical damage application
    render/
      ocean.ts            — 512×512-segment displaced plane, GLSL Gerstner matching sim params,
                            depth-tinted color, specular sun, foam tint at crests
      sky.ts              — gradient sky dome, directional sun + hemisphere light, fog,
                            ACES tonemapping config
      voxelMesher.ts      — greedy meshing per 16³ chunk, per-face vertex AO, material colors
                            (no grid lines — realistic palette per spec aesthetic directive)
      shipVisual.ts       — binds a ship's grid → chunk meshes under one Group; mast/sail/
                            rigging quads; per-compartment interior water planes
      effects.ts          — cannon muzzle smoke, splash particles, wake foam sprites
    game/
      physics.ts          — rapier init (async), world, fixed-step accumulator
      ship.ts             — Ship entity: rapier body + grid + compartments + visual; applies
                            buoyancy/flood/sail forces each fixed step; damage entry point
      sailing.ts          — wind vector, sail-set fraction → thrust along heading, rudder yaw
                            torque, keel lateral resistance
      cannons.ts          — battery placement from shipwright metadata, aim/fire, projectile
                            pool, impact → ship.applyDamage
      player.ts           — input (WASD/QE sails+rudder, mouse orbit follow cam, F fire,
                            X cutaway toggle)
      debris.ts           — severed islands → short-lived rapier bodies + meshes
      world.ts            — owns scene, ships, loop wiring; spawn target ship
    main.ts               — boot: renderer, sky, ocean, world, RAF loop, resize
  tests/
    rng.test.ts  gerstner.test.ts  voxelGrid.test.ts  shipwright.test.ts
    connectivity.test.ts  compartments.test.ts  buoyancy.test.ts  ballistics.test.ts
```

Interface contracts referenced across tasks:

```ts
// voxelGrid.ts
export interface VoxelGrid {
  dims: [number, number, number];           // nx, ny, nz
  data: Int8Array;                          // material id, 0 = empty
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, mat: number): void;
  remove(x: number, y: number, z: number): boolean;
  isSolid(x: number, y: number, z: number): boolean;   // false out of bounds
  totalMass(): number;                       // Σ density(mat) · VOXEL_VOLUME
  centerOfMass(): [number, number, number]; // local voxel-space meters
  dirtyChunks: Set<string>;                  // "cx,cy,cz" needing remesh
}

// gerstner.ts
export interface WaveSet { waves: Wave[]; time: number }
export interface Wave { dirX: number; dirZ: number; amplitude: number; wavelength: number; steepness: number; phaseSpeed: number }
export function makeWaves(rng: Rng, count?: number): Wave[];
export function surfaceHeight(waves: Wave[], x: number, z: number, t: number): number; // world y of surface at horizontal (x,z)

// compartments.ts
export interface Compartment {
  id: number; cells: Set<number>;            // packed cell indices
  volume: number;                            // m³ capacity
  waterVolume: number;                       // m³ current
  centroid: [number, number, number];        // local meters
  openingsTo: Map<number, number>;           // neighbor compartment id → opening area m²
  breaches: Breach[];
}
export interface Breach { cell: [number, number, number]; area: number }

// buoyancy.ts
export interface Probe { local: [number, number, number]; volume: number; compartmentId: number | -1 }
export function makeProbes(grid: VoxelGrid, compartments: Compartment[]): Probe[];
export function probeForce(probe: Probe, worldY: number, surfaceY: number, floodFrac: number): number; // newtons up
```

---

### Task 0: Scaffold

**Files:** Create `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`, `src/core/constants.ts`, `.gitignore`

- [ ] **Step 0.1:** `npm create vite@latest . -- --template vanilla-ts` equivalent by hand (folder is non-empty: write files directly). Dependencies: `three`, `@dimforge/rapier3d-compat`; dev: `typescript`, `vite`, `vitest`, `@types/three`.
- [ ] **Step 0.2:** `npm install` — expect clean install.
- [ ] **Step 0.3:** `src/main.ts` renders a full-screen canvas cleared to deep-sea blue-black via three WebGLRenderer; `index.html` titled "SCUTTLE". `npx vite build` passes.
- [ ] **Step 0.4:** Add `vitest` config (`test` block in vite.config) + `npm test` script (`vitest run`); a trivial `tests/smoke.test.ts` (`expect(1+1).toBe(2)`) passes.
- [ ] **Step 0.5:** Commit `chore: scaffold vite+ts+three+rapier project`.

### Task 1: Seeded RNG (`src/core/rng.ts`) — TDD

- [ ] **Step 1.1:** Failing tests in `tests/rng.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { Rng } from "../src/core/rng";

describe("Rng", () => {
  it("same seed → same sequence", () => {
    const a = new Rng("voyage-1"), b = new Rng("voyage-1");
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it("different seeds diverge", () => {
    expect(new Rng("a").next()).not.toBe(new Rng("b").next());
  });
  it("range respects bounds", () => {
    const r = new Rng("x");
    for (let i = 0; i < 1000; i++) {
      const v = r.range(2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThan(5);
    }
  });
});
```

- [ ] **Step 1.2:** Run `npx vitest run tests/rng.test.ts` — FAIL (module not found).
- [ ] **Step 1.3:** Implement: xmur3 string hash → mulberry32. `next(): number` in [0,1), `range(min,max)`, `int(min,maxExcl)`, `pick<T>(arr)`.
- [ ] **Step 1.4:** Tests pass. **Step 1.5:** Commit `feat: seeded rng`.

### Task 2: Gerstner waves CPU (`src/sim/gerstner.ts`) — TDD

The single most load-bearing module: physics and visuals BOTH read these params. Gerstner displaces points horizontally, so "height at horizontal (x,z)" requires fixed-point inversion: start p=(x,z), iterate 3×: `p -= horizontalDisplacement(p) ; p += (target - displaced(p).xz)` — standard Crest-style approach, 3 iterations is plenty for game steepness.

- [ ] **Step 2.1:** Failing tests in `tests/gerstner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeWaves, surfaceHeight, surfaceNormal } from "../src/sim/gerstner";
import { Rng } from "../src/core/rng";

const waves = makeWaves(new Rng("sea"), 4);

describe("gerstner surface", () => {
  it("flat sea when amplitudes are zero", () => {
    const flat = waves.map(w => ({ ...w, amplitude: 0 }));
    expect(surfaceHeight(flat, 12.3, -7.7, 5)).toBeCloseTo(0, 6);
  });
  it("height stays within total amplitude bound", () => {
    const bound = waves.reduce((s, w) => s + w.amplitude, 0) + 1e-6;
    for (let i = 0; i < 200; i++) {
      const h = surfaceHeight(waves, i * 1.7, i * -2.3, i * 0.13);
      expect(Math.abs(h)).toBeLessThanOrEqual(bound);
    }
  });
  it("surface moves over time", () => {
    expect(surfaceHeight(waves, 5, 5, 0)).not.toBeCloseTo(surfaceHeight(waves, 5, 5, 2), 3);
  });
  it("deep-water dispersion: phaseSpeed = sqrt(g·λ/2π)", () => {
    for (const w of waves)
      expect(w.phaseSpeed).toBeCloseTo(Math.sqrt((9.81 * w.wavelength) / (2 * Math.PI)), 6);
  });
  it("inversion converges: sampled height matches forward-displaced point", () => {
    // forward-displace a grid point, then ask surfaceHeight at its displaced xz
    // implementation exposes displace(waves, x0, z0, t) for this test
  });
  it("normal points generally up", () => {
    const n = surfaceNormal(waves, 3, 9, 1);
    expect(n[1]).toBeGreaterThan(0.5);
  });
});
```

- [ ] **Step 2.2:** Run — FAIL. **Step 2.3:** Implement `makeWaves` (4 waves: wavelengths ~18–60 m log-spaced, amplitudes ~0.25–0.9 m scaled down with frequency, directions within ±50° of primary wind, steepness ≤ 0.8/(k·a·count)), `displace`, `surfaceHeight` (3-iteration inversion), `surfaceNormal` (central differences, eps 0.1). Complete the inversion test with real assertions while implementing. **Step 2.4:** Pass. **Step 2.5:** Commit `feat: gerstner wave math with invertible CPU sampling`.

### Task 3: Ocean + sky rendering (`src/render/ocean.ts`, `src/render/sky.ts`)

Visual task — verified by screenshot, not unit tests. The GLSL vertex shader takes the SAME wave params as uniforms (dir, amplitude, wavelength→k, steepness, phaseSpeed) and computes the forward Gerstner displacement; CPU inversion guarantees physics agreement.

- [ ] **Step 3.1:** `ocean.ts`: 600×600 m plane, 512² segments, custom ShaderMaterial. Vertex: sum Gerstner displacement + analytic normals. Fragment: deep/shallow water gradient (#04222e → #0a4a5c), sun specular (Blinn-Phong, sharp exponent), fresnel toward horizon sky color, crest foam factor from wave height + normal.y. `sky.ts`: large gradient dome (zenith #2e6e8e → horizon #cfe0d8 warm haze), DirectionalLight sun (warm, ~late-afternoon elevation for drama), HemisphereLight fill, exponential fog matched to horizon, `ACESFilmicToneMapping`, exposure ~1.1.
- [ ] **Step 3.2:** Wire into `main.ts` with a slow orbiting debug camera. Run dev server, Playwright screenshot at 1280×720.
- [ ] **Step 3.3:** Judge the screenshot against the spec bar ("premium water… wow in 30 seconds"). Iterate lighting/color until it genuinely looks good — this is the marketing surface, budget 2-3 iterations.
- [ ] **Step 3.4:** Commit `feat: gerstner ocean + sky/lighting pass`.

### Task 4: Voxel grid (`src/sim/voxelGrid.ts`) — TDD

- [ ] **Step 4.1:** Failing tests in `tests/voxelGrid.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { MATERIALS, OAK } from "../src/sim/materials";
import { VOXEL_VOLUME } from "../src/core/constants";

describe("VoxelGrid", () => {
  it("set/get/remove round-trip and out-of-bounds safety", () => {
    const g = createGrid(8, 8, 8);
    g.set(1, 2, 3, OAK);
    expect(g.get(1, 2, 3)).toBe(OAK);
    expect(g.isSolid(1, 2, 3)).toBe(true);
    expect(g.remove(1, 2, 3)).toBe(true);
    expect(g.isSolid(1, 2, 3)).toBe(false);
    expect(g.isSolid(-1, 0, 0)).toBe(false);   // no throw
    expect(g.get(99, 0, 0)).toBe(0);
  });
  it("mass = Σ density·volume", () => {
    const g = createGrid(4, 4, 4);
    g.set(0, 0, 0, OAK); g.set(1, 0, 0, OAK);
    expect(g.totalMass()).toBeCloseTo(2 * MATERIALS[OAK].density * VOXEL_VOLUME, 6);
  });
  it("center of mass of symmetric pair is midpoint", () => {
    const g = createGrid(4, 4, 4);
    g.set(0, 0, 0, OAK); g.set(2, 0, 0, OAK);
    expect(g.centerOfMass()[0]).toBeCloseTo(0.25 * 1.5, 6); // (0.5·(0+2)+0.5voxelcenter)·VOXEL_SIZE
  });
  it("mutations mark the containing 16³ chunk dirty", () => {
    const g = createGrid(40, 20, 40);
    g.set(17, 3, 33, OAK);
    expect(g.dirtyChunks.has("1,0,2")).toBe(true);
  });
});
```

- [ ] **Step 4.2:** FAIL. **Step 4.3:** Implement (`materials.ts` first: `EMPTY=0, OAK=1, PINE=2, IRON=3` with densities 700/500/7800 and base colors). **Step 4.4:** Pass. **Step 4.5:** Commit `feat: ship voxel grid with mass aggregation and dirty chunks`.

### Task 5: Procedural sloop (`src/sim/shipwright.ts`) — TDD

Hull from analytic curves: length 18 m (72 vox), beam 5 m (20 vox), depth 4 m (16 vox). Half-beam at station x: `beam/2 · sin(π·clamp(x/L)^0.8)` flared by deck height; keel rocker curve; 1-voxel oak shell (hull), pine deck at y=10 vox, two transverse oak bulkheads at 1/3 and 2/3 length → three watertight holds; deck hatches (2×2 openings) above each hold; mast socket positions + cannon port positions (4/side at deck level) in metadata.

- [ ] **Step 5.1:** Failing tests in `tests/shipwright.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSloop } from "../src/sim/shipwright";
import { findCompartments } from "../src/sim/compartments";
import { MATERIALS } from "../src/sim/materials";
import { WATER_DENSITY, VOXEL_VOLUME } from "../src/core/constants";

const ship = buildSloop();

describe("shipwright sloop", () => {
  it("is port/starboard symmetric", () => {
    const { grid } = ship;
    const [nx, ny, nz] = grid.dims;
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++)
      expect(grid.get(x, y, z)).toBe(grid.get(x, y, nz - 1 - z));
  });
  it("average density is below seawater (it will float)", () => {
    const { grid } = ship;
    // displaced volume if submerged to deck ≈ enclosed envelope volume
    const envelope = ship.envelopeVolume; // computed by shipwright: hull + enclosed air
    expect(grid.totalMass()).toBeLessThan(0.6 * envelope * WATER_DENSITY);
  });
  it("has exactly three watertight compartments", () => {
    expect(findCompartments(ship.grid, ship.deckY).length).toBe(3);
  });
  it("hull shell is watertight below deck (no leaks from interior to exterior)", () => {
    // flood-fill from a known interior cell must not reach the grid boundary
    expect(ship.interiorLeaks).toEqual([]);
  });
  it("metadata: 8 cannon ports, ≥1 mast, hatches over each hold", () => {
    expect(ship.cannonPorts.length).toBe(8);
    expect(ship.masts.length).toBeGreaterThanOrEqual(1);
    expect(ship.hatches.length).toBe(3);
  });
});
```

- [ ] **Step 5.2:** FAIL. **Step 5.3:** Implement `buildSloop()` AND the `findCompartments` detection it depends on (interior air flood-fill below deck, bounded by hull/bulkheads; openings = hatch cells recorded with areas). These co-develop; compartment FLOW dynamics stay in Task 8. **Step 5.4:** Pass. **Step 5.5:** Commit `feat: procedural voxel sloop with watertight compartments`.

### Task 6: Greedy mesher + ship visual (`src/render/voxelMesher.ts`, `src/render/shipVisual.ts`)

- [ ] **Step 6.1:** Unit-testable core in the mesher: face-culling (interior faces skipped). Test: a solid 2×2×2 block meshes to 24 quads max via greedy merge → exactly 6 merged quads; two diagonal cubes → 12 quads. Write tests, fail, implement greedy meshing per chunk with per-vertex AO (corner-occupancy darkening) and per-material vertex colors with subtle per-voxel value jitter (±4% luminance — weathered planking, not flat Minecraft faces).
- [ ] **Step 6.2:** `shipVisual.ts`: builds/refreshes one `Mesh` per dirty chunk under a ship-root `Group`; adds mast cylinders + sail (double-sided cloth quad, slight curve, wind-flutter vertex wobble) + bowsprit from metadata.
- [ ] **Step 6.3:** Render the sloop floating statically (no physics yet) in the ocean scene; screenshot; iterate palette/AO until it reads "weathered wooden ship", not "Minecraft boat" (spec aesthetic directive).
- [ ] **Step 6.4:** Commit `feat: greedy-meshed voxel ship rendering with AO`.

### Task 7: Physics + buoyancy (`src/game/physics.ts`, `src/sim/buoyancy.ts`, `src/game/ship.ts`) — TDD on the math

- [ ] **Step 7.1:** Failing tests in `tests/buoyancy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeProbes, probeForce, totalBuoyancy } from "../src/sim/buoyancy";
import { buildSloop } from "../src/sim/shipwright";
import { G, WATER_DENSITY } from "../src/core/constants";

describe("buoyancy", () => {
  it("probes partition the hull displaced volume (Σ probe volume ≈ envelope volume)", () => {
    const ship = buildSloop();
    const probes = makeProbes(ship.grid, ship.compartments);
    const v = probes.reduce((s, p) => s + p.volume, 0);
    expect(v).toBeCloseTo(ship.envelopeVolume, 1);
  });
  it("fully submerged unflooded ship: F = ρ·g·V upward", () => {
    const ship = buildSloop();
    const probes = makeProbes(ship.grid, ship.compartments);
    const F = totalBuoyancy(probes, () => 1e9 /* surface far above */, () => 0 /* no flood */);
    expect(F).toBeCloseTo(WATER_DENSITY * G * ship.envelopeVolume, -1);
  });
  it("probe above water contributes zero", () => {
    expect(probeForce({ local: [0,0,0], volume: 1, compartmentId: -1 }, 5, 2, 0)).toBe(0);
  });
  it("fully flooded compartment contributes ~zero buoyancy", () => {
    const F = probeForce({ local: [0,0,0], volume: 1, compartmentId: 0 }, -5, 0, 1);
    expect(F).toBeCloseTo(0, 4);
  });
  it("equilibrium: floating fraction equals density ratio (1D check)", () => {
    // mass m floats when submergedFraction = m / (ρ·V_envelope)
    const ship = buildSloop();
    const frac = ship.grid.totalMass() / (WATER_DENSITY * ship.envelopeVolume);
    expect(frac).toBeGreaterThan(0.15);
    expect(frac).toBeLessThan(0.6); // sits like a boat, not a cork or a brick
  });
});
```

- [ ] **Step 7.2:** FAIL. **Step 7.3:** Implement: probes = one per hull XZ column (coarsened 2×2 columns → ~40–60 probes for the sloop), each probe at the column's bottom face, volume = column's enclosed envelope volume share, compartment = whichever compartment the column passes through (or −1 for solid/outside-compartment volume). `probeForce`: submerged depth d = clamp(surfaceY − worldY, 0, columnHeight) → F = ρ·g·volume·(d/columnHeight)·(1 − floodFrac). **Step 7.4:** Pass. **Step 7.5:** `physics.ts` (async rapier-compat init, fixed-step accumulator) + `ship.ts`: dynamic rigid body (mass + COM from grid, cuboid-compound or convex-hull collider of hull bounds for now — ship/ship contact arrives in M3), each fixed step: per-probe world position → `surfaceHeight` → apply force at point; plus linear/angular water drag (−c·v scaled by submerged fraction; angular damping ~0.8) and a small keel-righting bias from low COM (emerges naturally — verify, don't fake). Spawn ship 2 m above water in `main.ts`: it must splash down, bob, and settle visibly stable. Screenshot sequence + console-log equilibrium draft vs predicted fraction (assert within 20%).
- [ ] **Step 7.6:** Commit `feat: probe buoyancy — the sloop floats`.

### Task 8: Sailing + camera (`src/game/sailing.ts`, `src/game/player.ts`)

- [ ] **Step 8.1:** Wind: constant world vector (seeded direction, ~6 m/s). Sail thrust = sailSet · windFactor(angle between heading & wind: 0 in irons ±30°, peak broad reach) · k, applied at mast base (heeling emerges). Rudder: yaw torque ∝ rudder angle · forwardSpeed. Keel: lateral velocity damping. W/S sails, A/D rudder, follow-orbit camera (mouse drag, wheel zoom).
- [ ] **Step 8.2:** Manual verify in dev server: sail a figure-eight; ship heels in turns, can't sail into irons, wake-side bobbing looks alive. Screenshot.
- [ ] **Step 8.3:** Commit `feat: wind sailing model + follow camera`.

### Task 9: Ballistics + cannons (`src/sim/ballistics.ts`, `src/game/cannons.ts`) — TDD on math

- [ ] **Step 9.1:** Failing tests in `tests/ballistics.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { simulateShot, sphereCells } from "../src/sim/ballistics";

describe("ballistics", () => {
  it("45° launch on flat earth lands at v²/g", () => {
    const v = 40;
    const { range } = simulateShot({ speed: v, elevationDeg: 45, drag: 0 });
    expect(range).toBeCloseTo(v * v / 9.81, 1);
  });
  it("drag shortens range", () => {
    const a = simulateShot({ speed: 40, elevationDeg: 45, drag: 0 });
    const b = simulateShot({ speed: 40, elevationDeg: 45, drag: 0.02 });
    expect(b.range).toBeLessThan(a.range);
  });
  it("sphereCells returns all cells within radius of impact", () => {
    const cells = sphereCells([10, 10, 10], 1.9);
    expect(cells).toContainEqual([10, 10, 10]);
    expect(cells).toContainEqual([11, 10, 10]);
    expect(cells).not.toContainEqual([12, 10, 10]);
  });
});
```

- [ ] **Step 9.2:** FAIL. **Step 9.3:** Implement (semi-implicit Euler integration for shots with quadratic drag; `sphereCells` in voxel coordinates). **Step 9.4:** Pass. **Step 9.5:** `cannons.ts`: cannons at metadata ports (simple dark cylinders M2; Kenney models later), broadside aim mode (hold RMB: trajectory preview arc using `simulateShot` samples), fire on F with stagger (80–150 ms between barrels), projectile pool integrated by the same math, muzzle smoke + water splash effects in `effects.ts`. Impact detection: ray/step against target ship grid in local space → `ship.applyDamage(cell, radius≈1.5 vox)`. A stationary practice hulk (second sloop, anchored) spawns 80 m off. Manual verify: arcs feel right, splashes on miss. Commit `feat: cannons and ballistics`.

### Task 10: Damage → connectivity → debris (`src/sim/connectivity.ts`, `src/game/debris.ts`) — TDD

- [ ] **Step 10.1:** Failing tests in `tests/connectivity.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { findSevered } from "../src/sim/connectivity";
import { OAK } from "../src/sim/materials";

describe("connectivity", () => {
  it("intact bar has no severed islands", () => {
    const g = createGrid(10, 3, 3);
    for (let x = 0; x < 10; x++) g.set(x, 0, 0, OAK);
    expect(findSevered(g, [0, 0, 0])).toEqual([]);
  });
  it("cutting a bar yields one island with the far cells", () => {
    const g = createGrid(10, 3, 3);
    for (let x = 0; x < 10; x++) g.set(x, 0, 0, OAK);
    g.remove(5, 0, 0);
    const islands = findSevered(g, [0, 0, 0]);   // keel anchor at x=0
    expect(islands.length).toBe(1);
    expect(islands[0].cells.length).toBe(4);      // x=6..9
  });
});
```

- [ ] **Step 10.2:** FAIL. **Step 10.3:** Implement `findSevered(grid, keelAnchor)`: BFS from anchor over solid 6-neighbors; solid cells not reached = islands (grouped by their own BFS). **Step 10.4:** Pass. **Step 10.5:** Wire `ship.applyDamage`: remove cells → dirty-chunk remesh → `findSevered` → islands removed from grid and handed to `debris.ts` (per-island: small dynamic rapier cuboid body sized to island bounds + its own greedy mesh; sinks or floats by island avg density; despawn after 30 s). Recompute body mass/COM from grid (rapier `setAdditionalMass`/recreate mass props). Manual verify: shoot the hulk's bow clean off; it falls as debris. Screenshot. Commit `feat: voxel damage with severed-island debris`.

### Task 11: Flooding (`src/sim/compartments.ts` runtime) — TDD

- [ ] **Step 11.1:** Failing tests in `tests/compartments.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { floodStep, breachInflow } from "../src/sim/compartments";

describe("flooding", () => {
  it("Bernoulli inflow: deeper breach floods faster", () => {
    expect(breachInflow(0.1, 3)).toBeGreaterThan(breachInflow(0.1, 1)); // (area m², depth m)
  });
  it("breach above the waterline admits nothing", () => {
    expect(breachInflow(0.1, -0.5)).toBe(0);
  });
  it("compartment never exceeds capacity", () => {
    const c = { volume: 10, waterVolume: 9.99, breaches: [{ area: 1, depth: 5 }] } as any;
    floodStep([c], [], 1.0);
    expect(c.waterVolume).toBeLessThanOrEqual(10);
  });
  it("water equalizes through an opening between connected compartments", () => {
    const a = { id: 0, volume: 10, waterVolume: 8, breaches: [] } as any;
    const b = { id: 1, volume: 10, waterVolume: 0, breaches: [] } as any;
    const opening = { a: 0, b: 1, area: 0.5, sillHeight: 0 };
    for (let i = 0; i < 600; i++) floodStep([a, b], [opening], 1 / 60);
    expect(a.waterVolume).toBeCloseTo(b.waterVolume, 0);
  });
  it("a sealed compartment with no breach stays dry", () => {
    const c = { volume: 10, waterVolume: 0, breaches: [] } as any;
    floodStep([c], [], 1.0);
    expect(c.waterVolume).toBe(0);
  });
});
```

- [ ] **Step 11.2:** FAIL. **Step 11.3:** Implement: `breachInflow(area, depth) = depth > 0 ? Cd·area·√(2·G·depth) : 0` (Cd ≈ 0.6); `floodStep` integrates inflows, then inter-compartment flow ∝ level difference above sill through opening area, clamped to capacity. Per-frame breach depth = surfaceHeight(world breach pos) − breachWorldY computed in ship.ts and passed in. Breach registry: when `applyDamage` removes a hull-shell cell adjacent to a compartment, register a breach (area = exposed face area · cells removed) on that compartment. **Step 11.4:** Pass. **Step 11.5:** Couple to physics in `ship.ts`: flooded water weight = `waterVolume·ρ·g` applied downward AT the compartment centroid (listing emerges); probe flood scaling from compartment fill fraction. Interior water render: translucent plane per compartment at current level, clipped to hull interior bounds, only visible through breaches/hatches — cheap and legible. **Step 11.6:** THE DEMO: broadside the hulk at the waterline until it floods, lists, and goes down by whichever end you holed. Confirm: no scripted motion anywhere — comment-audit `ship.ts`. Screenshots + a short capture. Commit `feat: compartment flooding — ships sink emergently`.

### Task 12: Cutaway view + polish pass

- [ ] **Step 12.1:** X toggles cutaway: clipping plane at ship midline (camera side), compartment water planes + flood % labels (HTML overlay positioned via projection) become visible, hull rendered with `clippingPlanes` + darkened cut faces. Spec: legibility is a core feature.
- [ ] **Step 12.2:** Effects pass: bow wake foam sprites, breach splash jets (scaled by inflow rate), floating debris splinters on hits, cannonball whistle + boom + splash audio stubs (Web Audio oscillator/noise placeholders; real CC0 SFX in M6).
- [ ] **Step 12.3:** Perf check vs spec budget: stats.js frame time during two-ship engagement with active flooding at 1280×720 — log result; if > 16.6 ms on this machine, profile and fix the top offender (likely remesh batching or ocean segment count).
- [ ] **Step 12.4:** Commit `feat: cutaway damage view + effects pass`. Tag `m2-it-sinks`.

### Task 13 (M1 spec item, sequenced last deliberately): character-on-deck spike

De-risks M4 per spec. A capsule kinematic body parented to the ship frame: WASD moves in deck-local space, world gravity projected onto deck plane (listing deck = slope), simple step/edge handling, jump. No combat, no model — a capsule that stays planted while the ship rolls, pitches, heels, and sinks under it.

- [ ] **Step 13.1:** Implement `src/game/character.ts` spike behind a `?spike=char` URL flag.
- [ ] **Step 13.2:** Manual verify: walk the deck while turning hard in waves; stand on the bow as it floods and goes under — capsule slides downhill when list exceeds ~25°. Document findings (what's solid, what's janky, M4 implications) in `docs/superpowers/notes/char-spike.md`.
- [ ] **Step 13.3:** Commit `spike: character controller on moving listing deck`.

---

## Self-review (run after writing, fixed inline)

1. **Spec coverage (M1+M2):** ocean ✓(T2,T3) sloop ✓(T5,T6) buoyancy ✓(T7) sailing ✓(T8) lighting ✓(T3) char spike ✓(T13) cannonballs ✓(T9) voxel destruction ✓(T10) flooding ✓(T11) listing/capsize emergent ✓(T7+T11 coupling) debris ✓(T10) cutaway ✓(T12). Deferred per scope note: AI ships (M3), boarding/melee (M4), run structure (M5), leaderboard (M5), real audio (M6). WebGPU upgrade deferred — documented decision.
2. **Placeholder scan:** none found; audio explicitly stubbed with real implementation noted for M6 scope (allowed: it's a scope boundary, not a hand-wave).
3. **Type consistency:** `surfaceHeight(waves,x,z,t)` signature consistent across T2/T7/T11; `Compartment.waterVolume`/`volume` consistent T5/T7/T11; `applyDamage(cell, radius)` consistent T9/T10/T11; `findSevered(grid, anchor)` consistent T10. `breachInflow(area, depth)` test signature matches impl note. Fixed during review: probe test in T7 originally referenced `ship.compartments` before T5 established it — T5 now explicitly exports compartments on the ship build result.
