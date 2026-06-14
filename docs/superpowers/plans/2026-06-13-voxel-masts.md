# Voxel Masts, Yards & Bowsprit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the masts, yards (sail cross-poles) and bowsprit (bow pole) real voxels in the existing hull grid on both ships, so they're destructible per-voxel and a felled mast breaks off as physics debris — sails/rudder/wheel/cannons stay as separate models.

**Architecture:** Spars become `SPAR` voxels stamped into each ship's `VoxelGrid` (grown taller). They reuse the existing mesh/collider/sever-to-debris/mass pipeline. The one rule that keeps physics honest: SPAR is **solid for structure** (mesh, collider, connectivity, mass, COM, damage) but **skipped for buoyancy** (probes, columns, hull profile) — rigging adds weight, not displacement. Real spar mass raises the COM, so the iron ballast is re-tuned and float/stability verified in-browser.

**Tech Stack:** TypeScript, Three.js, Rapier3D (compat), Vitest. Dev server `npm run dev` (port 5173). Tests `npm run test`. Type-check `npx tsc --noEmit`.

**Spec:** `docs/superpowers/specs/2026-06-13-voxel-masts-design.md`

---

## Task 1: Add the `SPAR` material

**Files:**
- Modify: `src/sim/materials.ts`
- Test: `tests/materials.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// tests/materials.test.ts
import { describe, it, expect } from "vitest";
import { MATERIALS, SPAR, OAK, PINE, IRON, EMPTY } from "../src/sim/materials";

describe("materials", () => {
  it("SPAR is a distinct id with a sane wood density", () => {
    expect(SPAR).not.toBe(OAK);
    expect(SPAR).not.toBe(PINE);
    expect(SPAR).not.toBe(IRON);
    expect(SPAR).not.toBe(EMPTY);
    expect(MATERIALS[SPAR]).toBeDefined();
    // light spar: lighter than oak, below seawater so a floating spar bobs
    expect(MATERIALS[SPAR].density).toBeGreaterThan(200);
    expect(MATERIALS[SPAR].density).toBeLessThan(500);
    expect(MATERIALS[SPAR].color).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -- materials`
Expected: FAIL — `SPAR` is not exported.

- [ ] **Step 3: Add the material**

In `src/sim/materials.ts`, add the export beside the others and the table entry:

```ts
export const EMPTY = 0;
export const OAK = 1;
export const PINE = 2;
export const IRON = 3;
export const SPAR = 4;
```

Add to the `MATERIALS` record (after IRON):

```ts
  // masts/yards/bowsprit — light effective density so the rig adds weight high
  // up without capsizing the ballasted hull; weathered brown, distinct from
  // the deck PINE and hull OAK. SPAR is SOLID for structure but SKIPPED for
  // buoyancy (see buoyancy.ts isHull) — rigging displaces no water.
  [SPAR]: { name: "spar", density: 350, color: [0.08, 0.05, 0.028], strength: 2 },
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npm run test -- materials`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim/materials.ts tests/materials.test.ts
git commit -m "feat(materials): add SPAR material for voxel masts"
```

---

## Task 2: Buoyancy skips SPAR (the `isHull` rule)

**Files:**
- Modify: `src/sim/buoyancy.ts` (`makeProbes`, `makeVoxelColumns`, `buildHullProfile`)
- Test: `tests/buoyancy.test.ts` (add cases)

- [ ] **Step 1: Write the failing test**

Append to `tests/buoyancy.test.ts`:

```ts
import { makeVoxelColumns, makeProbes, buildHullProfile } from "../src/sim/buoyancy";
import { createGrid } from "../src/sim/voxelGrid";
import { OAK, SPAR } from "../src/sim/materials";
import { VOXEL_SIZE } from "../src/core/constants";

describe("buoyancy ignores SPAR (rigging displaces no water)", () => {
  it("a SPAR cell stacked above a hull column adds no displaced cells", () => {
    const grid = createGrid(4, 40, 4);
    grid.set(1, 0, 1, OAK); // a one-cell hull column at the bottom
    const before = makeVoxelColumns(grid, []);
    grid.set(1, 30, 1, SPAR); // a mast cell far above
    const after = makeVoxelColumns(grid, []);
    const colB = before.find((c) => c.x === (1 + 0.5) * VOXEL_SIZE && c.z === (1 + 0.5) * VOXEL_SIZE)!;
    const colA = after.find((c) => c.x === (1 + 0.5) * VOXEL_SIZE && c.z === (1 + 0.5) * VOXEL_SIZE)!;
    expect(colA.cellY).toEqual(colB.cellY); // SPAR added nothing
  });

  it("buildHullProfile deck is unaffected by a SPAR cell above the hull", () => {
    const grid = createGrid(4, 40, 4);
    grid.set(1, 0, 1, OAK);
    grid.set(1, 1, 1, OAK); // hull top at y=1 → deck = 2*VOXEL_SIZE
    const prof0 = buildHullProfile(grid);
    grid.set(1, 30, 1, SPAR);
    const prof1 = buildHullProfile(grid);
    const o = (1 * 4 + 1) * 2; // (z*nx + x)*2
    expect(prof1.data[o + 1]).toBe(prof0.data[o + 1]); // deck height unchanged
  });

  it("makeProbes displaced volume is unaffected by a SPAR cell", () => {
    const grid = createGrid(4, 40, 4);
    grid.set(1, 0, 1, OAK);
    const vol0 = makeProbes(grid, []).reduce((s, p) => s + p.volume, 0);
    grid.set(1, 30, 1, SPAR);
    const vol1 = makeProbes(grid, []).reduce((s, p) => s + p.volume, 0);
    expect(vol1).toBeCloseTo(vol0, 10);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -- buoyancy`
Expected: FAIL — SPAR currently counts as solid, so the column/profile/volume grow.

- [ ] **Step 3: Implement the `isHull` skip**

In `src/sim/buoyancy.ts`, import SPAR at the top:

```ts
import { SPAR } from "./materials";
```

In **`makeProbes`**, replace the lowest/highest scan and the cell tally to use a hull test. Define near the top of the function (after `const idx = ...`):

```ts
  const isHull = (x: number, y: number, z: number) => {
    const m = grid.get(x, y, z);
    return m !== 0 && m !== SPAR;
  };
```

Then change `if (grid.isSolid(x, y, z))` (the lo/hi scan) to `if (isHull(x, y, z))`, and in the inner tally change `const solid = grid.isSolid(x, y, z);` to `const solid = isHull(x, y, z);`.

In **`makeVoxelColumns`**, add the same `isHull` helper after `const idx = ...`, change the lo/hi scan `if (grid.isSolid(x, y, z))` to `if (isHull(x, y, z))`, and the cell push condition `if (grid.isSolid(x, y, z) || enclosed.has(idx(x, y, z)))` to `if (isHull(x, y, z) || enclosed.has(idx(x, y, z)))`.

In **`buildHullProfile`**, add the same `isHull` helper after `const [nx, ny, nz] = grid.dims;` and change `if (grid.isSolid(x, y, z))` to `if (isHull(x, y, z))`.

- [ ] **Step 4: Run it, verify it passes**

Run: `npm run test -- buoyancy`
Expected: PASS (new cases) and all existing buoyancy cases still PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sim/buoyancy.ts tests/buoyancy.test.ts
git commit -m "feat(buoyancy): SPAR cells are structural but displace no water"
```

---

## Task 3: Extend `ShipBuild` with the spar descriptor (no stamping yet)

**Files:**
- Modify: `src/sim/shipwright.ts` (interface + both builders compute yards/footY/bowsprit)
- Test: `tests/shipwright.test.ts`, `tests/brig.test.ts` (add cases)

The yard levels move out of `shipVisual` into the builder so the grid stamping and the cloth sails share one source. Levels match today's render math (course/topsail/topgallant at 0.17/0.56/0.88·h; full spans 0.71/0.57/0.43·h).

- [ ] **Step 1: Write the failing test**

Append to `tests/shipwright.test.ts`:

```ts
import { SPAR } from "../src/sim/materials";

describe("shipwright spar descriptor", () => {
  it("each mast carries a foot height and three yards", () => {
    for (const m of ship.masts) {
      expect(m.footY).toBeGreaterThan(0);
      expect(m.yards).toHaveLength(3);
      for (const y of m.yards) {
        expect(y.yM).toBeGreaterThan(0);
        expect(y.halfSpanM).toBeGreaterThan(0);
      }
      // yards ascend and narrow
      expect(m.yards[0].yM).toBeLessThan(m.yards[2].yM);
      expect(m.yards[0].halfSpanM).toBeGreaterThan(m.yards[2].halfSpanM);
    }
  });

  it("exposes a bowsprit rooted near the bow", () => {
    expect(ship.bowsprit).toBeDefined();
    expect(ship.bowsprit.lengthM).toBeGreaterThan(2);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -- shipwright`
Expected: FAIL — `footY`, `yards`, `bowsprit` are not on the build.

- [ ] **Step 3: Extend the interface and populate it**

In `src/sim/shipwright.ts`, change the `masts` field of `ShipBuild` and add `bowsprit`:

```ts
  masts: {
    x: number; z: number; h: number; // voxel coords on centerline; h = rig height (m)
    footY: number;                   // deck-top voxel y the mast steps on
    yards: { yM: number; halfSpanM: number }[]; // height above foot (m), half-width (m)
  }[];
  bowsprit: {
    rootX: number; rootZ: number; rootY: number; // root cell (voxels)
    lengthM: number; steeve: number;             // length (m), rise angle (rad)
  };
```

Add a shared helper near the top of the file (module scope, after imports):

```ts
/** The three square-rig yard levels for a mast of rig height h (m): height
 *  above the foot and half-span, matching the canvas proportions. */
function yardLevels(h: number): { yM: number; halfSpanM: number }[] {
  return [
    { yM: h * 0.17, halfSpanM: (h * 0.71) / 2 },
    { yM: h * 0.56, halfSpanM: (h * 0.57) / 2 },
    { yM: h * 0.88, halfSpanM: (h * 0.43) / 2 },
  ];
}
```

In **`buildSloop`**, replace the single-mast line with the enriched descriptor and add a bowsprit:

```ts
  // single mast slightly forward of midship
  const sloopMastX = x0 + Math.round(L * 0.42);
  const masts = [
    {
      x: sloopMastX,
      z: Math.round(cz),
      h: 15,
      footY: deckY + 1,
      yards: yardLevels(15),
    },
  ];
  const bowsprit = {
    rootX: x0 + L - 4,
    rootZ: Math.round(nz / 2),
    rootY: deckY + 2,
    lengthM: (L * VOXEL_SIZE) * 0.28,
    steeve: 0.3,
  };
```

Add `bowsprit` to the returned object (next to `masts`).

In **`buildBrig`**, replace the two-mast block similarly:

```ts
  const masts = [
    { x: x0 + Math.round(L * 0.38), z: Math.round(cz), h: 21, footY: deckY + 1, yards: yardLevels(21) },
    { x: x0 + Math.round(L * 0.68), z: Math.round(cz), h: 18, footY: deckY + 1, yards: yardLevels(18) },
  ];
  const bowsprit = {
    rootX: x0 + L - 4,
    rootZ: Math.round(nz / 2),
    rootY: deckY + 2,
    lengthM: (L * VOXEL_SIZE) * 0.28,
    steeve: 0.3,
  };
```

Add `bowsprit` to the brig's returned object too.

> Note: both masts foot on the waist deck (their `x` is forward of `qX1`), so `footY = deckY + 1` is correct for both. The `SPAR` import added here is used by Task 4/5.

- [ ] **Step 4: Run it, verify it passes**

Run: `npm run test -- shipwright brig`
Expected: PASS. (No grid change yet, so symmetry/determinism cases stay green.)

- [ ] **Step 5: Commit**

```bash
git add src/sim/shipwright.ts tests/shipwright.test.ts
git commit -m "feat(shipwright): expose mast yard + bowsprit descriptor"
```

---

## Task 4: Stamp the mast trunks into the grid (both ships)

**Files:**
- Modify: `src/sim/shipwright.ts` (grow `ny`; add `stampSpars` call stamping mast trunks)
- Test: `tests/shipwright.test.ts`, `tests/brig.test.ts`

Mast cross-section is **2 cells in z** (`floor(cz)`, `ceil(cz)`) to stay port/starboard symmetric, and 2 cells in x (`m.x`, `m.x+1`) for the lower 40%, tapering to 1 cell in x above. Grid grows: sloop `ny` 30→84, brig 42→112.

- [ ] **Step 1: Write the failing test**

Append to `tests/shipwright.test.ts`:

```ts
describe("shipwright voxel masts", () => {
  it("stamps a continuous SPAR trunk from the deck to near the masthead", () => {
    const m = ship.masts[0];
    const topY = m.footY + Math.round(m.h / 0.25) - 1;
    // foot is solid SPAR
    expect(ship.grid.get(m.x, m.footY, Math.floor((ship.grid.dims[2] - 1) / 2))).toBe(SPAR);
    // near the top is solid SPAR
    expect(ship.grid.isSolid(m.x, topY - 2, Math.round(ship.grid.dims[2] / 2) - 1)).toBe(true);
    // grid is tall enough to hold it
    expect(ship.grid.dims[1]).toBeGreaterThan(topY);
  });

  it("masts do not change the below-deck compartment count", () => {
    expect(ship.compartments.length).toBe(3);
    expect(ship.interiorLeaks).toEqual([]);
  });
});
```

(The existing `is port/starboard symmetric` and `deterministic` cases now also guard the stamping.)

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -- shipwright`
Expected: FAIL — trunk cells are EMPTY (no stamping yet).

- [ ] **Step 3: Grow the grids and stamp trunks**

In **`buildSloop`** change `const ny = 30;` → `const ny = 84;`
In **`buildBrig`** change `const ny = 42;` → `const ny = 112;`

Add a shared stamping helper at module scope (it stamps into a grid using the descriptor; called near the end of each builder, AFTER compartments/ports are computed). Mast portion only in this task:

```ts
/** Stamp the voxel rig (masts now; yards + bowsprit added in the next task)
 *  into the grid. Symmetric in z about the centerline so the hull stays
 *  port/starboard symmetric. */
function stampMasts(grid: VoxelGrid, masts: ShipBuild["masts"]): void {
  const [, , nz] = grid.dims;
  const zL = Math.floor((nz - 1) / 2); // the two centerline columns (e.g. 15,16)
  const zR = Math.ceil((nz - 1) / 2);  // == nz/2 ... for even nz, zL=nz/2-1, zR=nz/2
  for (const m of masts) {
    const cells = Math.round(m.h / VOXEL_SIZE);
    const taperTop = m.footY + Math.round(cells * 0.4); // 2-wide below, 1-wide above
    for (let k = 0; k < cells; k++) {
      const y = m.footY + k;
      const xs = y <= taperTop ? [m.x, m.x + 1] : [m.x];
      for (const x of xs) {
        grid.set(x, y, zL, SPAR);
        grid.set(x, y, zR, SPAR);
      }
    }
  }
}
```

In each builder, just before the `return { ... }`, call:

```ts
  stampMasts(grid, masts);
```

> The `findCompartments`/leak audit already ran above on the hull-only grid; masts sit above `deckY` so they don't affect compartments or the leak audit.

- [ ] **Step 4: Run it, verify it passes**

Run: `npm run test -- shipwright brig`
Expected: PASS — trunk present, symmetry holds, compartments unchanged, deterministic.

Run the broader suite to catch fallout: `npm run test`
Expected: `stability` / `draft` MAY now fail (rig mass raises the COM with no rig buoyancy) — that is expected and fixed in Task 9. Everything else green. Note which fail.

- [ ] **Step 5: Commit**

```bash
git add src/sim/shipwright.ts tests/shipwright.test.ts
git commit -m "feat(shipwright): stamp voxel mast trunks into both hulls"
```

---

## Task 5: Stamp the yards and bowsprit

**Files:**
- Modify: `src/sim/shipwright.ts` (`stampMasts` → also yards; add bowsprit stamping)
- Test: `tests/shipwright.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/shipwright.test.ts`:

```ts
describe("shipwright voxel yards + bowsprit", () => {
  it("stamps a SPAR yard spanning the beam at each level", () => {
    const m = ship.masts[0];
    const lv = m.yards[0];
    const yCell = m.footY + Math.round(lv.yM / 0.25);
    const zc = Math.round(ship.grid.dims[2] / 2);
    const span = Math.round(lv.halfSpanM / 0.25);
    // out near the yardarm, off the centerline, there is SPAR at the yard height
    expect(ship.grid.isSolid(m.x, yCell, zc + span - 1)).toBe(true);
    expect(ship.grid.isSolid(m.x, yCell, zc - span + 1)).toBe(true);
  });

  it("stamps a SPAR bowsprit forward of and above the deck", () => {
    const b = ship.bowsprit;
    expect(ship.grid.get(b.rootX, b.rootY, b.rootZ)).toBe(SPAR);
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npm run test -- shipwright`
Expected: FAIL — yard/bowsprit cells are EMPTY.

- [ ] **Step 3: Extend stamping**

Replace `stampMasts` with a fuller `stampRig` that does masts + yards + bowsprit, and update the call sites to `stampRig(grid, masts, bowsprit)`:

```ts
function stampRig(grid: VoxelGrid, masts: ShipBuild["masts"], bowsprit: ShipBuild["bowsprit"]): void {
  const [, , nz] = grid.dims;
  const zL = Math.floor((nz - 1) / 2);
  const zR = Math.ceil((nz - 1) / 2);
  const zc = Math.round(nz / 2);
  for (const m of masts) {
    const cells = Math.round(m.h / VOXEL_SIZE);
    const taperTop = m.footY + Math.round(cells * 0.4);
    for (let k = 0; k < cells; k++) {
      const y = m.footY + k;
      const xs = y <= taperTop ? [m.x, m.x + 1] : [m.x];
      for (const x of xs) {
        grid.set(x, y, zL, SPAR);
        grid.set(x, y, zR, SPAR);
      }
    }
    // yards: 1-cell-thick horizontal runs across the beam, symmetric about zc
    for (const lv of m.yards) {
      const yCell = m.footY + Math.round(lv.yM / VOXEL_SIZE);
      const span = Math.round(lv.halfSpanM / VOXEL_SIZE);
      for (let dz = 0; dz <= span; dz++) {
        grid.set(m.x, yCell, zc + dz, SPAR);
        grid.set(m.x, yCell, zc - 1 - dz, SPAR); // mirror across the centerline gap
      }
    }
  }
  // bowsprit: a stair-stepped diagonal rising from the foredeck toward the bow
  const len = Math.round(bowsprit.lengthM / VOXEL_SIZE);
  for (let s = 0; s < len; s++) {
    const x = bowsprit.rootX + s; // marches toward the bow (+x)
    const y = bowsprit.rootY + Math.round(s * Math.tan(bowsprit.steeve));
    const wide = s < len * 0.4; // 2-wide near the root, 1-wide out at the tip
    grid.set(x, y, bowsprit.rootZ, SPAR);
    if (wide) grid.set(x, y, bowsprit.rootZ - 1, SPAR);
  }
}
```

> z-symmetry note: yards stamp `zc+dz` and `zc-1-dz` so they mirror about the cell boundary at `nz/2`; the bowsprit is given a matching mirror cell only when 2-wide — keep it symmetric by stamping `rootZ` = `nz/2` and the mirror `nz/2-1`. If the `is port/starboard symmetric` test fails, adjust the bowsprit to stamp symmetric z pairs the same way the yards do.

- [ ] **Step 4: Run it, verify it passes**

Run: `npm run test -- shipwright brig`
Expected: PASS, including the symmetry case.

- [ ] **Step 5: Commit**

```bash
git add src/sim/shipwright.ts tests/shipwright.test.ts
git commit -m "feat(shipwright): stamp voxel yards and bowsprit"
```

---

## Task 6: Decouple ship-ship collider + inertia from grid height

**Files:**
- Modify: `src/game/ship.ts` (constructor: coarse collider + inertia box height)
- Test: `tests/smoke.test.ts` or a focused check (see below)

Growing `ny` would otherwise inflate the coarse collider and the box inertia (both use `h = ny * VOXEL_SIZE`). Base them on the hull deck height instead.

- [ ] **Step 1: Add the hull-height computation**

In `src/game/ship.ts` constructor, after `const [nx, ny, nz] = build.grid.dims;` and the `l`/`h`/`w` lines, add a hull-only height (deck + rail + a little), independent of the now-taller grid:

```ts
    // hull extent for the COARSE ship-ship collider and the box-inertia ONLY:
    // the grid is now tall enough to hold the voxel masts, but ships must not
    // collide through each other's rigging space, and the rig's mass (not its
    // height) is what should drive inertia. Use the deck height, not ny.
    const hullTopVox = (build.quarterdeck?.deckY ?? build.deckY) + 5; // + bulwark rail
    const hullH = hullTopVox * VOXEL_SIZE;
```

- [ ] **Step 2: Use `hullH` for inertia and the collider**

Replace the three inertia lines' `h` with `hullH`:

```ts
    const ixx = (mass / 12) * (w * w + hullH * hullH);
    const iyy = (mass / 12) * (l * l + w * w) * 1.6;
    const izz = (mass / 12) * (l * l + hullH * hullH) * 1.6;
```

Replace the coarse collider's height (`(h * 0.7) / 2` twice) with `hullH`:

```ts
    const collider = R.ColliderDesc.cuboid(l / 2, (hullH * 0.7) / 2, w / 2)
      .setTranslation(l / 2, (hullH * 0.7) / 2, w / 2)
      .setDensity(0)
      .setCollisionGroups(0x0002ffff);
```

(Leave the original `const h = ny * VOXEL_SIZE;` only if still referenced elsewhere; otherwise remove it. Check with `tsc`.)

- [ ] **Step 3: Type-check + smoke**

Run: `npx tsc --noEmit`
Expected: no errors (remove the now-unused `h` if it warns).

Run: `npm run test -- smoke`
Expected: PASS (the smoke test constructs ships/physics).

- [ ] **Step 4: Commit**

```bash
git add src/game/ship.ts
git commit -m "fix(ship): base coarse collider + inertia on hull height, not grid height"
```

---

## Task 7: Voxel damage path for masts; remove the analytic mast HP system

**Files:**
- Modify: `src/game/ship.ts` (drop mast colliders, mast HP, mast-foot; add trunk fell-detect; `rigImpacts` drops mast test)
- Modify: `src/game/cannons.ts` (drop the `hitMast` call)
- Test: `tests/rigDamage.test.ts` (adjust if it asserted mast stops), `tests/connectivity.test.ts` (unchanged)

Masts now take damage through `marchGrid`→`applyDamage`. A mast is "felled" (sails drop, drive dies) when its lower trunk is mostly gone; the severed upper voxels are already turned into debris by the existing `findSevered` path inside `applyDamage`.

- [ ] **Step 1: Write the failing test**

Append to `tests/connectivity.test.ts` (it already imports the grid + sever helpers; this asserts the *intent* that blasting a mast foot disconnects the upper mast):

```ts
import { buildSloop } from "../src/sim/shipwright";
import { findSevered } from "../src/sim/connectivity";
import { SPAR } from "../src/sim/materials";

describe("a blasted mast foot severs the upper mast", () => {
  it("removing the trunk's bottom courses disconnects the rest as an island", () => {
    const ship = buildSloop();
    const m = ship.masts[0];
    const [, , nz] = ship.grid.dims;
    const zL = Math.floor((nz - 1) / 2);
    const zR = Math.ceil((nz - 1) / 2);
    // keel anchor (lowest solid on centerline)
    const ax = Math.floor(ship.grid.dims[0] / 2);
    const az = Math.floor(nz / 2);
    let ay = 0;
    while (!ship.grid.isSolid(ax, ay, az)) ay++;
    // blow out the bottom 4 courses of the trunk
    for (let k = 0; k < 4; k++) for (const x of [m.x, m.x + 1]) {
      ship.grid.remove(x, m.footY + k, zL);
      ship.grid.remove(x, m.footY + k, zR);
    }
    const islands = findSevered(ship.grid, [ax, ay, az]);
    const sparIsland = islands.find((i) => i.cells.some((c) => c.mat === SPAR));
    expect(sparIsland).toBeDefined(); // the upper mast broke off
  });
});
```

- [ ] **Step 2: Run it, verify it fails or passes meaningfully**

Run: `npm run test -- connectivity`
Expected: PASS already if stamping is correct (this codifies the behavior). If it FAILS, the trunk isn't actually disconnecting (e.g., a yard bridges to the hull) — fix stamping so the trunk is the only deck connection.

- [ ] **Step 3: Remove the analytic mast system in `ship.ts`**

Delete these members and their initialisation: `mastHp`, `private mastFootInit`, `private mastColliders`, and the `mastFootCount` method. Delete the mast-collider creation loop in the constructor (the `for (const m of build.masts) { ... mastColliders.push(...) }` block). Delete `hitMast`.

Replace `mastFootInit` with a trunk-cell baseline. Add a field and a counter:

```ts
  /** Per mast: SPAR cells in the lower trunk at build (the fell threshold). */
  private mastTrunk0: number[];

  /** Surviving SPAR cells in mast mi's lower trunk (the bottom ~2 m). */
  private mastTrunkCount(mi: number): number {
    const m = this.build.masts[mi];
    const grid = this.build.grid;
    const [, , nz] = grid.dims;
    const zL = Math.floor((nz - 1) / 2);
    const zR = Math.ceil((nz - 1) / 2);
    let n = 0;
    for (let k = 0; k < 8; k++) {
      for (const x of [m.x, m.x + 1]) {
        if (grid.get(x, m.footY + k, zL) === SPAR) n++;
        if (grid.get(x, m.footY + k, zR) === SPAR) n++;
      }
    }
    return n;
  }
```

In the constructor, replace the `this.mastFootInit = ...` line with:

```ts
    this.mastTrunk0 = build.masts.map((_, mi) => this.mastTrunkCount(mi));
```

(Import `SPAR` from `../sim/materials` — the file already imports `IRON` from there.)

`fellMast` keeps its body but drop the collider removal (no colliders now):

```ts
  fellMast(mi: number): void {
    if (!this.mastAlive[mi]) return;
    this.mastAlive[mi] = false;
    this.sailIntegrity[mi] = 0;
    this.visual.fellMast(mi);
    this.onMastFelled?.(mi);
  }
```

In `applyDamage`, replace the old foot-check block:

```ts
    // a mast whose step has been blown out goes by the board (round 7)
    this.build.masts.forEach((m, mi) => {
      if (this.mastAlive[mi] && this.mastFootCount(m) < this.mastFootInit[mi] * 0.5) {
        this.fellMast(mi);
      }
    });
```

with:

```ts
    // a mast whose lower trunk has been shot away goes by the board; the
    // severed upper voxels already left as debris via findSevered above.
    this.build.masts.forEach((_, mi) => {
      if (this.mastAlive[mi] && this.mastTrunkCount(mi) < this.mastTrunk0[mi] * 0.5) {
        this.fellMast(mi);
      }
    });
```

In `rigImpacts`, **delete** the `this.build.masts.forEach(...)` mast-cylinder block and narrow the `stop` type to rudder only:

```ts
  rigImpacts(
    fromW: THREE.Vector3,
    toW: THREE.Vector3,
  ): {
    sails: { rec: SailRecord; y: number; z: number }[];
    stop: { kind: "rudder" } | null;
  } {
    const p0 = this.worldToLocal(this.tmpHitA.copy(fromW), this.tmpHitA);
    const p1 = this.worldToLocal(this.tmpHitB.copy(toW), this.tmpHitB);

    const sails: { rec: SailRecord; y: number; z: number }[] = [];
    for (const rec of this.visual.sails) {
      if (!this.mastAlive[rec.mastIdx]) continue;
      const hit = segmentSailHit(p0, p1, rec);
      if (hit) sails.push({ rec, y: hit.y, z: hit.z });
    }

    let stop: { kind: "rudder" } | null = null;
    if (this.rudderHp > 0) {
      const sternX = 4 * VOXEL_SIZE;
      const bladeW = 0.9 + this.build.lengthM * 0.022;
      const bladeH = this.build.deckY * VOXEL_SIZE * 0.95;
      const zC = (this.build.grid.dims[2] / 2) * VOXEL_SIZE;
      const box = {
        min: { x: sternX - bladeW - 0.4, y: 0.1, z: zC - 0.45 },
        max: { x: sternX + 0.3, y: 1.8 + bladeH * 0.55, z: zC + 0.45 },
      };
      if (segmentBoxHit(p0, p1, box)) stop = { kind: "rudder" };
    }
    return { sails, stop };
  }
```

Remove the now-unused `segmentMastHit` import from `ship.ts` (keep `segmentBoxHit`, `segmentSailHit`).

- [ ] **Step 4: Update `cannons.ts`**

In `src/game/cannons.ts`, the rig-stop block becomes rudder-only:

```ts
        if (rig.stop) {
          ship.hitRudder();
          this.effects.splinters(b.pos, this.tmpDir.copy(b.vel).normalize().negate());
          this.kill(b);
          stopped = true;
          break;
        }
```

- [ ] **Step 5: Type-check + tests**

Run: `npx tsc --noEmit`
Expected: no errors. (If `tests/rigDamage.test.ts` asserted a mast cylinder stop via `segmentMastHit`, keep the pure-function test — the function still exists — but remove any test that drove `ship.hitMast`, which is gone.)

Run: `npm run test -- connectivity rigDamage`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/game/ship.ts src/game/cannons.ts tests/connectivity.test.ts
git commit -m "feat(ship): masts take voxel damage; remove analytic mast HP path"
```

---

## Task 8: Render — delete spar meshes, re-anchor sails, drop sails on fell

**Files:**
- Modify: `src/render/shipVisual.ts` (`addRig`, `animate`, `fellMast`, fields)

The masts/yards/bowsprit are now voxels (meshed by the chunk pipeline). Remove their meshes and the topple animation. Keep the cloth sails — but build them from `build.masts[mi].yards` and parent each mast's sails under a `sailGroup` that drops when the mast is felled. Keep the wheel and ladder.

- [ ] **Step 1: Re-anchor the sails to the descriptor**

In `addRig`, delete the `const mast = new THREE.Mesh(new THREE.CylinderGeometry(...))` creation and `mastGroup.add(mast)`, delete the yards loop (`for (const lv of levels) { ... yard ... }`), and delete the bowsprit (`sprit`) block at the end. Replace the per-mast `levels` array with the descriptor:

```ts
    this.build.masts.forEach((m, mi) => {
      const deckTop = (m.footY) * VOXEL_SIZE;
      const mx = (m.x + 0.5) * VOXEL_SIZE;
      const mz = (this.build.grid.dims[2] / 2) * VOXEL_SIZE; // centerline (matches voxel mast)

      // a group holding ONLY this mast's cloth sails; dropped when the mast falls
      const sailGroup = new THREE.Group();
      this.group.add(sailGroup);
      const df = new THREE.Vector3(-0.4, 0, mi % 2 === 0 ? 1 : -1).normalize();
      this.mastRigs.push({
        group: sailGroup,
        fallT: -1,
        fallAxis: new THREE.Vector3(df.z, 0, -df.x),
      });

      const yardR = 0.12;
      const mastR = 0.11;
      const sailOff = mastR + yardR * 1.4; // cloth just forward of the voxel mast
      const levels = m.yards.map((y) => ({ y: y.yM, w: y.halfSpanM * 2 }));
      for (let i = 0; i < levels.length - 1; i++) {
        const foot = levels[i];
        const head = levels[i + 1];
        const h = head.y - foot.y - 0.12;
        const geo = new THREE.PlaneGeometry(foot.w, h, 14, 10);
        const pos = geo.attributes.position as THREE.BufferAttribute;
        for (let vi = 0; vi < pos.count; vi++) {
          const f = (pos.getY(vi) + h / 2) / h;
          pos.setX(vi, pos.getX(vi) * (1 - f + (f * head.w) / foot.w));
        }
        geo.rotateY(Math.PI / 2);
        const bellyArr = new Float32Array(pos.count).fill(foot.w * 0.17);
        geo.setAttribute("aBelly", new THREE.BufferAttribute(bellyArr, 1));

        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const cctx = canvas.getContext("2d")!;
        cctx.fillStyle = "#fff";
        cctx.fillRect(0, 0, 128, 128);
        const tex = new THREE.CanvasTexture(canvas);
        const mat = newSailMaterial();
        mat.alphaMap = tex;
        mat.alphaTest = 0.45;

        const sail = new THREE.Mesh(geo, mat);
        // sailGroup sits at origin, so position the sail in ship-local space
        sail.position.set(mx + sailOff, deckTop + (foot.y + head.y) / 2, mz);
        sail.castShadow = true;
        sailGroup.add(sail);

        this.sails.push({
          mesh: sail,
          mastIdx: mi,
          planeX: mx + sailOff,
          yMin: deckTop + foot.y,
          yMax: deckTop + head.y,
          zMin: mz - foot.w / 2,
          zMax: mz + foot.w / 2,
          canvas,
          tex,
        });
      }
    });
```

> Keep the existing `woodMat`/`rigTex` (still used by the wheel + ladder), `sailUniforms`, `injectBillow`, and `newSailMaterial` definitions above this block. The rudder, wheel, ladder code below stays unchanged.

- [ ] **Step 2: Drop the sails when the mast falls**

`mastRigs` now holds the per-mast `sailGroup`. The existing `animate` fall loop already tips `rig.group` over `rig.fallAxis` and sinks it — that now drops the **cloth** (the timber falls as real debris separately). Adjust the fall loop to also fade and fully remove after the fall:

In `animate`, replace the felled-mast loop body with:

```ts
    for (const rig of this.mastRigs) {
      if (rig.fallT < 0) continue;
      rig.fallT += dt;
      const ang = Math.min(rig.fallT * rig.fallT * 1.1, 1.62);
      rig.group.quaternion.setFromAxisAngle(rig.fallAxis, ang);
      if (rig.fallT > 1.5) rig.group.position.y -= dt * 2.0; // cloth slides into the sea
      if (rig.fallT > 6) rig.group.visible = false;
    }
```

`fellMast(mi)` is unchanged (sets `mastRigs[mi].fallT = 0`). `chipRudder`, `puncture`, the barrels loop, etc. stay as they are.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (Remove any now-unused locals the compiler flags, e.g. an orphaned `mastH`/`mastGroup`/`spritLen`.)

- [ ] **Step 4: In-browser smoke**

Run the dev server (`npm run dev`) and load `http://localhost:5173` in a normal browser (or Playwright). Confirm: both ships show blocky voxel masts/yards/bowsprit continuous with the hull; the sails still hang in place; the wheel and rudder still look right.

- [ ] **Step 5: Commit**

```bash
git add src/render/shipVisual.ts
git commit -m "feat(render): masts/yards/bowsprit are voxels; sails re-anchored + drop on fell"
```

---

## Task 9: Re-tune ballast for the added rig mass; verify float & stability

**Files:**
- Modify: `src/sim/shipwright.ts` (iron ballast tiers / `AFT` shift in both builders)
- Test: `tests/stability.test.ts`, `tests/draft.test.ts`, `tests/shipwright.test.ts`

The rig adds mass high up (no rig buoyancy), lowering GM and shifting trim. Re-tune until the regression gates pass and in-browser behaviour is right.

- [ ] **Step 1: Establish the failing state**

Run: `npm run test -- stability draft shipwright`
Expected: note which assertions fail (likely `GM > 0.15`, the upright-trim torque, and/or the draft band, and the sloop "average density below seawater" if mass rose a lot). These are the targets.

- [ ] **Step 2: Re-tune the ballast**

In `buildSloop` and `buildBrig`, adjust the iron ballast to restore a low COM and level trim. Levers, in order of preference:
1. **Trim:** the sloop's single mast sits forward (≈0.42 L) → bias ballast slightly forward (reduce the `AFT` shift, currently `0.1`) to counter bow-down trim. The brig's two masts roughly balance; adjust its t-band centres only if `draft`/upright-trim fail.
2. **GM:** if GM dropped below 0.15, add a low ballast course (extend a `ballastZ` tier one cell deeper or widen a low tier) — mass added LOW raises GM. Do NOT add high tiers.
3. Keep total mass under the `shipwright` density ceiling (`< 0.68 * envelopeVolume * WATER_DENSITY`).

Make ONE change at a time and re-run the gate (Step 3). Example first move for the sloop (tune the value empirically):

```ts
  const AFT = 0.06; // was 0.10 — the forward mast pulls the COM forward; ease the aft shift
```

- [ ] **Step 3: Re-run the regression gates after each change**

Run: `npm run test -- stability draft shipwright brig`
Expected (target): all PASS — floats at draft, near-zero upright trim torque, GM ≥ 0.15 at 5°, restoring at 15°.

- [ ] **Step 4: In-browser verification (both ships)**

Start `npm run dev`. Using the Playwright/readback approach (per the project's GPU-verification note), at `http://localhost:5173`:
- Confirm both hulls float at a believable waterline (~0.45 draft), sitting **level** (no persistent bow/stern dip) at rest.
- Sail up to full and put the helm hard over — confirm she heels and **rights**, never turtles.
- Read back `ship.submergedFrac` / pose via `window.DEBUG` if needed to confirm numbers, not just the picture.

Document the readings briefly in `docs/superpowers/notes/` if they're non-obvious.

- [ ] **Step 5: Commit**

```bash
git add src/sim/shipwright.ts tests/stability.test.ts tests/draft.test.ts
git commit -m "tune(shipwright): re-balance ballast for voxel rig mass"
```

---

## Task 10: Full verification — shoot a mast down

**Files:** none (verification only)

- [ ] **Step 1: Full test suite + type-check**

Run: `npx tsc --noEmit && npm run test`
Expected: all green.

- [ ] **Step 2: In-browser destruction check**

Start `npm run dev`. At `http://localhost:5173`:
- Fire at the enemy's mast mid-height — confirm voxels are carved out (a visible notch/hole), not an HP bar.
- Blow out a mast's base — confirm the upper mast + yards **break off and fall into the sea as debris** (a tumbling voxel chunk that floats then sinks), the cloth sails drop, and that mast stops driving the ship (speed/heel respond).
- Walk the player deck into a standing mast — confirm you **cannot** pass through it.
- Confirm the ocean waterline around both hulls is unchanged (no new void or sliver).

- [ ] **Step 3: Update memory + worklog**

Add a short entry to `docs/superpowers/notes/overnight-progress.md` (or the current worklog) summarising: voxel masts/yards/bowsprit shipped on both ships, real spar mass + ballast re-tune values, analytic mast HP path removed, fell→debris path. Note the deferred follow-up: **rotating voxel rudder**.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "docs: log voxel-masts completion; note rudder follow-up"
```

---

## Self-review notes (coverage check)
- Spec "spars in main grid / reuse sever→debris" → Tasks 4,5,7 (+ connectivity test).
- Spec "SPAR solid-for-structure, skip-for-buoyancy" → Tasks 1,2.
- Spec "single source of truth descriptor" → Task 3 (consumed in 5,8).
- Spec "delete mast meshes + topple; re-anchor sails; drop on fell" → Task 8.
- Spec "drop mast colliders; trunk fell-detect; rigImpacts mast removal; cannons" → Task 7.
- Spec "decouple collider + inertia from ny" → Task 6.
- Spec "real mass + ballast re-tune + verify" → Task 9.
- Spec acceptance criteria → Task 10.
- Deferred by user decision (NOT in this plan): rotating voxel rudder, voxel wheel, voxel ladder.
