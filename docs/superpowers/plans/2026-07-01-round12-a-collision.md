# Collision Correctness (Round 12, Agent A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**: Fix the three structural collision-correctness bugs in the deformable ship contact — aggregate-direction misclassification (T-bone/scrape), centroid-based energy budget, and non-robust REST separation — plus pool `planCarve`'s per-call allocations, all behind deterministic regression tests that first characterize today's head-on behavior.

**Architecture**: The deformable crush stays exactly as documented in CLAUDE.md (energy-bounded cheapest/nearest-first carving, BREAK/REST split on closing speed vs `TUN.crush.vBreak`, horizontal-only position-based de-penetration with closing pre-zeroed, ship pairs outside Rapier, terrain infinite-mass/`canCarve:false`). The change is *where the closing speed is measured*: `sim/voxelOverlap.detectContacts` gains an optional per-contact local surface normal (B's occupancy gradient at the contacted cell, world-rotated), and `game/voxelContact.resolveContact` classifies each contact along its own horizontal local normal (falling back to the old aggregate relative-velocity direction d̂ only when the local normal is degenerate — deep-engulf interior cells or vertical faces), allocates the break budget per contact (½·μ·mean(vᵢ²), never more than the pair's real closing KE), and hardens the REST branch with a fallback push-axis chain + a small equal-and-opposite tangential friction impulse. `sim/carve.planCarve` gets a module-level pooled heap + seen-set, fully reset per call (determinism preserved).

**Tech Stack**: TypeScript (strict, `tsc --noEmit` via `npm run build`), Vitest 4 (`npm run test`), three.js vector math in the game layer only. No new dependencies. `sim/` stays pure (no three.js, no game/render imports).

## Global Constraints

- `npm run build` AND `npm run test` must pass before every commit (vitest does NOT type-check — a red tsc hides behind green tests).
- Stage ONLY files this plan owns via explicit `git add <paths>` (NEVER `git add -A` / `git add .` — concurrent agents share this working dir).
- Do NOT push (the orchestrator pushes per wave).
- Do NOT edit frozen files. Frozen for this agent: `src/core/tunables.ts`, `src/game/ship.ts`, `src/game/world.ts`, `src/main.ts`, everything in `src/render/`, and any file not in the owned list. Owned (editable) files: `src/game/voxelContact.ts`, `src/sim/voxelOverlap.ts`, `src/sim/crush.ts`, `src/sim/carve.ts`, `src/sim/surfaceSet.ts` (if needed), and test files for these modules under `tests/`. If a TUN knob value must change, record it as a handoff item (Task 6) instead of editing `tunables.ts`.
- sim/ purity: no `game/` or `render/` imports, no `Date.now`/`Math.random` in `src/sim/**`.
- TUN tunables are NOT read by the vitest oracle (`src/sim/**` never imports `core/tunables`); the *game-layer* contact tests DO run against live `TUN.crush` values (vBreak 4.0, toughness 2.5, transferFrac 0.35, buffer 0.4, depen 0.8, maxDepenSpeed 30, biteDvCap 3.5, maxStepEnergy 5e6, minDepth 0.04 — verified in `src/core/tunables.ts:193-248`). Test literals below are derived from those values; the new test file documents this dependency in a header comment.
- Brig/frigate symmetric tests can false-fail on timeout under CPU load — re-run isolated (`npx vitest run tests/brig.test.ts tests/manOfWar.test.ts tests/manOfWarFloat.test.ts`) before treating them as red.

## Audit findings verified against HEAD (the code wins)

Read before implementing — two audit claims were inaccurate; the plan reflects the code as it actually is:

1. **CONFIRMED (finding 1, 2):** `src/game/voxelContact.ts:209-218` computes one aggregate horizontal direction d̂ from relative velocity at the contact centroid; lines 235-252 classify every contact by its velocity projected onto that d̂; lines 266-275 compute the break budget from the centroid velocity along d̂. Because d̂ is *derived from the relative velocity itself*, a **pure tangential slide reads as full closing speed** (a parallel scrape at 5 m/s classifies every contact as BREAK at 5 m/s > vBreak 4 and tears both sides — the very bug the vBreak 2→4 retune band-aided), and a T-bone mixes the victim's forward motion into d̂ so the bite impulse brakes motion *tangent* to the impact and inflates the budget with tangential KE.
2. **CONFIRMED (finding 3):** lines 359-379 gate the off-axis push on `align < 0.5` against the COM→COM line; there is no tangential dissipation anywhere, so grinding pairs keep their slide speed.
3. **PARTIALLY STALE (finding 4):** with `|vRel| < 1e-4` the REST branch (line 306) DOES still fire — `depth` from `detectContacts` is always ≥ one voxel (`src/sim/voxelOverlap.ts:180-183`, thin extent + `vs`) > `minDepth` 0.04, and the COM-line de-pen at lines 339-344 runs regardless of velocity. The *real* deadlock is the double-degenerate case: horizontal COM→COM length ≤ 1e-4 (line 322 guard skips everything) AND `ov.axis` vertical (line 361 guard skips the off-axis push) → nothing ever separates. Task 1 locks the working slow-press behavior; Task 4 fixes the true deadlock with a fallback axis chain.
4. **STALE CALLER CLAIM (finding 5 / SP4):** `sim/carve.planCarve` (lines 20-55: fresh node-object heap at line 27, fresh `seen` Set at line 32) is NOT on the contact path. Its only importer is `game/ship.ts:1147` inside `Ship.carve()`, which currently has **zero call sites** (cannons route through `ship.crush` → `sim/crush.planCrush`, `game/cannons.ts:302`; debris via `game/debris.ts:500`). The pooling is still implemented per the approved spec (pure, deterministic, benefits the tested oracle and any future caller); the dead-caller fact goes in the Task 6 handoff notes.
5. `sim/crush.ts` and `sim/surfaceSet.ts` need **no changes** (verified: `breakImpulse`/`splitClosingImpulse` are direction-agnostic — they take scalar speeds along whatever axis the caller supplies).

---

### Task 1: Characterization tests — head-on ram baseline + slow-press separation lock

**Files**
- Create: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\voxelContactRegression.test.ts`

**Interfaces**
- Consumes: `VoxelContact.resolveContact(a: ContactTarget, b: ContactTarget, dt: number): ContactDebug | null` and `ContactTarget` from `src/game/voxelContact.ts` (unchanged); harness mirrors `FakeTarget` from `tests/voxelContact.test.ts:35-83` plus impulse integration.
- Produces: the shared `SimTarget`/`step`/`mkPair` test harness reused by Tasks 3 and 4 (same file).

Derivation of the exact numbers (from HEAD source, verify by running): two 8³ oak blocks (voxelSize 1, masses 2e5 each → μ = 1e5), A at origin driving +x at 6 m/s, B at x=7, gives 64 contacts (A's x=7 face; the x=6 layer centres at 6.5 miss B's 0.4-voxel-padded min 6.6). Every contact breaks (closing 6 > vBreak 4). Old budget = ½·1e5·6² = 1.8e6 J; cell cost = oak `breakEnergy` 15 kJ × toughness 2.5 = 37.5 kJ (FakeTarget `hullToughness` 1) → 48 cells removed (24 pairs, both hulls). After Task 3 the per-contact RMS closing dilutes to √31.5 ≈ 5.61 (the 16 z-edge/corner contacts get diagonal local normals → closing 6/√2), budget 1.575e6 → 41–42 cells. The bite impulse is **cap-bound both before and after** (`biteDvCap` 3.5 < either uncapped Δv), so jA = μ·0.35·3.5 + 2e5·0.65·3.5 = **577,500** and jB = μ·0.35·3.5 = **122,500** exactly, along ∓x exactly (the edge normals' z-shares cancel by symmetry). The band assertions bracket both worlds; the impulse assertions are exact and must never move.

- [ ] Write `tests/voxelContactRegression.test.ts` with this complete content:

```ts
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { VoxelContact, type ContactTarget } from "../src/game/voxelContact";
import { createGrid, type VoxelGrid } from "../src/sim/voxelGrid";
import { computeSurface, unpackCell } from "../src/sim/surfaceSet";
import { breakEnergy, OAK } from "../src/sim/materials";
import type { HullView } from "../src/sim/voxelOverlap";

// Round-12 SP2 collision-correctness regression suite.
//
// Task 1 CHARACTERIZES the behavior that must SURVIVE the local-normal classification fix
// (head-on ram numbers, slow-press separation); Tasks 3/4 append the new-behavior tests
// (45° ram parity, parallel-scrape no-carve, tangential friction, degenerate-axis escape).
//
// ⚠ These are GAME-layer tests: they run against the LIVE TUN.crush knobs (vBreak 4.0,
// toughness 2.5, transferFrac 0.35, biteDvCap 3.5, buffer 0.4, depen 0.8, maxDepenSpeed 30,
// minDepth 0.04). If a future round retunes those, the literals below shift WITH the knobs.

const DT = 1 / 60;

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

/** tests/voxelContact.test.ts's FakeTarget, PLUS impulse integration (Δv = J/m, linear only —
 *  these axis-aligned block rigs carry no angular velocity), so multi-step scrape-friction and
 *  separation behavior is observable. Records carves, impulses, and translations like the original. */
class SimTarget implements ContactTarget {
  removed: [number, number, number][] = [];
  impulses: { imp: THREE.Vector3; pt: { x: number; y: number; z: number } }[] = [];
  moved: { x: number; y: number; z: number }[] = [];
  hullToughness = 1;
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
    this.vel = { x: this.vel.x + imp.x / this.m, y: this.vel.y + imp.y / this.m, z: this.vel.z + imp.z / this.m };
  }
  translation() { return this.pos; }
  setTranslation(t: { x: number; y: number; z: number }): void { this.moved.push({ ...t }); this.pos = t; }
}

/** One fixed step the way game/world.ts wraps the contact: integrate positions from the
 *  (impulse-updated) velocities, then resolve the pair. Returns the debug or null (separated). */
function step(contact: VoxelContact, a: SimTarget, b: SimTarget) {
  a.pos = { x: a.pos.x + a.vel.x * DT, y: a.pos.y + a.vel.y * DT, z: a.pos.z + a.vel.z * DT };
  b.pos = { x: b.pos.x + b.vel.x * DT, y: b.pos.y + b.vel.y * DT, z: b.pos.z + b.vel.z * DT };
  return contact.resolveContact(a, b, DT);
}

/** Two 8³ oak hulls, A at the origin, B at x=bx (7 → one-voxel overlap; 7.5 → half-voxel press). */
function mkPair(
  vA: { x: number; y: number; z: number },
  vB: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  bx = 7,
) {
  const A = new SimTarget(solidBlock(8, OAK), { x: 0, y: 0, z: 0 }, { ...vA }, 2e5, true, 1);
  const B = new SimTarget(solidBlock(8, OAK), { x: bx, y: 0, z: 0 }, { ...vB }, 2e5, true, 1);
  return { A, B };
}

describe("characterization — head-on ram (must survive the round-12 classification fix)", () => {
  // 8³ oak vs 8³ oak, 1-voxel overlap, A drives +x at 6 m/s (> vBreak 4), B dead in the water.
  // Derivation vs HEAD: 64 contacts; 37.5 kJ/cell (oak 15 kJ × toughness 2.5); μ = 1e5.
  // Aggregate rule: budget ½·μ·6² = 1.8e6 → 48 cells. Per-contact RMS rule (post-fix): edge
  // contacts read 6/√2 → vEff ≈ 5.61, budget ≈ 1.575e6 → 41–42 cells. The band brackets BOTH.
  // The bite impulse is biteDvCap-bound (3.5 m/s) in BOTH worlds → jA = 577,500, jB = 122,500
  // EXACTLY, purely along ∓x — these must not move at all.
  it("carves inside the energy band and applies the exact cap-bound bite impulses", () => {
    const contact = new VoxelContact();
    const { A, B } = mkPair({ x: 6, y: 0, z: 0 });
    const d = contact.resolveContact(A, B, DT);
    expect(d).not.toBeNull();
    expect(d!.overlapCount).toBe(64);
    expect(d!.vClose).toBeGreaterThan(5.0);   // 6.0 aggregate today; ~5.61 RMS after the fix
    expect(d!.vClose).toBeLessThan(6.5);
    const removed = d!.removedA + d!.removedB;
    expect(removed).toBeGreaterThanOrEqual(40);
    expect(removed).toBeLessThanOrEqual(50);
    expect(d!.energy).toBeGreaterThan(1.45e6);
    expect(d!.energy).toBeLessThan(1.85e6);
    // ONE bite impulse per hull, horizontal, along ∓x (edge-normal z-shares cancel by symmetry).
    expect(A.impulses).toHaveLength(1);
    expect(B.impulses).toHaveLength(1);
    expect(A.impulses[0].imp.x).toBeCloseTo(-577500, 0);
    expect(A.impulses[0].imp.y).toBeCloseTo(0, 6);
    expect(Math.abs(A.impulses[0].imp.z)).toBeLessThan(1);
    expect(B.impulses[0].imp.x).toBeCloseTo(122500, 0);
    expect(Math.abs(B.impulses[0].imp.z)).toBeLessThan(1);
    // BREAK regime: the carve clears the way — NO positional shove while breaking (anti-jar law).
    expect(A.moved).toHaveLength(0);
    expect(B.moved).toHaveLength(0);
  });

  it("slow-drift press (vRel = 0): REST de-penetration separates, breaks nothing, flings nothing", () => {
    // The audit claimed near-zero relative velocity deadlocks; the CODE already de-penetrates
    // along the COM→COM line here (the true deadlock needs a degenerate COM line too — Task 4).
    // This locks the working behavior so the Task 3/4 rewrites cannot regress it.
    const contact = new VoxelContact();
    const { A, B } = mkPair({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 7.5); // 0.5 m pressed overlap
    let sep = -1;
    for (let i = 0; i < 10; i++) { if (!step(contact, A, B)) { sep = i; break; } }
    expect(sep).toBeGreaterThanOrEqual(0);   // separated within 10 steps
    expect(A.removed).toHaveLength(0);
    expect(B.removed).toHaveLength(0);
    expect(A.impulses).toHaveLength(0);      // position-only: zero velocity stays EXACTLY zero
    expect(B.impulses).toHaveLength(0);
    expect(A.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(A.pos.y).toBeCloseTo(0, 9);       // de-pen never touches the vertical (horizontal-only law)
  });
});
```

- [ ] Run it: `npx vitest run tests/voxelContactRegression.test.ts` — expected: **2 passed** (these characterize HEAD). If either fails, do NOT "fix" the test blindly: re-derive the failing number from the live source (the derivation is in the comments above) and correct the literal, noting the delta in the commit body.
- [ ] Run the full suite once to confirm a clean baseline: `npm run test` — expected: all files green (~431 tests).
- [ ] Run `npm run build` — expected: clean.
- [ ] Commit:
```
git add tests/voxelContactRegression.test.ts
git commit -m "test(contact): characterize head-on ram + slow-press separation (round-12 SP2 baseline)

Locks the exact cap-bound bite impulses (577.5k/122.5k N·s), the carve-count/energy
band that must bracket the upcoming per-contact-closing fix, and the already-working
REST de-penetration of a zero-velocity press.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Per-contact local surface normals in `detectContacts`

**Files**
- Modify: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\sim\voxelOverlap.ts` (interface at lines 30-37, module scratch after line 89, contact-record block at lines 165-169)
- Modify: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\voxelOverlap.test.ts` (append a describe block + helper)

**Interfaces**
- Produces (consumed by Task 3; other agents' plans may reference):
```ts
export interface ContactScratch {
  aCells: Int32Array;
  bCells: Int32Array;
  points: Float32Array;
  /** NEW, OPTIONAL: per-contact outward unit surface normal of B at the contacted B cell
   *  (world frame), flat [x,y,z,...]. All-zero when the contacted cell is interior (deep
   *  engulf) — callers fall back to their aggregate direction. Filled only when present. */
  normals?: Float32Array;
}
```
- `detectContacts(a, b, voxelSize, buffer, scratch, voxelSizeB?)` signature is UNCHANGED. Purity unchanged (no new imports).

- [ ] Append to `tests/voxelOverlap.test.ts` (after the existing corner-clip test), plus the helper right after the existing `scratch()` function:

```ts
function scratchN(capacity: number): ContactScratch {
  return {
    aCells: new Int32Array(capacity * 3),
    bCells: new Int32Array(capacity * 3),
    points: new Float32Array(capacity * 3),
    normals: new Float32Array(capacity * 3),
  };
}

describe("detectContacts — per-contact local surface normals (round 12)", () => {
  it("flat-wall contact: every normal is unit, faces A; interior face cells are EXACTLY (-1,0,0)", () => {
    const a = block(4, [0, 0, 0], ID); // A's x=3 layer meets…
    const b = block(4, [3, 0, 0], ID); // …B's x=0 face
    const s = scratchN(64);
    const r = detectContacts(a, b, 1, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16);
    let interiorChecked = false;
    for (let i = 0; i < r!.count; i++) {
      const nx0 = s.normals![i * 3], ny0 = s.normals![i * 3 + 1], nz0 = s.normals![i * 3 + 2];
      expect(Math.hypot(nx0, ny0, nz0)).toBeCloseTo(1, 5); // unit
      expect(nx0).toBeLessThan(0);                          // every contacted cell exposes -x (toward A)
      const bc = bCell(s, i);
      if (bc[0] === 0 && bc[1] === 1 && bc[2] === 1) {      // an interior face cell → exact face normal
        expect(nx0).toBeCloseTo(-1, 5);
        expect(ny0).toBeCloseTo(0, 5);
        expect(nz0).toBeCloseTo(0, 5);
        interiorChecked = true;
      }
    }
    expect(interiorChecked).toBe(true);
  });

  it("deep engulf: contacts against INTERIOR B cells report zero normals (caller falls back)", () => {
    const b = block(6, [0, 0, 0], ID);
    const a = block(2, [2, 2, 2], ID); // fully inside B — every contacted B cell has 6 solid neighbours
    const s = scratchN(64);
    const r = detectContacts(a, b, 1, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(8);
    for (let i = 0; i < r!.count * 3; i++) expect(s.normals![i]).toBe(0);
  });

  it("rotated B: the local face normal is rotated into world space", () => {
    const flip: [number, number, number, number] = [0, 1, 0, 0]; // 180° yaw about the grid corner
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [7, 0, 4], flip); // local (x,z) → world (7−x, 4−z): occupies x[3,7) z[0,4)
    const s = scratchN(64);
    const r = detectContacts(a, b, 1, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16);
    let checked = false;
    for (let i = 0; i < r!.count; i++) {
      const bc = bCell(s, i);
      if (bc[0] === 3 && bc[1] === 1 && bc[2] === 2) {
        // B-LOCAL outward is (+1,0,0) (the local +x face is the wall A touches); yawed 180°
        // it must land at world (−1,0,0) — still pointing out of the wall toward A.
        expect(s.normals![i * 3]).toBeCloseTo(-1, 5);
        expect(s.normals![i * 3 + 1]).toBeCloseTo(0, 5);
        expect(s.normals![i * 3 + 2]).toBeCloseTo(0, 5);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });
});
```

- [ ] Run it: `npx vitest run tests/voxelOverlap.test.ts` — expected failure: the three new tests fail with `AssertionError: expected +0 to be close to 1` (the `normals` buffer exists but `detectContacts` never fills it). Note: `npm run build` would ALSO fail right now (`normals` is an unknown property on `ContactScratch`) — proceed to the implementation before committing anything.
- [ ] Implement in `src/sim/voxelOverlap.ts` — three edits:

**(1)** In `interface ContactScratch` (lines 30-37), after the `points: Float32Array;` line, add:

```ts
  /** OPTIONAL per-contact local contact normals (world, unit), flat [x,y,z,...]: the outward
   *  occupancy-gradient normal of B's surface at the contacted B cell — the 6-neighbourhood
   *  empty-face sum, normalized, rotated into world by B's quat. ALL-ZERO for a contact against
   *  an INTERIOR B cell (deep engulf — no empty face) — callers must fall back to their aggregate
   *  closing direction there. Filled only when the buffer is provided (voxelContact always
   *  provides it; older callers/tests may omit). */
  normals?: Float32Array;
```

**(2)** After the module scratch `const _bc: [number, number, number] = [0, 0, 0];` (line 89), add:

```ts
const _gn: [number, number, number] = [0, 0, 0];
```

**(3)** Replace the contact-record block (lines 165-169):

```ts
    const o = count * 3;
    scratch.aCells[o] = ax; scratch.aCells[o + 1] = ay; scratch.aCells[o + 2] = az;
    scratch.bCells[o] = fx; scratch.bCells[o + 1] = fy; scratch.bCells[o + 2] = fz;
    scratch.points[o] = wx; scratch.points[o + 1] = wy; scratch.points[o + 2] = wz;
    count++;
```

with:

```ts
    const o = count * 3;
    scratch.aCells[o] = ax; scratch.aCells[o + 1] = ay; scratch.aCells[o + 2] = az;
    scratch.bCells[o] = fx; scratch.bCells[o + 1] = fy; scratch.bCells[o + 2] = fz;
    scratch.points[o] = wx; scratch.points[o + 1] = wy; scratch.points[o + 2] = wz;
    if (scratch.normals) {
      // Local outward surface normal of B at the contacted cell: the occupancy gradient of its
      // 6-neighbourhood (each empty/out-of-bounds face contributes its direction), normalized,
      // rotated into world by B's quat. isSolid is bounds-checked by the impl, so a grid-boundary
      // face correctly reads as exposed. An interior cell (deep engulf) has no empty face →
      // all-zero, and the caller (voxelContact) falls back to its aggregate closing direction for
      // that contact — exactly the old behavior for the deep-lodge case the COM-line rule owns.
      let gx = 0, gy = 0, gz = 0;
      if (!b.isSolid(fx - 1, fy, fz)) gx -= 1;
      if (!b.isSolid(fx + 1, fy, fz)) gx += 1;
      if (!b.isSolid(fx, fy - 1, fz)) gy -= 1;
      if (!b.isSolid(fx, fy + 1, fz)) gy += 1;
      if (!b.isSolid(fx, fy, fz - 1)) gz -= 1;
      if (!b.isSolid(fx, fy, fz + 1)) gz += 1;
      const gl = Math.hypot(gx, gy, gz);
      if (gl > 0) {
        qRot(b.quat[0], b.quat[1], b.quat[2], b.quat[3], gx / gl, gy / gl, gz / gl, _gn);
        scratch.normals[o] = _gn[0]; scratch.normals[o + 1] = _gn[1]; scratch.normals[o + 2] = _gn[2];
      } else {
        scratch.normals[o] = 0; scratch.normals[o + 1] = 0; scratch.normals[o + 2] = 0;
      }
    }
    count++;
```

- [ ] Run: `npx vitest run tests/voxelOverlap.test.ts` — expected: all pass (the pre-existing tests use the normal-less `scratch()` helper and are untouched).
- [ ] Run `npm run test` (full suite green — no consumer reads normals yet) and `npm run build` (clean).
- [ ] Commit:
```
git add src/sim/voxelOverlap.ts tests/voxelOverlap.test.ts
git commit -m "feat(overlap): per-contact local surface normals in detectContacts

Optional ContactScratch.normals: outward occupancy-gradient normal of B at each
contacted cell (world frame), zero for interior cells so callers can fall back.
Costs 6 isSolid probes per RECORDED contact only. Signature unchanged; sim/ pure.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Classify + budget per contact along local normals in `voxelContact`

**Files**
- Modify: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\game\voxelContact.ts` (scratch init line 112, `ensureScratch` lines 175-179, classification + BREAK block lines 208-305)
- Modify: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\voxelContactRegression.test.ts` (append a describe block)

**Interfaces**
- Consumes: `ContactScratch.normals` from Task 2.
- Produces (semantic change other agents should know): `ContactDebug.vClose` in the BREAK regime is now the **RMS of per-contact closing speeds** over breaking contacts (≡ the old centroid value for a uniform head-on); `ContactDebug`'s shape and all `ContactTarget`/`VoxelContact` signatures are unchanged. `sim/crush.ts` is untouched (its functions are direction-agnostic).

- [ ] Append to `tests/voxelContactRegression.test.ts`:

```ts
describe("local-normal classification (round-12 fix)", () => {
  it("a 45° ram carves comparably to a head-on with the same face-normal closing speed", () => {
    const contact = new VoxelContact();
    const head = mkPair({ x: 6, y: 0, z: 0 });
    const dH = contact.resolveContact(head.A, head.B, DT)!;
    const diag = mkPair({ x: 6, y: 0, z: 6 }); // same +x closing, PLUS an equal tangential slide
    const dD = contact.resolveContact(diag.A, diag.B, DT)!;
    const removedH = dH.removedA + dH.removedB;
    const removedD = dD.removedA + dD.removedB;
    expect(removedD).toBeGreaterThan(0);               // never misread as REST
    expect(removedD / removedH).toBeGreaterThan(0.7);  // carves comparably…
    expect(removedD / removedH).toBeLessThan(1.4);     // …and the slide does NOT inflate the
                                                       // budget (aggregate rule scored ≈ 2.0 here)
  });

  it("a parallel side-scrape above vBreak breaks NOTHING (a slide is not a closing)", () => {
    const contact = new VoxelContact();
    // A slides +z along B's -x face at 5 m/s (> vBreak 4), pressed 0.5 m in. The aggregate rule
    // read the slide speed as closing and tore both sides; the face-normal closing here is ~0.
    const { A, B } = mkPair({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, 7.5);
    const d = contact.resolveContact(A, B, DT);
    expect(d).not.toBeNull();
    expect(d!.removedA + d!.removedB).toBe(0);
    expect(A.removed).toHaveLength(0);
    expect(B.removed).toHaveLength(0);
  });

  it("T-bone: the bite acts along the struck face's normal, not the victim's course", () => {
    const contact = new VoxelContact();
    const { A, B } = mkPair({ x: 6, y: 0, z: 0 }, { x: 0, y: 0, z: 6 }); // A rams +x; B sails +z across
    const d = contact.resolveContact(A, B, DT)!;
    expect(d.removedA + d.removedB).toBeGreaterThan(0);
    expect(A.impulses).toHaveLength(1);
    const imp = A.impulses[0].imp;
    // The drag slows A's +x approach; it must NOT brake the tangential (z) motion. The old
    // aggregate d̂ was the diagonal relative-velocity direction → |imp.z| == |imp.x|.
    expect(imp.x).toBeLessThan(0);
    expect(Math.abs(imp.z)).toBeLessThan(0.3 * Math.abs(imp.x));
  });
});
```

- [ ] Run: `npx vitest run tests/voxelContactRegression.test.ts` — expected failures on HEAD: 45° test with `expected 2 to be less than 1.4` (96 vs 48 cells); scrape test with `expected 33 to be +0` (≈33 cells carved from a pure slide); T-bone with `expected 247487.4… to be less than 74246.2…` (|imp.z| ≈ |imp.x|). Task 1's two characterization tests still pass.
- [ ] Implement in `src/game/voxelContact.ts`. **(1)** Replace the scratch member init (line 112):

```ts
  private scratch: ContactScratch = { aCells: new Int32Array(0), bCells: new Int32Array(0), points: new Float32Array(0), normals: new Float32Array(0) };
```

**(2)** Replace `ensureScratch` (lines 175-179):

```ts
  /** Grow the contact scratch so it can hold `contacts` entries. */
  private ensureScratch(contacts: number): void {
    if (this.scratch.aCells.length >= contacts * 3) return;
    const n = contacts * 3;
    this.scratch = { aCells: new Int32Array(n), bCells: new Int32Array(n), points: new Float32Array(n), normals: new Float32Array(n) };
  }
```

**(3)** Replace the block from the comment line 209 (`// aggregate HORIZONTAL closing direction d̂ from the relative velocity at the contact centroid.`) through line 305 (the `}` closing the `if (this.effects && TUN.crush.fling > 0 …)` block, i.e. everything up to but NOT including `} else if (depth >= TUN.crush.minDepth) {`) with:

```ts
    // Aggregate HORIZONTAL relative direction d̂ at the contact centroid — now only (a) a cheap
    // "is anything moving" gate and (b) the FALLBACK closing axis for contacts whose local surface
    // normal is degenerate (contacted B cell fully interior — a deep engulf — or a purely vertical
    // face). Classification itself is PER CONTACT along each contact's local normal (below): a
    // T-bone/angled ram reads its true perpendicular closing speed and a parallel scrape reads ~0
    // instead of the full slide speed (the old single-d̂ rule misread both). Horizontal-only so
    // wave heave never reads as closing, and so the bite (applied at COM height) yaws, never rolls.
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

    // ---- classify each contact: BREAK (LOCAL closing > vBreak) vs REST ----
    // Each contact's closing speed is measured along its OWN horizontal contact normal ĝ — the
    // occupancy-gradient normal of B at the contacted cell (from detectContacts), negated to point
    // INTO B, horizontal-projected and re-normalized. Round-12 fix: the old rule projected every
    // contact onto ONE aggregate direction d̂ (the relative-velocity direction itself), which (a)
    // read a parallel side-scrape's slide speed as "closing" → grinding hulls tore each other's
    // sides off, and (b) mixed a T-bone victim's forward motion into the closing axis → the bite
    // braked motion TANGENT to the impact. A degenerate local normal (interior cell in a deep
    // engulf, or a purely vertical face) falls back to d̂ — the old behavior, which is what the
    // deep-lodge COM-line logic was designed around. brokenA/brokenB are reused member scratch
    // (cleared here), backed by a tuple pool, so classification allocates nothing in a sustained ram.
    let bSumX = 0, bSumY = 0, bSumZ = 0;
    let sumV2 = 0;            // Σ vci² over breaking contacts → per-contact energy budget (½·μ·mean v²)
    let gSumX = 0, gSumZ = 0; // Σ ĝ·vci → closing-weighted mean break direction ḡ
    const brokenA = this.brokenA, brokenB = this.brokenB;
    const ptsA = this.ptsA, ptsB = this.ptsB;
    const nrm = sc.normals!;
    brokenA.length = 0;
    brokenB.length = 0;
    ptsA.length = 0;
    ptsB.length = 0;
    if (moving) {
      for (let i = 0; i < count; i++) {
        const o = i * 3;
        const px = sc.points[o], py = sc.points[o + 1], pz = sc.points[o + 2];
        // local horizontal closing axis ĝ, pointing INTO B (= −outward normal of B at the contact).
        let gx = -nrm[o], gz = -nrm[o + 2];
        const glen = Math.hypot(gx, gz);
        if (glen > 1e-4) { gx /= glen; gz /= glen; }
        else { gx = dhx; gz = dhz; } // degenerate local normal → aggregate fallback (old behavior)
        this.velAt(this.comA, lvA, avA, px, py, pz, this.vA);
        this.velAt(this.comB, lvB, avB, px, py, pz, this.vB);
        const vci = (this.vA.x - this.vB.x) * gx + (this.vA.z - this.vB.z) * gz; // horizontal LOCAL closing
        if (vci <= TUN.crush.vBreak) continue;
        // DEFENSIVE clamp, mirrored from sim/crush.breakImpulse: real closing speeds are <~10 m/s;
        // 50 only catches a teleport-deep degenerate overlap blowing up the energy budget.
        const vc = Math.min(vci, 50);
        // pooled push (no per-contact allocation in a sustained ram). Only flag B's cell when B can
        // actually be carved — terrain (canCarve === false) is never eroded, so its broken layer is
        // never collected and ALL the budget falls on the ship. The A and B cells of one contact share
        // the same world contact point (the A-cell centre), so both get `px,py,pz` for the distance sort.
        this.pushBroken(brokenA, this.poolA, sc.aCells[o], sc.aCells[o + 1], sc.aCells[o + 2]);
        ptsA.push(px, py, pz);
        if (b.canCarve) { this.pushBroken(brokenB, this.poolB, sc.bCells[o], sc.bCells[o + 1], sc.bCells[o + 2]); ptsB.push(px, py, pz); }
        bSumX += px; bSumY += py; bSumZ += pz;
        sumV2 += vc * vc;
        gSumX += gx * vc; gSumZ += gz * vc;
      }
    }
    const breakCount = brokenA.length;

    let removedA = 0, removedB = 0, energy = 0, force = 0, vClose = 0;

    if (breakCount > 0) {
      // ---- BREAK regime: destruction is BOUNDED by the collision energy ----
      // The budget is allocated PER CONTACT: each breaking contact contributes ½·(μ/N)·vci² — its
      // own closing KE at an equal reduced-mass share — so the total is ½·μ·mean(vci²) = ½·μ·vEff².
      // For a uniform head-on this is EXACTLY the old ½·μ·vClose² (every vci equal); for an angled
      // hit only the genuinely-closing share of the motion pays for carving — the tangential slide
      // is never spent as break energy, and since vci ≤ |vrel| per contact the total can never
      // exceed the pair's real closing KE (no energy injection). Carve nearest-the-impact first up
      // to that budget: a ram bites a hole and LODGES once the energy is spent instead of carving
      // the whole overlap. Against terrain B can't carve, so ALL the budget erodes the ship.
      // maxStepEnergy is only an anti-vaporize clamp for a pathological (teleport) deep overlap.
      const bcx = bSumX / breakCount, bcy = bSumY / breakCount, bcz = bSumZ / breakCount;
      // closing-weighted mean break direction ḡ (unit, horizontal). Head-on: every ĝ ≡ d̂ → ḡ = d̂
      // exactly. Degenerate (a symmetric pincer summing to ~0) → d̂ fallback.
      let gbx = gSumX, gbz = gSumZ;
      const gblen = Math.hypot(gbx, gbz);
      if (gblen > 1e-6) { gbx /= gblen; gbz /= gblen; } else { gbx = dhx; gbz = dhz; }
      this.velAt(this.comA, lvA, avA, bcx, bcy, bcz, this.vA);
      this.velAt(this.comB, lvB, avB, bcx, bcy, bcz, this.vB);
      const sA = this.vA.x * gbx + this.vA.z * gbz; // A's speed along ḡ (who is driving in?)
      const sB = this.vB.x * gbx + this.vB.z * gbz; // B's speed along ḡ (0 for static terrain)
      vClose = Math.min(Math.sqrt(sumV2 / breakCount), 50); // RMS per-contact closing (≡ old head-on vClose)
      const budget = Math.min(0.5 * mu * vClose * vClose, TUN.crush.maxStepEnergy);
      energy = this.carveWithinBudget(a, b, brokenA, brokenB, this.ptsA, this.ptsB, bcx, bcy, bcz, tough, budget);
      removedA = this.lastRemovedA; removedB = this.lastRemovedB;
      // The fracture energy is shed as a DRAG on the hull(s) driving INTO the contact — the crumbling
      // layer carries its momentum off as debris and pushes the body behind it ~nothing, so a heavy
      // ram spends its OWN speed boring through and a dead-in-the-water victim is NOT accelerated up
      // to ramming speed (see crush.splitClosingImpulse; transferFrac dials the shove back in).
      const dvClose = breakImpulse(mu, vClose, energy, TUN.crush.biteDvCap) / mu; // closing-speed to remove
      let { jA, jB } = splitClosingImpulse(mA, mB, mu, sA, sB, dvClose, TUN.crush.transferFrac);
      // DEFENSIVE finite guard: a NaN/Inf impulse (e.g. from a degenerate mass/velocity) must never
      // reach applyImpulseAtPoint and launch a hull. Real impulses are finite; this only catches corruption.
      if (!Number.isFinite(jA)) jA = 0;
      if (!Number.isFinite(jB)) jB = 0;
      this.pushAtComHeight(a, bcx, bcz, this.comA.y, -gbx, -gbz, jA); // slow A's approach (+ḡ)
      this.pushAtComHeight(b, bcx, bcz, this.comB.y, gbx, gbz, jB);   // drag/transfer onto B (−ḡ; no-op for terrain)
      force = (jA + jB) / dt;

      const removed = removedA + removedB;
      if (this.effects && removed > 0) {
        this.effects.crunch(this.pt2.set(bcx, bcy, bcz), removed);
      }
      if (this.effects && TUN.crush.fling > 0 && removed > 0) {
        this.pt2.set(bcx, bcy, bcz);
        this.imp.set(gbx, 0, gbz);
        this.effects.impactDebris(this.pt2, this.imp, Math.min(removed * TUN.crush.fling, 40));
      }
```

(The following `} else if (depth >= TUN.crush.minDepth) {` REST block and everything after it are untouched in this task.)

- [ ] Run: `npx vitest run tests/voxelContactRegression.test.ts` — expected: **all pass** (head-on characterization holds: ~41-42 cells inside the [40,50] band, impulses still exactly ∓577,500 / +122,500 because `biteDvCap` binds in both worlds; 45° ratio ≈ 1.29; scrape carves 0; T-bone |imp.z|/|imp.x| ≈ 0.14).
- [ ] Run: `npx vitest run tests/voxelContact.test.ts` — expected: **all 6 pass unchanged**. Analysis vs HEAD: the terrain fast-ram still breaks (all 16 contacts read ≥ 4.24 m/s locally, removed drops ~4→3, assertion is only `> 0`); the two "no checkerboard" tests keep breaking all their A-side candidates (deep-overlap interior B cells have zero gradient → d̂ fallback ≡ old behavior; only B's tangential side-wall cells drop out), and the nearest-first ordering is untouched, so `>= 6`, compactness and connectivity hold. If any of these four fail, that is NOT an expected shift — debug with superpowers:systematic-debugging before touching the expectation.
- [ ] Run `npm run test` (full suite) and `npm run build` — expected: green/clean.
- [ ] Commit:
```
git add src/game/voxelContact.ts tests/voxelContactRegression.test.ts
git commit -m "feat(contact): classify + budget per-contact along local surface normals

Each voxel contact now reads its closing speed along its OWN horizontal contact
normal (B's occupancy gradient from detectContacts; aggregate-d̂ fallback for
interior/vertical degenerates). Break budget = ½·μ·mean(vci²) — bounded by the
real closing KE, tangential slide no longer pays for carving. Bite impulse acts
along the closing-weighted mean normal ḡ (≡ d̂ for a head-on: characterization
impulses unchanged to the newton). Fixes T-bone over/mis-classification and
parallel-scrape side-tearing (the bug vBreak 2→4 band-aided).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Robust REST separation — fallback push-axis chain + tangential scrape friction

**Files**
- Modify: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\game\voxelContact.ts` (new module constant near the top after the imports; replace the whole `} else if (depth >= TUN.crush.minDepth) {` block — it starts at the line with that exact text and ends at the `}` immediately before `return { overlapCount: count, depth, force, energy, removedA, removedB, vClose };`)
- Modify: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\voxelContactRegression.test.ts` (append a describe block)

**Interfaces**
- Consumes: Task 3's classification (a parallel scrape must reach the REST branch for friction to be observable).
- Produces: new module constant `const SCRAPE_FRICTION = 0.02` in `game/voxelContact.ts` (candidate TUN knob — handoff item, Task 6). No signature changes.

- [ ] Append to `tests/voxelContactRegression.test.ts`:

```ts
describe("REST robustness — scrape friction + degenerate-axis separation (round-12 fix)", () => {
  it("two hulls grinding side-by-side shed relative slide speed and separate without damage", () => {
    const contact = new VoxelContact();
    const { A, B } = mkPair({ x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, 7.5);
    let sep = -1;
    for (let i = 0; i < 10; i++) { if (!step(contact, A, B)) { sep = i; break; } }
    expect(sep).toBeGreaterThanOrEqual(0);        // lateral de-pen expels the press within 10 steps
    expect(A.removed).toHaveLength(0);            // a slide is never damage
    expect(B.removed).toHaveLength(0);
    expect(A.vel.z).toBeLessThan(4.99);           // friction shed some of A's slide…
    expect(A.vel.z).toBeGreaterThan(4.5);         // …but only a small bite (no stop, no reversal)
    expect(B.vel.z).toBeGreaterThan(0.005);       // equal-and-opposite share dragged B along
    expect(B.vel.z).toBeLessThan(0.5);
    // momentum conserved exactly — the friction pair is equal-and-opposite:
    expect(2e5 * (5 - A.vel.z)).toBeCloseTo(2e5 * B.vel.z, -1);
  });

  it("a pressed pair with degenerate COM line AND vertical thin axis still separates (no deadlock)", () => {
    const contact = new VoxelContact();
    // A 2³ block lodged into the TOP of an 8³ block, horizontally concentric: the COM→COM line has
    // zero horizontal length and the contact's thin axis is vertical (zero horizontal projection).
    // Before the fallback chain, NEITHER push-out fired — welded forever (the true finding-4 bug).
    const B = new SimTarget(solidBlock(8, OAK), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 2e5, true, 1);
    const A = new SimTarget(solidBlock(2, OAK), { x: 3, y: 7.2, z: 3 }, { x: 0, y: 0, z: 0 }, 1e3, true, 1);
    let sep = -1;
    for (let i = 0; i < 25; i++) { if (!contact.resolveContact(A, B, DT)) { sep = i; break; } }
    expect(sep).toBeGreaterThanOrEqual(0);        // escapes horizontally within 25 steps
    expect(A.removed).toHaveLength(0);
    expect(B.removed).toHaveLength(0);
    expect(A.impulses).toHaveLength(0);           // position-only — no fling from a still press
    expect(A.pos.y).toBeCloseTo(7.2, 9);          // the vertical is NEVER touched (horizontal-only law)
  });
});
```

- [ ] Run: `npx vitest run tests/voxelContactRegression.test.ts` — expected failures: scrape test with `expected 5 to be less than 4.99` (de-pen separates but no friction exists, A keeps its full slide); stacked test with `expected -1 to be greaterThanOrEqual 0` (deadlock). Everything else passes.
- [ ] Implement. **(1)** In `src/game/voxelContact.ts`, after the imports (below line 6), add:

```ts
/** REST-regime tangential friction: fraction of the tangential relative speed shed per step as a
 *  reduced-mass impulse pair jT = μ·vTan·SCRAPE_FRICTION (≈70%/s relative-slide decay at 60 Hz).
 *  Equal-and-opposite (momentum-conserving) and strictly ≤ μ·vTan, so it can only SHRINK the slide
 *  — never reverse or fling; horizontal at COM height (yaw, never roll); heavier = harder to shove
 *  (Δv = jT/m); a no-op on terrain's applyImpulseAtPoint, so a grounded scrape just bleeds the
 *  ship's slide. Round-12 handoff: candidate for promotion to TUN.crush.scrapeFriction. */
const SCRAPE_FRICTION = 0.02;
```

**(2)** Replace the entire REST block (`} else if (depth >= TUN.crush.minDepth) {` … through its closing `}` just before the `return {` statement) with:

```ts
    } else if (depth >= TUN.crush.minDepth) {
      // ---- REST regime: too slow to break → DELETE the closing velocity + push the hulls apart so
      // no two voxels share space — "the final voxel that won't break stops the ram dead": once
      // breaking has bled the approach below vBreak, the layer it can't pay to break cancels the
      // rest of the closing and expels the lodged hull.
      //
      // Push-out direction: the HORIZONTAL COM→COM line — NOT the geometric push-out axis, which
      // FLIPS when one hull engulfs another (a deep-lodged ram would be shoved further IN, the
      // "nose rotates straight through the voxels" bug). The COM line never flips — but it CAN be
      // degenerate (hulls horizontally concentric), so it now falls back, ROBUSTLY and never to a
      // deadlock: → the contact's horizontal thin axis (ov.axis) → the centroid→B-COM line → +x as
      // a deterministic last resort (pathological perfectly-stacked case only). HORIZONTAL only so
      // buoyancy keeps owning the vertical (a downward shove used to ram a holed victim past the
      // −12 m "sunk" line → premature respawn). Against terrain (huge mB) the inverse-mass split
      // puts ~all the de-penetration on the ship.
      let nx = this.comB.x - this.comA.x, nz = this.comB.z - this.comA.z;
      let nlen = Math.hypot(nx, nz);
      if (nlen <= 1e-4) { nx = ov.axis[0]; nz = ov.axis[2]; nlen = Math.hypot(nx, nz); }
      if (nlen <= 1e-4) { nx = this.comB.x - cx; nz = this.comB.z - cz; nlen = Math.hypot(nx, nz); }
      if (nlen <= 1e-4) { nx = 1; nz = 0; nlen = 1; }
      nx /= nlen; nz /= nlen;
      const invA = mB / (mA + mB), invB = mA / (mA + mB); // inverse-mass split (terrain huge mB → invA≈1, invB≈0)
      const cap = TUN.crush.maxDepenSpeed * dt;            // per-step positional ceiling (HORIZONTAL)

      this.velAt(this.comA, lvA, avA, cx, cy, cz, this.vA);
      this.velAt(this.comB, lvB, avB, cx, cy, cz, this.vB);
      const rvx = this.vA.x - this.vB.x, rvz = this.vA.z - this.vB.z; // horizontal relative velocity at the contact
      vClose = rvx * nx + rvz * nz;
      if (vClose > 0) {
        // full inelastic cancel of the (sub-vBreak) closing — they stop moving INTO each other.
        const jv = mu * Math.min(vClose, TUN.crush.biteDvCap);
        this.pushAtComHeight(a, cx, cz, this.comA.y, -nx, -nz, jv);
        this.pushAtComHeight(b, cx, cz, this.comB.y, nx, nz, jv);
        force = jv / dt;
      }

      // TANGENTIAL scrape friction (round 12): the cancel + de-pen only act along n̂; a grinding
      // side-scrape carries most of its relative velocity PERPENDICULAR to n̂ and used to slide on
      // forever (and, before local-normal classification, tear the sides off instead). Shed a small
      // fixed fraction of the tangential relative speed per step (see SCRAPE_FRICTION above).
      const tvx0 = rvx - vClose * nx, tvz0 = rvz - vClose * nz;
      const tlen = Math.hypot(tvx0, tvz0);
      if (tlen > 1e-3) {
        const tx = tvx0 / tlen, tz = tvz0 / tlen;
        const jT = mu * tlen * SCRAPE_FRICTION;
        this.pushAtComHeight(a, cx, cz, this.comA.y, -tx, -tz, jT);
        this.pushAtComHeight(b, cx, cz, this.comB.y, tx, tz, jT);
        force += jT / dt;
      }

      // POSITION de-penetration, inverse-mass split — unchanged mechanics, but it now ALWAYS has a
      // valid axis (the fallback chain above), so a degenerate press can no longer deadlock. Strong
      // enough to EXPEL a lodged hull; the overlap only ever decreases because the closing above is
      // zeroed first, so it can't re-penetrate. Position-only (no velocity added) so a hard
      // separation still can't "jar" / fling.
      const corr = Math.min(depth * TUN.crush.depen, cap);
      const moveA = corr * invA, moveB = corr * invB; // terrain's huge mB → moveA≈corr, moveB≈0
      const ta = a.translation();
      a.setTranslation({ x: ta.x - nx * moveA, y: ta.y, z: ta.z - nz * moveA });
      const tb = b.translation();
      b.setTranslation({ x: tb.x + nx * moveB, y: tb.y, z: tb.z + nz * moveB }); // no-op for terrain

      // OFF-AXIS push-out (the corner-clip blind spot): when the genuine separating axis (ov.axis,
      // the contact's thin face normal) DISAGREES with the push axis (|axis·n̂| low — a glancing
      // corner-clip, not a bow-on ram), also resolve along its horizontal projection, faded in as
      // the disagreement grows (no double-counting). If n̂ already fell back to ov.axis above,
      // align is 1 and this is a no-op. Position-only, same cap, closing already zeroed → can only
      // shrink the overlap. HORIZONTAL only, so buoyancy keeps owning the vertical.
      let axx = ov.axis[0], axz = ov.axis[2];
      const axLen = Math.hypot(axx, axz);
      if (axLen > 1e-4) {
        axx /= axLen; axz /= axLen;
        const align = Math.abs(axx * nx + axz * nz);
        if (align < 0.5) {
          const w = 1 - align / 0.5;
          const corr2 = Math.min(depth * TUN.crush.depen, cap) * w;
          if (corr2 > 0) {
            const mvA2 = corr2 * invA, mvB2 = corr2 * invB;
            const ta2 = a.translation();
            a.setTranslation({ x: ta2.x - axx * mvA2, y: ta2.y, z: ta2.z - axz * mvA2 });
            const tb2 = b.translation();
            b.setTranslation({ x: tb2.x + axx * mvB2, y: tb2.y, z: tb2.z + axz * mvB2 }); // no-op for terrain
          }
        }
      }
    }
```

- [ ] Run: `npx vitest run tests/voxelContactRegression.test.ts` — expected: **all pass** (scrape: friction sheds ≈0.05 m/s off A per contact step, momentum-symmetric; stacked pair escapes along the deterministic +x fallback in ~10-14 steps; Task 1's slow-press test still sees ZERO impulses — its tangential speed is exactly 0).
- [ ] Run `npm run test` (full suite — `tests/voxelContact.test.ts`'s slow-drift terrain test has zero tangential speed and an aligned axis, so it is bit-identical) and `npm run build`.
- [ ] Commit:
```
git add src/game/voxelContact.ts tests/voxelContactRegression.test.ts
git commit -m "feat(contact): robust REST separation — fallback push-axis chain + scrape friction

REST push axis: COM line → horizontal ov.axis → centroid→B-COM → +x (deterministic
last resort) — a pressed pair can never deadlock (stacked/engulfed degenerate).
New equal-and-opposite tangential friction (SCRAPE_FRICTION 0.02/step, ≤ μ·vTan,
horizontal at COM height) so grinding hulls shed relative slide and part cleanly.
De-pen stays position-only, horizontal-only, closing pre-zeroed (anti-fling).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: SP4 — pool `planCarve`'s heap + seen-set (deterministic)

**Files**
- Modify: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\sim\carve.ts` (full-file rewrite below; behavior identical)
- Modify: `C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\carve.test.ts` (append one test)

**Interfaces**
- `export function planCarve(p: CarveParams): CarveResult` — signature, semantics, and visit order UNCHANGED. `CarveResult.cells` remains a FRESH array (returned to callers — never pooled). Only the internal heap + seen-set are module-level pooled state, fully reset at entry (sim/ purity: no new imports, no Date.now/Math.random).

- [ ] Append to `tests/carve.test.ts` inside the `describe("planCarve", …)` block:

```ts
  it("pooled scratch carries NOTHING across calls (same call → same result after unrelated calls)", () => {
    const mk = () => planCarve({ ...uniform([30, 1, 30], 2), origin: [15, 0, 15], dir: [1, 0, 0], energy: 50 * C, maxCells: 999 });
    const first = mk();
    // dirty the pooled heap + seen set with unrelated, differently-shaped work…
    planCarve({ ...uniform([9, 9, 9], 8), origin: [4, 4, 4], dir: [0, 1, 0], energy: 200 * C, maxCells: 7 });
    planCarve({ dims: [5, 5, 5], isSolid: () => false, strengthAt: () => 1, origin: [2, 2, 2], dir: null, energy: 1e9, maxCells: 99 });
    // …then the identical call must be bit-identical (determinism survives pooling).
    const again = mk();
    expect(again.cells).toEqual(first.cells);
    expect(again.spent).toBe(first.spent);
  });
```

- [ ] Run: `npx vitest run tests/carve.test.ts` — expected: **passes already** (this is the contract lock; TDD here is "green → refactor → still green").
- [ ] Replace the entire content of `src/sim/carve.ts` with:

```ts
// Pure, deterministic, engine-free. Spends an energy budget removing voxels,
// cheapest-to-reach first, biased along an impact direction. The single
// destruction primitive both ramming and cannon fire route through.
import { STRENGTH_TO_JOULES } from "./materials";

export interface CarveParams {
  dims: [number, number, number];
  isSolid: (x: number, y: number, z: number) => boolean;
  strengthAt: (x: number, y: number, z: number) => number; // material strength of a solid cell
  origin: [number, number, number];     // impact cell (may be empty; the flood finds the nearest solid)
  dir: [number, number, number] | null; // unit impact direction; null = isotropic
  energy: number;                        // joules
  maxCells: number;                      // per-call hard cap
}
export interface CarveResult { cells: [number, number, number][]; spent: number; }

const LATERAL_BIAS = 1.5; // lateral/backward steps cost up to ×(1+LATERAL_BIAS) more than forward
const STEPS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// ---- pooled per-call scratch (round-12 SP4) ----
// planCarve used to build a fresh node-object binary heap + a fresh seen-Set on EVERY call — pure
// GC churn on the damage path. The heap is now four parallel number arrays with an explicit live
// length (no node objects at all) and `seen` is one module-level Set; both are FULLY reset at
// function entry (heapLen = 0, seen.clear()), so no state crosses calls. Determinism preserved:
// the module is synchronous + single-threaded, the comparisons and visit order are IDENTICAL to
// the old object heap (min-heap keyed on cumulative cost only), and there are no game/render
// imports and no Date.now/Math.random (sim/ purity). The RESULT array is always fresh — callers
// keep it.
const heapC: number[] = [];
const heapX: number[] = [];
const heapY: number[] = [];
const heapZ: number[] = [];
let heapLen = 0;
const seen = new Set<number>();

function heapSwap(i: number, j: number): void {
  let t = heapC[i]; heapC[i] = heapC[j]; heapC[j] = t;
  t = heapX[i]; heapX[i] = heapX[j]; heapX[j] = t;
  t = heapY[i]; heapY[i] = heapY[j]; heapY[j] = t;
  t = heapZ[i]; heapZ[i] = heapZ[j]; heapZ[j] = t;
}
function heapUp(n: number): void {
  while (n > 0) { const par = (n - 1) >> 1; if (heapC[par] <= heapC[n]) break; heapSwap(par, n); n = par; }
}
function heapDown(n: number): void {
  for (;;) {
    let s = n; const l = 2 * n + 1, r = 2 * n + 2;
    if (l < heapLen && heapC[l] < heapC[s]) s = l;
    if (r < heapLen && heapC[r] < heapC[s]) s = r;
    if (s === n) break;
    heapSwap(s, n); n = s;
  }
}
function heapPush(c: number, x: number, y: number, z: number): void {
  heapC[heapLen] = c; heapX[heapLen] = x; heapY[heapLen] = y; heapZ[heapLen] = z;
  heapUp(heapLen++);
}
/** Pops the min-cost node into _top (module scratch — no per-pop allocation). */
const _top = { c: 0, x: 0, y: 0, z: 0 };
function heapPop(): void {
  _top.c = heapC[0]; _top.x = heapX[0]; _top.y = heapY[0]; _top.z = heapZ[0];
  heapLen--;
  if (heapLen > 0) {
    heapC[0] = heapC[heapLen]; heapX[0] = heapX[heapLen]; heapY[0] = heapY[heapLen]; heapZ[0] = heapZ[heapLen];
    heapDown(0);
  }
}

export function planCarve(p: CarveParams): CarveResult {
  const [nx, ny, nz] = p.dims;
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const d = p.dir ? norm(p.dir) : null;

  heapLen = 0;   // reset the pooled scratch — nothing survives from the previous call
  seen.clear();

  const seed = nearestSolid(p);
  if (!seed) return { cells: [], spent: 0 };
  heapPush(0, seed[0], seed[1], seed[2]); seen.add(idx(seed[0], seed[1], seed[2]));

  const out: [number, number, number][] = []; // returned to the caller — NEVER pooled
  let spent = 0;
  while (heapLen > 0 && out.length < p.maxCells) {
    heapPop();
    const curC = _top.c, curX = _top.x, curY = _top.y, curZ = _top.z;
    const cost = p.strengthAt(curX, curY, curZ) * STRENGTH_TO_JOULES; // removal cost (raw)
    if (spent + cost > p.energy) break;                               // can't afford the cheapest remaining → done
    spent += cost; out.push([curX, curY, curZ]);
    for (const [sx, sy, sz] of STEPS) {
      const x = curX + sx, y = curY + sy, z = curZ + sz;
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      if (!p.isSolid(x, y, z)) continue;
      const ni = idx(x, y, z); if (seen.has(ni)) continue; seen.add(ni);
      const align = d ? Math.max(0, sx * d[0] + sy * d[1] + sz * d[2]) : 1;
      const penalty = 1 + LATERAL_BIAS * (1 - align); // forward ×1, lateral/back up to ×2.5
      heapPush(curC + p.strengthAt(x, y, z) * STRENGTH_TO_JOULES * penalty, x, y, z);
    }
  }
  return { cells: out, spent };
}

function norm(v: [number, number, number]): [number, number, number] { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; }

function nearestSolid(p: CarveParams): [number, number, number] | null {
  const o: [number, number, number] = [Math.round(p.origin[0]), Math.round(p.origin[1]), Math.round(p.origin[2])];
  if (inBounds(p.dims, o) && p.isSolid(o[0], o[1], o[2])) return o;
  for (let r = 1; r <= 6; r++) for (const [sx, sy, sz] of STEPS) {
    const c: [number, number, number] = [o[0] + sx * r, o[1] + sy * r, o[2] + sz * r];
    if (inBounds(p.dims, c) && p.isSolid(c[0], c[1], c[2])) return c;
  }
  return null;
}
function inBounds(dims: [number, number, number], c: [number, number, number]): boolean {
  return c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < dims[0] && c[1] < dims[1] && c[2] < dims[2];
}
```

- [ ] Run: `npx vitest run tests/carve.test.ts` — expected: all 7 pass (6 pre-existing + the new pool-contamination lock; the parallel-array heap performs the exact comparison sequence of the old object heap, so results are bit-identical).
- [ ] Run `npm run test` and `npm run build` — expected: green/clean.
- [ ] Commit:
```
git add src/sim/carve.ts tests/carve.test.ts
git commit -m "perf(carve): pool planCarve's heap + seen-set across calls (deterministic)

Module-level parallel-array min-heap + one reused Set, fully reset at entry —
zero per-call scratch allocation, identical comparison/visit order, result array
still fresh. sim/ purity untouched. Note: planCarve currently has no live caller
(ship.carve is uncalled; cannons route via ship.crush/planCrush) — pooled per the
round-12 SP4 spec for the oracle + future callers.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Final verification + handoff notes

**Files**
- None created or modified (verification + report only; do NOT edit CLAUDE.md — it is not owned by this agent).

**Interfaces**
- Produces: the handoff-note block below, delivered verbatim in this agent's completion report to the orchestrator.

- [ ] Run `npm run build` — expected: clean `tsc --noEmit` + vite build.
- [ ] Run `npm run test` — expected: every file green (431+ tests, now including ~10 new). If `tests/brig.test.ts` / `tests/manOfWar*.test.ts` time out, re-run isolated (`npx vitest run tests/brig.test.ts tests/manOfWar.test.ts tests/manOfWarFloat.test.ts`) before treating as red.
- [ ] Confirm `git status` shows NO unstaged changes to frozen files (`src/core/tunables.ts`, `src/game/ship.ts`, `src/game/world.ts`, `src/main.ts`, `src/render/**`) and that only this plan's five commits exist on top of the starting HEAD. Do NOT push.
- [ ] Include this handoff block in the completion report:

```
ROUND-12 AGENT A — TUN / cross-agent handoff notes
1. NEW constant SCRAPE_FRICTION = 0.02 in game/voxelContact.ts (REST tangential
   friction, ~70%/s relative-slide decay). Candidate for promotion to
   TUN.crush.scrapeFriction — tunables.ts is owned by agent C (wave 1) / D (wave 2).
2. TUN.crush.vBreak was raised 2→4 specifically because side-by-side pressed hulls
   tore each other apart under the aggregate-d̂ rule. Local-normal classification
   fixes that structurally; vBreak could be re-evaluated toward its physical value
   (feel decision for Josh — NOT changed this round).
3. ContactDebug.vClose (dev-panel contact readout) is now the RMS of per-contact
   closing speeds in the BREAK regime (≡ old value for a clean head-on).
4. Discovered dead code: Ship.carve() (game/ship.ts:1145) has zero call sites, so
   sim/carve.planCarve is currently only exercised by the oracle. Cleanup-agent (E)
   candidate; pooling landed anyway per SP4.
5. No TUN values were changed; no frozen files were touched.
```

### Critical Files for Implementation
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\game\voxelContact.ts
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\sim\voxelOverlap.ts
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\sim\carve.ts
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\voxelContactRegression.test.ts
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\voxelOverlap.test.ts
