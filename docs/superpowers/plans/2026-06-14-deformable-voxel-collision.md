# Deformable Voxel Collision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the rigid-body-with-confetti destruction with a true deformable voxel contact — one `crush()` core that ramming, gunnery, flooding, and (later) grounding all route through; ship-vs-ship hulls mutually indent and absorb the energy instead of rigidly shoving; cannonball penetration is emergent. Built behind a numeric readback harness.

**Architecture:** Two layers. **Layer 1** `crush(ship, cells, energy)` removes voxels cheapest-first by material toughness until the budget is spent (the universal energy→voxels primitive, routing through the existing `carveCells` tail). **Layer 2** takes the hull-vs-hull pair **out of Rapier's rigid solver** (`filterContactPair` without `COMPUTE_IMPULSES`) and runs a sub-stepped, force-capped penalty contact (`F = k·d − c·vₙ`) whose over-cap energy feeds `crush()` on **both** hulls at the real overlap, so the carve bleeds the spring.

**Tech Stack:** TypeScript, Rapier3D JS (native voxel colliders, `setVoxel` O(1), `filterContactPair`, CCD, manifold readback), Three.js, vitest. Reference: `docs/superpowers/specs/2026-06-14-deformable-voxel-collision-design.md`.

**Key constraints (from research):** Rapier-JS has **no** `modify_solver_contacts` (so we run the contact ourselves) and **no** `contact_damping_ratio`. It **does** expose `ActiveHooks.FILTER_CONTACT_PAIR` + `SolverFlags`, manifold `.normal()`/`.contactDist(i)`/`.contactImpulse(i)`, `setVoxel`, `combineVoxelStates`/`propagateVoxelChange`, `setCcdEnabled`/`setSoftCcdPrediction`, `applyImpulseAtPoint`.

**Verify before relying on any API:** the code is the source of truth — confirm each Rapier method name against the installed `@dimforge/rapier3d-compat` typings before use (versions drift). Run `npx tsc --noEmit` and `npx vitest run` after every task; keep green.

---

## File Structure

- **Create** `src/sim/crush.ts` — pure energy-budget cell selection (`planCrush`): given candidate cells + a `toughnessAt` fn + budget, returns the prefix to remove + leftover energy. Engine-free, deterministic, unit-tested.
- **Create** `src/sim/voxelOverlap.ts` — pure overlap detection: given two grids + their world transforms, return the overlapping cells (in each grid's frame) + an approximate penetration depth + axis. Engine-free, unit-tested.
- **Create** `src/game/voxelContact.ts` — Layer 2: the manual deformable hull-hull contact (cull → overlap → penalty force → mutual `crush` → sub-step), plus the `ContactDebug` readback struct.
- **Modify** `src/game/ship.ts` — add `crush(cells, energy)` (wraps `planCrush` + `carveCells`); maintain a surface-voxel list / occupancy view for overlap tests; expose `aabbWorld()`.
- **Modify** `src/game/cannons.ts` — replace the fixed bore with `ship.crush(boreCells, ½mv²)` → emergent depth.
- **Modify** `src/game/physics.ts` — register a `PhysicsHooks` with `filterContactPair` that strips `COMPUTE_IMPULSES` from the hull-hull pair; enable CCD on hulls.
- **Modify** `src/game/world.ts` — drive `voxelContact.step()` each fixed step (sub-stepped); stop calling the old `collisionDestruction`.
- **Modify** `src/sim/shipwright.ts` — extend `armorBow` into a reinforced prow ram zone (RAM, a couple voxels deep at the stem).
- **Modify** `src/core/tunables.ts` — add `TUN.crush { k, damping, fMax, substeps, yield, fling, enabled }`; retire `TUN.ram`.
- **Modify** `src/main.ts` — dev panel: crush tunables + live `ContactDebug` readout; remove the old ram sliders.
- **Delete (Task 10)** `src/game/collisionDestruction.ts`, `src/sim/impact.ts` (now unused).
- **Tests:** `tests/crush.test.ts`, `tests/voxelOverlap.test.ts`, extend cannon coverage if present.

---

## Task 1: `planCrush` — the energy→voxels core

**Files:** Create `src/sim/crush.ts`; Test `tests/crush.test.ts`.

This is `planCarve`'s sibling: instead of flood-filling from a seed, it takes **explicit candidate cells** (the real overlap, or the real bore ray) and removes them cheapest-first until the energy budget is spent. That single change is what kills the wrong-location bug.

- [ ] **Step 1: Write the failing test**

```ts
// tests/crush.test.ts
import { describe, it, expect } from "vitest";
import { planCrush } from "../src/sim/crush";
import { STRENGTH_TO_JOULES } from "../src/sim/materials";

const J = STRENGTH_TO_JOULES;
// candidate cells with toughness (strength) per cell
const cells = [
  { x: 0, y: 0, z: 0, strength: 3 },  // oak  -> 3J
  { x: 1, y: 0, z: 0, strength: 2 },  // pine -> 2J
  { x: 2, y: 0, z: 0, strength: 8 },  // iron -> 8J
];
const tough = (c: { strength: number }) => c.strength * J;

describe("planCrush", () => {
  it("removes cheapest-first until the budget can't afford the next", () => {
    // budget = 2+3 = 5 strength-units of J -> removes pine(2) then oak(3); iron(8) unaffordable
    const r = planCrush(cells, tough, 5 * J);
    expect(r.removed.map((c) => c.strength).sort()).toEqual([2, 3]);
    expect(r.leftover).toBe(0);
  });
  it("returns leftover energy when budget exceeds total cost", () => {
    const r = planCrush(cells, tough, 100 * J);
    expect(r.removed).toHaveLength(3);
    expect(r.leftover).toBe((100 - 13) * J);
  });
  it("removes nothing on a budget below the cheapest cell", () => {
    const r = planCrush(cells, tough, 1 * J);
    expect(r.removed).toHaveLength(0);
    expect(r.leftover).toBe(1 * J);
  });
});
```

- [ ] **Step 2: Run it, verify it fails** — `npx vitest run tests/crush.test.ts` → FAIL (`planCrush` not defined).

- [ ] **Step 3: Implement**

```ts
// src/sim/crush.ts
// Pure, engine-free. The universal energy->voxels primitive: spend an energy budget
// removing supplied candidate cells, cheapest (toughest-to-break LAST) first, until the
// next cell is unaffordable. Ramming feeds it the overlap cells; cannon fire the bore-ray
// cells; both pay the same per-voxel material toughness. Returns removed prefix + leftover.
export interface CrushResult<C> { removed: C[]; leftover: number; }

export function planCrush<C>(
  cells: C[],
  toughnessAt: (c: C) => number, // joules to break this cell
  energy: number,
): CrushResult<C> {
  // cheapest-first so a fixed budget bites as many cells as it can afford
  const order = [...cells].sort((a, b) => toughnessAt(a) - toughnessAt(b));
  const removed: C[] = [];
  let budget = energy;
  for (const c of order) {
    const cost = toughnessAt(c);
    if (cost > budget) break;
    budget -= cost;
    removed.push(c);
  }
  return { removed, leftover: budget };
}
```

- [ ] **Step 4: Run it, verify pass** — `npx vitest run tests/crush.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git add src/sim/crush.ts tests/crush.test.ts && git commit -m "feat(crush): planCrush — energy-budgeted cheapest-first cell removal (the destruction core)"`

---

## Task 2: `ship.crush()` + cannonballs route through it (emergent depth)

**Files:** Modify `src/game/ship.ts`, `src/game/cannons.ts`.

Wire `planCrush` into the ship (pay real materials, remove via the existing `carveCells` tail) and switch cannons to a KE budget so penetration emerges.

- [ ] **Step 1:** Add `ship.crush()` to `src/game/ship.ts` (near `carveCells`):

```ts
import { planCrush } from "../sim/crush";
import { breakEnergy } from "../sim/materials";

/** The universal destruction entry point: spend `energy` joules removing as many of the
 *  given candidate cells as it can afford (toughest survive), paying each cell's real
 *  material break-energy. Routes removal through carveCells (grid + collider + breaches +
 *  dust). Returns voxels removed + leftover energy (caller spends leftover on push/debris). */
crush(cells: [number, number, number][], energy: number): { removed: number; leftover: number } {
  const grid = this.build.grid;
  const solid = cells.filter(([x, y, z]) => grid.isSolid(x, y, z));
  const { removed, leftover } = planCrush(
    solid,
    ([x, y, z]) => breakEnergy(grid.get(x, y, z)),
    energy,
  );
  const n = this.carveCells(removed);
  return { removed: n, leftover };
}
```

- [ ] **Step 2:** In `src/game/cannons.ts`, replace the fixed bore carve. Compute the ball KE and crush the bore-ray cells with it (keep `boreCells` to gather the candidate path):

```ts
// at the voxel hit:
const dir = this.tmpDir.copy(b.vel).normalize();
const ke = 0.5 * TUN.gun.mass * b.vel.lengthSq();   // joules carried by the ball
const path = this.boreCells(ship, hit.world, dir);  // candidate cells along the ray (radius from TUN.gun.boreRadiusVox)
const { removed } = ship.crush(path, ke * TUN.gun.crushEfficiency);
if (removed > 0) this.effects.impactDebris(hit.world, dir.negate(), removed);
// leftover (if the ball didn't punch through) still applies the small momentum kick below
```

Add `TUN.gun.crushEfficiency` (fraction of KE that goes to carving; default ~1, tune live) in `tunables.ts`. `boreRadiusVox` now only sets the candidate-path width; **depth is emergent** (KE decides how far down the sorted path the budget reaches).

- [ ] **Step 3:** Test (extend cannon test or add a focused one): a high-KE budget removes strictly more bore cells than a low-KE budget on the same hull; a budget below an iron belt's cost stops at the belt. (If cannons aren't currently unit-tested, add `tests/crush.test.ts` cases on `planCrush` with a mixed oak/iron path proving the iron stops a small budget.)

- [ ] **Step 4:** `npx tsc --noEmit && npx vitest run` → green.

- [ ] **Step 5: Commit** — `git commit -am "feat(crush): ship.crush() + cannonballs spend KE -> emergent penetration depth"`

---

## Task 3: Surface-voxel + occupancy view on the ship (for overlap tests)

**Files:** Modify `src/game/ship.ts`.

Overlap detection must test only **boundary** voxels against the other hull's occupancy — never all ~10⁴ cells.

- [ ] **Step 1:** Add a maintained surface set. A cell is "surface" if solid and at least one 6-neighbour is empty/out-of-bounds. Build it once from the grid; update incrementally whenever `carveCells` removes cells (a removed cell's solid neighbours may become surface). Expose:

```ts
/** Local-frame integer coords of every solid cell with an exposed face. Kept fresh as the
 *  hull is carved. Used by voxelContact for cheap hull-vs-hull overlap tests. */
surfaceCells(): Int32Array  // packed [x,y,z, x,y,z, ...]
/** World-space AABB {min,max} of the live hull, for broad-phase culling. */
aabbWorld(out): { min: Vec3, max: Vec3 }
```

- [ ] **Step 2:** Test (in `tests/` against a tiny synthetic grid via the existing `voxelGrid` + a stub): a 3×3×3 solid block has 26 surface cells (all but the centre); after removing one face cell, the now-exposed neighbour joins the surface set.

- [ ] **Step 3–5:** tsc + vitest green; commit `feat(ship): maintained surface-voxel set + world AABB for overlap broad-phase`.

> Implementation note: if profiling later shows `grid.isSolid` is fast enough at our counts, the separate occupancy bitset in the spec can be skipped — the surface set is the essential part. Decide against the harness in Task 8.

---

## Task 4: `voxelOverlap` — overlapping cells between two oriented hulls

**Files:** Create `src/sim/voxelOverlap.ts`; Test `tests/voxelOverlap.test.ts`.

- [ ] **Step 1: Failing test** — two identical 4×4×4 blocks; place B offset by 1 voxel along +x and overlapping; assert the returned overlap cells are exactly the shared slab, expressed in each grid's local indices, and the reported penetration ≈ 3 voxels along x.

- [ ] **Step 2:** Run → fail.

- [ ] **Step 3: Implement** — pure function:

```ts
// src/sim/voxelOverlap.ts
// Given grid A (its surface cells) and grid B (occupancy test), plus each hull's world
// transform (pos+quat) and the shared voxel size, return the cells of A that fall inside a
// solid cell of B, the matching B cells, an approximate penetration depth, and a unit axis.
// Caller passes the SMALLER hull as A (fewer surface cells to transform).
export interface Overlap {
  aCells: [number, number, number][];
  bCells: [number, number, number][];
  depth: number;        // meters of interpenetration (approx)
  axis: [number, number, number]; // unit, points A->B push-out direction (world)
}
export function voxelOverlap(a: HullView, b: HullView, voxelSize: number): Overlap | null { /* ... */ }
```

Algorithm: world AABB ∩ AABB first (return null on miss). For each surface cell of A: world-center = A.transform · (cell+0.5)·vs; B-local = B.invTransform · world-center; index = floor(B-local / vs); if `b.isSolid(index)` → record the A cell and the B cell. Penetration ≈ how deep A's surface cells reach past B's surface along the dominant separating axis (estimate from the overlap AABB extent on its thinnest axis); axis from the overlap-box thin axis oriented A→B.

- [ ] **Step 4:** Run → pass.

- [ ] **Step 5: Commit** — `feat(overlap): voxelOverlap — overlapping cell set + penetration between two oriented hulls`.

---

## Task 5: Take the hull-hull pair out of Rapier's solver + CCD

**Files:** Modify `src/game/physics.ts`, `src/game/ship.ts`.

- [ ] **Step 1:** Register a `PhysicsHooks` (or set `world.contactPairHooks`/`integrationParameters` per the installed API) implementing `filterContactPair(c1, c2)`: if **both** colliders are hulls (tag them, e.g. a `Set<colliderHandle>` of hull handles on `Physics`), return `SolverFlags` **without** `COMPUTE_IMPULSES` (so a manifold is generated but no impulse solved); otherwise return the default flags. Enable the hook on both hull colliders via `collider.setActiveHooks(ActiveHooks.FILTER_CONTACT_PAIR)`.
- [ ] **Step 2:** Enable CCD on each ship body: `body.enableCcd(true)` (confirm method name) and `collider.setSoftCcdPrediction(...)` if available, so a fast ram is caught before deep penetration.
- [ ] **Step 3: Verify live (no unit test — engine wiring):** with the hook active, drive the ram-test; the two hulls should now **pass through / overlap freely** (no rigid bounce) since nothing yet applies the manual force. That visible interpenetration is the proof the solver is off for the pair — Task 6 adds the response. Capture a `window.DEBUG` flag confirming the hook fired for the hull pair.
- [ ] **Step 4:** tsc green.
- [ ] **Step 5: Commit** — `feat(physics): strip COMPUTE_IMPULSES from the hull-hull pair (manual contact takes over) + CCD on hulls`.

---

## Task 6: `voxelContact` — penalty force + mutual carve (single-step)

**Files:** Create `src/game/voxelContact.ts`; Modify `src/game/world.ts`.

The heart. One step (sub-stepping added in Task 7).

- [ ] **Step 1:** Implement `VoxelContact.step(a, b, dt)`:
  1. `voxelOverlap(smaller, larger)` → null? return zeroed debug.
  2. penetration `d`, axis `n` (world). Relative velocity at the overlap centroid `vᵣ`; normal closing speed `vₙ = vᵣ·n`.
  3. **Penalty force** `F = clamp(k·d − c·vₙ, 0, fMax)`. Apply `+F·dt·n` impulse to the body being pushed back and `−F·dt·n` to the other, at the centroid (`applyImpulseAtPoint`).
  4. **Carve energy** = the portion of the closing kinetic energy above what the capped force absorbs this step: `E = max(0, ½·μ·vₙ² − fMax·d) · yield` (μ = reduced mass). Split **symmetrically**: `ship.crush(a.aCells, E/2)` and `ship.crush(b.bCells, E/2)`. (The bow's RAM toughness, Task 9, makes the bow lose fewer cells for its E/2 — emergent bow-wins.)
  5. Populate `ContactDebug { overlapCount, depth, force, energy, removedA, removedB, vClose }`.
- [ ] **Step 2:** In `world.ts`, after buoyancy/forces and BEFORE `physics.world.step()`, call `voxelContact.step(sloop, enemy, FIXED_DT)` for each hull pair (guard with `TUN.crush.enabled`). Remove the `collisionDestruction.update(...)` call.
- [ ] **Step 3: Verify live:** ram-test. Expect: hulls meet, both gouge at the contact, rammer decelerates, target only nudged. Read `ContactDebug` (Task 8 panel) — `energy` and `removedA/B` non-zero only during real closing; `force` bounded by `fMax`.
- [ ] **Step 4:** tsc + vitest green.
- [ ] **Step 5: Commit** — `feat(contact): voxelContact — penalty push + symmetric mutual crush at the real overlap`.

---

## Task 7: Sub-stepping + stability

**Files:** Modify `src/game/voxelContact.ts`, `src/game/world.ts`, `src/core/tunables.ts`.

Penalty contacts are stiff; this is what makes it not explode.

- [ ] **Step 1: Sub-step** the contact: loop `step()`'s cull→force→carve `N = TUN.crush.substeps` times per fixed step at `dt/N`. (Bodies' velocities update via the applied impulses between sub-iterations; re-read overlap each sub-step.)
- [ ] **Step 2: Critical damping** — derive `c = 2·√(k·m_eff)` from `k` and the reduced mass each step (with a `TUN.crush.damping` multiplier ~0.8–1.0), rather than a raw constant, so stability holds as `k` is tuned.
- [ ] **Step 3: Monotonic carve + hysteresis + clamp** — only carve when closing (`vₙ > 0`) and `d` exceeds a min threshold (no flicker on graze); clamp `d` used in `F` to a few voxels (a momentary deep overlap can't explode); never re-add voxels mid-episode.
- [ ] **Step 4: Tunables** — `TUN.crush = { enabled: true, k, damping: 0.9, fMax, substeps: 6, yield: 1, fling, minDepth }`. Pick a stable starting `k` via `k·(dt/N)²/m_eff ≲ 1`.
- [ ] **Step 5: Verify live + Commit** — `feat(contact): sub-stepped, critically-damped, force-capped, monotonic carve (stable crunch)`.

---

## Task 8: Readback harness + dev panel

**Files:** Modify `src/main.ts`, `src/game/voxelContact.ts`.

Build the instrument we tune against.

- [ ] **Step 1:** Expose the latest `ContactDebug` on `window.DEBUG.contact` and render it live in a dev-panel "🔧 Crunch" group (text readout: overlap, depth, force, energy, removed A/B, vClose) alongside sliders for every `TUN.crush` field + a master ⊘ toggle.
- [ ] **Step 2 (optional but recommended):** a Playwright readback oracle (per `memory/scuttle-gpu-shader-verification`): script the ram-test, sample `window.DEBUG.contact` over the collision, assert invariants — no `NaN`, `force ≤ fMax`, overlap depth non-increasing once carving starts (no trampoline), removed cells localized to the contact AABB.
- [ ] **Step 3: Commit** — `feat(contact): live ContactDebug readout + crunch tunables (+ optional Playwright oracle)`.

---

## Task 9: Bow ram zone (reinforced prow)

**Files:** Modify `src/sim/shipwright.ts`.

- [ ] **Step 1:** Extend `armorBow` into a deliberate ram zone: the forward shell stays RAM, and add a few voxels of RAM depth at the very stem (the prow), so the bow is the durable ramming area. Keep RAM density ≈ oak so trim is unchanged (THE LAW #2). Because the Task-6 carve is symmetric in *energy*, the high-toughness prow simply loses far fewer cells per joule → **ramming bow-first wins, emergent from material.**
- [ ] **Step 2:** Verify the existing shipwright tests still pass (mass-neutral swap); add an assertion that the forward-most stem stations are RAM.
- [ ] **Step 3: Commit** — `feat(shipwright): reinforced prow ram zone (RAM stem) — bow-first ramming wins via toughness`.

---

## Task 10: Retire the old path + verification sweep + cleanup

**Files:** Delete `src/game/collisionDestruction.ts`, `src/sim/impact.ts`; Modify `src/main.ts`, `src/game/world.ts`, `src/core/tunables.ts`.

- [ ] **Step 1:** Remove `collisionDestruction.ts` and its construction/calls in `main.ts`/`world.ts`; remove `TUN.ram` and its dev sliders. Remove `src/sim/impact.ts` (KAPPA/reducedMass/impactEnergy — superseded; confirm no importers) and any now-dead helpers.
- [ ] **Step 2:** Full `npx tsc --noEmit` + `npx vitest run` → green. Grep for dangling references (`collisionDestruction`, `TUN.ram`, `impact`).
- [ ] **Step 3: Live verification sweep against the spec's cases:** (a) rest/side-by-side → no damage; (b) perch attempt → falls through (your weight clears the yield); (c) hard ram → mutual gouge, rammer slows, target barely moves; (d) bow vs side → bow survives, side caves; (e) cannon slow vs fast → lodge vs through; (f) holes appear ONLY at contacts, never on the far side; (g) flooding follows below-waterline holes. Tune `TUN.crush` live via the harness until each reads right.
- [ ] **Step 4: Commit** — `refactor(destruction): retire rigid-reaction collisionDestruction + impact.ts; deformable contact is the one path`.
- [ ] **Step 5:** Final code-review pass over `crush.ts`, `voxelOverlap.ts`, `voxelContact.ts` (the new core) before considering the rebuild done.

---

## Self-review notes (author)

- **Spec coverage:** crush core (T1–2), overlap (T4), out-of-solver contact (T5), penalty+mutual carve (T6), stability (T7), harness (T8), bow zone (T9), emergence checks — flooding (T10 step 3g), gunnery (T2), grounding (deferred, same contact) — all mapped.
- **Emergence bar:** ramming, gunnery, flooding all flow through `crush()`; no per-effect destruction path. Grounding reuses `voxelContact` against a terrain body when terrain exists — no new code anticipated.
- **Type consistency:** `crush(cells, energy) → {removed, leftover}` used identically by cannons (T2) and voxelContact (T6); `voxelOverlap → {aCells, bCells, depth, axis}` consumed by T6.
- **Empirical steps flagged honestly:** T5/T6/T7 verify live (engine wiring + feel), not by unit test — the harness (T8, brought forward if convenient) is the objective check. T1/T2/T4 are deterministic and unit-tested.
- **Risk:** the `filterContactPair`/`SolverFlags`/CCD method names must be confirmed against the installed Rapier build at T5 (research cited the API but versions drift) — verify before relying.
