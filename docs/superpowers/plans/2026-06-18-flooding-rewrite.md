# Flooding + Cutaway Rewrite — Implementation Plan

> **For agentic workers:** Execute inline (shared working dir → no parallel subagents on `ship.ts`/`compartments.ts`). TDD the `sim/` parts; the render parts are GPU — build-verify + user confirms visually. Steps use `- [ ]` tracking.

**Goal:** Interior flood water that sloshes (world-horizontal), spills hold→hold over physical bulkhead gaps with no threshold logic, renders as calm-ocean-top / solid-navy-below, and a cutaway that never shows white.

**Architecture:** Sim stays the per-compartment reservoir model (deterministic oracle) but inter-compartment flow becomes sill-overflow through carved bulkhead-top gaps. Render moves the water level-cut into world space and draws one solid body per compartment at its own world level. Cutaway gets a solid deep-blue backing so no sightline escapes to sky.

**Tech Stack:** TypeScript, Three.js (custom ShaderMaterial + clipping includes), Rapier3D, vitest oracle.

---

## File structure

- `sim/compartments.ts` — add `Opening.sillY`; sill-aware `floodStep` opening loop; DELETE `equalizeFlooding` + `SEEP_*`. (pure, tested)
- `sim/shipwright.ts` — `stampBulkheads` leaves a top gap; detect-before-carve; emit adjacency+sill openings on the build. (tested for compartment count/symmetry)
- `game/ship.ts` — drop `equalizeFlooding` call; seed `this.openings` from build sill openings; give breach-openings a `sillY`; expose per-compartment world pool level for the render.
- `render/compartmentFluid.ts` — REWRITE: per-compartment solid body, world-space level clamp, calm-top/solid-below.
- `render/shipVisual.ts` — pass per-compartment world levels into the fluid.
- `render/ocean.ts` + `main.ts` — cutaway solid-navy backing (no sky leak).

---

## Part B — sim spill (foundation, do first)

### Task B1: `Opening.sillY` + sill-aware flow; delete `equalizeFlooding`

**Files:** Modify `sim/compartments.ts`; Test `tests/compartments.test.ts` (or wherever floodStep is tested).

- [ ] **Step 1 — test the sill behavior.** Add tests: (a) two compartments, A full above sill, B empty → water flows A→B; (b) A below sill, B below sill → NO flow (the "fills up THEN spills"); (c) mass conserved.

```ts
// tests/compartments.test.ts
import { floodStep, type Compartment, type Opening } from "../src/sim/compartments";
function comp(id: number, vol: number, water: number, floorY = 0, topY = 9): Compartment {
  const cells = new Set<number>(); // cells not needed by floodStep; volume drives it
  return { id, cells, volume: vol, waterVolume: water, centroid: [0,0,0], hatchArea: 0,
    floorY, bboxMin: [0,floorY,0], bboxMax: [0,topY,0] };
}
test("water does NOT cross a sill until a hold tops it", () => {
  const a = comp(0, 10, 4), b = comp(1, 10, 0); // both ~40%/0% — below an 0.8-fill sill
  const op: Opening = { a: 0, b: 1, area: 0.25, sillY: 0.8 }; // sill at 80% fill-fraction-equiv level
  floodStep([a, b], [op], [], 1);
  expect(b.waterVolume).toBeCloseTo(0, 5); // nothing crossed
});
test("a hold over its sill spills to the neighbor, mass-conserving", () => {
  const a = comp(0, 10, 9.5), b = comp(1, 10, 0);
  const op: Opening = { a: 0, b: 1, area: 0.25, sillY: 0.8 };
  const before = a.waterVolume + b.waterVolume;
  floodStep([a, b], [op], [], 1);
  expect(b.waterVolume).toBeGreaterThan(0);
  expect(a.waterVolume + b.waterVolume).toBeCloseTo(before, 5);
});
```

- [ ] **Step 2 — run, expect FAIL** (`sillY` not on `Opening`; flow ignores sill). `npm run test -- compartments`.

- [ ] **Step 3 — implement.** Add `sillY: number` to `Opening` (fill-FRACTION at/over which the gap conducts — kept dimensionless so it works off the existing `waterVolume/volume`, no pose needed → stays pure). Rewrite the opening loop in `floodStep`:

```ts
// Opening interface: add
//   /** Fill-fraction sill: the gap only conducts the water ABOVE this fraction on each side
//    *  (a top-of-bulkhead overflow). 0 = a bottom hole (always conducts), as before. */
//   sillY: number;
for (const o of openings) {
  const a = compartments[o.a]; const b = compartments[o.b];
  if (!a || !b) continue;
  const fillA = a.waterVolume / a.volume;
  const fillB = b.waterVolume / b.volume;
  const overA = Math.max(0, fillA - o.sillY); // how far A rises above the sill (fraction)
  const overB = Math.max(0, fillB - o.sillY);
  if (overA === 0 && overB === 0) continue;   // neither tops the sill → nothing (no threshold logic)
  const head = (overA - overB) * EXCHANGE_HEAD_SCALE; // drive on the OVER-sill difference only
  if (Math.abs(head) < 1e-9) continue;
  const rate = DISCHARGE * o.area * Math.sqrt(2 * 9.81 * Math.abs(head)) * Math.sign(head);
  let flow = rate * dt;
  flow = Math.min(flow, a.waterVolume, b.volume - b.waterVolume);
  flow = Math.max(flow, -b.waterVolume, -(a.volume - a.waterVolume));
  a.waterVolume -= flow; b.waterVolume += flow;
}
```

DELETE `equalizeFlooding`, `SEEP_FILL_GATE`, `SEEP_RATE`.

- [ ] **Step 4 — run, expect PASS.** `npm run test -- compartments`.

- [ ] **Step 5 — commit** `git add src/sim/compartments.ts tests/compartments.test.ts && git commit`.

### Task B2: bulkhead top gap + detect-before-carve + sill openings

**Files:** Modify `sim/shipwright.ts`. Test: existing compartment symmetry tests must still pass.

- [ ] **Step 1 — `stampBulkheads` gap.** Add a `gap` param (default 0 = old behavior) and a return of the stations + sill voxel-Y:

```ts
const BULKHEAD_TOP_GAP = 2; // voxels left open at the top of every interior bulkhead (overflow notch)
function stampBulkheads(grid, bulkheadXs, deckY, inside, gap = BULKHEAD_TOP_GAP): number {
  for (const bx of bulkheadXs)
    for (let z ...) for (let y = 0; y < deckY - gap; y++) if (inside(...)) grid.set(bx, y, z, OAK);
  return deckY - gap; // sill voxel-Y (bottom of the gap)
}
```

- [ ] **Step 2 — detect-before-carve helper.** Add `buildSillOpenings(compartments, bulkheadXs, sillVoxelY, grid)`: for each interior bulkhead station, find the compartment on each side (by cell x-bbox straddling the station), emit `{ a, b, area: gapArea, sillY: sillFraction }` where `sillFraction = (sillVoxelY - floorY) / (deckY - floorY)` per the SHARED span — approximate as `sillVoxelY / deckY` is wrong; compute per-pair from the lower compartment's bbox. Keep it the fraction of the SHALLOWER hold. Carve the gap voxels (`grid.set(bx, y, z, EMPTY)` for `y in [deckY-gap, deckY)`), inside the hull, AFTER `findCompartments`.

- [ ] **Step 3 — wire into each hull builder** (`buildCutter/Sloop/Brig/Frigate/...`): after `const compartments = findCompartments(grid, deckY)` and `assignHatchAreas`, call `const sillOpenings = buildSillOpenings(...)` and carve. Add `sillOpenings` to the returned `ShipBuild` (new field).

- [ ] **Step 4 — build + test.** `npm run build && npm run test`. Compartment count/symmetry tests must stay green (detection is on full bulkheads, so counts are unchanged).

- [ ] **Step 5 — commit.**

### Task B3: `ship.ts` — use sill openings, drop equalize, expose world level

**Files:** Modify `game/ship.ts`.

- [ ] **Step 1.** Seed `this.openings` from `build.sillOpenings` at construction (so the designed overflow gaps are live from the start). Keep `registerBreaches` pushing battle-damage openings — give them `sillY: 0` (a hole conducts at any level).
- [ ] **Step 2.** DELETE the `equalizeFlooding(this.build.compartments, dt)` call + import in `updateFlooding`.
- [ ] **Step 3.** Expose the render level: `poolWorldY(id: number): number` returning `this.floodGeom.get(id)?.poolY ?? -Infinity` (already computed in `updateFloodGeom`).
- [ ] **Step 4 — build + test.** `npm run build && npm run test` green.
- [ ] **Step 5 — commit.**

---

## Part A — flood water render

### Task A1: rewrite `compartmentFluid.ts` (per-compartment, world-level, calm-top/solid-below)

**Files:** Rewrite `render/compartmentFluid.ts`. Modify `render/shipVisual.ts` (pass levels).

- [ ] **Step 1 — geometry.** Per compartment, build one solid box per occupied `(x,z)` column from `floorY` to `deckY + 3` (margin so the world clamp always caps under heel). Tag each vertex `aTop` on the +y cap. Keep one mesh per compartment, each a cloned material (shared program), `clippingPlanes` for the cutaway.

- [ ] **Step 2 — vertex shader: WORLD-space level cut (the slosh).**

```glsl
uniform float uWorldLevelY;     // world Y of THIS compartment's pool surface
varying float vWorldY; varying float vTop;
#include <clipping_planes_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y = min(wp.y, uWorldLevelY);   // clamp in WORLD space → surface stays level as she pitches (SLOSH)
  vWorldY = wp.y; vTop = aTop;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}
```

- [ ] **Step 3 — fragment: calm-ocean top, solid navy below.**

```glsl
// solid body, darkening with depth below the surface
float depthF = clamp((uWorldLevelY - vWorldY) / max(uWorldLevelY - uFloorWorldY, 1e-3), 0.0, 1.0);
vec3 col = mix(uDeepColor, uDeepColor * uWallFloorDarken, depthF);
bool isLid = vTop > 0.5 && (uWorldLevelY - vWorldY) < 0.06;   // the clamped top slice
if (isLid) {
  // CALM-DAY ocean surface stolen from getOceanLook: gentle sky tint + LOW reflection, no hard glint.
  vec3 V = normalize(uCameraPos - vWorldPos);
  float fres = pow(1.0 - max(dot(vec3(0,1,0), V), 0.0), 5.0);
  vec3 surf = mix(uDeepColor * 1.3, uSkyColor, clamp(fres * uReflStrength, 0.0, 0.35)); // capped low
  col = mix(col, surf, 0.6);
}
gl_FragColor = vec4(col, 1.0);   // opaque
```

- [ ] **Step 4 — update().** For each compartment with `waterVolume > tiny`: `mesh.visible = true`, set `uWorldLevelY = ship.poolWorldY(id)`, `uFloorWorldY` from the body's floor transformed by the pose (or pass from sim). Dry → hidden.

- [ ] **Step 5 — `shipVisual.updateWater`** passes the ship handle (or a `(id)=>worldY` getter) through to `fluid.update`.

- [ ] **Step 6 — build.** `npm run build` clean. (Visual → user verifies slosh + look.)

- [ ] **Step 7 — commit.**

---

## Part C — cutaway: no white

### Task C1: solid deep-blue backing below the waterline

**Files:** Modify `render/ocean.ts` and/or `main.ts`.

- [ ] **Step 1 — diagnose the escape.** The leak is a grazing sightline through the cut passing OVER the backdrop rim / abyss to the sky. Two robust closes: (a) during cutaway, lift the abyss into a deep **box/bowl that fully encloses under+around** the cut ship (solid navy, unlit, renderOrder below the hull) so no ray escapes below the waterline; (b) hold the navy backdrop rim AT/above the waterline while cutaway is on (it's already near there).

- [ ] **Step 2 — implement** a cutaway-only solid navy "interior sea" backing: replace the flat `abyss` disc with a navy **open-topped box** (or raise the existing backdrop's rim to the sea surface) sized to the hull footprint × deep, centered on the hull, `MeshBasicMaterial({color: uDeepColor})`, visible only while cutaway. Below the waterline every cut sightline lands on it = deep-blue solid; above stays dry interior.

- [ ] **Step 3 — keel cap.** Confirm the voxel-cull cross-section caps the ballast/keel solid (no holes). If the mesher leaves the centerline column open, ensure the cull predicate keeps `z == zc` cells on the kept side (`<=` not `<`).

- [ ] **Step 4 — build.** `npm run build` clean. (Visual → user verifies no white.)

- [ ] **Step 5 — commit.**

---

## Finalize

- [ ] `npm run build` + `npm run test` fully green.
- [ ] Commit + `git push origin main` (user tests `main`).
- [ ] Update `CLAUDE.md` (flood section + cutaway) and the flood/cutaway memory files.
- [ ] Tell the user: hard-refresh `scuttle-gold.vercel.app`, flood a hull, watch it slosh + spill hold→hold, press X for a solid cross-section with no white.

## Self-review notes
- Spec coverage: slosh (A2), calm-top/solid-below (A3), per-compartment levels (A1/A4), sill overflow no-threshold (B1), carved gaps (B2), white (C). ✓
- Determinism: `floodStep` sill logic uses only `waterVolume/volume` + constants — pure, no pose. ✓
- Shared files: `ship.ts`, `compartments.ts` edited inline in sequence, staged by explicit path. ✓
