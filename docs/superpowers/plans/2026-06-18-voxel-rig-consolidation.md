# Voxel Rig Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the ship's masts, yards, sails and bowsprit into the voxel grid and delete the parallel mesh + lattice rig systems, so cannon-puncture, severing, falling and ram-bore all reuse the one voxel-destruction rule.

**Architecture:** Extend the shipwright's mast-stamp pass into a full `stampRig` (2×2 `SPAR` trunk, 1-thick `SPAR` yards, 1-thin `CANVAS` sail sheets, a thick `SPAR` bowsprit). Sail thrust integrity is derived from surviving canvas voxels. The voxel mesher draws the rig; the existing `findSevered`/`debris.spawnMast` shed it; the existing `boreCells`/`crush` punctures it. The mesh/lattice rig (`game/rig.ts`, `sim/rigLattice.ts`, `sim/rigBuild.ts`, `render/rigVisual.ts`, the sail/mast tests in `sim/rigDamage.ts`, and shipVisual's mesh rig) is removed. Cannons, helm wheel and rudder stay meshes.

**Tech Stack:** TypeScript, Three.js, Rapier3D (compat), Vite, Vitest. Deterministic sim in `src/sim/` (the test oracle); render in `src/render/`; game glue in `src/game/`. Tests in `tests/` (vitest), run with `npm run test`; type-check + build with `npm run build`.

**Spec:** `docs/superpowers/specs/2026-06-18-voxel-rig-consolidation-design.md`

**Conventions for every task below:**
- Run `npm run build` (= `tsc --noEmit && vite build`) AND `npm run test` (= `vitest run`) before each commit; both MUST be green. `npm run test` does NOT type-check, so the build step is what catches type errors.
- Work on `main`, commit per task, and `git push origin main` after the suite is green (project workflow: the user tests on Vercel, which serves only pushed `main`). Stage only the files you touched.
- `VOXEL_SIZE` is `0.25` (m). `cz = (nz - 1) / 2` is the centerline; the mirror pair is `{Math.floor(cz), Math.ceil(cz)}` (sums to `nz-1` → port/starboard symmetric).

---

## Task 1: Add the `CANVAS` material

Cloth as a near-massless, easily-torn voxel so big sail areas up high don't capsize her (LAW #2/#3) and a ball blows straight through.

**Files:**
- Modify: `src/sim/materials.ts`
- Test: `tests/materials.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/materials.test.ts` (inside the existing top-level `describe`, or append a new one):

```ts
import { MATERIALS, CANVAS, SPAR, OAK, breakEnergy } from "../src/sim/materials";

describe("CANVAS material (voxel sail cloth)", () => {
  it("exists, is near-massless and tears far more easily than wood", () => {
    const canvas = MATERIALS[CANVAS];
    expect(canvas).toBeDefined();
    // a ~1 mm cloth sheet inside a 0.25 m voxel is nearly weightless vs spar (120) / oak (430)
    expect(canvas.density).toBeLessThan(20);
    expect(canvas.density).toBeGreaterThan(0);
    // far softer than oak (3) and spar (1.5): a ball punches straight through
    expect(breakEnergy(CANVAS)).toBeLessThan(breakEnergy(SPAR));
    expect(MATERIALS[CANVAS].strength).toBeLessThan(MATERIALS[OAK].strength);
    // a light, distinct off-white colour (lighter than spar brown)
    const [r, g, b] = canvas.color;
    expect(r + g + b).toBeGreaterThan(MATERIALS[SPAR].color.reduce((a, c) => a + c, 0));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- materials`
Expected: FAIL — `CANVAS` is not exported / `MATERIALS[CANVAS]` is undefined.

- [ ] **Step 3: Add the material**

In `src/sim/materials.ts`, add the id export next to `SPAR`:

```ts
export const CANVAS = 14; // sail cloth — VOXEL sails (near-massless, easily torn). See MATERIALS below.
```

Then add the table entry inside `MATERIALS` (after the `[SPAR]` entry):

```ts
  // VOXEL SAILS (cloth). Sails are now real grid voxels (sim/shipwright stampRig): a 1-voxel-thin
  // CANVAS sheet between the yards. A cannonball bores clean holes through it (it adds almost no ram
  // resistance), and a felled mast/yard sheds its cloth as a severed voxel island — one destruction
  // rule for the whole rig. CRITICAL (THE LAW #2/#3): a sail is a LARGE flat area high above the
  // waterline (pure topweight — buoyancy only lifts SUBMERGED voxels), so it must be near-massless or
  // it raises the COM and capsizes her under sail. A real sail occupying a 0.25 m voxel is a ~1 mm
  // cloth sheet → effective density ~8 kg/m³ (cloth ≈1500 × 0.001/0.25). STRENGTH 0.4 = far below oak
  // (3): the ball tears through. Colour: light weathered off-white canvas.
  [CANVAS]: { name: "canvas", density: 8, color: [0.16, 0.15, 0.12], strength: 0.4 },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- materials`
Expected: PASS.

- [ ] **Step 5: Build + full suite, then commit**

```bash
npm run build && npm run test
git add src/sim/materials.ts tests/materials.test.ts
git commit -m "feat(rig): add near-massless CANVAS material for voxel sails"
git push origin main
```

---

## Task 2: Rename `stampMasts` → `stampRig`, thicken the trunk to 2×2, and add a `sailVoxels` build field

Evolve the stamp into the rig's single entry point. This task only changes the trunk to 2×2 and threads a (still-empty) `sailVoxels` through the build; yards/sails/bowsprit arrive in Tasks 3–5.

**Files:**
- Modify: `src/sim/shipwright.ts` (the `stampMasts` function + the `ShipBuild` interface + every builder's call site + returned object)
- Test: `tests/mastVoxels.test.ts`

- [ ] **Step 1: Update the test for a 2×2 trunk**

In `tests/mastVoxels.test.ts`, the "stamps a real SPAR voxel trunk" test currently assumes a 1×2 (z-pair only) column. Replace that `it(...)` block with:

```ts
    it("stamps a real 2x2 SPAR voxel trunk per mast, rising off the deck", () => {
      expect(b.mastVoxels.length).toBe(b.masts.length);
      for (let mi = 0; mi < b.masts.length; mi++) {
        const cells = b.mastVoxels[mi];
        expect(cells.length).toBeGreaterThan(8); // a meaningful 2x2 trunk
        for (const c of cells) expect(b.grid.get(c.x, c.y, c.z)).toBe(SPAR);
        // 2 distinct x and 2 distinct z columns => a 2x2 trunk cross-section
        const xs = new Set(cells.map((c) => c.x));
        const zs = new Set(cells.map((c) => c.z));
        expect(xs.size).toBe(2);
        expect(zs.size).toBe(2);
        // still a substantial breakable tower (whole mast, or capped at the grid top on big hulls)
        const ys = cells.map((c) => c.y);
        const span = (Math.max(...ys) - Math.min(...ys) + 1) * VOXEL_SIZE;
        const top = Math.max(...ys);
        const cappedAtGridTop = top >= b.grid.dims[1] - 2;
        expect(span >= b.masts[mi].h * 0.8 || (cappedAtGridTop && span >= 12)).toBe(true);
      }
    });
```

The two sever tests in that file remove "every cell at `baseY`/`midY`"; a 2×2 trunk has 4 cells per layer instead of 2, and those tests already iterate ALL cells at the chosen y — they keep working unchanged.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- mastVoxels`
Expected: FAIL — `xs.size` is 1 (the trunk is currently 1 cell in x).

- [ ] **Step 3: Rename + thicken the stamp**

In `src/sim/shipwright.ts`, replace the whole `stampMasts` function with `stampRig` (keep its doc-comment intent; the 2×2 change is the `xPair` loop). The bowsprit param is declared now but unused until Task 5:

```ts
export interface BowspritSpec {
  lengthM: number;      // bowsprit length (m); the builder passes ≈0.28 × hull length
  steeve?: number;      // radians above horizontal (default 0.3)
  diameterVox?: number; // cross-section diameter in voxels (default 3)
}

type RigCell = { x: number; y: number; z: number };

/**
 * Stamp the whole rig as grid voxels: a 2×2 SPAR trunk per mast (Task 2), 1-thick SPAR yards +
 * 1-thin CANVAS sails (Tasks 3–4), and a thick SPAR bowsprit (Task 5). One face-connected island
 * anchored through the deck to the keel, so the unified crush + 18-connectivity sever break and fell
 * it with no rig-specific code. Returns the SPAR mast voxels and the CANVAS sail voxels per mast.
 * Run BEFORE weldToSingleComponent, AFTER castFlatBallast. Deterministic integer math.
 */
function stampRig(
  grid: VoxelGrid,
  masts: { x: number; z: number; h: number }[],
  deckYAt: (x: number) => number,
  bowsprit?: BowspritSpec,
): { mastVoxels: RigCell[][]; sailVoxels: RigCell[][] } {
  const [nx, ny, nz] = grid.dims;
  const cz = (nz - 1) / 2;
  const zPair = [Math.floor(cz), Math.ceil(cz)]; // mirror pair (sum = nz−1)
  const mastVoxels: RigCell[][] = [];
  const sailVoxels: RigCell[][] = [];

  for (const m of masts) {
    const mastCells: RigCell[] = [];
    const sailCells: RigCell[] = []; // filled in Task 4
    const yBase = deckYAt(m.x) + 1;
    const hVox = Math.max(1, Math.round(m.h / VOXEL_SIZE));
    const xPair = [m.x, Math.min(m.x + 1, nx - 1)]; // 2 voxels in x → a 2×2 trunk with zPair

    // --- trunk (2×2) ---
    for (let i = 0; i < hVox; i++) {
      const y = yBase + i;
      if (y >= ny) break;
      for (const x of xPair) {
        for (const z of zPair) {
          if (grid.get(x, y, z) === EMPTY) {
            grid.set(x, y, z, SPAR);
            mastCells.push({ x, y, z });
          }
        }
      }
    }

    // --- yards + sails arrive in Tasks 3 & 4 (insert here) ---

    mastVoxels.push(mastCells);
    sailVoxels.push(sailCells);
  }

  return { mastVoxels, sailVoxels };
}
```

- [ ] **Step 4: Add `sailVoxels` to `ShipBuild` and update every builder**

In the `ShipBuild` interface (near the top of `shipwright.ts`, where `mastVoxels` is declared), add right after `mastVoxels`:

```ts
  /** Per mast: the CANVAS sail voxels stamped for it (sim/shipwright stampRig), keel→top. Masts'
   *  sails are real grid voxels now; ship derives sailIntegrity from how many still survive. */
  sailVoxels: { x: number; y: number; z: number }[][];
```

In EACH builder (`buildCutter`, `buildSloop`, `buildBrig`, `buildFrigate`, `buildManOfWar`), find the line `const mastVoxels = stampMasts(grid, masts, <accessor>);` and replace it with the form below, keeping that builder's existing deck accessor verbatim — cutter/sloop pass `() => deckY`, brig/frigate/MoW pass `deckYAt`:

```ts
  // cutter / sloop:
  const { mastVoxels, sailVoxels } = stampRig(grid, masts, () => deckY, { lengthM: Math.min(0.28 * L * VOXEL_SIZE, 9) });
  // brig / frigate / man-o-war:
  const { mastVoxels, sailVoxels } = stampRig(grid, masts, deckYAt, { lengthM: Math.min(0.28 * L * VOXEL_SIZE, 9) });
```

`lengthM` is the BOWSPRIT length (≈0.28 × hull length, capped at 9 m so the fixed forward grid margin in Task 5 always contains it). Then in that builder's returned object literal, add `sailVoxels,` next to the existing `mastVoxels,`.

- [ ] **Step 5: Verify the suite (build catches every missed call site)**

Run: `npm run build` then `npm run test -- mastVoxels`
Expected: build PASS (all 5 builders updated + interface satisfied); mastVoxels test PASS.

- [ ] **Step 6: Commit**

```bash
npm run build && npm run test
git add src/sim/shipwright.ts tests/mastVoxels.test.ts
git commit -m "feat(rig): stampRig with a 2x2 SPAR trunk + sailVoxels build field"
git push origin main
```

---

## Task 3: Stamp the yards as 1-thick SPAR voxels

Three horizontal yard bars per mast, in the mast's x-plane, face-connected to the trunk so they sever with it.

**Files:**
- Modify: `src/sim/shipwright.ts` (`stampRig`)
- Test: `tests/mastVoxels.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the `describe(\`voxel masts: ${name}\`, ...)` loop in `tests/mastVoxels.test.ts`:

```ts
    it("stamps 1-thick SPAR yards spanning the centerline at each level", () => {
      // a yard is a horizontal bar of SPAR in the mast x-plane, wider than the 2-cell trunk.
      const cells = b.mastVoxels[0];
      const trunkZ = new Set(cells.filter((c) => true).map((c) => c.z));
      // group spar cells by y; at least 3 y-levels must be WIDER in z than the 2-cell trunk (the yards)
      const byY = new Map<number, Set<number>>();
      for (const c of cells) { (byY.get(c.y) ?? byY.set(c.y, new Set()).get(c.y)!).add(c.z); }
      const wideLevels = [...byY.values()].filter((zs) => zs.size > 2).length;
      expect(wideLevels).toBeGreaterThanOrEqual(3);
      // yards stay mirror-symmetric about the centerline (port == starboard)
      for (const [, zs] of byY) {
        if (zs.size <= 2) continue;
        for (const z of zs) expect(zs.has(b.grid.dims[2] - 1 - z)).toBe(true);
      }
      expect(trunkZ.size).toBeGreaterThan(0);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- mastVoxels`
Expected: FAIL — only the 2-cell trunk exists, so `wideLevels` is 0.

- [ ] **Step 3: Add the yard stamping**

In `stampRig`, replace the `// --- yards + sails arrive ... ---` placeholder comment with the yard block (sails still come in Task 4). Add this module constant near the top of `shipwright.ts` (mirrors the old `rigBuild` layout):

```ts
// Rig yard geometry: per level, fraction-of-mast-height for the y-position and the yard's z-width.
const YARD_LEVELS = [
  { f: 0.17, wf: 0.71 },
  { f: 0.56, wf: 0.57 },
  { f: 0.88, wf: 0.43 },
];
```

Yard block (insert at the placeholder, inside the `for (const m of masts)` loop, after the trunk loop):

```ts
    // --- yards: 1-thick SPAR bars across the centerline, in the mast x-plane (x = m.x) ---
    const yardZsByLevel: { yv: number; zs: number[] }[] = [];
    for (const lv of YARD_LEVELS) {
      const yv = yBase + Math.min(Math.round(lv.f * hVox), hVox - 1);
      if (yv >= ny) continue;
      const halfW = Math.max(0, Math.round((lv.wf * m.h) / VOXEL_SIZE / 2));
      const zs: number[] = [];
      // symmetric span: the two centreline cells + halfW pairs out to each side
      for (let k = halfW; k >= 0; k--) { zs.push(zPair[0] - k); }
      for (let k = 0; k <= halfW; k++) { zs.push(zPair[1] + k); }
      for (const z of zs) {
        if (z < 0 || z >= nz) continue;
        if (grid.get(m.x, yv, z) === EMPTY) {
          grid.set(m.x, yv, z, SPAR);
          mastCells.push({ x: m.x, y: yv, z });
        }
      }
      yardZsByLevel.push({ yv, zs }); // Task 4 fills the bays between consecutive yards
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- mastVoxels`
Expected: PASS — ≥3 wide, symmetric yard levels.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run test
git add src/sim/shipwright.ts tests/mastVoxels.test.ts
git commit -m "feat(rig): stamp 1-thick SPAR yards into the grid"
git push origin main
```

---

## Task 4: Stamp the sails as 1-thin CANVAS sheets

Fill each bay between consecutive yards with `CANVAS`, connected to the yards top and bottom, recorded in `sailVoxels`.

**Files:**
- Modify: `src/sim/shipwright.ts` (`stampRig`)
- Test: `tests/mastVoxels.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the same `describe` loop in `tests/mastVoxels.test.ts` (import `CANVAS`):

```ts
    it("stamps CANVAS sail sheets that fall when the mast base is shot out", () => {
      const fresh = build();
      const sail = fresh.sailVoxels[0];
      expect(sail.length).toBeGreaterThan(10); // a real sheet of cloth voxels
      for (const c of sail) expect(fresh.grid.get(c.x, c.y, c.z)).toBe(CANVAS);
      // sail voxels sit in the mast's x-plane and are mirror-symmetric about the centerline
      for (const c of sail) expect(fresh.grid.get(c.x, c.y, fresh.grid.dims[2] - 1 - c.z)).toBe(CANVAS);
      // shoot out the trunk base → the whole rig (incl. canvas) severs off as one island
      const base = fresh.mastVoxels[0];
      const baseY = Math.min(...base.map((c) => c.y));
      for (const c of base) if (c.y === baseY) fresh.grid.remove(c.x, c.y, c.z);
      const severed = findSevered(fresh.grid, keelAnchor(fresh)).flatMap((i) => i.cells);
      for (const c of sail) {
        expect(severed.some((s) => s.x === c.x && s.y === c.y && s.z === c.z)).toBe(true);
      }
    });
```

Add `CANVAS` to the materials import at the top of the file: `import { SPAR, CANVAS } from "../src/sim/materials";`

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- mastVoxels`
Expected: FAIL — `sailVoxels[0]` is empty.

- [ ] **Step 3: Add the sail stamping**

Add `CANVAS` to the materials import at the top of `shipwright.ts` (`import { EMPTY, IRON, OAK, PINE, RAM, SPAR, CANVAS } from "./materials";`). Then, in `stampRig`, immediately AFTER the yard `for (const lv of YARD_LEVELS)` loop (and still inside `for (const m of masts)`), insert:

```ts
    // --- sails: 1-thin CANVAS sheets filling each bay between consecutive yards (x = m.x) ---
    for (let s = 0; s + 1 < yardZsByLevel.length; s++) {
      const lo = yardZsByLevel[s], hi = yardZsByLevel[s + 1];
      const zMin = Math.min(...lo.zs, ...hi.zs);
      const zMax = Math.max(...lo.zs, ...hi.zs);
      for (let y = lo.yv + 1; y < hi.yv; y++) {
        // taper the bay width linearly from the lower yard to the upper yard
        const f = (y - lo.yv) / (hi.yv - lo.yv);
        const halfLo = (Math.max(...lo.zs) - Math.min(...lo.zs)) / 2;
        const halfHi = (Math.max(...hi.zs) - Math.min(...hi.zs)) / 2;
        const half = halfLo + (halfHi - halfLo) * f;
        const z0 = Math.round(cz - half), z1 = Math.round(cz + half);
        for (let z = Math.max(0, z0); z <= Math.min(nz - 1, z1); z++) {
          if (grid.get(m.x, y, z) === EMPTY) { // never overwrite the trunk/yards it laces to
            grid.set(m.x, y, z, CANVAS);
            sailCells.push({ x: m.x, y, z });
          }
        }
      }
      void zMin; void zMax;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- mastVoxels`
Expected: PASS — canvas exists, is symmetric, and severs with the mast.

- [ ] **Step 5: Commit**

```bash
npm run build && npm run test
git add src/sim/shipwright.ts tests/mastVoxels.test.ts
git commit -m "feat(rig): stamp 1-thin CANVAS sail sheets between the yards"
git push origin main
```

---

## Task 5: Stamp the bowsprit as a thick SPAR cylinder + give the grid forward room

A voxel-rasterized angled spar spiking forward of the bow. Each builder's grid gains a forward x-margin so the spar fits; the hull stamping is unchanged (the margin is empty +x cells where the bow points).

**Files:**
- Modify: `src/sim/shipwright.ts` (`stampRig` bowsprit branch + each builder's `nx`)
- Test: `tests/mastVoxels.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the same `describe` loop in `tests/mastVoxels.test.ts`:

```ts
    it("stamps a thick SPAR bowsprit spiking forward of the bow", () => {
      // find the bow stem: the max solid x at/over the deck band
      const [gx, gy, gz] = b.grid.dims;
      let hullMaxX = 0;
      for (let x = gx - 1; x >= 0 && hullMaxX === 0; x--)
        for (let y = 0; y < gy && hullMaxX === 0; y++)
          for (let z = 0; z < gz; z++)
            if (b.grid.get(x, y, z) === 1 /*OAK*/) { hullMaxX = x; break; }
      // there must be SPAR voxels forward of the hull stem (the bowsprit reaches past the bow)
      let spritCells = 0;
      for (let x = hullMaxX + 1; x < gx; x++)
        for (let y = 0; y < gy; y++)
          for (let z = 0; z < gz; z++)
            if (b.grid.get(x, y, z) === SPAR) spritCells++;
      expect(spritCells).toBeGreaterThan(10);
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- mastVoxels`
Expected: FAIL — no SPAR forward of the hull yet.

- [ ] **Step 3: Add the forward grid margin in every builder**

At the top of `shipwright.ts` add:

```ts
/** Empty voxels added to the +x (bow) end of every hull grid so the forward-raking bowsprit fits.
 *  Covers a capped 9 m bowsprit (≈36 voxels) at the 0.3-rad steeve, plus the heel inset + slack. */
export const BOWSPRIT_MARGIN_VOX = 44;
```

In EACH builder, change the grid width allocation from `const nx = <value>;` to `const nx = <value> + BOWSPRIT_MARGIN_VOX;`. The hull rasterization uses `x0`/`L` (unchanged), so the hull is identical; only empty bow-side cells are added.

- [ ] **Step 4: Add the bowsprit branch to `stampRig`**

After the `for (const m of masts)` loop in `stampRig` (just before `return`), insert:

```ts
  // --- bowsprit: a thick SPAR spar raking up & forward off the bow stem ---
  if (bowsprit) {
    const steeve = bowsprit.steeve ?? 0.3;
    const diam = bowsprit.diameterVox ?? 3;
    const rad = Math.floor(diam / 2);
    // locate the bow stem: the highest-x solid hull cell, and the deck-ish y there.
    let stemX = 0, stemY = 0;
    for (let x = nx - 1; x >= 0 && stemX === 0; x--) {
      for (let y = ny - 1; y >= 0; y--) {
        let hit = false;
        for (let z = 0; z < nz; z++) if (grid.isSolid(x, y, z)) { hit = true; break; }
        if (hit) { stemX = x; stemY = y; break; }
      }
    }
    const heelX = stemX - 2;                 // root a little inboard so it ties into the bow
    const lenVox = Math.round(bowsprit.lengthM / VOXEL_SIZE);
    const dxv = Math.cos(steeve), dyv = Math.sin(steeve);
    const samples = Math.max(1, lenVox);
    const czi0 = Math.floor(cz), czi1 = Math.ceil(cz);
    for (let s = 0; s <= samples; s++) {
      const cxf = heelX + dxv * s;
      const cyf = stemY + dyv * s;
      const cxi = Math.round(cxf), cyi = Math.round(cyf);
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dy * dy + dz * dz > rad * rad + 1) continue; // round the square toward a cylinder
          const y = cyi + dy;
          // keep the cross-section mirror-symmetric about the centreline pair
          for (const zc of [czi0, czi1]) {
            const z = zc + dz;
            if (cxi < 0 || cxi >= nx || y < 0 || y >= ny || z < 0 || z >= nz) continue;
            if (grid.get(cxi, y, z) === EMPTY) grid.set(cxi, y, z, SPAR);
          }
        }
      }
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- mastVoxels`
Expected: PASS — >10 SPAR cells forward of the bow.

- [ ] **Step 6: Build + full suite + commit**

```bash
npm run build && npm run test
git add src/sim/shipwright.ts tests/mastVoxels.test.ts
git commit -m "feat(rig): stamp a thick SPAR bowsprit + forward grid margin"
git push origin main
```

---

## Task 6: Stability gate — verify GM, tune CANVAS/SPAR density if needed

The full voxel rig adds topweight; the float/restoring-torque tests are the guard. This task adds NO feature code — it confirms the rig didn't capsize her and tunes density if it did.

**Files:**
- Possibly modify: `src/sim/materials.ts` (only if a GM test regresses)
- Test: `tests/manOfWarFloat.test.ts` and any sibling float/GM tests

- [ ] **Step 1: Run the stability + float tests**

Run: `npm run test -- manOfWarFloat brig`
Expected: PASS — `heeling 5°/15° produces a RESTORING torque (positive GM)` and the draft-ratio test stay green.

- [ ] **Step 2: Run the WHOLE suite**

Run: `npm run test`
Expected: PASS (other than the rig-mesh/lattice tests still present — those are removed in Tasks 9 & 11; they should still pass for now since their code still exists).

- [ ] **Step 3: If any GM/float test FAILS, lower the topweight**

The lever is `MATERIALS[CANVAS].density` (Task 1) — halve it (e.g. 8 → 4) and re-run. If still failing, also confirm yards aren't over-wide (Task 3 `YARD_LEVELS` widths) and that `SPAR` density stays 120. Re-run Step 1 until green. Document the final density in a one-line code comment.

- [ ] **Step 4: Commit (only if density changed)**

```bash
npm run build && npm run test
git add src/sim/materials.ts
git commit -m "fix(rig): tune CANVAS density to keep positive GM under full voxel rig"
git push origin main
```

If nothing changed, skip the commit and note "stability green, no tuning needed."

---

## Task 7: Derive `sailIntegrity` from surviving canvas voxels

Replace the analytic puncture accounting with a voxel count. The math lives in a PURE sim module (unit-testable without a Rapier body); `ship.updateMastState` calls it.

**Files:**
- Create: `src/sim/rigState.ts`
- Modify: `src/game/ship.ts`
- Test: `tests/rigState.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/rigState.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { CANVAS } from "../src/sim/materials";
import { survivingFraction, sailIntegrityValue } from "../src/sim/rigState";

describe("rig state (sail integrity)", () => {
  it("survivingFraction tracks how many cells still hold the material", () => {
    const g = createGrid(4, 1, 1);
    const cells = [0, 1, 2, 3].map((x) => ({ x, y: 0, z: 0 }));
    for (const c of cells) g.set(c.x, c.y, c.z, CANVAS);
    expect(survivingFraction(g, cells, CANVAS)).toBeCloseTo(1, 6);
    g.remove(0, 0, 0);
    g.remove(1, 0, 0);
    expect(survivingFraction(g, cells, CANVAS)).toBeCloseTo(0.5, 6);
    expect(survivingFraction(g, [], CANVAS)).toBe(1); // a mast with no canvas reads full
  });

  it("sailIntegrityValue is convex: a few holes barely matter, a peppered sail collapses", () => {
    expect(sailIntegrityValue(1)).toBeCloseTo(1, 6);
    expect(sailIntegrityValue(0.9)).toBeGreaterThan(0.95); // ~0.97
    expect(sailIntegrityValue(0.5)).toBeLessThan(0.3);     // ~0.25
    expect(sailIntegrityValue(0)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- rigState`
Expected: FAIL — `src/sim/rigState.ts` does not exist.

- [ ] **Step 3: Write the pure module**

Create `src/sim/rigState.ts`:

```ts
import type { VoxelGrid } from "./voxelGrid";

/** Fraction (0..1) of `cells` whose grid material still equals `mat` (1.0 for an empty list). */
export function survivingFraction(
  grid: VoxelGrid,
  cells: { x: number; y: number; z: number }[],
  mat: number,
): number {
  if (cells.length === 0) return 1;
  let alive = 0;
  for (const c of cells) if (grid.get(c.x, c.y, c.z) === mat) alive++;
  return alive / cells.length;
}

/** Thrust integrity from the surviving-canvas fraction. CONVEX (1 − 3·destroyed²) so a couple of
 *  holes barely scratch top speed (frac 0.9 → ~0.97) but a peppered sail collapses (frac 0.5 →
 *  ~0.25). Clamped 0..1; the caller forces 0 when the mast itself is down. */
export function sailIntegrityValue(survivingCanvasFrac: number): number {
  const destroyed = 1 - survivingCanvasFrac;
  return Math.min(Math.max(1 - destroyed * destroyed * 3, 0), 1);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- rigState`
Expected: PASS.

- [ ] **Step 5: Wire it into the ship**

In `src/game/ship.ts`, add the imports: `import { survivingFraction, sailIntegrityValue } from "../sim/rigState";` and add `CANVAS` to the materials import. Where `mastCells` is initialised from `build.mastVoxels` (constructor), add a sibling field + init from `build.sailVoxels`:

```ts
  /** Per mast: the CANVAS voxels stamped for its sails (from build.sailVoxels). A coord whose grid
   *  cell is no longer CANVAS has been shot/severed away — the live survivor count drives integrity. */
  private sailCells: { x: number; y: number; z: number }[][];
```

```ts
    this.sailCells = build.sailVoxels.map((cells) => cells.slice());
```

Then, inside `updateMastState`, set integrity from the survivors (replace the per-mast tail so it keeps the `mastTopY`/`mastAlive`/`onMastFelled` logic AND adds the integrity line):

```ts
      this.mastTopY[mi] = topY;
      const aliveNow = topY > -Infinity;
      if (this.mastAlive[mi] && !aliveNow) this.onMastFelled?.(mi);
      this.mastAlive[mi] = aliveNow;
      // sailIntegrity = surviving-canvas fraction (0 once the mast is down). Convex feel curve.
      this.sailIntegrity[mi] = aliveNow
        ? sailIntegrityValue(survivingFraction(grid, this.sailCells[mi], CANVAS))
        : 0;
```

(The old `this.sailIntegrity[mi] = 0` that was gated behind the alive→dead edge is now covered by the `: 0` branch every step — keep the `onMastFelled?.(mi)` on the edge as shown.)

- [ ] **Step 6: Build + suite + commit**

```bash
npm run build && npm run test
git add src/sim/rigState.ts src/game/ship.ts tests/rigState.test.ts
git commit -m "feat(rig): derive sailIntegrity from surviving CANVAS voxels (pure rigState)"
git push origin main
```

---

## Task 8: Cannons — delete the analytic sail/mast path, keep the voxel bore + the rudder stop

The voxel bore now punctures canvas and spar; only the (still-mesh) rudder needs the analytic test.

**Files:**
- Modify: `src/game/cannons.ts`, `src/game/ship.ts` (the `rigImpacts` method)
- Test: `tests/rigDamage.test.ts` (the rudder cases stay; sail/mast cases removed in Task 11)

- [ ] **Step 1: Simplify `ship.rigImpacts` to the rudder only**

In `src/game/ship.ts`, the `rigImpacts(...)` method currently returns every sail crossed plus the first hard stop. Change it to return an empty `sails` list and only the rudder stop (it still uses `segmentBoxHit` against the rudder-blade box). Concretely: delete the sail-rectangle loop and any `this.build.sails`/`SailRecord` usage inside it; keep the rudder-box test and its `{ kind: "rudder", ... }` stop. Leave the method signature shape (`{ sails, stop }`) intact so the cannon call site keeps compiling, with `sails` always `[]`.

- [ ] **Step 2: Remove the cannon's analytic sail/mast handling**

In `src/game/cannons.ts`, in the block that iterates `rig.sails` and calls `ship.visual.puncture` / `ship.hitSail`, and the `rig.stop.kind === "mast"` branch (around lines 285–298): delete the sail loop, the `hitSails` Set field + its `.clear()`/`.add()`/`.has()` uses, and the mast-stop branch. Keep the rudder-stop branch (`rig.stop.kind === "rudder"` → `ship.hitRudder()`), and keep the voxel bore (`ship.crush(this.boreCells(...))`) exactly as is — it now punctures the canvas/spar.

- [ ] **Step 3: Build + run the cannon/rig tests**

Run: `npm run build && npm run test -- cannon rigDamage`
Expected: build PASS; rudder cases PASS. (Type errors here usually mean a missed `SailRecord` reference — remove it.)

- [ ] **Step 4: Commit**

```bash
npm run build && npm run test
git add src/game/cannons.ts src/game/ship.ts
git commit -m "refactor(rig): cannon punctures sails via the voxel bore; analytic path gone"
git push origin main
```

---

## Task 9: Debris — float a severed CANVAS island, drop the mesh-clone coupling

A pure-cloth island (sail shot free of intact yards) must float as debris, not vanish; and the `mastRig` mesh param is obsolete.

**Files:**
- Modify: `src/game/debris.ts`, `src/main.ts`
- Test: `tests/wreck.test.ts` (routing) — add a CANVAS case

- [ ] **Step 1: Write the failing test**

In `tests/wreck.test.ts` (or wherever `routeIsland`/`islandHasSpar` are tested — grep for `routeIsland`), add:

```ts
import { routeIsland } from "../src/game/debris";
import { SPAR, CANVAS, OAK } from "../src/sim/materials";

describe("debris routing keeps rig pieces afloat", () => {
  const isl = (mat: number, n = 20) =>
    ({ cells: Array.from({ length: n }, (_, i) => ({ x: i, y: 0, z: 0, mat })) });
  it("a pure-CANVAS severed island floats (route 'mast'), not dust", () => {
    expect(routeIsland(isl(CANVAS))).toBe("mast");
  });
  it("a SPAR island still floats", () => {
    expect(routeIsland(isl(SPAR))).toBe("mast");
  });
  it("a small plain-OAK chip still dusts", () => {
    expect(routeIsland(isl(OAK))).toBe("dust");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- wreck`
Expected: FAIL — a CANVAS island routes to `dust`.

- [ ] **Step 3: Generalize the rig-content check**

In `src/game/debris.ts`, add `CANVAS` to the materials import, and broaden `islandHasSpar` (rename to `islandHasRig`, update its one caller in `routeIsland`):

```ts
/** Does a severed island contain any RIG material (mast/yard SPAR or sail CANVAS)? Such pieces take
 *  the persistent floating-body path regardless of size, while small plain-hull chips still dust. */
export function islandHasRig(island: Island): boolean {
  for (const c of island.cells) if (c.mat === SPAR || c.mat === CANVAS) return true;
  return false;
}
```

Update `routeIsland`: `if (islandHasRig(island)) return "mast";`. (If `islandHasSpar` is imported elsewhere, grep and update those imports; the export rename is the only breaking change.)

- [ ] **Step 4: Drop the obsolete mesh-clone wiring in `main.ts`**

In `src/main.ts`, delete the `mastClonesFor` helper (around lines 449–457) and change every `onSevered` handler from `islands.forEach((i) => debris.spawn(i, ship, mastClonesFor(ship, i)))` to:

```ts
  ship.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, ship));
```

(There are three: the initial player ship, the enemy-spawn path, and `swapPlayerShip`'s fresh hull — grep `mastClonesFor` to find all and remove each.) Then in `src/game/debris.ts`, drop the now-unused `mastRig` param from `spawn` and `spawnMast` (and the `cloneMastRig`-derived attach inside `spawnMast`); the canvas/yards are in the re-gridded voxel island already.

- [ ] **Step 5: Run the tests + build**

Run: `npm run build && npm run test -- wreck`
Expected: build PASS (no more `mastClonesFor`/`cloneMastRig`/`mastRig` references); routing tests PASS.

- [ ] **Step 6: Commit**

```bash
npm run build && npm run test
git add src/game/debris.ts src/main.ts tests/wreck.test.ts
git commit -m "feat(rig): float severed CANVAS islands; remove mesh-clone debris coupling"
git push origin main
```

---

## Task 10: Unwire the RigManager (bowsprit-bore lattice)

Ram-bore now emerges from `voxelContact` (the bowsprit is hull voxels). Remove the RigManager step from the world loop and its DEBUG/dev-panel hooks.

**Files:**
- Modify: `src/game/world.ts`, `src/main.ts`

- [ ] **Step 1: Remove RigManager from the world loop**

In `src/game/world.ts`: delete the `import { RigManager } from "./rig";`, the `readonly rig = new RigManager();` field, the `this.rig.scene = scene;` / `this.rig.waves = this.physWaves;` lines, the `this.rig.stepAll(...)` call in the fixed step, and the `this.rig.refresh();` call in the render-sync. (Grep `this.rig` / `rig` in this file to catch all.)

- [ ] **Step 2: Remove the main.ts hooks**

In `src/main.ts`: delete `world.rig.effects = effects;`, the `rig: world.rig,` entry in the `window.DEBUG` object, and the dev-panel "⛵ Voxel rig (masts/sails)" entry (grep `world.rig` and `Voxel rig`).

- [ ] **Step 3: Build (rig.ts still exists, so it compiles; it's just unreferenced now)**

Run: `npm run build && npm run test`
Expected: PASS. (`game/rig.ts` is now dead code; it's deleted in Task 11.)

- [ ] **Step 4: Commit**

```bash
git add src/game/world.ts src/main.ts
git commit -m "refactor(rig): unwire RigManager; ram-bore emerges from voxelContact"
git push origin main
```

---

## Task 11: Delete the lattice rig modules + their tests

**Files:**
- Delete: `src/game/rig.ts`, `src/sim/rigLattice.ts`, `src/sim/rigBuild.ts`, `src/render/rigVisual.ts`, `tests/rigLattice.test.ts`, `tests/rigBuild.test.ts`

- [ ] **Step 1: Confirm no remaining importers**

Run (grep): search the repo for `rigLattice`, `rigBuild`, `rigVisual`, `from "./rig"`, `from "../game/rig"`, `RigManager`, `RigPieceVisual`, `buildRig`.
Expected: only the files being deleted (and each other) reference these. If anything else does, fix it first (it shouldn't after Tasks 8 & 10).

- [ ] **Step 2: Delete the files**

```bash
git rm src/game/rig.ts src/sim/rigLattice.ts src/sim/rigBuild.ts src/render/rigVisual.ts tests/rigLattice.test.ts tests/rigBuild.test.ts
```

- [ ] **Step 3: Build + full suite**

Run: `npm run build && npm run test`
Expected: PASS — no dangling imports; test count drops by the two removed files.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(rig): delete the lattice rig modules (superseded by voxel rig)"
git push origin main
```

---

## Task 12: Strip the mesh rig from shipVisual + rigDamage; keep wheel/rudder

The voxel mesher draws masts/yards/sails/bowsprit now. Remove their mesh construction and the detach/clone/update plumbing.

**Files:**
- Modify: `src/render/shipVisual.ts`, `src/game/ship.ts`, `src/sim/rigDamage.ts`
- Test: `tests/rigDamage.test.ts` (drop sail/mast cases; keep `segmentBoxHit`)

- [ ] **Step 1: Remove the mesh rig construction + API from `shipVisual.ts`**

Delete: the mast-cylinder + yard-cylinder + sail-mesh construction in the constructor/`buildRig`-style helper (the `CylinderGeometry` mast ~line 992, yards ~1030, the sail mesh + `sails.push` ~1069–1075, and the bowsprit `spritMesh`); the `mastRigs`, `sails`, `spritMesh`, `sailUniforms` fields; the `SailRecord` interface/export; the methods `detachMast`, `cloneMastRig`, `updateRig`, `detachBowsprit`, `bowspritStanding`, `puncture`, `repairSails`; the sail material + `injectBillow`/`onBeforeCompile` sail shader; and the sail-uniform driving inside `animate()` (`this.sailUniforms` block ~274–277). KEEP the hull/iron materials, the rudder + helm-wheel meshes, and `setCutaway`.

- [ ] **Step 2: Fix the now-dangling calls in `ship.ts`**

In `src/game/ship.ts`:
- Delete the `this.visual.updateRig(this.mastTopY)` call (~line 1209). `mastTopY`/`mastCapped` are now written-but-unread (only the deleted `updateRig` consumed them); leave the fields (a written, unread private field is harmless to `tsc`) or remove them + their assignments if you prefer — either keeps the build green.
- Delete `hitSail`, `hitMast`, and `mastIndexForIsland` (they lost their callers in Tasks 8 & 9 — grep each to confirm zero references first). Keep `hitRudder`.
- **REWRITE `repairSails()` to regrow rig voxels** — it is still called by `port.ts applyRepair` (confirmed), so do NOT delete it. Replace its body with a grid re-stamp + remesh (and drop the old `this.visual.repairSails()` line, since that mesh method is deleted in Step 1):

```ts
  /** Port repair: re-grow every still-standing mast's shot-out trunk/yard/canvas voxels and restore
   *  its thrust. A mast that's by the board (mastAlive false) is NOT re-rigged. updateMastState
   *  recomputes integrity from the restored grid on the next flush. */
  repairSails(): void {
    const grid = this.build.grid;
    for (let mi = 0; mi < this.mastCells.length; mi++) {
      if (!this.mastAlive[mi]) continue;
      for (const c of this.mastCells[mi]) if (grid.get(c.x, c.y, c.z) === EMPTY) grid.set(c.x, c.y, c.z, SPAR);
      for (const c of this.sailCells[mi]) if (grid.get(c.x, c.y, c.z) === EMPTY) grid.set(c.x, c.y, c.z, CANVAS);
      this.sailIntegrity[mi] = 1;
    }
    this.visual.refresh(); // remesh the hull + rig from the restored grid
  }
```

(`EMPTY`/`SPAR`/`CANVAS` are already imported after Tasks 1 & 7. The rig isn't walked on, so re-seeding the deck-collider/surface set for these cells isn't required for repair; the voxel mesher draws them via `refresh()` and integrity reads the grid directly.)

- [ ] **Step 3: Trim `rigDamage.ts` to the rudder**

In `src/sim/rigDamage.ts`: delete `segmentSailHit`, `segmentMastHit`, and the `SailRect`/`MastCyl` interfaces. KEEP `segmentBoxHit` + `Box`/`V3` (the rudder uses them). In `tests/rigDamage.test.ts`, delete the `segmentSailHit`/`segmentMastHit` describe blocks; keep the `segmentBoxHit` ones.

- [ ] **Step 4: Build + full suite (this is the big one — let the compiler find every loose end)**

Run: `npm run build && npm run test`
Expected: PASS. Type errors point straight at any missed reference (e.g. a `SailRecord` import in `cannons.ts` — remove it). Fix until green.

- [ ] **Step 5: Commit**

```bash
git add src/render/shipVisual.ts src/game/ship.ts src/sim/rigDamage.ts tests/rigDamage.test.ts
git commit -m "chore(rig): remove mesh masts/yards/sails/bowsprit; keep wheel + rudder"
git push origin main
```

---

## Task 13: Full verification — suite, build, and in-browser

**Files:** none (verification + any small fixes)

- [ ] **Step 1: Whole suite + build green**

Run: `npm run build && npm run test`
Expected: PASS. Note the test count (should be ~ original − rigLattice/rigBuild files + sailIntegrity).

- [ ] **Step 2: Stability re-confirm**

Run: `npm run test -- manOfWarFloat brig sailing`
Expected: PASS — GM/restoring-torque + thrust still green with the final rig.

- [ ] **Step 3: In-browser verify (the real oracle)**

Start `npm run dev` (port 5173) and drive it with Playwright MCP (or by hand) on a sandbox battle:
1. Shoot an enemy's sail with the mast intact → blocky voxel holes appear in the canvas and that ship visibly slows (sailIntegrity drop).
2. Shoot/ram the mast base → the whole mast+yards+sails falls away as ONE floating voxel body, no mesh flicker, no orphaned canvas.
3. Ram an enemy bow-on → the bowsprit chips/snaps via the normal crush; no separate bowsprit physics.
4. **Perf (spec §F):** with the sandbox enemy count maxed (6) on a fresh browser profile, watch the fps HUD (`TUN.gfx.auto.hud`) — confirm no regression from the added canvas voxels. If fps drops, coarsen the sail resolution (widen the `YARD_LEVELS` gaps / skip alternate sail rows in Task 4's stamp) and re-verify.
Capture a screenshot to `projects/<name>.png` and Read it back to confirm. If anything misbehaves, debug with `superpowers:systematic-debugging` before claiming done.

- [ ] **Step 4: Final confirmation**

Run: `git status`
Expected: clean working tree, everything pushed to `main`. State plainly what was verified (suite green with counts, in-browser behaviors observed).

---

## Notes for the executor

- **Order matters for "always green":** Tasks 1–7 are additive (both rig systems coexist — the ship is visually double-rigged in-browser between Task 4 and Task 12, which is expected and harmless). Tasks 8–12 remove the mesh/lattice side. Don't reorder the deletions before their unwiring.
- **The compiler is your friend:** after each deletion, `npm run build` pinpoints every dangling reference. Follow the type errors.
- **If `Ship` is hard to instantiate headless (Task 7):** copy the harness from `tests/wreck.test.ts`/`tests/foundering.test.ts`. The assertion (integrity tracks surviving canvas) is what matters.
- **Determinism (LAW #1):** all new logic lives in `sim/shipwright.ts` (pure) and `game/ship.ts` (grid reads only). Never feed render/cascade data into it.
