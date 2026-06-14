# Voxel Destruction Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the coarse-box ship collider + preset-radius damage with native Rapier voxel colliders and a single physics-energy `carve` primitive, so ships tear into / embed in / shear through each other (tougher bow than flanks, all emergent), the helm-connected hull is always the ship, and cannons share the same mechanic.

**Architecture:** One pure `planCarve` function spends an energy budget (`½·m_reduced·v²·κ`) removing voxels cheapest-first (each costs `material.strength × C` joules), biased along the impact direction. The hull's Rapier shape becomes a mutable `ColliderDesc.voxels` updated in-place via O(1) `setVoxel` as voxels are carved; two hulls are paired with `combineVoxelStates`/`propagateVoxelChange` so they collide concavely and embed. Ramming reads Rapier contact-force events → energy → `carve` both hulls; cannons feed the same `carve`. Severance is anchored at the helm, so the controllable ship always persists; non-helm components become free buoyant voxel chunks.

**Tech Stack:** TypeScript, Vite, Three.js 0.184, @dimforge/rapier3d-compat 0.19.3 (native voxel colliders), vitest (pure-sim unit tests), Playwright (live integration verification with logged numbers).

**Spec:** `docs/superpowers/specs/2026-06-13-voxel-destruction-core-design.md` — read it first. **Supersedes** `voxel-overhaul-design.md` V1/V2.

---

## ⚠️ Read before starting — hard-won constraints (from the overnight log)

1. **Never cache a Rapier body/collider reference across frames without a guard.** A despawned body referenced later threw `RuntimeError: unreachable` and poisoned the whole physics world. Pairing holds references to the *other* hull — tear every pairing down the same step a ship/chunk is removed. Guard wasm-boundary calls with try/catch.
2. **The iron keel is a strength-8 spine** down the hull length; under the energy model it resists carving, so midship rams split through the wooden quarters first and the keel goes last. This is correct — don't fight it.
3. **Preserve collision groups:** hull voxel collider stays in group `0x0002ffff` (so the character KCC keeps filtering it out with `~0x0002`); characters collide with the **deck trimesh** only. Otherwise the "walk on air"/stair-eject bugs return.
4. **Determinism:** `planCarve` + impact-energy + severance must be RNG-free. `debris.ts` `Math.random` scatter moves out of the deterministic path or is seeded from sim state.
5. **Temp-vector discipline:** every cached `THREE.Vector3` temp gets one job per call. A reused temp silently nuked forces three times in this repo's history.
6. **Standing bar:** `npm test` (~105 vitest tests) green + `npx tsc --noEmit` clean after every task. `npm run dev` for the live game (port ~5180).

---

## File-structure map (decomposition locked here)

**New files:**
- `src/sim/carve.ts` — PURE. `planCarve(params): CarveResult`. Dijkstra-style toughness/direction-weighted flood that returns which cells to remove (in order) for an energy budget. The heart. No Three, no Rapier.
- `src/sim/carve.test.ts` — unit tests for `planCarve`.
- `src/sim/impact.ts` — PURE. `reducedMass`, `impactEnergy`. No Three, no Rapier.
- `src/sim/impact.test.ts` — unit tests.
- `src/game/hullCollider.ts` — wraps the Rapier voxel-collider lifecycle for a ship: build from grid, `removeVoxel` (setVoxel + propagate to paired hulls), `pairWith`/`unpair`, `dispose`. Owns the wasm-reference safety.
- `src/game/collisionDestruction.ts` — reads Rapier contact-force events each step, derives energy, calls `ship.carve(...)` on both hulls, manages hull-collider pairing lifecycle. Replaces the body of `ramming.ts`.

**Modified files:**
- `src/sim/materials.ts` — reframe `strength` as "joules-to-break ÷ C"; add `RAM` material; export `STRENGTH_TO_JOULES`.
- `src/sim/shipwright.ts` — author a reinforced bow (thicker + `RAM`) in `buildBrig`/`buildSloop`.
- `src/sim/connectivity.ts` — rename param `keelAnchor`→`anchor` (cosmetic clarity); no logic change.
- `src/game/ship.ts` — voxel hull collider via `HullCollider` (replaces cuboid `:150`); `applyDamage`→thin wrapper over new `carve(...)` (uses `planCarve`, mutates collider, breaches cut faces); `keelAnchor`→`helmAnchor` from `build.wheelM` (`:107`).
- `src/game/ramming.ts` — gutted; re-exported shim or deleted in favor of `collisionDestruction.ts`.
- `src/game/cannons.ts` — hit path → `ship.carve(cell, E_ball, dir)`; delete preset radius + IRON-shrug branch.
- `src/game/debris.ts` — chunk buoyancy via per-voxel probes + physics waterlogging (replaces `wreckLift` timer); seed/remove `Math.random`; keep deep-despawn.
- `src/game/physics.ts` — create the `EventQueue`, enable contact-force events.
- `src/game/world.ts` / `src/main.ts` — step the `EventQueue`, run `collisionDestruction.update(...)`, keep `onSevered` routing.

## Shared contracts (every task uses these EXACT signatures — do not invent variants)

```ts
// src/sim/materials.ts
export const RAM = 4; // reinforced bow timber/iron band
export const STRENGTH_TO_JOULES = 6000; // C: joules to break one strength point (TUNED in Task 10)
// MATERIALS[mat].strength stays the field name; breakEnergy(mat) = strength × STRENGTH_TO_JOULES

// src/sim/carve.ts
export interface CarveParams {
  dims: [number, number, number];
  isSolid: (x: number, y: number, z: number) => boolean;
  strengthAt: (x: number, y: number, z: number) => number; // material strength of a solid cell
  origin: [number, number, number];     // impact cell (may be empty; flood finds nearest solid)
  dir: [number, number, number] | null; // unit impact direction; null = isotropic
  energy: number;                        // joules
  maxCells: number;                      // per-call hard cap
}
export interface CarveResult { cells: [number, number, number][]; spent: number; }
export function planCarve(p: CarveParams): CarveResult;

// src/sim/impact.ts
export function reducedMass(mA: number, mB: number): number;
export function impactEnergy(mA: number, mB: number, vRelNormal: number, kappa: number): number;
export const KAPPA = 0.015; // fraction of collision KE → destruction (TUNED in Task 10)

// src/game/hullCollider.ts
export class HullCollider {
  constructor(physics: Physics, body: RAPIER.RigidBody, grid: VoxelGrid);
  readonly collider: RAPIER.Collider;
  removeVoxel(x: number, y: number, z: number): void; // setVoxel(false) + propagate to paired
  pairWith(other: HullCollider): void;
  unpair(other: HullCollider): void;
  dispose(): void;                                     // unpairs from all, removes collider
}

// src/game/ship.ts (new public method; applyDamage becomes a wrapper)
carve(cell: [number, number, number], energy: number, dir: [number, number, number] | null): number;
```

`LATERAL_BIAS = 1.5` and `MAX_CARVE_CELLS = 60` live in `src/sim/carve.ts` and `src/core/constants.ts` respectively (also tuned in Task 10).

---

## Task 0: Voxel-collider perf spike (GO/NO-GO gate — throwaway)

**Files:**
- Create (throwaway): `src/dev/voxelSpike.ts`
- Reference: `src/game/physics.ts`, `src/sim/shipwright.ts`, `@dimforge/rapier3d-compat/geometry/collider.d.ts:633` (`ColliderDesc.voxels`)

This proves the central bet before anything is built on it. If it fails, STOP and switch to the compound-greedy-box fallback (spec §7) — do not proceed with Tasks 1–10 as written.

- [ ] **Step 1: Build the spike scene.** New `src/dev/voxelSpike.ts` exporting `runVoxelSpike(physics)`: build two `buildBrig()` (or a doubled-up galleon-scale) grids; for each, create a dynamic body + a `ColliderDesc.voxels(coords, {x:VOXEL_SIZE,y:VOXEL_SIZE,z:VOXEL_SIZE})` where `coords` is an `Int32Array` filled by `grid.forEachSolid((x,y,z)=>push(x,y,z))`. Call `a.combineVoxelStates(b, shiftX,shiftY,shiftZ)` once (shift = grid-origin delta in voxel units). Place them ~30 m apart closing at 8 m/s.

- [ ] **Step 2: Drive sustained carving.** Each step, pick the nearest overlapping voxel region; call `setVoxel(...,false)` on ~40 cells/hull/step on both colliders and `propagateVoxelChange(other, ix,iy,iz, sx,sy,sz)` for each; log `performance.now()` delta per `world.step()`.

- [ ] **Step 3: Measure against budget.** Run ~600 steps through the contact. Log median + p95 step time. Add `?spike=1` URL gate in `main.ts` to launch it.

Run: `npm run dev`, open `http://localhost:5180/?spike=1`, read console.
Expected (PASS): median `world.step()` ≤ ~10 ms and total frame ≤ 16.6 ms on an Iris-Xe-class GPU while both hulls are in contact and carving; no `RuntimeError: unreachable`.

- [ ] **Step 4: Record the verdict in the plan + commit the finding.** Append a "Spike result" note (numbers + PASS/FAIL) to this plan. If FAIL: open the fallback (spec §7 compound boxes) and revise Tasks 1, 4, 5 before continuing.

```bash
git add docs/superpowers/plans/2026-06-13-voxel-destruction-core.md src/dev/voxelSpike.ts
git commit -m "spike: voxel-collider perf gate (two hulls grinding) — <PASS/FAIL, numbers>"
```

> Task 0 code is throwaway; it is removed in Task 10. Keep it behind `?spike=1` until then.

---

## Task 1: HullCollider wrapper + swap the box for voxels

**Files:**
- Create: `src/game/hullCollider.ts`
- Modify: `src/game/ship.ts:144-154` (replace cuboid), constructor (`:114-172`), add field
- Test: live regression (no new unit test — pure-less integration)

- [ ] **Step 1: Write `HullCollider`.** Build the collider from the grid; keep group `0x0002ffff`; store paired set.

```ts
import type RAPIER from "@dimforge/rapier3d-compat";
import { VOXEL_SIZE } from "../core/constants";
import type { VoxelGrid } from "../sim/voxelGrid";
import type { Physics } from "./physics";

export class HullCollider {
  readonly collider: RAPIER.Collider;
  private paired = new Set<HullCollider>();
  constructor(private physics: Physics, body: RAPIER.RigidBody, private grid: VoxelGrid) {
    const { world, RAPIER: R } = physics;
    const coords: number[] = [];
    grid.forEachSolid((x, y, z) => { coords.push(x, y, z); });
    const desc = R.ColliderDesc.voxels(new Int32Array(coords), { x: VOXEL_SIZE, y: VOXEL_SIZE, z: VOXEL_SIZE })
      .setDensity(0)
      .setCollisionGroups(0x0002ffff);
    this.collider = world.createCollider(desc, body);
  }
  removeVoxel(x: number, y: number, z: number): void {
    try {
      this.collider.setVoxel(x, y, z, false);
      for (const other of this.paired) {
        if (!other.collider) continue;
        this.collider.propagateVoxelChange(other.collider, x, y, z, 0, 0, 0);
      }
    } catch { /* wasm boundary: a collider mid-teardown — safe to skip this frame */ }
  }
  pairWith(other: HullCollider): void {
    if (other === this || this.paired.has(other)) return;
    this.paired.add(other); other.paired.add(this);
    try { this.collider.combineVoxelStates(other.collider, 0, 0, 0); } catch {}
  }
  unpair(other: HullCollider): void { this.paired.delete(other); other.paired.delete(this); }
  dispose(): void {
    for (const other of [...this.paired]) this.unpair(other);
    try { this.physics.world.removeCollider(this.collider, false); } catch {}
  }
}
```

> NOTE on `shift` args: both ships' voxel colliders share the same `VOXEL_SIZE` local grid and the body origin = grid corner, so the per-pair shift is the inter-body grid-origin offset. For a first pass the bodies' own transforms place the colliders; pass `0,0,0` and let Rapier's broad/narrow phase use world transforms. If the spike showed pairing needs explicit shifts, compute `shift = round((otherBodyOrigin - thisBodyOrigin)/VOXEL_SIZE)` and thread it through `pairWith`/`removeVoxel`. (Confirm against the spike's working setup.)

- [ ] **Step 2: Swap the box in `ship.ts`.** Replace the cuboid block (`:144-154`) with `this.hull = new HullCollider(physics, this.body, build.grid);` and add `readonly hull: HullCollider;` field. Keep the mast cylinders + `rebuildDeckCollider()` exactly as-is.

- [ ] **Step 3: Verify regression live.** `npm run dev`; confirm: ships still float at rest, sail, and stop when hulls touch (now voxel-shaped). Characters still walk the deck (deck trimesh unaffected). `window.DEBUG.sloop` exists.
Expected: rest draft ~0.43–0.53 (unchanged), no console errors, ships collide on contact.

- [ ] **Step 4: tsc + tests + commit.**
```bash
npx tsc --noEmit && npm test
git add src/game/hullCollider.ts src/game/ship.ts
git commit -m "feat(physics): mutable Rapier voxel hull collider replaces the coarse box"
```

---

## Task 2: Material cost model (strength → break-energy) + RAM bow material

**Files:**
- Modify: `src/sim/materials.ts`
- Test: `src/sim/materials.test.ts` (create)

- [ ] **Step 1: Write the failing test.**
```ts
import { describe, it, expect } from "vitest";
import { MATERIALS, breakEnergy, OAK, PINE, IRON, RAM, STRENGTH_TO_JOULES } from "./materials";
describe("material break energy", () => {
  it("scales with strength", () => {
    expect(breakEnergy(PINE)).toBe(MATERIALS[PINE].strength * STRENGTH_TO_JOULES);
    expect(breakEnergy(IRON)).toBeGreaterThan(breakEnergy(OAK));
  });
  it("ram is the toughest hull timber", () => {
    expect(MATERIALS[RAM].strength).toBeGreaterThan(MATERIALS[OAK].strength);
  });
});
```
- [ ] **Step 2: Run → FAIL** (`breakEnergy`/`RAM` undefined). `npm test -- materials`
- [ ] **Step 3: Implement.** In `materials.ts`: add `export const RAM = 4;`, `export const STRENGTH_TO_JOULES = 6000;`, a `RAM` entry `{ name:"ram", density:900, color:[0.04,0.025,0.015], strength:14 }` (dense, dark, very tough), and `export function breakEnergy(mat: number): number { return (MATERIALS[mat]?.strength ?? 0) * STRENGTH_TO_JOULES; }`. Update the doc-comment: `strength` is now "joules-to-break ÷ STRENGTH_TO_JOULES (impact energy a cell absorbs)".
- [ ] **Step 4: Run → PASS.** `npm test -- materials`
- [ ] **Step 5: Commit.**
```bash
git add src/sim/materials.ts src/sim/materials.test.ts
git commit -m "feat(sim): material break-energy model + reinforced RAM timber"
```

---

## Task 3: `planCarve` — the energy-budget carve (the heart)

**Files:**
- Create: `src/sim/carve.ts`, `src/sim/carve.test.ts`

- [ ] **Step 1: Write the failing tests.**
```ts
import { describe, it, expect } from "vitest";
import { planCarve, type CarveParams } from "./carve";

function uniform(dims: [number,number,number], strength: number): Omit<CarveParams,"origin"|"dir"|"energy"|"maxCells"> {
  const [nx,ny,nz] = dims;
  return { dims, isSolid: (x,y,z)=> x>=0&&y>=0&&z>=0&&x<nx&&y<ny&&z<nz, strengthAt: () => strength };
}
const C = 6000;
describe("planCarve", () => {
  it("removes energy/cost cells from a uniform soft wall", () => {
    const r = planCarve({ ...uniform([20,1,20], 2), origin:[10,0,10], dir:null, energy: 5*2*C, maxCells: 999 });
    expect(r.cells.length).toBe(5);
    expect(r.spent).toBeLessThanOrEqual(5*2*C);
  });
  it("tough material removes fewer cells than soft for equal energy", () => {
    const soft = planCarve({ ...uniform([20,1,20], 2), origin:[10,0,10], dir:null, energy: 40*C, maxCells: 999 });
    const tough = planCarve({ ...uniform([20,1,20], 8), origin:[10,0,10], dir:null, energy: 40*C, maxCells: 999 });
    expect(tough.cells.length).toBeLessThan(soft.cells.length);
  });
  it("biases penetration along dir (tunnel deeper than wide)", () => {
    const r = planCarve({ ...uniform([41,1,41], 2), origin:[20,0,20], dir:[1,0,0], energy: 30*2*C, maxCells: 999 });
    const xs = r.cells.map(c=>c[0]); const zs = r.cells.map(c=>c[2]);
    const xSpan = Math.max(...xs)-Math.min(...xs); const zSpan = Math.max(...zs)-Math.min(...zs);
    expect(xSpan).toBeGreaterThan(zSpan);
  });
  it("respects maxCells", () => {
    const r = planCarve({ ...uniform([50,1,50], 1), origin:[25,0,25], dir:null, energy: 1e12, maxCells: 12 });
    expect(r.cells.length).toBe(12);
  });
  it("is deterministic", () => {
    const mk = () => planCarve({ ...uniform([30,1,30], 2), origin:[15,0,15], dir:[1,0,0], energy: 50*C, maxCells: 999 });
    expect(mk().cells).toEqual(mk().cells);
  });
});
```
- [ ] **Step 2: Run → FAIL.** `npm test -- carve`
- [ ] **Step 3: Implement `planCarve`** (Dijkstra flood weighted by toughness × directional penalty; deterministic tie-break by linear index).
```ts
export interface CarveParams {
  dims: [number, number, number];
  isSolid: (x: number, y: number, z: number) => boolean;
  strengthAt: (x: number, y: number, z: number) => number;
  origin: [number, number, number];
  dir: [number, number, number] | null;
  energy: number;
  maxCells: number;
}
export interface CarveResult { cells: [number, number, number][]; spent: number; }

import { STRENGTH_TO_JOULES } from "./materials";
const LATERAL_BIAS = 1.5;
const STEPS: [number,number,number][] = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];

export function planCarve(p: CarveParams): CarveResult {
  const [nx, ny, nz] = p.dims;
  const idx = (x:number,y:number,z:number) => x + nx*(y + ny*z);
  const d = p.dir ? norm(p.dir) : null;
  // binary min-heap of {cost, cellIndex}
  const heap: { c: number; i: number; x: number; y: number; z: number }[] = [];
  const push = (c:number,x:number,y:number,z:number) => { heap.push({c,i:idx(x,y,z),x,y,z}); up(heap.length-1); };
  const up = (n:number)=>{ while(n>0){const par=(n-1)>>1; if(heap[par].c<=heap[n].c)break; [heap[par],heap[n]]=[heap[n],heap[par]]; n=par;} };
  const pop = ()=>{ const top=heap[0]; const last=heap.pop()!; if(heap.length){heap[0]=last; down(0);} return top; };
  const down=(n:number)=>{ for(;;){let s=n,l=2*n+1,r=2*n+2; if(l<heap.length&&heap[l].c<heap[s].c)s=l; if(r<heap.length&&heap[r].c<heap[s].c)s=r; if(s===n)break; [heap[s],heap[n]]=[heap[n],heap[s]]; n=s;} };

  const seen = new Set<number>();
  // seed: nearest solid to origin (origin may be empty padding) — small BFS outward
  const seed = nearestSolid(p);
  if (!seed) return { cells: [], spent: 0 };
  push(0, seed[0], seed[1], seed[2]); seen.add(idx(seed[0],seed[1],seed[2]));

  const out: [number,number,number][] = [];
  let spent = 0;
  while (heap.length && out.length < p.maxCells) {
    const cur = pop();
    const cost = p.strengthAt(cur.x,cur.y,cur.z) * STRENGTH_TO_JOULES;
    if (spent + cost > p.energy) break;            // can't afford the cheapest remaining → done
    spent += cost; out.push([cur.x,cur.y,cur.z]);
    for (const [sx,sy,sz] of STEPS) {
      const x=cur.x+sx,y=cur.y+sy,z=cur.z+sz;
      if (x<0||y<0||z<0||x>=nx||y>=ny||z>=nz) continue;
      if (!p.isSolid(x,y,z)) continue;
      const ni = idx(x,y,z); if (seen.has(ni)) continue; seen.add(ni);
      const align = d ? Math.max(0, sx*d[0]+sy*d[1]+sz*d[2]) : 1;
      const penalty = 1 + LATERAL_BIAS * (1 - align); // forward ×1, lateral/back up to ×2.5
      push(cur.c + p.strengthAt(x,y,z)*STRENGTH_TO_JOULES*penalty, x, y, z);
    }
  }
  return { cells: out, spent };
}
function norm(v:[number,number,number]):[number,number,number]{const m=Math.hypot(...v)||1;return [v[0]/m,v[1]/m,v[2]/m];}
function nearestSolid(p: CarveParams): [number,number,number] | null {
  const [ox,oy,oz]=p.origin.map(Math.round) as [number,number,number];
  if (p.isSolid(ox,oy,oz)) return [ox,oy,oz];
  for (let r=1;r<=6;r++) for (const [sx,sy,sz] of STEPS) { const x=ox+sx*r,y=oy+sy*r,z=oz+sz*r; if (p.isSolid(x,y,z)) return [x,y,z]; }
  return null;
}
```
- [ ] **Step 4: Run → PASS.** `npm test -- carve`
- [ ] **Step 5: Commit.**
```bash
git add src/sim/carve.ts src/sim/carve.test.ts
git commit -m "feat(sim): planCarve — toughness/direction-weighted energy-budget voxel carve"
```

---

## Task 4: Refactor `ship.applyDamage` → `ship.carve` (planCarve + collider mutation + cut-face breaches)

**Files:**
- Modify: `src/game/ship.ts:645-709` (`applyDamage`)

- [ ] **Step 1: Add `carve`, make `applyDamage` a wrapper.** Replace the `sphereCells` loop with `planCarve`; remove each returned cell from the grid AND `this.hull.removeVoxel(...)`; keep the existing breach/opening registration (`:664-688`), `findSevered`, mast-foot check, `recomputeMassProperties`, `rebuildDeckCollider`.
```ts
carve(cell: [number,number,number], energy: number, dir: [number,number,number] | null): number {
  const grid = this.build.grid; const [nx,ny,nz] = grid.dims;
  const plan = planCarve({
    dims: grid.dims, isSolid: (x,y,z)=>grid.isSolid(x,y,z),
    strengthAt: (x,y,z)=> MATERIALS[grid.get(x,y,z)]?.strength ?? 0,
    origin: cell, dir, energy, maxCells: MAX_CARVE_CELLS,
  });
  if (plan.cells.length === 0) return 0;
  for (const [x,y,z] of plan.cells) { grid.remove(x,y,z); this.hull.removeVoxel(x,y,z); }
  this.registerBreaches(plan.cells);           // existing :664-688 logic, extracted
  const islands = findSevered(grid, this.helmAnchor);
  if (islands.length > 0) {
    for (const island of islands) for (const c of island.cells) { grid.remove(c.x,c.y,c.z); this.hull.removeVoxel(c.x,c.y,c.z); }
    this.breachCutFaces(islands);              // NEW: newly-exposed faces flood (see Step 2)
    this.onSevered?.(islands);
  }
  // ...existing mast-foot check, recomputeMassProperties(), rebuildDeckCollider()...
  return plan.cells.length;
}
// Back-compat: keep cannon/ram call sites compiling until they migrate (Tasks 5,9)
applyDamage(cell: [number,number,number], radiusVox: number): number {
  return this.carve(cell, radiusVox * radiusVox * 30000, null); // rough energy ~ old radius; removed in T5/T9
}
```
- [ ] **Step 2: `breachCutFaces`.** When a section severs, mark every remaining solid hull cell that is now adjacent to open exterior (below deck) as a breach for its compartment, reusing the adjacency logic so the stump floods from the cut.
```ts
private breachCutFaces(islands: Island[]): void {
  const grid = this.build.grid; const [nx,ny] = grid.dims;
  const cidx = (x:number,y:number,z:number)=> x + nx*(y + grid.dims[1]*z);
  const faces = new Set<number>();
  for (const isl of islands) for (const c of isl.cells) for (const [px,py,pz] of neighbors6(c.x,c.y,c.z)) {
    if (grid.isSolid(px,py,pz)) faces.add(cidx(px,py,pz)); // solid neighbour of a removed island cell = new exterior face
  }
  for (const fi of faces) {
    const comp = this.cellComp.get(fi); if (comp === undefined) continue;
    const [x,y,z] = unpack(fi, nx, grid.dims[1]);
    this.breachCells.get(comp)?.push([x,y,z]);
  }
}
```
- [ ] **Step 3: Verify live.** Ram/cannon a hull; the removed voxels show as a hole (mesh rebuilds via dirty chunks), the hull collider opens (the other ship can nose in), and a below-water hole floods.
Run: `npm run dev`; fire a broadside at the waterline; watch flood start.
Expected: visible hole; flood `0.02→…` climbs; no errors.
- [ ] **Step 4: tsc + tests + commit.**
```bash
npx tsc --noEmit && npm test
git add src/game/ship.ts
git commit -m "feat(ship): carve() over planCarve + voxel-collider mutation + cut-face breaching"
```

---

## Task 5: Impact energy + contact-driven ramming (replace the box-perimeter hack)

**Files:**
- Create: `src/sim/impact.ts`, `src/sim/impact.test.ts`, `src/game/collisionDestruction.ts`
- Modify: `src/game/physics.ts` (EventQueue + contact-force events), `src/game/world.ts`/`src/main.ts` (wire it), `src/game/ramming.ts` (gut), `src/game/ship.ts` (drop the temporary `applyDamage` shim's ram caller)

- [ ] **Step 1: Write `impact.test.ts` (failing).**
```ts
import { describe, it, expect } from "vitest";
import { reducedMass, impactEnergy, KAPPA } from "./impact";
describe("impact", () => {
  it("reduced mass of equal masses is m/2", () => { expect(reducedMass(100,100)).toBeCloseTo(50); });
  it("energy scales with v^2 and kappa", () => {
    const e1 = impactEnergy(1000,1000,4,KAPPA); const e2 = impactEnergy(1000,1000,8,KAPPA);
    expect(e2/e1).toBeCloseTo(4); expect(e1).toBeGreaterThan(0);
  });
  it("zero closing speed yields zero", () => { expect(impactEnergy(1000,500,0,KAPPA)).toBe(0); });
});
```
- [ ] **Step 2: Run → FAIL**, then implement `src/sim/impact.ts`.
```ts
export const KAPPA = 0.015;
export function reducedMass(mA: number, mB: number): number { return (mA*mB)/(mA+mB || 1); }
export function impactEnergy(mA: number, mB: number, vRelNormal: number, kappa: number): number {
  return kappa * 0.5 * reducedMass(mA, mB) * vRelNormal * vRelNormal;
}
```
Run → PASS: `npm test -- impact`.
- [ ] **Step 3: Enable contact-force events in `physics.ts`.** Create and export an `EventQueue`; the ship hull colliders call `.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)` (add to `HullCollider` ctor desc) with a force threshold; step with `world.step(eventQueue)`.
```ts
// physics.ts
export interface Physics { world: RAPIER.World; RAPIER: typeof RAPIER; events: RAPIER.EventQueue; }
// in init: const events = new RAPIER.EventQueue(true); return { world, RAPIER, events };
// HullCollider ctor desc: .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(8000)
```
- [ ] **Step 4: Write `collisionDestruction.ts`.** Each step, drain force events; for each pair of two ship hulls, find the contact point + normal + relative normal speed (from `body.linvel/angvel` via the existing `velocityAtPoint`), compute `E = impactEnergy(massA,massB,vRelN,KAPPA)`, and `carve` BOTH hulls at the contact cell along ±normal. Manage `pairWith`/`unpair` as hulls enter/leave proximity (and `dispose` cleanup on ship removal).
```ts
export class CollisionDestruction {
  constructor(private effects: Effects) {}
  update(physics: Physics, ships: Ship[]): void {
    physics.events.drainContactForceEvents((e) => {
      const a = shipOfCollider(ships, e.collider1()); const b = shipOfCollider(ships, e.collider2());
      if (!a || !b || a === b) return;
      a.hull.pairWith(b.hull);
      const contact = contactPointWorld(physics, a, b); if (!contact) return;
      const n = contactNormal(physics, a, b);
      const vRelN = closingNormalSpeed(a, b, contact, n);
      const E = impactEnergy(a.body.mass(), b.body.mass(), vRelN, KAPPA);
      if (E <= 0) return;
      carveShipAt(a, contact, E, neg(n)); carveShipAt(b, contact, E, n);
      this.effects.splinters(contact, n); this.effects.splash(contact.x, contact.y-1, contact.z, 1.5);
    });
  }
}
// carveShipAt: worldToLocal(contact) → floor /VOXEL_SIZE → ship.carve(cell, E, localDir)
```
> Keep `velocityAtPoint` (now in `gunnery.ts`) as the ONE source of point velocity. Watch temp-vector aliasing — give each helper its own temp.
>
> **Verified Rapier API (0.19.3):** enable events via `ColliderDesc.setContactForceEventThreshold(8000)` + `.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS)` (`pipeline/event_queue.d.ts:16`); step with `world.step(physics.events)`; read with `physics.events.drainContactForceEvents((e: TempContactForceEvent) => …)` (`event_queue.d.ts:96`) which yields the two collider handles + max-force direction/magnitude. Get the contact point + normal for the carve via `world.contactPair(colliderA, colliderB, (manifold, flipped) => …)` (`pipeline/world.d.ts:460`). Map a collider handle → its `Ship` via the existing ship list (`shipOfCollider`). `neg`, `closingNormalSpeed`, `carveShipAt` are thin local helpers — implement inline against these symbols.
- [ ] **Step 5: Wire + gut `ramming.ts`.** In `main.ts`/`world.ts` `onFixedStep`, replace `ramming.update(...)` with `collisionDestruction.update(physics, ships)`. Delete `ramming.ts`'s perimeter logic (leave a one-line re-export or remove the file + its imports). Remove the temporary `applyDamage` ram path.
- [ ] **Step 6: Verify live (numbers).** `npm run dev`; drive the player bow-first into the enemy flank at speed.
Expected: the bow visibly noses INTO and embeds in the enemy flank; both hulls breach; the rammer's bow loses far fewer voxels than the victim's flank; no freeze, no `unreachable`.
- [ ] **Step 7: tsc + tests + commit.**
```bash
npx tsc --noEmit && npm test
git add src/sim/impact.ts src/sim/impact.test.ts src/game/collisionDestruction.ts src/game/physics.ts src/game/world.ts src/main.ts src/game/ramming.ts src/game/ship.ts
git commit -m "feat(physics): contact-impulse ramming carves both hulls (embedding emerges); delete box-perimeter hack"
```

---

## Task 6: Helm-anchored ship identity

**Files:**
- Modify: `src/game/ship.ts:77,107` (`keelAnchor`→`helmAnchor`), `src/sim/connectivity.ts` (param rename)
- Test: extend `src/sim/connectivity.test.ts` (or `wreck.test.ts`)

- [ ] **Step 1: Write/extend the failing test** — a bar grid cut in two, anchor in the stern half, asserts the bow half is returned as the severed island and the stern (anchor) half is retained.
```ts
it("keeps the helm-anchored component, sheds the rest", () => {
  const g = createGrid(11,1,1); for (let x=0;x<11;x++) g.set(x,0,0,OAK);
  g.remove(5,0,0); // cut amidships
  const severed = findSevered(g, [9,0,0]); // anchor in the stern half
  const xs = severed.flatMap(i=>i.cells.map(c=>c.x)).sort((a,b)=>a-b);
  expect(xs).toEqual([0,1,2,3,4]); // bow half sheds; stern (anchor) half stays the ship
});
```
- [ ] **Step 2: Run → FAIL** if anchor isn't wired; then set `helmAnchor` from `build.wheelM`.
```ts
// ship.ts ctor, replacing the keelAnchor assignment (:107)
const wx = Math.floor(build.wheelM.x / VOXEL_SIZE);
const wz = Math.floor(build.wheelM.z / VOXEL_SIZE);
let wy = 0; while (wy < build.grid.dims[1] && !build.grid.isSolid(wx, wy, wz)) wy++; // keel cell under the wheel
this.helmAnchor = [wx, Math.min(wy, build.grid.dims[1]-1), wz];
```
Rename the field `keelAnchor`→`helmAnchor` (`:77`) and the `findSevered` param `keelAnchor`→`anchor` (cosmetic).
- [ ] **Step 3: Run → PASS.** `npm test -- connectivity`
- [ ] **Step 4: Verify live.** Saw a ship roughly in half; the half with the wheel keeps sailing/steering (crippled, flooding); the other half drifts off as a chunk.
- [ ] **Step 5: Commit.**
```bash
npx tsc --noEmit && npm test
git add src/game/ship.ts src/sim/connectivity.ts src/sim/connectivity.test.ts
git commit -m "feat(ship): helm-anchored identity — the wheel half is always the ship"
```

---

## Task 7: Free chunks sink naturally (per-voxel buoyancy, no timer)

**Files:**
- Modify: `src/game/debris.ts`

- [ ] **Step 1: Replace `wreckLift(age)` timer with physics waterlogging.** Wrecks accumulate a `waterlog` while submerged; lift = `ρ·g·V·(1 - waterlog)` summed at the existing corner probes; despawn only on deep-sink or a long safety lifetime. Remove `Math.random` from the spawn velocity/angvel (seed from the source ship's state instead) so the path is deterministic.
```ts
// per piece: replace `const lift = p.wreck ? wreckLift(p.age) : 1;` with a waterlog model
p.waterlog = Math.min(p.waterlog + (anyProbeWet ? 0.02 : -0.05) * dt, 0.6);
const lift = 1 - p.waterlog;            // floats fresh, founders as it logs
// spawn: replace (Math.random()-0.5) jitter with deterministic spread from island bbox + ship angvel
```
Keep the `tr.y < -40/-60` deep-despawn (prevents the "fall forever" leak).
- [ ] **Step 2: Verify live.** A bow sheared off floats a moment, settles, lists, and founders under its own waterlogging — not a fixed 35/150 s clock. Two identical seeds produce identical chunk motion (determinism).
- [ ] **Step 3: Commit.**
```bash
npx tsc --noEmit && npm test
git add src/game/debris.ts
git commit -m "feat(debris): chunks founder by physics waterlogging, RNG-free"
```

---

## Task 8: Directional bow armor (authoring)

**Files:**
- Modify: `src/sim/shipwright.ts` (`buildBrig`, `buildSloop`)

- [ ] **Step 1: Lay a reinforced bow.** In each builder, after the hull voxels are placed, overwrite the forward ~12% of hull length (the stem/cutwater region) with `RAM` material and add one extra voxel of thickness on the bow faces. Keep `wheelM`, deck, ports, masts untouched.
```ts
// after hull fill, before iron keel: reinforce the stem
const bowEnd = Math.round(x0 + 0.12 * L);
grid.forEachSolid((x,y,z) => { if (x <= bowEnd) grid.set(x,y,z, RAM); });
// (optional) thicken: for cells just outside the bow shell within the wedge, set RAM
```
- [ ] **Step 2: Verify the tactic live (numbers).** Ram bow-first into an enemy flank at ~10 m/s and, separately, take a flank-on hit at the same speed.
Expected: bow-first — rammer loses ≪ victim (target: rammer ≲ ⅓ of victim's removed voxels); the reinforced stem stays largely intact while the flank caves and floods.
- [ ] **Step 3: Commit.**
```bash
npx tsc --noEmit && npm test
git add src/sim/shipwright.ts
git commit -m "feat(ships): reinforced RAM bow — ramming becomes a tactic (emergent, no armor code)"
```

---

## Task 9: Cannons feed the same `carve`

**Files:**
- Modify: `src/game/cannons.ts` (hit handler), `src/game/ship.ts` (remove the `applyDamage` shim + IRON-shrug branch `:654-657`)

- [ ] **Step 1: Migrate the hit path.** At impact, compute the ball's KE (`0.5 * BALL_MASS * speed²`) and travel direction; call `ship.carve(cell, E_ball, dir)` instead of `applyDamage(cell, BLAST_RADIUS_VOX)`. Tune `BALL_MASS`/a cannon energy scale so a round shot holes a pine flank but barely marks the RAM bow (the IRON-shrug special case is now emergent — delete it).
- [ ] **Step 2: Delete the back-compat `applyDamage` wrapper** in `ship.ts` (no callers remain) and the IRON fringe branch.
- [ ] **Step 3: Verify live.** Broadside a flank → clean holes + flooding (as before). Fire on the reinforced bow → it shrugs most shots. Numbers comparable to m10's "waterline broadside → flood climbs."
- [ ] **Step 4: Commit.**
```bash
npx tsc --noEmit && npm test
git add src/game/cannons.ts src/game/ship.ts
git commit -m "feat(cannons): unified onto carve — shot penetration scales with material"
```

---

## Task 10: Verification sweep + tuning + spike cleanup

**Files:**
- Create: `tests/destruction.spec.ts` (Playwright) — follow the m10/m11 telemetry pattern (`window.DEBUG`, logged numbers, monkey-patch `controls.updateCamera`).
- Modify: `src/sim/materials.ts` / `src/sim/impact.ts` / `src/core/constants.ts` (final `STRENGTH_TO_JOULES`, `KAPPA`, `MAX_CARVE_CELLS`, `LATERAL_BIAS` values); delete `src/dev/voxelSpike.ts` + `?spike=1`.

- [ ] **Step 1: Tune the two knobs** so, at a 12 m/s closing ram, both hulls breach with carving on the m10 scale (~hundreds of voxels over the contact), the bow-rammer loses ≲ ⅓ of the flank-victim, and a hard bow-first ram into a small/wounded hull can shear a section. Adjust `KAPPA`/`STRENGTH_TO_JOULES`; keep `MAX_CARVE_CELLS` as the per-step grind cap.
- [ ] **Step 2: Playwright assertions** (drive via `window.DEBUG`): ram embeds (penetration depth > 0, hulls interpenetrate where carved); bow-vs-flank voxel-loss asymmetry; midship saw → helm component still controllable + a chunk spawned + chunk founders; cannon flank-hole vs bow-shrug; carved-grid hash identical across two identical seeded runs (determinism); median frame ≤ 16.6 ms during a two-ship grind with cannons firing.
- [ ] **Step 3: Remove the spike** and any dead `ramming.ts`. Confirm `npx tsc --noEmit` clean and full `npm test` green (≥ prior count).
- [ ] **Step 4: Final commit.**
```bash
git add -A
git commit -m "test+tune: destruction-core verification sweep; remove perf spike"
```

---

## Self-review — spec coverage map

| Spec section | Task(s) |
|---|---|
| §1 carve primitive (energy, cheapest-first, dir bias, two knobs) | T2, T3, T10 |
| §2 native voxel collider (build, setVoxel, pairing, groups) | T0 (gate), T1 |
| §3 ramming = contact impulse → carve (feedback loop, per-step cap) | T5, T10 |
| §4 directional armor (materials + reinforced bow, no special-case) | T2, T8 |
| §5 helm anchor + cut-face breaches + free chunks | T4 (breaches), T6 (anchor), T7 (chunks) |
| §6 cannons unified | T9 |
| §7 risk/perf (spike gate, fallback, stale-ref guard, det., temp discipline) | T0, T1 (guards), T10 |
| §8 testing (pure unit + Playwright sweep) | T2,3,5,6 (unit), T10 (Playwright) |
| §9 data flow | realized across T4–T7 |
| §10 scope fence (islands/flooding-tuning/embed-lock deferred) | not in plan — correct |

No placeholders; all shared symbols defined in the contracts block and reused verbatim. Constants carry concrete starting values, explicitly tuned in T10.
