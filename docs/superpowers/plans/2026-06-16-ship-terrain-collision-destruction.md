# Ship↔Terrain Collision Destruction + Hazards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make ramming land destroy the *ship* (not the land) by feeding the existing voxel crush a new kind of hull B — terrain: infinitely heavy, zero velocity, never carved — and add cliffier coasts + sea stacks to weave around.

**Architecture:** Terrain becomes "hull B" in the deformable crush (`game/voxelContact.ts`). The B side of the contact rule is abstracted behind a `ContactTarget` interface that `Ship` implements (ship↔ship unchanged) and a new `IslandTarget` adapter implements for static terrain. Ship↔terrain pairs are pulled out of Rapier's rigid solver (`game/physics.ts`) so the hull interpenetrates and the crush owns the response. Sea stacks reuse the island voxel/visual/physics path.

**Tech Stack:** TypeScript, Three.js, Rapier3D (compat), Vite, Vitest (deterministic sim oracle).

**Spec:** `docs/superpowers/specs/2026-06-16-ship-terrain-collision-destruction-design.md`

**Branch:** `worktree-man-o-war` (already a worktree — work here, do not switch branches).

---

## File Structure

- `src/sim/voxelOverlap.ts` — MODIFY. `detectContacts` gains an optional `voxelSizeB` so hull A (ship, 0.25 m) and hull B (terrain, 1 m) can have different cell sizes. Backward compatible.
- `src/game/voxelContact.ts` — MODIFY. Export a `ContactTarget` interface (the B side). Refactor the per-pair rule into a public, interface-driven `resolveContact(a, b, dt)`. `stepAll` gains a ship↔terrain pass.
- `src/game/islandTarget.ts` — CREATE. `IslandTarget implements ContactTarget`: occupancy-only, infinite mass, zero velocity, never carved.
- `src/game/ship.ts` — MODIFY. `Ship implements ContactTarget` (thin pass-throughs) so it is a first-class participant in the one contact rule.
- `src/game/physics.ts` — MODIFY. Add `terrainBodies` and pull ship↔terrain out of the rigid solver.
- `src/game/islandField.ts` — MODIFY. Register each terrain body, build `IslandTarget`s, scatter sea-stack hazards.
- `src/game/world.ts` — MODIFY. Hold `terrain: ContactTarget[]` and pass it to `stepAll`.
- `src/main.ts` — MODIFY. Wire `world.terrain = islands.contactTargets`.
- `src/sim/islandwright.ts` — MODIFY. Cliffier coasts (tuning) + `buildSeaStack`.
- `src/core/tunables.ts` — MODIFY. Add `TUN.hazard.seaStacks`.
- Tests: `tests/voxelOverlap.test.ts` (+1 case), `tests/islandTarget.test.ts` (new), `tests/voxelContact.test.ts` (new), `tests/islandwright.test.ts` (+sea-stack cases), `tests/islandField.test.ts` (+planHazards cases).

---

## Task 1: Generalize `detectContacts` for a second voxel size

**Files:**
- Modify: `src/sim/voxelOverlap.ts`
- Test: `tests/voxelOverlap.test.ts`

- [ ] **Step 1: Write the failing test**

Add this case inside the `describe("detectContacts", …)` block in `tests/voxelOverlap.test.ts` (after the existing `buffer` test):

```ts
  it("mismatched voxel sizes: a fine hull A overlapping a coarse hull B finds the contacts", () => {
    // B: a 2^3 block at voxel size 2 -> world extent [0,4)^3
    const b = block(2, [0, 0, 0], ID);
    // A: a 4^3 block at voxel size 1, shifted so only A's x=0 layer (centre 3.5) lands inside B
    const a = block(4, [3, 0, 0], ID); // A world x [3,7)
    const s = scratch(64);
    const r = detectContacts(a, b, 1, 0, s, 2); // vsA=1, vsB=2
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16); // A's x=0 face layer, 4x4 in y,z
    for (let i = 0; i < r!.count; i++) {
      expect(aCell(s, i)[0]).toBe(0); // A's leading (-x) layer into B
      expect(bCell(s, i)[0]).toBe(1); // world 3.5 -> B-local floor(3.5/2) = 1
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/voxelOverlap.test.ts -t "mismatched voxel sizes"`
Expected: FAIL — `detectContacts` ignores the 6th arg, so B-local uses `vs=1` and the cells/counts are wrong (or it throws on the extra arg under strict types only at build; at runtime the contacts won't match).

- [ ] **Step 3: Add the `voxelSizeB` parameter and use it for all B-side geometry**

In `src/sim/voxelOverlap.ts`, change the `detectContacts` signature and the B-side uses. Replace the signature line:

```ts
export function detectContacts(
  a: HullView,
  b: HullView,
  voxelSize: number,
  buffer: number,
  scratch: ContactScratch,
): ContactResult | null {
  const vs = voxelSize;
```

with:

```ts
export function detectContacts(
  a: HullView,
  b: HullView,
  voxelSize: number,
  buffer: number,
  scratch: ContactScratch,
  voxelSizeB: number = voxelSize, // B's cell size (terrain is 4x the ship's); defaults to A's for ship-ship
): ContactResult | null {
  const vs = voxelSize;   // A (the hull whose surface cells we walk)
  const vsB = voxelSizeB; // B (occupancy lookup target)
```

Then update the four B-side uses:

1. B's AABB — change `worldAabb(b, vs, _bMin, _bMax);` to:
```ts
  worldAabb(b, vsB, _bMin, _bMax);
```
2. The pad — change `const pad = buffer * vs;` to:
```ts
  const pad = buffer * vsB;
```
3. The world→B-local conversion — change `const ux = _blocal[0] / vs, uy = _blocal[1] / vs, uz = _blocal[2] / vs;` to:
```ts
    const ux = _blocal[0] / vsB, uy = _blocal[1] / vsB, uz = _blocal[2] / vsB;
```
4. B's centre (for the signed axis) — change `qRot(b.quat[0], b.quat[1], b.quat[2], b.quat[3], (b.dims[0] * vs) / 2, (b.dims[1] * vs) / 2, (b.dims[2] * vs) / 2, _bc);` to:
```ts
  qRot(b.quat[0], b.quat[1], b.quat[2], b.quat[3], (b.dims[0] * vsB) / 2, (b.dims[1] * vsB) / 2, (b.dims[2] * vsB) / 2, _bc);
```

Leave the A-cell-centre projection (`(ax + 0.5) * vs`, etc.) and the depth `+ vs` term on `vs` — those measure A's contact box.

- [ ] **Step 4: Run tests to verify they pass (new + the equal-size regressions)**

Run: `npx vitest run tests/voxelOverlap.test.ts`
Expected: PASS — the new mismatched-size case AND every existing equal-size case (they call the 5-arg form, so `voxelSizeB` defaults to `voxelSize`).

- [ ] **Step 5: Commit**

```bash
git add src/sim/voxelOverlap.ts tests/voxelOverlap.test.ts
git commit -m "feat(overlap): detectContacts supports a second (B) voxel size

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `ContactTarget` interface + `IslandTarget` adapter

The `ContactTarget` interface is declared in `voxelContact.ts` (Task 4 consumes it; declaring it here lets `IslandTarget` and the test compile first). `IslandTarget` is terrain as hull B.

**Files:**
- Modify: `src/game/voxelContact.ts` (add the exported interface only)
- Create: `src/game/islandTarget.ts`
- Test: `tests/islandTarget.test.ts`

- [ ] **Step 1: Declare the `ContactTarget` interface**

In `src/game/voxelContact.ts`, add this exported interface just below the existing imports (above `export interface ContactDebug`). It describes the **B side** of a contact (everything the rule reads/mutates on the other body):

```ts
/**
 * The "other body" (hull B) in a deformable contact. A ship implements this as a thin pass-through
 * (ship-vs-ship is unchanged); IslandTarget implements it for static terrain (infinite mass, zero
 * velocity, never carved). The contact rule (resolveContact) is written entirely against this
 * interface, so terrain is just another hull — THE LAW invariant #4, one destruction rule.
 */
export interface ContactTarget {
  /** This body's voxel cell size in metres (ship 0.25, terrain 1.0). */
  readonly voxelSize: number;
  /** False for indestructible terrain — its voxels are never carved. */
  readonly canCarve: boolean;
  /** Fill a HullView for overlap detection. Surface is only walked when this body is hull A. */
  fillHullView(hv: HullView): void;
  /** World AABB of this body's voxel envelope, written into out (broad-phase cull). */
  aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }): void;
  /** World centre (closing direction + point velocity), into out. */
  comWorld(out: THREE.Vector3): THREE.Vector3;
  linvel(): { x: number; y: number; z: number };
  angvel(): { x: number; y: number; z: number };
  /** Effective mass (kg); terrain reports a huge value so it acts immovable. */
  mass(): number;
  /** Joules to break the local cell (only called when canCarve). */
  cellBreakEnergy(x: number, y: number, z: number): number;
  /** Remove local cells; returns count removed (only called when canCarve). */
  carveCells(cells: [number, number, number][]): number;
  /** Apply a world impulse at a world point (no-op for immovable terrain). */
  applyImpulseAtPoint(impulse: THREE.Vector3, point: { x: number; y: number; z: number }): void;
  /** Current world translation (for de-penetration). */
  translation(): { x: number; y: number; z: number };
  /** Set world translation (no-op for immovable terrain). */
  setTranslation(t: { x: number; y: number; z: number }): void;
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/islandTarget.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createGrid } from "../src/sim/voxelGrid";
import { ROCK } from "../src/sim/materials";
import { IslandTarget } from "../src/game/islandTarget";

describe("IslandTarget — terrain as an immovable, indestructible hull", () => {
  function rockBlock() {
    const grid = createGrid(4, 4, 4);
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) grid.set(x, y, z, ROCK);
    return grid;
  }

  it("is indestructible: canCarve is false and carveCells is a no-op", () => {
    const grid = rockBlock();
    const t = new IslandTarget(grid, { x: 10, y: -3, z: 20 }, 1);
    expect(t.canCarve).toBe(false);
    expect(t.carveCells([[0, 0, 0], [1, 1, 1]])).toBe(0);
    expect(grid.isSolid(0, 0, 0)).toBe(true); // grid untouched
  });

  it("is immovable: zero velocity, and setTranslation / applyImpulseAtPoint do nothing", () => {
    const t = new IslandTarget(rockBlock(), { x: 10, y: -3, z: 20 }, 1);
    expect(t.linvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(t.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    const before = { ...t.translation() };
    t.setTranslation({ x: 999, y: 999, z: 999 });
    t.applyImpulseAtPoint(new THREE.Vector3(1, 1, 1), { x: 0, y: 0, z: 0 });
    expect(t.translation()).toEqual(before); // never moved
  });

  it("reports its voxel size, a world centre, and an AABB from the grid envelope", () => {
    const t = new IslandTarget(rockBlock(), { x: 10, y: -3, z: 20 }, 1);
    expect(t.voxelSize).toBe(1);
    const c = t.comWorld(new THREE.Vector3());
    expect(c.x).toBeCloseTo(12, 9); // 10 + 4*1/2
    expect(c.y).toBeCloseTo(-1, 9); // -3 + 4*1/2
    const box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    t.aabbWorld(box);
    expect(box.min.toArray()).toEqual([10, -3, 20]);
    expect(box.max.toArray()).toEqual([14, 1, 24]);
  });

  it("reports an effectively-infinite mass", () => {
    const t = new IslandTarget(rockBlock(), { x: 0, y: 0, z: 0 }, 1);
    expect(t.mass()).toBeGreaterThan(1e10);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/islandTarget.test.ts`
Expected: FAIL — `Cannot find module '../src/game/islandTarget'`.

- [ ] **Step 4: Create `IslandTarget`**

Create `src/game/islandTarget.ts`:

```ts
import * as THREE from "three";
import type { VoxelGrid } from "../sim/voxelGrid";
import type { HullView } from "../sim/voxelOverlap";
import type { ContactTarget } from "./voxelContact";

/** Effectively-infinite mass so terrain is immovable in the crush — huge but FINITE, so the
 *  reduced-mass / impulse arithmetic stays away from Infinity·0 = NaN. Ships are ~1e4–1e6 kg. */
const TERRAIN_MASS = 1e12;
const ZERO = { x: 0, y: 0, z: 0 } as const;
const EMPTY_SURFACE = new Int32Array(0);

/**
 * A piece of static voxel terrain (island, cliff, sea stack) presented to the deformable crush
 * (game/voxelContact.ts) as hull B: occupancy only, infinite mass, zero velocity, NEVER carved.
 * The crush then erodes the SHIP against it and leaves the rock untouched — "an infinitely heavy,
 * infinitely durable hull" (THE LAW invariant #4: one destruction rule for everything).
 *
 * Pure data + grid (no Rapier dependency): terrain is always hull B, so its surface is never
 * walked and its body is never touched by the contact response.
 */
export class IslandTarget implements ContactTarget {
  readonly canCarve = false;
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;

  constructor(
    private readonly grid: VoxelGrid,
    /** World position of the grid's local (0,0,0) corner. */
    private readonly pos: { x: number; y: number; z: number },
    readonly voxelSize: number,
  ) {
    const [nx, ny, nz] = grid.dims;
    this.cx = pos.x + (nx * voxelSize) / 2;
    this.cy = pos.y + (ny * voxelSize) / 2;
    this.cz = pos.z + (nz * voxelSize) / 2;
  }

  fillHullView(hv: HullView): void {
    hv.surface = EMPTY_SURFACE; // terrain is only ever hull B → its surface is never walked
    const grid = this.grid;
    hv.isSolid = (x, y, z) => grid.isSolid(x, y, z);
    hv.dims = grid.dims;
    hv.pos[0] = this.pos.x; hv.pos[1] = this.pos.y; hv.pos[2] = this.pos.z;
    hv.quat[0] = 0; hv.quat[1] = 0; hv.quat[2] = 0; hv.quat[3] = 1; // islands never rotate
  }

  aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }): void {
    const [nx, ny, nz] = this.grid.dims;
    const vs = this.voxelSize;
    out.min.set(this.pos.x, this.pos.y, this.pos.z);
    out.max.set(this.pos.x + nx * vs, this.pos.y + ny * vs, this.pos.z + nz * vs);
  }

  comWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.cx, this.cy, this.cz);
  }

  linvel() { return ZERO; }
  angvel() { return ZERO; }
  mass() { return TERRAIN_MASS; }
  cellBreakEnergy(): number { return 0; } // never called (canCarve === false)
  carveCells(): number { return 0; }      // indestructible — no-op
  applyImpulseAtPoint(): void { /* immovable — no-op */ }
  translation() { return this.pos; }
  setTranslation(): void { /* immovable — no-op */ }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/islandTarget.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add src/game/voxelContact.ts src/game/islandTarget.ts tests/islandTarget.test.ts
git commit -m "feat(contact): ContactTarget interface + IslandTarget (terrain as immovable hull B)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `Ship` implements `ContactTarget`

Make `Ship` a first-class contact body so the unified rule (Task 4) runs ship↔ship through the same interface with byte-identical math.

**Files:**
- Modify: `src/game/ship.ts`

- [ ] **Step 1: Add the imports**

In `src/game/ship.ts`, add to the existing imports:

```ts
import type { HullView } from "../sim/voxelOverlap";
import type { ContactTarget } from "./voxelContact";
```

(`breakEnergy` is already imported from `../sim/materials`.)

- [ ] **Step 2: Declare the interface on the class**

Change the class declaration line from:

```ts
export class Ship {
```

to:

```ts
export class Ship implements ContactTarget {
```

- [ ] **Step 3: Add the ContactTarget members**

Insert this block into the `Ship` class (e.g. just above `expectedSubmergedFrac()` near the end). These are thin pass-throughs to the body/grid that `Ship` already owns:

```ts
  // ---- ContactTarget (game/voxelContact.ts B-side): Ship is a full participant in the one
  //      deformable-contact rule. carveCells() and aabbWorld() already exist above. ----
  readonly voxelSize = VOXEL_SIZE;
  readonly canCarve = true;

  fillHullView(hv: HullView): void {
    hv.surface = this.surfaceCells();
    const grid = this.build.grid;
    hv.isSolid = (x, y, z) => grid.isSolid(x, y, z);
    hv.dims = grid.dims;
    const tr = this.body.translation();
    hv.pos[0] = tr.x; hv.pos[1] = tr.y; hv.pos[2] = tr.z;
    const rot = this.body.rotation();
    hv.quat[0] = rot.x; hv.quat[1] = rot.y; hv.quat[2] = rot.z; hv.quat[3] = rot.w;
  }

  comWorld(out: THREE.Vector3): THREE.Vector3 {
    return this.localToWorld(this.comLocal, out);
  }

  linvel(): { x: number; y: number; z: number } { return this.body.linvel(); }
  angvel(): { x: number; y: number; z: number } { return this.body.angvel(); }
  mass(): number { return this.body.mass(); }
  cellBreakEnergy(x: number, y: number, z: number): number { return breakEnergy(this.build.grid.get(x, y, z)); }
  applyImpulseAtPoint(impulse: THREE.Vector3, point: { x: number; y: number; z: number }): void {
    this.body.applyImpulseAtPoint(impulse, point, true);
  }
  translation(): { x: number; y: number; z: number } { return this.body.translation(); }
  setTranslation(t: { x: number; y: number; z: number }): void { this.body.setTranslation(t, true); }
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: PASS (`tsc --noEmit` clean, then the vite build). If `tsc` reports a missing member, the interface in Task 2 and this block must match exactly (compare names/signatures). Note: this build also exercises Task 4 once it lands; at this point `voxelContact.ts` still has its old `stepPair`, which is fine — `Ship` satisfying the interface does not depend on Task 4.

- [ ] **Step 5: Run the test suite (no regressions)**

Run: `npm run test`
Expected: PASS (unchanged behavior; this task only adds members).

- [ ] **Step 6: Commit**

```bash
git add src/game/ship.ts
git commit -m "feat(ship): Ship implements ContactTarget (B-side pass-throughs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Unify the contact rule on `ContactTarget` + add the terrain pass

Refactor `voxelContact.ts` so the per-pair rule is a public, interface-driven `resolveContact(a, b, dt)`. `stepPair` becomes a thin ship↔ship selector; `stepAll` gains a ship↔terrain loop. Ship↔ship math is unchanged (the interface methods are exact pass-throughs).

**Files:**
- Modify: `src/game/voxelContact.ts`
- Test: `tests/voxelContact.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/voxelContact.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { VoxelContact, type ContactTarget } from "../src/game/voxelContact";
import { createGrid, type VoxelGrid } from "../src/sim/voxelGrid";
import { computeSurface, unpackCell } from "../src/sim/surfaceSet";
import { breakEnergy, OAK, ROCK } from "../src/sim/materials";
import type { HullView } from "../src/sim/voxelOverlap";

function surfaceArray(grid: VoxelGrid): Int32Array {
  const set = computeSurface(grid);
  const [nx, ny] = grid.dims;
  const out = new Int32Array(set.size * 3);
  let i = 0;
  for (const k of set) { const [x, y, z] = unpackCell(k, nx, ny); out[i++] = x; out[i++] = y; out[i++] = z; }
  return out;
}

function solidBlock(n: number, mat: number): VoxelGrid {
  const g = createGrid(n, n, n);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g.set(x, y, z, mat);
  return g;
}

/** A test ContactTarget backed by a grid + explicit pose/velocity/mass. Records carve, impulse,
 *  and translation calls so a test can assert what the contact rule did to each side. */
class FakeTarget implements ContactTarget {
  removed: [number, number, number][] = [];
  impulses: { imp: THREE.Vector3; pt: { x: number; y: number; z: number } }[] = [];
  moved: { x: number; y: number; z: number }[] = [];
  constructor(
    public grid: VoxelGrid,
    public pos: { x: number; y: number; z: number },
    public vel: { x: number; y: number; z: number },
    public m: number,
    public canCarve: boolean,
    public voxelSize = 1,
  ) {}
  fillHullView(hv: HullView): void {
    hv.surface = surfaceArray(this.grid);
    const g = this.grid;
    hv.isSolid = (x, y, z) => g.isSolid(x, y, z);
    hv.dims = g.dims;
    hv.pos[0] = this.pos.x; hv.pos[1] = this.pos.y; hv.pos[2] = this.pos.z;
    hv.quat[0] = 0; hv.quat[1] = 0; hv.quat[2] = 0; hv.quat[3] = 1;
  }
  aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }): void {
    const [nx, ny, nz] = this.grid.dims;
    out.min.set(this.pos.x, this.pos.y, this.pos.z);
    out.max.set(this.pos.x + nx * this.voxelSize, this.pos.y + ny * this.voxelSize, this.pos.z + nz * this.voxelSize);
  }
  comWorld(out: THREE.Vector3): THREE.Vector3 {
    const [nx, ny, nz] = this.grid.dims;
    return out.set(
      this.pos.x + (nx * this.voxelSize) / 2,
      this.pos.y + (ny * this.voxelSize) / 2,
      this.pos.z + (nz * this.voxelSize) / 2,
    );
  }
  linvel() { return this.vel; }
  angvel() { return { x: 0, y: 0, z: 0 }; }
  mass() { return this.m; }
  cellBreakEnergy(x: number, y: number, z: number): number { return breakEnergy(this.grid.get(x, y, z)); }
  carveCells(cells: [number, number, number][]): number {
    let n = 0;
    for (const [x, y, z] of cells) if (this.grid.remove(x, y, z)) { this.removed.push([x, y, z]); n++; }
    return n;
  }
  applyImpulseAtPoint(imp: THREE.Vector3, pt: { x: number; y: number; z: number }): void {
    this.impulses.push({ imp: imp.clone(), pt: { ...pt } });
  }
  translation() { return this.pos; }
  setTranslation(t: { x: number; y: number; z: number }): void { this.moved.push({ ...t }); this.pos = t; }
}

describe("VoxelContact.resolveContact — ship vs immovable, indestructible terrain", () => {
  it("a fast ram breaks the SHIP's voxels and leaves the terrain intact", () => {
    const contact = new VoxelContact();
    // ship A: oak block driving +x into the wall at 6 m/s (> vBreak 2)
    const ship = new FakeTarget(solidBlock(4, OAK), { x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, 1e4, true, 1);
    // terrain B: rock wall overlapping A's +x face, immovable (huge mass) + indestructible (canCarve false)
    const wall = new FakeTarget(solidBlock(4, ROCK), { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1e12, false, 1);
    const d = contact.resolveContact(ship, wall, 1 / 60);
    expect(d).not.toBeNull();
    expect(ship.removed.length).toBeGreaterThan(0);  // the ship erodes
    expect(wall.removed.length).toBe(0);             // the rock never breaks
    expect(ship.impulses.length).toBeGreaterThan(0); // drag slows the ship
  });

  it("a slow drift (< vBreak) breaks nothing and de-penetrates the ship", () => {
    const contact = new VoxelContact();
    const ship = new FakeTarget(solidBlock(4, OAK), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 1e4, true, 1); // 1 m/s < 2
    const wall = new FakeTarget(solidBlock(4, ROCK), { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1e12, false, 1);
    const d = contact.resolveContact(ship, wall, 1 / 60);
    expect(d).not.toBeNull();
    expect(ship.removed.length).toBe(0); // nothing breaks below vBreak
    expect(wall.removed.length).toBe(0);
    expect(ship.moved.length).toBeGreaterThan(0); // the ship is pushed out
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/voxelContact.test.ts`
Expected: FAIL — `resolveContact` does not exist on `VoxelContact` (and/or `ContactTarget` is unused). (TypeScript error or runtime "not a function".)

- [ ] **Step 3: Refactor `voxelContact.ts` to the interface-driven rule**

Make these edits in `src/game/voxelContact.ts`:

**3a.** Trim the imports. Replace:
```ts
import * as THREE from "three";
import { TUN } from "../core/tunables";
import { VOXEL_SIZE } from "../core/constants";
import { detectContacts, type HullView, type ContactScratch } from "../sim/voxelOverlap";
import { breakEnergy } from "../sim/materials";
import { breakImpulse, splitClosingImpulse } from "../sim/crush";
import type { VoxelGrid } from "../sim/voxelGrid";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";
```
with:
```ts
import * as THREE from "three";
import { TUN } from "../core/tunables";
import { detectContacts, type HullView, type ContactScratch } from "../sim/voxelOverlap";
import { breakImpulse, splitClosingImpulse } from "../sim/crush";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";
```
(`VOXEL_SIZE`, `breakEnergy`, and `VoxelGrid` are no longer used here — A's voxel size now comes from `a.voxelSize`, break energy from `cellBreakEnergy`.)

**3b.** Add a `tAabb` temp. After the line `private aabbs: { min: THREE.Vector3; max: THREE.Vector3 }[] = [];` add:
```ts
  private tAabb = { min: new THREE.Vector3(), max: new THREE.Vector3() }; // terrain broad-phase scratch
```

**3c.** Replace the whole `stepAll` method with the ship↔ship + ship↔terrain version:
```ts
  /** Run the deformable contact for every ship↔ship and ship↔terrain pair this fixed step. */
  stepAll(ships: Ship[], terrain: ContactTarget[], dt: number): void {
    if (!TUN.crush.enabled) {
      this.debug = zeroDebug();
      return;
    }
    while (this.aabbs.length < ships.length) this.aabbs.push({ min: new THREE.Vector3(), max: new THREE.Vector3() });
    for (let i = 0; i < ships.length; i++) ships[i].aabbWorld(this.aabbs[i]);

    let best = zeroDebug();
    // ship ↔ ship: both hulls carve (existing behavior)
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        if (!aabbIntersect(this.aabbs[i], this.aabbs[j])) continue; // broad cull
        best = this.worse(best, this.stepPair(ships[i], ships[j], dt));
      }
    }
    // ship ↔ terrain: terrain is hull B — immovable + indestructible, only the SHIP erodes
    for (let i = 0; i < ships.length; i++) {
      for (let t = 0; t < terrain.length; t++) {
        terrain[t].aabbWorld(this.tAabb);
        if (!aabbIntersect(this.aabbs[i], this.tAabb)) continue;
        best = this.worse(best, this.resolveContact(ships[i], terrain[t], dt));
      }
    }
    this.debug = best;
  }

  /** Keep whichever debug reflects the most-damaged pair this step (for the dev harness). */
  private worse(best: ContactDebug, d: ContactDebug | null): ContactDebug {
    if (!d) return best;
    const dRem = d.removedA + d.removedB, bRem = best.removedA + best.removedB;
    return dRem > bRem || (dRem === bRem && d.overlapCount > best.overlapCount) ? d : best;
  }
```

**3d.** Replace the `stepPair` method (the old `(s1, s2)` body) with a thin selector that delegates to `resolveContact`:
```ts
  /** One ship pair: walk the SMALLER hull's surface (fewer cells) as A; both ships carve. */
  private stepPair(s1: Ship, s2: Ship, dt: number): ContactDebug | null {
    const aSmaller = s1.surfaceCells().length <= s2.surfaceCells().length;
    return aSmaller ? this.resolveContact(s1, s2, dt) : this.resolveContact(s2, s1, dt);
  }

  /**
   * The ONE deformable-contact rule, run for ANY pair: ship↔ship (both carve) or ship↔terrain
   * (B is immovable + indestructible). A's surface is walked against B's occupancy. Returns the
   * per-pair debug, or null if the hulls don't overlap. See the module header for the two regimes.
   */
  resolveContact(a: ContactTarget, b: ContactTarget, dt: number): ContactDebug | null {
    a.fillHullView(this.hvA);
    b.fillHullView(this.hvB);
    this.ensureScratch(this.hvA.surface.length / 3);
    const ov = detectContacts(this.hvA, this.hvB, a.voxelSize, TUN.crush.buffer, this.scratch, b.voxelSize);
    if (!ov) return null;

    const sc = this.scratch;
    const count = ov.count;
    const depth = ov.depth;

    a.comWorld(this.comA);
    b.comWorld(this.comB);
    const lvA = a.linvel(), avA = a.angvel();
    const lvB = b.linvel(), avB = b.angvel();

    // aggregate HORIZONTAL closing direction from the relative velocity at the contact centroid.
    const cx = ov.centroid[0], cy = ov.centroid[1], cz = ov.centroid[2];
    this.velAt(this.comA, lvA, avA, cx, cy, cz, this.vA);
    this.velAt(this.comB, lvB, avB, cx, cy, cz, this.vB);
    let dhx = this.vA.x - this.vB.x, dhz = this.vA.z - this.vB.z;
    const dlen = Math.hypot(dhx, dhz);
    const moving = dlen > 1e-4;
    if (moving) { dhx /= dlen; dhz /= dlen; }

    const mA = Math.max(a.mass(), 1);
    const mB = Math.max(b.mass(), 1);
    const mu = (mA * mB) / (mA + mB); // reduced mass — terrain's huge mB makes this ≈ mA
    const tough = TUN.crush.toughness;

    // ---- classify each contact: BREAK (closing > vBreak) vs REST ----
    let breakCount = 0, bSumX = 0, bSumY = 0, bSumZ = 0;
    const brokenA: [number, number, number][] = [];
    const brokenB: [number, number, number][] = [];
    if (moving) {
      for (let i = 0; i < count; i++) {
        const o = i * 3;
        const px = sc.points[o], py = sc.points[o + 1], pz = sc.points[o + 2];
        this.velAt(this.comA, lvA, avA, px, py, pz, this.vA);
        this.velAt(this.comB, lvB, avB, px, py, pz, this.vB);
        const vci = (this.vA.x - this.vB.x) * dhx + (this.vA.z - this.vB.z) * dhz; // horizontal closing
        if (vci <= TUN.crush.vBreak) continue;
        brokenA.push([sc.aCells[o], sc.aCells[o + 1], sc.aCells[o + 2]]);
        if (b.canCarve) brokenB.push([sc.bCells[o], sc.bCells[o + 1], sc.bCells[o + 2]]);
        bSumX += px; bSumY += py; bSumZ += pz; breakCount++;
      }
    }

    let removedA = 0, removedB = 0, energy = 0, force = 0, vClose = 0;

    if (breakCount > 0) {
      // ---- BREAK regime: destruction BOUNDED by the collision KE; only carveable sides break. ----
      const bcx = bSumX / breakCount, bcy = bSumY / breakCount, bcz = bSumZ / breakCount;
      this.velAt(this.comA, lvA, avA, bcx, bcy, bcz, this.vA);
      this.velAt(this.comB, lvB, avB, bcx, bcy, bcz, this.vB);
      const sA = this.vA.x * dhx + this.vA.z * dhz;
      const sB = this.vB.x * dhx + this.vB.z * dhz; // 0 for static terrain
      vClose = sA - sB;
      const budget = Math.min(0.5 * mu * vClose * vClose, TUN.crush.maxStepEnergy);
      energy = this.carveWithinBudget(a, b, brokenA, brokenB, tough, budget);
      removedA = this.lastRemovedA; removedB = this.lastRemovedB;
      const dvClose = breakImpulse(mu, vClose, energy, TUN.crush.biteDvCap) / mu;
      const { jA, jB } = splitClosingImpulse(mA, mB, mu, sA, sB, dvClose, TUN.crush.transferFrac);
      this.pushAtComHeight(a, bcx, bcz, this.comA.y, -dhx, -dhz, jA); // slow A's approach
      this.pushAtComHeight(b, bcx, bcz, this.comB.y, dhx, dhz, jB);   // drag/transfer onto B (no-op for terrain)
      force = (jA + jB) / dt;

      const removed = removedA + removedB;
      if (this.effects && TUN.crush.fling > 0 && removed > 0) {
        this.pt2.set(bcx, bcy, bcz);
        this.imp.set(dhx, 0, dhz);
        this.effects.impactDebris(this.pt2, this.imp, Math.min(removed * TUN.crush.fling, 40));
      }
    } else if (depth >= TUN.crush.minDepth) {
      // ---- REST regime: cancel the closing + de-penetrate by POSITION along the horizontal COM→COM line. ----
      let nx = this.comB.x - this.comA.x, nz = this.comB.z - this.comA.z;
      const hlen = Math.hypot(nx, nz);
      if (hlen > 1e-4) {
        nx /= hlen; nz /= hlen;
        this.velAt(this.comA, lvA, avA, cx, cy, cz, this.vA);
        this.velAt(this.comB, lvB, avB, cx, cy, cz, this.vB);
        vClose = (this.vA.x - this.vB.x) * nx + (this.vA.z - this.vB.z) * nz;
        if (vClose > 0) {
          const jv = mu * Math.min(vClose, TUN.crush.biteDvCap);
          this.pushAtComHeight(a, cx, cz, this.comA.y, -nx, -nz, jv);
          this.pushAtComHeight(b, cx, cz, this.comB.y, nx, nz, jv);
          force = jv / dt;
        }
        const corr = Math.min(depth * TUN.crush.depen, TUN.crush.maxDepenSpeed * dt);
        const moveA = corr * (mB / (mA + mB)), moveB = corr * (mA / (mA + mB)); // terrain's huge mB → moveA≈corr, moveB≈0
        const ta = a.translation();
        a.setTranslation({ x: ta.x - nx * moveA, y: ta.y, z: ta.z - nz * moveA });
        const tb = b.translation();
        b.setTranslation({ x: tb.x + nx * moveB, y: tb.y, z: tb.z + nz * moveB }); // no-op for terrain
      }
    }

    return { overlapCount: count, depth, force, energy, removedA, removedB, vClose };
  }
```

**3e.** Replace `carveWithinBudget` (it now takes two `ContactTarget`s and respects `canCarve`):
```ts
  /** Spend the energy budget cheapest-first across both sides' broken candidates, carving only the
   *  sides that CAN break (terrain's canCarve === false → all the energy erodes the ship). Returns
   *  the energy actually spent; writes the two removal counts into lastRemovedA/lastRemovedB. */
  private carveWithinBudget(
    a: ContactTarget, b: ContactTarget,
    brokenA: [number, number, number][], brokenB: [number, number, number][],
    tough: number, budget: number,
  ): number {
    const cand: { isA: boolean; c: [number, number, number]; e: number }[] = [];
    if (a.canCarve) for (const c of brokenA) cand.push({ isA: true, c, e: a.cellBreakEnergy(c[0], c[1], c[2]) * tough });
    if (b.canCarve) for (const c of brokenB) cand.push({ isA: false, c, e: b.cellBreakEnergy(c[0], c[1], c[2]) * tough });
    cand.sort((x, y) => x.e - y.e);
    let bud = budget, spent = 0;
    const remA: [number, number, number][] = [], remB: [number, number, number][] = [];
    for (const k of cand) { if (k.e > bud) break; bud -= k.e; spent += k.e; (k.isA ? remA : remB).push(k.c); }
    this.lastRemovedA = remA.length ? a.carveCells(remA) : 0;
    this.lastRemovedB = remB.length ? b.carveCells(remB) : 0;
    return spent;
  }
```

**3f.** Change `pushAtComHeight` to take a `ContactTarget` and route through `applyImpulseAtPoint`. Replace:
```ts
  private pushAtComHeight(ship: Ship, px: number, pz: number, comY: number, dx: number, dz: number, jMag: number): void {
    if (jMag === 0) return;
    this.imp.set(dx * jMag, 0, dz * jMag);
    this.pt2.set(px, comY, pz);
    ship.body.applyImpulseAtPoint(this.imp, this.pt2, true);
  }
```
with:
```ts
  private pushAtComHeight(target: ContactTarget, px: number, pz: number, comY: number, dx: number, dz: number, jMag: number): void {
    if (jMag === 0) return;
    this.imp.set(dx * jMag, 0, dz * jMag);
    this.pt2.set(px, comY, pz);
    target.applyImpulseAtPoint(this.imp, this.pt2);
  }
```

**3g.** Delete the now-unused module-level `fillHullView(hv, ship)` function at the bottom of the file (its logic now lives on `Ship.fillHullView` / `IslandTarget.fillHullView`). Keep `aabbIntersect`.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `npx vitest run tests/voxelContact.test.ts`
Expected: PASS — fast ram carves the ship (`ship.removed > 0`), leaves the wall (`wall.removed === 0`), drags the ship (`ship.impulses > 0`); slow drift carves nothing and moves the ship.

- [ ] **Step 5: Type-check + full suite**

Run: `npm run build && npm run test`
Expected: PASS. (`stepAll` now needs two args — its only caller, `world.ts`, is updated in Task 6; if you run this before Task 6, expect a `tsc` error at `world.ts:78`. Do Task 6's world.ts edit together with this if the build must be green at every commit; otherwise proceed — the commit below is logically complete and Task 6 immediately fixes the caller.)

- [ ] **Step 6: Commit**

```bash
git add src/game/voxelContact.ts tests/voxelContact.test.ts
git commit -m "feat(contact): unify ship/terrain contact on resolveContact + terrain pass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Pull ship↔terrain out of the rigid solver

**Files:**
- Modify: `src/game/physics.ts`

- [ ] **Step 1: Add `terrainBodies` to the `Physics` interface**

In `src/game/physics.ts`, in the `export interface Physics`, add after the `shipBodies` field/docs:

```ts
  /** Rigid-body handles of every static terrain piece (islands, cliffs, sea stacks). A contact
   *  pair where one body is a ship and the other is terrain is ALSO pulled out of Rapier's rigid
   *  solver (the hook returns null), so the hull interpenetrates and game/voxelContact.ts erodes
   *  the ship against the terrain (which is an immovable, indestructible hull). Character/debris vs
   *  terrain still solve rigidly — neither is a ship — so the captain still walks the dock. */
  terrainBodies: Set<number>;
```

- [ ] **Step 2: Create the set and extend the contact filter**

Replace:
```ts
  const shipBodies = new Set<number>();
  const hooks: RAPIER.PhysicsHooks = {
    filterContactPair(_c1, _c2, body1, body2) {
      // Two distinct ships: generate NO rigid contact. voxelContact reads the real voxel overlap
      // (which needs the hulls to actually interpenetrate) and applies its own carve + hard
      // position-based de-penetration + inelastic velocity cancel. Returning null is what lets the
      // hulls overlap enough to crunch instead of Rapier rigidly shoving them apart first.
      if (body1 !== body2 && shipBodies.has(body1) && shipBodies.has(body2)) return null;
      // everything else (hull↔debris, hull↔player, deck↔character, …) solves normally.
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair() {
      return true;
    },
  };
```
with:
```ts
  const shipBodies = new Set<number>();
  const terrainBodies = new Set<number>();
  const hooks: RAPIER.PhysicsHooks = {
    filterContactPair(_c1, _c2, body1, body2) {
      // Generate NO rigid contact for ship↔ship AND ship↔terrain: voxelContact reads the real voxel
      // overlap (which needs the bodies to actually interpenetrate) and applies its own carve + hard
      // position de-penetration + inelastic cancel. Returning null is what lets them overlap enough
      // to crunch instead of Rapier rigidly shoving them apart first.
      if (body1 !== body2) {
        const s1 = shipBodies.has(body1), s2 = shipBodies.has(body2);
        if (s1 && s2) return null; // ship ↔ ship
        if ((s1 && terrainBodies.has(body2)) || (s2 && terrainBodies.has(body1))) return null; // ship ↔ terrain
      }
      // everything else (terrain↔character, terrain↔debris, hull↔debris, hull↔player, …) solves normally.
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair() {
      return true;
    },
  };
```

- [ ] **Step 3: Return the new set**

Change the final `return { world, RAPIER, shipBodies, hooks, events };` to:
```ts
  return { world, RAPIER, shipBodies, terrainBodies, hooks, events };
```

- [ ] **Step 4: Type-check**

Run: `npm run build`
Expected: `tsc` may still error at `world.ts` (`stepAll` arity) until Task 6 — that is expected if Task 4 was committed separately. The `physics.ts` changes themselves are type-correct.

- [ ] **Step 5: Commit**

```bash
git add src/game/physics.ts
git commit -m "feat(physics): pull ship-terrain pairs out of the rigid solver

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire islands as terrain (field → world → main)

**Files:**
- Modify: `src/game/islandField.ts`, `src/game/world.ts`, `src/main.ts`

- [ ] **Step 1: `IslandField` — imports + a `contactTargets` list + terrain registration**

In `src/game/islandField.ts`, add to the imports:
```ts
import { TUN } from "../core/tunables";
import type { VoxelGrid } from "../sim/voxelGrid";
import { buildHarborIsland, buildIsland, buildSeaStack, type IslandModel } from "../sim/islandwright";
import { IslandTarget } from "./islandTarget";
```
(The `buildSeaStack` import resolves once Task 8 lands; if implementing strictly in order, do Task 8 before this step, or temporarily omit the sea-stack loop in Step 3 and add it after Task 8/9. The recommended order is Tasks 7–9 then this wiring — see "Build order" at the bottom.)

Add a `contactTargets` field next to `readonly islands`:
```ts
  readonly islands: IslandInstance[] = [];
  /** Every terrain piece (islands, cliffs, sea stacks) as a crush hull-B for game/voxelContact.ts.
   *  main.ts hands this to GameWorld.terrain so the ship-vs-terrain crush runs each step. */
  readonly contactTargets: IslandTarget[] = [];
```

- [ ] **Step 2: Replace the constructor body with a terrain-registering version**

Replace the entire `constructor(seed, physics, scene) { … }` with:
```ts
  constructor(seed: string, physics: Physics, scene: THREE.Scene) {
    const placements = planIslandPlacements(seed);
    for (const p of placements) {
      const model =
        p.kind === "harbor"
          ? buildHarborIsland({ seed: p.seed, radiusVox: p.radiusVox, peakVox: p.peakVox })
          : buildIsland({
              seed: p.seed,
              radiusVox: p.radiusVox,
              peakVox: p.peakVox,
              ruggedness: p.ruggedness,
              landBias: p.landBias,
            });
      const worldY = -model.meta.waterlineY * M_PER_VOX;
      const visual = new IslandVisual(model.grid, { x: p.x, y: worldY, z: p.z }, ISLAND_VOXEL_SCALE);
      scene.add(visual.group);
      this.registerTerrain(physics, model.grid, visual, { x: p.x, y: worldY, z: p.z });

      let dockWorld: THREE.Vector3 | null = null;
      if (model.meta.dock) {
        const d = model.meta.dock;
        dockWorld = new THREE.Vector3(p.x + d.x * M_PER_VOX, worldY + d.y * M_PER_VOX, p.z + d.z * M_PER_VOX);
      }
      this.islands.push({ placement: p, model, visual, dockWorld });
    }

    // sea-stack hazards: terrain too → same crush + render path (no new physics/render code)
    for (const h of planHazards(seed, TUN.hazard.seaStacks, placements)) {
      const model = buildSeaStack({ seed: h.seed, radiusVox: h.radiusVox, peakVox: h.peakVox });
      const worldY = -model.meta.waterlineY * M_PER_VOX;
      const visual = new IslandVisual(model.grid, { x: h.x, y: worldY, z: h.z }, ISLAND_VOXEL_SCALE);
      scene.add(visual.group);
      this.registerTerrain(physics, model.grid, visual, { x: h.x, y: worldY, z: h.z });
    }
  }

  /** Build the static trimesh collider + the crush contact target for one terrain grid. */
  private registerTerrain(
    physics: Physics,
    grid: VoxelGrid,
    visual: IslandVisual,
    worldPos: { x: number; y: number; z: number },
  ): void {
    const R = physics.RAPIER;
    if (visual.colliderIndices.length > 0) {
      const body = physics.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(worldPos.x, worldPos.y, worldPos.z),
      );
      const col = physics.world.createCollider(
        R.ColliderDesc.trimesh(visual.colliderVerts, visual.colliderIndices),
        body,
      );
      // ship↔terrain is DEFORMABLE: tag the body as terrain (physics.ts filterContactPair pulls
      // ship↔terrain out of the rigid solver) and flag the collider so the contact hook fires.
      // Character/debris↔terrain still solve rigidly (not ships) — the captain still walks the dock.
      physics.terrainBodies.add(body.handle);
      col.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS);
    }
    this.contactTargets.push(new IslandTarget(grid, worldPos, M_PER_VOX));
  }
```
(`planHazards` is added in Task 9. If wiring before Task 9, temporarily replace the sea-stack `for` loop with nothing; add it back after Task 9.)

- [ ] **Step 3: `GameWorld` — hold terrain and feed it to `stepAll`**

In `src/game/world.ts`, add the import:
```ts
import type { ContactTarget } from "./voxelContact";
```
Add a field next to `readonly contact`:
```ts
  /** Static terrain (islands, cliffs, sea stacks) as crush hull-B; populated by main.ts after the
   *  IslandField is built. Empty in headless tests (ship-vs-ship still runs). */
  terrain: ContactTarget[] = [];
```
Change the contact call inside `step()` from:
```ts
      this.contact.stepAll(this.ships, FIXED_DT);
```
to:
```ts
      this.contact.stepAll(this.ships, this.terrain, FIXED_DT);
```

- [ ] **Step 4: `main.ts` — point the world at the island targets**

In `src/main.ts`, right after `const islands = new IslandField(seed, physics, scene);` (≈ line 146), add:
```ts
  world.terrain = islands.contactTargets; // ship↔terrain deformable destruction (game/voxelContact.ts)
```

- [ ] **Step 5: Type-check + full suite**

Run: `npm run build && npm run test`
Expected: PASS (clean `tsc`, all ~existing tests green; `world.ts` now passes two args to `stepAll`).

- [ ] **Step 6: Commit**

```bash
git add src/game/islandField.ts src/game/world.ts src/main.ts
git commit -m "feat(islands): register terrain targets + wire ship-terrain crush into the loop

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Cliffier coasts (tuning)

**Files:**
- Modify: `src/sim/islandwright.ts`
- Test: `tests/islandwright.test.ts` (run existing; no new assertions unless one breaks)

- [ ] **Step 1: Widen the sea-cliff window and raise the cliff height**

In `src/sim/islandwright.ts`, inside `makeHeightField`, change:
```ts
  const cliffAmp = Math.max(4, peak * 0.4); // sea-cliff height where the cliff field is high
```
to:
```ts
  const cliffAmp = Math.max(6, peak * 0.55); // taller sea-cliffs (cliffier coasts pass)
```
and change:
```ts
      const cliffSel = smoothstep(0.5, 0.9, cn);
```
to:
```ts
      const cliffSel = smoothstep(0.38, 0.82, cn); // more of the coast becomes sheer cliff
```

- [ ] **Step 2: Run the island tests (beaches + rock must both survive)**

Run: `npx vitest run tests/islandwright.test.ts`
Expected: PASS. The tuning increases ROCK/DARKROCK and aboveWater (still `> 0` / `> 500`), keeps inland GRASS and the sea-ringed edges, and must keep `SAND > 40` (beaches still form on low-cliff-noise coasts). If `SAND > 40` fails, dial `cliffSel` back toward `smoothstep(0.42, 0.85, cn)` and re-run until both the SAND and ROCK assertions pass.

- [ ] **Step 3: Commit**

```bash
git add src/sim/islandwright.ts
git commit -m "feat(islands): cliffier coasts (wider sea-cliff window, taller cliffs)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `buildSeaStack`

**Files:**
- Modify: `src/sim/islandwright.ts`
- Test: `tests/islandwright.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/islandwright.test.ts`. First extend the import line to include `buildSeaStack`:
```ts
import { buildIsland, buildHarborIsland, buildSeaStack } from "../src/sim/islandwright";
```
Then add this `describe` block (after the `buildHarborIsland` block):
```ts
describe("buildSeaStack", () => {
  it("is deterministic and pokes a narrow rock spire above the waterline", () => {
    const a = buildSeaStack({ seed: 7, radiusVox: 4, peakVox: 16 });
    const b = buildSeaStack({ seed: 7, radiusVox: 4, peakVox: 16 });
    expect(checksum(a.grid.data)).toBe(checksum(b.grid.data));
    const { grid, meta } = a;
    let above = 0;
    const mats = new Set<number>();
    grid.forEachSolid((_x, y, _z, m) => {
      if (y > meta.waterlineY) above++;
      mats.add(m);
    });
    expect(above).toBeGreaterThan(0); // it breaches the surface
    expect(mats.has(ROCK) || mats.has(DARKROCK)).toBe(true); // made of rock
  });

  it("is sea-ringed (open water at the grid edge columns)", () => {
    const { grid } = buildSeaStack({ seed: 7, radiusVox: 4, peakVox: 16 });
    const [nx, ny, nz] = grid.dims;
    let edge = 0;
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ny; y++) {
        if (grid.isSolid(x, y, 0)) edge++;
        if (grid.isSolid(x, y, nz - 1)) edge++;
      }
    expect(edge).toBe(0);
  });
});
```
(`ROCK`, `DARKROCK`, and `checksum` are already imported/defined in this test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/islandwright.test.ts -t buildSeaStack`
Expected: FAIL — `buildSeaStack` is not exported.

- [ ] **Step 3: Implement `buildSeaStack`**

In `src/sim/islandwright.ts`, add this exported function (e.g. just after `buildIsland`). It reuses the module's `SEABED_Y` / `WATERLINE_Y` / `Rng` / `createNoise2D` / `ROCK` / `DARKROCK`, all already in scope:
```ts
/**
 * A lone SEA STACK / rock spire: a tall, narrow, jagged ROCK/DARKROCK pillar that juts out of open
 * water — a thing to weave around. Same grid + waterline convention as buildIsland, so IslandField
 * places and renders it identically; it is terrain, so the ship-vs-terrain crush (game/voxelContact.ts)
 * erodes the SHIP against it and the spire never breaks. Deterministic (same opts → identical grid).
 */
export function buildSeaStack(opts: { seed: number; radiusVox: number; peakVox: number }): IslandModel {
  const { radiusVox, peakVox } = opts;
  const margin = 3;
  const nx = radiusVox * 2 + margin * 2;
  const nz = radiusVox * 2 + margin * 2;
  const ny = SEABED_Y + peakVox + 4;
  const grid = createGrid(nx, ny, nz);
  const data = grid.data;
  const nxny = nx * ny;

  const rng = new Rng(`stack-${opts.seed}`);
  const shapeN = createNoise2D(() => rng.next()); // irregular footprint
  const heightN = createNoise2D(() => rng.next()); // jagged crown
  const cx = nx / 2;
  const cz = nz / 2;
  const Fs = 1.6 / Math.max(radiusVox, 1);

  for (let x = 1; x < nx - 1; x++) {
    for (let z = 1; z < nz - 1; z++) {
      const dx = x - cx;
      const dz = z - cz;
      const dist = Math.hypot(dx, dz);
      const ang = Math.atan2(dz, dx);
      const rEff = radiusVox * (0.55 + 0.45 * (0.5 + 0.5 * shapeN(Math.cos(ang), Math.sin(ang))));
      if (dist > rEff) continue;
      const taper = 1 - dist / Math.max(rEff, 1); // tall in the centre, low at the rim
      const jag = 0.7 + 0.3 * (0.5 + 0.5 * heightN(x * Fs, z * Fs));
      const h = Math.max(1, Math.round(peakVox * taper * jag));
      const topY = Math.min(SEABED_Y + h, ny - 1);
      const colBase = x + nxny * z;
      for (let y = 0; y <= topY; y++) {
        data[colBase + nx * y] = y >= topY - 2 ? DARKROCK : ROCK; // weathered dark crown
      }
    }
  }

  return { grid, meta: { waterlineY: WATERLINE_Y, radiusVox, peakVox, dock: null } };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/islandwright.test.ts`
Expected: PASS (the two new sea-stack cases + all existing island cases).

- [ ] **Step 5: Commit**

```bash
git add src/sim/islandwright.ts tests/islandwright.test.ts
git commit -m "feat(islands): buildSeaStack — jagged rock spire terrain

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: `planHazards` + scatter sea stacks + `TUN.hazard`

**Files:**
- Modify: `src/core/tunables.ts`, `src/game/islandField.ts`
- Test: `tests/islandField.test.ts`

- [ ] **Step 1: Add the tunable**

In `src/core/tunables.ts`, add this block inside `TUN`, after the `crush: { … }` block (before `flood`):
```ts
  /** Navigational hazards (game/islandField.ts) — extra terrain scattered at world generation.
   *  Read ONCE when the archipelago is built (changing it needs a reload, not a live tweak). */
  hazard: {
    /** how many sea-stack spires to scatter in open water between the islands. */
    seaStacks: 12,
  },
```

- [ ] **Step 2: Write the failing test**

In `tests/islandField.test.ts`, extend the import line:
```ts
import { planIslandPlacements, planHazards } from "../src/game/islandField";
```
Add this `describe` block:
```ts
describe("planHazards", () => {
  const islands = planIslandPlacements("scuttle-dev");
  const stacks = planHazards("scuttle-dev", 12, islands);

  it("is deterministic for a seed", () => {
    expect(planHazards("scuttle-dev", 12, islands)).toEqual(stacks);
  });
  it("places sea stacks in open water clear of the spawn lagoon", () => {
    expect(stacks.length).toBeGreaterThan(0);
    for (const s of stacks) {
      expect(s.kind).toBe("stack");
      expect(Math.hypot(s.x, s.z)).toBeGreaterThan(150); // clear of the spawn lagoon
    }
  });
  it("keeps stacks off the islands", () => {
    for (const s of stacks)
      for (const p of islands)
        expect(Math.hypot(p.x - s.x, p.z - s.z)).toBeGreaterThan(p.radiusM + s.radiusM);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/islandField.test.ts -t planHazards`
Expected: FAIL — `planHazards` is not exported.

- [ ] **Step 4: Implement `planHazards`**

In `src/game/islandField.ts`, add (after `planIslandPlacements`, reusing its module constants `LAGOON_M`, `FIELD_M`, `M_PER_VOX`, and `Rng`):
```ts
export interface HazardPlacement {
  kind: "stack";
  seed: number;
  x: number; // world metres
  z: number;
  radiusVox: number;
  radiusM: number;
  peakVox: number;
}

const STACK_R_MIN = 3;
const STACK_R_MAX = 6;
const STACK_PEAK_MIN = 8;
const STACK_PEAK_MAX = 24;

/**
 * Scatter sea-stack hazards in open water between the islands. Deterministic for a seed. Stacks
 * avoid the spawn lagoon and every island footprint, but may sit closer to one another than
 * islands do — so they form gauntlets you must weave through.
 */
export function planHazards(seed: string, count: number, islands: IslandPlacement[]): HazardPlacement[] {
  const rng = new Rng(`hazards-${seed}`);
  const out: HazardPlacement[] = [];
  let tries = 0;
  while (out.length < count && tries < 2000) {
    tries++;
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(LAGOON_M + 40, FIELD_M);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const radiusVox = rng.int(STACK_R_MIN, STACK_R_MAX);
    const radiusM = radiusVox * M_PER_VOX;
    if (Math.hypot(x, z) < LAGOON_M + radiusM) continue; // keep the spawn lagoon clear
    if (islands.some((p) => Math.hypot(p.x - x, p.z - z) < p.radiusM + radiusM + 16)) continue; // off the islands
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < p.radiusM + radiusM + 4)) continue; // not on another stack
    out.push({
      kind: "stack",
      seed: rng.int(1, 1e9),
      x,
      z,
      radiusVox,
      radiusM,
      peakVox: rng.int(STACK_PEAK_MIN, STACK_PEAK_MAX),
    });
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/islandField.test.ts`
Expected: PASS (the three new planHazards cases + the existing planIslandPlacements cases). The sea-stack `for` loop added in Task 6 Step 2 now resolves `planHazards`.

- [ ] **Step 6: Type-check + full suite**

Run: `npm run build && npm run test`
Expected: PASS — everything wired (`IslandField` builds islands + stacks, all registered as terrain).

- [ ] **Step 7: Commit**

```bash
git add src/core/tunables.ts src/game/islandField.ts tests/islandField.test.ts
git commit -m "feat(islands): planHazards scatters sea stacks; TUN.hazard.seaStacks

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Full verification (build, tests, in-browser feel)

**Files:** none (verification only)

- [ ] **Step 1: Type-check + full deterministic suite**

Run: `npm run build && npm run test`
Expected: clean `tsc`, vite build OK, all test files green (incl. the new `islandTarget`, `voxelContact`, sea-stack, and planHazards cases).

- [ ] **Step 2: In-browser — ramming a cliff**

Start dev: `npm run dev` → open http://localhost:5173. Sail the player ship bow-first into the nearest island cliff at speed. Verify (via Playwright MCP screenshots into the projects ROOT, or by eye):
- the bow voxels erode where it strikes the rock (a hole/crater, dust flung),
- the rock is unchanged,
- she grinds to a halt / is pushed back offshore rather than phasing through OR rigidly bouncing,
- `window.DEBUG.contact.debug` shows `removedA > 0`, `removedB === 0` during the impact.

- [ ] **Step 3: In-browser — sea stacks + gentle dock approach**

- Confirm sea-stack spires are visible in open water between islands; ram one and confirm it tears the bow (stack intact).
- Drift the ship slowly (< ~2 m/s) up to the harbor pier: confirm NO hull damage (sub-`vBreak` rest) and that the ship still stops there (make-port still reachable).

- [ ] **Step 4: Update CLAUDE.md current-state notes**

In `CLAUDE.md` (worktree root), under "What's in the build", update the archipelago line to note ship-vs-terrain destruction + sea stacks (terrain = an immovable, indestructible hull in the one crush rule). Keep it to one or two sentences; the code is the source of truth.

- [ ] **Step 5: Commit the docs touch-up**

```bash
git add CLAUDE.md
git commit -m "docs: note ship-terrain destruction + sea-stack hazards in the build index

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Build order note

Tasks are written so the deterministic tests pass at each commit, with ONE cross-file caveat: `stepAll`'s new arity (Task 4) needs its caller updated (Task 6), and `IslandField`'s sea-stack loop (Task 6) needs `buildSeaStack` (Task 8) + `planHazards` (Task 9). Two safe orders:

- **Linear (commit-green-each-step):** 1 → 2 → 3 → 7 → 8 → 9 → 4 → 5 → 6 → 10. (Sea-stack helpers exist before the wiring; the `stepAll`/`world.ts` pair lands together in 4+6.)
- **Spec order (allow one transient red build between 4 and 6):** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10, doing Task 6's `world.ts` edit immediately after Task 4 to keep `tsc` green, and temporarily omitting the sea-stack loop in Task 6 Step 2 until Tasks 8–9 land.

Prefer the **linear** order.
