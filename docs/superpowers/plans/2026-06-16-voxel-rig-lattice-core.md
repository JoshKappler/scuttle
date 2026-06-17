# Voxel Rig — Phase 1: Lattice Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, deterministic, unit-tested simulation core for SCUTTLE's breakable rig — point-masses joined by breakable links, with one rule (break overstressed links) — plus a builder that constructs a ship's rig (masts, yards, cloth, bowsprit) from its geometry. No rendering, no game wiring yet.

**Architecture:** Two new pure modules, `src/sim/rigLattice.ts` (the Verlet solver + the break rule + connectivity helpers) and `src/sim/rigBuild.ts` (assemble a `Rig` from a `RigSpec`). Both are side-effect-free and oracle-testable like `sim/buoyancy.ts` / `sim/crush.ts`. Forces (gravity/wind/buoyancy) and collisions are injected by the caller, so the core stays pure and deterministic. This is the foundation phases 2–5 build on.

**Tech Stack:** TypeScript, vitest (tests in `tests/<module>.test.ts`). No new dependencies. Math is plain `{x,y,z}` objects matching the existing `sim/rigDamage.ts` `V3` style.

**Spec:** `docs/superpowers/specs/2026-06-16-voxel-rig-design.md`

---

## File Structure

- **Create `src/sim/rigLattice.ts`** — types (`Vec3`, `RigNode`, `RigLink`, `Rig`, flag/kind enums), Verlet `integrate`, `relax` (with the break rule), `stepRig`, `kineticEnergy`, and connectivity helpers (`attachedToPin`, `components`). One responsibility: simulate and query a lattice.
- **Create `src/sim/rigBuild.ts`** — `buildRig(spec: RigSpec): Rig`. One responsibility: turn ship geometry into a `Rig`. Imports types from `rigLattice.ts`.
- **Create `tests/rigLattice.test.ts`** — unit tests for the solver + connectivity.
- **Create `tests/rigBuild.test.ts`** — unit tests for the builder.

No existing files are modified in Phase 1.

---

## Task 1: Core types + vector helpers

**Files:**
- Create: `src/sim/rigLattice.ts`
- Test: `tests/rigLattice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/rigLattice.test.ts
import { describe, it, expect } from "vitest";
import { dist, type RigNode, NodeFlag } from "../src/sim/rigLattice";

describe("rigLattice vec helpers", () => {
  it("dist measures node separation", () => {
    const a: RigNode = { pos: { x: 0, y: 0, z: 0 }, prev: { x: 0, y: 0, z: 0 }, mass: 1, pinned: false, flags: NodeFlag.WOOD };
    const b: RigNode = { pos: { x: 3, y: 4, z: 0 }, prev: { x: 3, y: 4, z: 0 }, mass: 1, pinned: false, flags: NodeFlag.WOOD };
    expect(dist(a.pos, b.pos)).toBeCloseTo(5, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: FAIL — `Failed to resolve import "../src/sim/rigLattice"` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

```ts
// src/sim/rigLattice.ts
/**
 * Rig lattice (voxel rig core): masts, yards, bowsprit and sails are all the
 * SAME primitive — point-masses joined by breakable distance links. ONE rule:
 * a link whose strain exceeds its breakStrain is deleted instead of satisfied.
 * Topple, break-in-half, tear, flap and detach all emerge from that. Pure &
 * deterministic (forces + collisions are injected by the caller); unit-tested
 * like sim/buoyancy.ts. See docs/superpowers/specs/2026-06-16-voxel-rig-design.md.
 */

export interface Vec3 { x: number; y: number; z: number; }

// Plain const objects, NOT enums: the project sets `isolatedModules: true` (so
// `const enum` is unsafe across modules) and uses no enums anywhere — match that.

/** Node role bits (bitmask in RigNode.flags). */
export const NodeFlag = {
  WOOD: 1,
  CLOTH: 2,
  FOOT: 4, // a hull anchor (mast foot / bowsprit heel); pinned to the deck
  WET: 8,
} as const;

/** Link material: WOOD is rigid (resists stretch AND compression); CLOTH only
 *  resists stretch (goes slack under compression, like real canvas). */
export const LinkKind = { WOOD: 0, CLOTH: 1 } as const;
export type LinkKindV = (typeof LinkKind)[keyof typeof LinkKind];

export interface RigNode {
  pos: Vec3;
  prev: Vec3; // previous position (Verlet velocity = pos - prev)
  mass: number;
  /** A world anchor: never integrated, never moved by relax. The mast foot and
   *  bowsprit heel start pinned; clearing the pin (hull voxel gone) frees the
   *  rig to fall. Cloth/yards are NOT pinned — they attach via links. */
  pinned: boolean;
  flags: number;
}

export interface RigLink {
  a: number; // node index
  b: number; // node index
  rest: number;
  breakStrain: number; // |len - rest| / rest beyond which the link deletes
  kind: LinkKindV;
  alive: boolean;
}

export interface Rig {
  nodes: RigNode[];
  links: RigLink[];
  awake: boolean;
  sleepTimer: number; // seconds spent below the sleep KE threshold
}

export function dist(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/sim/rigLattice.ts tests/rigLattice.test.ts
git commit -m "feat(rig): lattice core types + dist helper"
```

---

## Task 2: `relax` — constraint satisfaction + the break rule

**Files:**
- Modify: `src/sim/rigLattice.ts`
- Test: `tests/rigLattice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/rigLattice.test.ts
import { dist, relax, type Rig, type RigNode, NodeFlag, LinkKind } from "../src/sim/rigLattice";

function node(x: number, y: number, z: number, pinned = false): RigNode {
  return { pos: { x, y, z }, prev: { x, y, z }, mass: 1, pinned, flags: NodeFlag.WOOD };
}

describe("rigLattice relax", () => {
  it("pulls a stretched intact link back toward its rest length", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0), node(3, 0, 0)],
      links: [{ a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true }],
      awake: true, sleepTimer: 0,
    };
    relax(rig, 1);
    // both free, equal mass: each moves halfway toward closing the 3->1 gap
    expect(dist(rig.nodes[0].pos, rig.nodes[1].pos)).toBeLessThan(3);
    expect(rig.links[0].alive).toBe(true);
  });

  it("breaks (deletes) a link whose strain exceeds breakStrain", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0), node(3, 0, 0)],
      links: [{ a: 0, b: 1, rest: 1, breakStrain: 0.5, kind: LinkKind.WOOD, alive: true }],
      awake: true, sleepTimer: 0,
    };
    relax(rig, 1); // strain = (3-1)/1 = 2 > 0.5
    expect(rig.links[0].alive).toBe(false);
  });

  it("a pinned node does not move; the free end does all the correcting", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0, true), node(3, 0, 0)],
      links: [{ a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true }],
      awake: true, sleepTimer: 0,
    };
    relax(rig, 1);
    expect(rig.nodes[0].pos.x).toBe(0); // pinned, immovable
    expect(rig.nodes[1].pos.x).toBeCloseTo(1, 6); // free end snaps to rest
  });

  it("a slack CLOTH link applies no push (canvas does not strut)", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0), node(0.5, 0, 0)], // closer than rest
      links: [{ a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true }],
      awake: true, sleepTimer: 0,
    };
    relax(rig, 1);
    expect(rig.nodes[1].pos.x).toBeCloseTo(0.5, 6); // unchanged: slack
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: FAIL — `relax is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/sim/rigLattice.ts

/**
 * Satisfy all alive links over `iterations` passes (position-based dynamics).
 * THE ONE RULE: a link whose tension strain exceeds breakStrain is deleted
 * (alive=false) instead of satisfied. WOOD resists both stretch and
 * compression; CLOTH only resists stretch (slack under compression).
 */
export function relax(rig: Rig, iterations: number): void {
  const { nodes, links } = rig;
  for (let it = 0; it < iterations; it++) {
    for (const lk of links) {
      if (!lk.alive) continue;
      const a = nodes[lk.a], b = nodes[lk.b];
      const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-9) continue;
      const delta = d - lk.rest;
      // break on TENSION strain only (compression buckles, never snaps)
      if (delta > 0 && delta / lk.rest > lk.breakStrain) { lk.alive = false; continue; }
      // cloth goes slack under compression — no outward push
      if (lk.kind === LinkKind.CLOTH && delta < 0) continue;
      const wa = a.pinned ? 0 : 1 / a.mass;
      const wb = b.pinned ? 0 : 1 / b.mass;
      const wsum = wa + wb;
      if (wsum === 0) continue;
      const f = (delta / d) / wsum; // scalar correction per unit inverse-mass
      a.pos.x += dx * f * wa; a.pos.y += dy * f * wa; a.pos.z += dz * f * wa;
      b.pos.x -= dx * f * wb; b.pos.y -= dy * f * wb; b.pos.z -= dz * f * wb;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/sim/rigLattice.ts tests/rigLattice.test.ts
git commit -m "feat(rig): relax with the break rule (wood rigid, cloth slack)"
```

---

## Task 3: `integrate` — Verlet step with injected acceleration

**Files:**
- Modify: `src/sim/rigLattice.ts`
- Test: `tests/rigLattice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/rigLattice.test.ts
import { integrate } from "../src/sim/rigLattice";

describe("rigLattice integrate", () => {
  it("a free node under gravity falls by accel*dt^2 on the first step", () => {
    const rig: Rig = { nodes: [node(0, 10, 0)], links: [], awake: true, sleepTimer: 0 };
    const dt = 1 / 60;
    integrate(rig, () => ({ x: 0, y: -9.81, z: 0 }), dt, 1);
    // prev==pos initially → displacement = a*dt^2
    expect(rig.nodes[0].pos.y).toBeCloseTo(10 - 9.81 * dt * dt, 6);
    expect(rig.nodes[0].prev.y).toBeCloseTo(10, 6); // prev updated to old pos
  });

  it("a pinned node ignores acceleration", () => {
    const rig: Rig = { nodes: [node(0, 10, 0, true)], links: [], awake: true, sleepTimer: 0 };
    integrate(rig, () => ({ x: 0, y: -9.81, z: 0 }), 1 / 60, 1);
    expect(rig.nodes[0].pos.y).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: FAIL — `integrate is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/sim/rigLattice.ts

/** Acceleration supplier (gravity + wind + buoyancy), injected so the core
 *  stays pure and deterministic. Returns m/s^2 in ship-local axes. */
export type AccelFn = (n: RigNode, i: number) => Vec3;

/**
 * Position-Verlet integrate. `damp` is velocity retention (1 = none, <1 bleeds
 * energy). Pinned nodes are skipped. prev is set to the pre-step position so
 * the implicit velocity carries to the next step.
 */
export function integrate(rig: Rig, accel: AccelFn, dt: number, damp: number): void {
  const dt2 = dt * dt;
  const nodes = rig.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.pinned) continue;
    const a = accel(n, i);
    const px = n.pos.x, py = n.pos.y, pz = n.pos.z;
    n.pos.x = px + (px - n.prev.x) * damp + a.x * dt2;
    n.pos.y = py + (py - n.prev.y) * damp + a.y * dt2;
    n.pos.z = pz + (pz - n.prev.z) * damp + a.z * dt2;
    n.prev.x = px; n.prev.y = py; n.prev.z = pz;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: PASS (7 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/sim/rigLattice.ts tests/rigLattice.test.ts
git commit -m "feat(rig): Verlet integrate with injected acceleration"
```

---

## Task 4: `kineticEnergy` + `stepRig` (integrate → relax → sleep bookkeeping)

**Files:**
- Modify: `src/sim/rigLattice.ts`
- Test: `tests/rigLattice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/rigLattice.test.ts
import { kineticEnergy, stepRig } from "../src/sim/rigLattice";

describe("rigLattice stepRig + sleep", () => {
  it("kineticEnergy is zero when no node has moved", () => {
    const rig: Rig = { nodes: [node(0, 0, 0)], links: [], awake: true, sleepTimer: 0 };
    expect(kineticEnergy(rig, 1 / 60)).toBeCloseTo(0, 9);
  });

  it("stepRig accumulates sleepTimer while KE stays below the threshold", () => {
    const dt = 1 / 60;
    // a single pinned node never moves → KE stays 0 → timer climbs each step
    const rig: Rig = { nodes: [node(0, 5, 0, true)], links: [], awake: true, sleepTimer: 0 };
    const opts = { dt, damp: 1, iterations: 1, accel: () => ({ x: 0, y: -9.81, z: 0 }), sleepKE: 1e-6 };
    stepRig(rig, opts);
    stepRig(rig, opts);
    expect(rig.sleepTimer).toBeCloseTo(2 * dt, 6);
  });

  it("stepRig resets sleepTimer when the rig is moving", () => {
    const dt = 1 / 60;
    const rig: Rig = { nodes: [node(0, 5, 0)], links: [], awake: true, sleepTimer: 99 };
    stepRig(rig, { dt, damp: 1, iterations: 1, accel: () => ({ x: 0, y: -9.81, z: 0 }), sleepKE: 1e-12 });
    expect(rig.sleepTimer).toBe(0); // a falling node has KE above the tiny threshold
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: FAIL — `kineticEnergy is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/sim/rigLattice.ts

/** Sum of ½·m·v² over free nodes, where v = (pos - prev) / dt. */
export function kineticEnergy(rig: Rig, dt: number): number {
  let ke = 0;
  const inv = 1 / dt;
  for (const n of rig.nodes) {
    if (n.pinned) continue;
    const vx = (n.pos.x - n.prev.x) * inv;
    const vy = (n.pos.y - n.prev.y) * inv;
    const vz = (n.pos.z - n.prev.z) * inv;
    ke += 0.5 * n.mass * (vx * vx + vy * vy + vz * vz);
  }
  return ke;
}

export interface StepOpts {
  dt: number;
  damp: number;
  iterations: number;
  accel: AccelFn;
  sleepKE: number; // KE below this counts as "settling"
}

/**
 * One full rig step: integrate, satisfy/break links, then advance the sleep
 * timer. Collision (node-vs-hull crush) is injected by the runtime BETWEEN
 * integrate and relax in later phases; the pure core only does motion + the
 * break rule + sleep accounting. The runtime decides when to actually sleep.
 */
export function stepRig(rig: Rig, opts: StepOpts): void {
  integrate(rig, opts.accel, opts.dt, opts.damp);
  relax(rig, opts.iterations);
  if (kineticEnergy(rig, opts.dt) < opts.sleepKE) rig.sleepTimer += opts.dt;
  else rig.sleepTimer = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/sim/rigLattice.ts tests/rigLattice.test.ts
git commit -m "feat(rig): kineticEnergy + stepRig with sleep bookkeeping"
```

---

## Task 5: connectivity — `attachedToPin` (which cloth still hangs on)

**Files:**
- Modify: `src/sim/rigLattice.ts`
- Test: `tests/rigLattice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/rigLattice.test.ts
import { attachedToPin } from "../src/sim/rigLattice";

describe("rigLattice attachedToPin", () => {
  it("all nodes reachable from a pinned anchor over alive links are attached", () => {
    // chain: 0(pinned) - 1 - 2 - 3
    const rig: Rig = {
      nodes: [node(0, 0, 0, true), node(1, 0, 0), node(2, 0, 0), node(3, 0, 0)],
      links: [
        { a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
        { a: 1, b: 2, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
        { a: 2, b: 3, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
      ],
      awake: true, sleepTimer: 0,
    };
    expect(attachedToPin(rig)).toEqual([true, true, true, true]);
  });

  it("a severed link cuts the far nodes loose (detached strip)", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0, true), node(1, 0, 0), node(2, 0, 0), node(3, 0, 0)],
      links: [
        { a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
        { a: 1, b: 2, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: false }, // cut
        { a: 2, b: 3, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
      ],
      awake: true, sleepTimer: 0,
    };
    expect(attachedToPin(rig)).toEqual([true, true, false, false]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: FAIL — `attachedToPin is not a function`.

- [ ] **Step 3: Write minimal implementation**

```ts
// add to src/sim/rigLattice.ts

/**
 * Flood from every pinned (anchored) node over ALIVE links. A node that cannot
 * reach any anchor is detached — a torn-off cloth strip or a felled spar that
 * has left the ship. The runtime uses this to drop / float-away loose pieces.
 */
export function attachedToPin(rig: Rig): boolean[] {
  const n = rig.nodes.length;
  const attached = new Array<boolean>(n).fill(false);
  // adjacency over alive links
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const lk of rig.links) {
    if (!lk.alive) continue;
    adj[lk.a].push(lk.b);
    adj[lk.b].push(lk.a);
  }
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (rig.nodes[i].pinned) { attached[i] = true; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop()!;
    for (const j of adj[i]) {
      if (!attached[j]) { attached[j] = true; stack.push(j); }
    }
  }
  return attached;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rigLattice.test.ts`
Expected: PASS (12 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/sim/rigLattice.ts tests/rigLattice.test.ts
git commit -m "feat(rig): attachedToPin connectivity for tear/detach"
```

---

## Task 6: `buildRig` — the mast trunk (foot pinned, chained nodes)

**Files:**
- Create: `src/sim/rigBuild.ts`
- Test: `tests/rigBuild.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/rigBuild.test.ts
import { describe, it, expect } from "vitest";
import { buildRig, type RigSpec } from "../src/sim/rigBuild";
import { NodeFlag } from "../src/sim/rigLattice";

const oneMast: RigSpec = {
  voxelSize: 0.25,
  deckTopY: () => 2.0,
  masts: [{ x: 10, z: 4, h: 15 }],
};

describe("buildRig trunk", () => {
  it("builds a trunk whose foot is the single pinned, FOOT-flagged node", () => {
    const rig = buildRig(oneMast);
    const pinned = rig.nodes.filter((n) => n.pinned);
    expect(pinned.length).toBe(1);
    expect(pinned[0].flags & NodeFlag.FOOT).toBeTruthy();
    expect(pinned[0].flags & NodeFlag.WOOD).toBeTruthy();
  });

  it("foot sits on the deck top at the mast's world x/z", () => {
    const rig = buildRig(oneMast);
    const foot = rig.nodes.find((n) => n.pinned)!;
    expect(foot.pos.x).toBeCloseTo((10 + 0.5) * 0.25, 6);
    expect(foot.pos.z).toBeCloseTo((4 + 0.5) * 0.25, 6);
    expect(foot.pos.y).toBeCloseTo(2.0, 6);
  });

  it("trunk reaches the masthead height (deckTop + h)", () => {
    const rig = buildRig(oneMast);
    const topY = Math.max(...rig.nodes.map((n) => n.pos.y));
    expect(topY).toBeCloseTo(2.0 + 15, 4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rigBuild.test.ts`
Expected: FAIL — `Failed to resolve import "../src/sim/rigBuild"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/sim/rigBuild.ts
/**
 * Build a Rig (sim/rigLattice) from a ship's geometry. Mirrors the spar/sail
 * layout render/shipVisual already draws (trunk + 3 yards + 2 laced sails per
 * mast, plus the bowsprit) so the lattice lines up with the hull. Pure: takes a
 * RigSpec, returns a Rig. See the voxel-rig design spec.
 */
import { type Rig, type RigNode, type RigLink, type Vec3, type LinkKindV, NodeFlag, LinkKind, dist } from "./rigLattice";

export interface MastSpec { x: number; z: number; h: number; } // voxel coords (x,z); h in meters
export interface RigSpec {
  voxelSize: number;
  /** Deck-top height (m) at a mast's voxel-x — pass build.deckYAt-derived value. */
  deckTopY: (xVox: number) => number;
  masts: MastSpec[];
  /** Optional bowsprit as a ship-local heel→tip segment (meters). */
  bowsprit?: { heel: Vec3; tip: Vec3 };
}

// Tuning defaults (overridden live by TUN.rig once wired in a later phase).
const TRUNK_STEP = 2.0;   // m between trunk nodes
const WOOD_BREAK = 0.06;
const WOOD_MASS = 4.0;

export function buildRig(spec: RigSpec): Rig {
  const nodes: RigNode[] = [];
  const links: RigLink[] = [];
  const vs = spec.voxelSize;

  const addNode = (pos: Vec3, mass: number, flags: number, pinned: boolean): number => {
    nodes.push({ pos, prev: { ...pos }, mass, pinned, flags });
    return nodes.length - 1;
  };
  const addLink = (a: number, b: number, kind: LinkKindV, breakStrain: number): void => {
    links.push({ a, b, rest: dist(nodes[a].pos, nodes[b].pos), breakStrain, kind, alive: true });
  };

  for (const m of spec.masts) {
    const mx = (m.x + 0.5) * vs;
    const mz = (m.z + 0.5) * vs;
    const deckTop = spec.deckTopY(m.x);
    const count = Math.max(2, Math.round(m.h / TRUNK_STEP) + 1);
    let prevIdx = -1;
    for (let i = 0; i < count; i++) {
      const y = deckTop + (i / (count - 1)) * m.h;
      const isFoot = i === 0;
      const idx = addNode({ x: mx, y, z: mz }, WOOD_MASS, NodeFlag.WOOD | (isFoot ? NodeFlag.FOOT : 0), isFoot);
      if (prevIdx >= 0) addLink(prevIdx, idx, LinkKind.WOOD, WOOD_BREAK);
      prevIdx = idx;
    }
  }

  return { nodes, links, awake: false, sleepTimer: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rigBuild.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sim/rigBuild.ts tests/rigBuild.test.ts
git commit -m "feat(rig): buildRig mast trunk (foot pinned)"
```

---

## Task 7: `buildRig` — yards laced to the trunk

**Files:**
- Modify: `src/sim/rigBuild.ts`
- Test: `tests/rigBuild.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/rigBuild.test.ts
import { LinkKind } from "../src/sim/rigLattice";

describe("buildRig yards", () => {
  it("adds three yards (5 nodes each) per mast, spanning the beam", () => {
    const rig = buildRig(oneMast);
    // trunk count = round(15/2)+1 = 9; yards add 3*5 = 15 wood nodes
    const trunkCount = Math.round(15 / 2) + 1;
    const woodNodes = rig.nodes.filter((n) => n.flags & 0x1).length; // NodeFlag.WOOD
    expect(woodNodes).toBe(trunkCount + 15);
  });

  it("each yard center is laced to the trunk by a wood link", () => {
    const rig = buildRig(oneMast);
    // there is at least one wood link whose endpoints share x but differ in z=0 span...
    // simpler: the yard introduces links beyond the trunk's (count-1)
    const trunkCount = Math.round(15 / 2) + 1;
    const woodLinks = rig.links.filter((l) => l.kind === LinkKind.WOOD).length;
    // trunk: count-1; each yard: 4 span links + 1 sling link = 5; *3 yards = 15
    expect(woodLinks).toBe(trunkCount - 1 + 15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rigBuild.test.ts`
Expected: FAIL — woodNodes/woodLinks counts wrong (yards not built yet).

- [ ] **Step 3: Write minimal implementation**

Replace the `for (const m of spec.masts) { ... }` body in `src/sim/rigBuild.ts` with the version below (adds yards after the trunk; keeps trunk code identical). Add the `YARD_LEVELS` / `YARD_NODES` constants near the other tuning constants.

```ts
// near the other constants in src/sim/rigBuild.ts
const YARD_NODES = 5;            // nodes across one yard
const YARD_FORE = 0.25;          // m the yard sits forward of the trunk axis
const YARD_LEVELS = [            // fraction of mast height, fraction-of-height width
  { f: 0.17, wf: 0.71 },
  { f: 0.56, wf: 0.57 },
  { f: 0.88, wf: 0.43 },
];
```

```ts
// the per-mast loop body
for (const m of spec.masts) {
  const mx = (m.x + 0.5) * vs;
  const mz = (m.z + 0.5) * vs;
  const deckTop = spec.deckTopY(m.x);

  // --- trunk ---
  const count = Math.max(2, Math.round(m.h / TRUNK_STEP) + 1);
  const trunkIdx: number[] = [];
  let prevIdx = -1;
  for (let i = 0; i < count; i++) {
    const y = deckTop + (i / (count - 1)) * m.h;
    const isFoot = i === 0;
    const idx = addNode({ x: mx, y, z: mz }, WOOD_MASS, NodeFlag.WOOD | (isFoot ? NodeFlag.FOOT : 0), isFoot);
    if (prevIdx >= 0) addLink(prevIdx, idx, LinkKind.WOOD, WOOD_BREAK);
    trunkIdx.push(idx);
    prevIdx = idx;
  }

  const nearestTrunk = (y: number): number => {
    let best = trunkIdx[0], bestD = Infinity;
    for (const ti of trunkIdx) {
      const d = Math.abs(nodes[ti].pos.y - y);
      if (d < bestD) { bestD = d; best = ti; }
    }
    return best;
  };

  // --- yards (laced to the trunk at their center) ---
  for (const lv of YARD_LEVELS) {
    const yc = deckTop + lv.f * m.h;
    const width = m.h * lv.wf;
    const yardIdx: number[] = [];
    for (let j = 0; j < YARD_NODES; j++) {
      const z = mz - width / 2 + (width * j) / (YARD_NODES - 1);
      yardIdx.push(addNode({ x: mx + YARD_FORE, y: yc, z }, WOOD_MASS, NodeFlag.WOOD, false));
      if (j > 0) addLink(yardIdx[j - 1], yardIdx[j], LinkKind.WOOD, WOOD_BREAK);
    }
    const centerNode = yardIdx[(YARD_NODES - 1) >> 1];
    addLink(centerNode, nearestTrunk(yc), LinkKind.WOOD, WOOD_BREAK); // the sling
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rigBuild.test.ts`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/sim/rigBuild.ts tests/rigBuild.test.ts
git commit -m "feat(rig): buildRig yards laced to the trunk"
```

---

## Task 8: `buildRig` — cloth grids + bowsprit chain

**Files:**
- Modify: `src/sim/rigBuild.ts`
- Test: `tests/rigBuild.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// add to tests/rigBuild.test.ts
import { NodeFlag as NF, attachedToPin } from "../src/sim/rigLattice";

describe("buildRig cloth + bowsprit", () => {
  it("adds CLOTH_COLS*CLOTH_ROWS cloth nodes per sail (2 sails per mast)", () => {
    const rig = buildRig(oneMast);
    const cloth = rig.nodes.filter((n) => n.flags & NF.CLOTH).length;
    expect(cloth).toBe(2 * 8 * 6); // 2 sails, 8x6 grid
  });

  it("every cloth node is initially attached to the ship via the yards", () => {
    const rig = buildRig(oneMast);
    const att = attachedToPin(rig);
    rig.nodes.forEach((n, i) => {
      if (n.flags & NF.CLOTH) expect(att[i]).toBe(true);
    });
  });

  it("a bowsprit becomes a wood chain whose heel is pinned (FOOT)", () => {
    const rig = buildRig({
      ...oneMast,
      bowsprit: { heel: { x: 8, y: 3, z: 1 }, tip: { x: 12, y: 4, z: 1 } },
    });
    // the bowsprit heel is a second pinned/FOOT node, sited at its heel
    const feet = rig.nodes.filter((n) => n.pinned && n.flags & NF.FOOT);
    expect(feet.length).toBe(2); // mast foot + bowsprit heel
    expect(feet.some((n) => Math.abs(n.pos.x - 8) < 1e-6 && Math.abs(n.pos.y - 3) < 1e-6)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rigBuild.test.ts`
Expected: FAIL — cloth count 0 / no bowsprit nodes.

- [ ] **Step 3: Write minimal implementation**

Add the cloth constants, then (a) build a cloth grid between each consecutive yard pair inside the per-mast loop, and (b) build the bowsprit chain after the mast loop.

```ts
// near the other constants
const CLOTH_COLS = 8;
const CLOTH_ROWS = 6;
const CLOTH_FORE = 0.4;   // m the cloth hangs forward of the yards
const CLOTH_BREAK = 0.30;
const LACE_BREAK = 0.40;  // cloth-to-yard lacing (a touch tougher than the cloth)
const CLOTH_MASS = 0.4;
```

Inside the per-mast loop, AFTER the yards block, keep each level's node array and its `yc`/`width` so the cloth can lace to them. Replace the yards block's local `for (const lv of YARD_LEVELS)` with a version that records results:

```ts
  // --- yards (record geometry for the cloth) ---
  const yards: { idx: number[]; yc: number; width: number }[] = [];
  for (const lv of YARD_LEVELS) {
    const yc = deckTop + lv.f * m.h;
    const width = m.h * lv.wf;
    const yardIdx: number[] = [];
    for (let j = 0; j < YARD_NODES; j++) {
      const z = mz - width / 2 + (width * j) / (YARD_NODES - 1);
      yardIdx.push(addNode({ x: mx + YARD_FORE, y: yc, z }, WOOD_MASS, NodeFlag.WOOD, false));
      if (j > 0) addLink(yardIdx[j - 1], yardIdx[j], LinkKind.WOOD, WOOD_BREAK);
    }
    addLink(yardIdx[(YARD_NODES - 1) >> 1], nearestTrunk(yc), LinkKind.WOOD, WOOD_BREAK);
    yards.push({ idx: yardIdx, yc, width });
  }

  const nearestYardNode = (yardIdx: number[], z: number): number => {
    let best = yardIdx[0], bestD = Infinity;
    for (const yi of yardIdx) {
      const d = Math.abs(nodes[yi].pos.z - z);
      if (d < bestD) { bestD = d; best = yi; }
    }
    return best;
  };

  // --- cloth: one sail between each consecutive yard pair ---
  for (let s = 0; s < yards.length - 1; s++) {
    const foot = yards[s], head = yards[s + 1];
    const grid: number[][] = [];
    for (let r = 0; r < CLOTH_ROWS; r++) {
      const fr = r / (CLOTH_ROWS - 1);                 // 0 at foot yard → 1 at head yard
      const y = foot.yc + (head.yc - foot.yc) * fr;
      const w = foot.width + (head.width - foot.width) * fr; // taper to the upper yard
      const row: number[] = [];
      for (let c = 0; c < CLOTH_COLS; c++) {
        const z = mz - w / 2 + (w * c) / (CLOTH_COLS - 1);
        row.push(addNode({ x: mx + CLOTH_FORE, y, z }, CLOTH_MASS, NodeFlag.CLOTH, false));
      }
      grid.push(row);
    }
    // structural + shear links
    for (let r = 0; r < CLOTH_ROWS; r++) {
      for (let c = 0; c < CLOTH_COLS; c++) {
        if (c + 1 < CLOTH_COLS) addLink(grid[r][c], grid[r][c + 1], LinkKind.CLOTH, CLOTH_BREAK);
        if (r + 1 < CLOTH_ROWS) addLink(grid[r][c], grid[r + 1][c], LinkKind.CLOTH, CLOTH_BREAK);
        if (c + 1 < CLOTH_COLS && r + 1 < CLOTH_ROWS) addLink(grid[r][c], grid[r + 1][c + 1], LinkKind.CLOTH, CLOTH_BREAK);
      }
    }
    // lace bottom row to the foot yard, top row to the head yard
    for (let c = 0; c < CLOTH_COLS; c++) {
      addLink(grid[0][c], nearestYardNode(foot.idx, nodes[grid[0][c]].pos.z), LinkKind.CLOTH, LACE_BREAK);
      addLink(grid[CLOTH_ROWS - 1][c], nearestYardNode(head.idx, nodes[grid[CLOTH_ROWS - 1][c]].pos.z), LinkKind.CLOTH, LACE_BREAK);
    }
  }
```

After the mast loop, add the bowsprit:

```ts
  // --- bowsprit: a wood chain rooted at the bow (heel pinned) ---
  if (spec.bowsprit) {
    const { heel, tip } = spec.bowsprit;
    const len = dist(heel, tip);
    const count = Math.max(2, Math.round(len / TRUNK_STEP) + 1);
    let prevIdx = -1;
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      const pos = { x: heel.x + (tip.x - heel.x) * f, y: heel.y + (tip.y - heel.y) * f, z: heel.z + (tip.z - heel.z) * f };
      const isHeel = i === 0;
      const idx = addNode(pos, WOOD_MASS, NodeFlag.WOOD | (isHeel ? NodeFlag.FOOT : 0), isHeel);
      if (prevIdx >= 0) addLink(prevIdx, idx, LinkKind.WOOD, WOOD_BREAK);
      prevIdx = idx;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rigBuild.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Run the full suite + the type check**

Run: `npm run test`
Expected: all existing tests still green, plus the new `rigLattice` + `rigBuild` files.

Run: `npm run build`
Expected: `tsc --noEmit` passes (no type errors) — remember vitest does NOT type-check, so this is the real gate.

- [ ] **Step 6: Commit**

```bash
git add src/sim/rigBuild.ts tests/rigBuild.test.ts
git commit -m "feat(rig): buildRig cloth grids + bowsprit chain"
```

---

## Phase 1 done — definition of done

- `npx vitest run tests/rigLattice.test.ts tests/rigBuild.test.ts` green (≈20 tests).
- `npm run test` green (no regressions), `npm run build` clean.
- The break rule, Verlet motion, sleep accounting, tear connectivity, and the full ship-rig builder are all proven by the oracle, with zero rendering / game coupling and zero edits to files the other agents are touching.

---

## Roadmap — Phases 2–5 (each becomes its own dated plan)

These wire the Phase-1 core into the live game. They edit `sim/crush.ts`, `game/voxelContact.ts`, `game/ship.ts`, `render/shipVisual.ts` and `core/tunables.ts` — files **currently being edited by the collision-perf and audio agents**, against a `main` this working tree isn't yet synced to. So each is authored as its own plan **after** Phase 1 lands AND `git reset --hard origin/main` has synced the tree (a user-run `! ` command), so the tasks reference the *current* signatures of `crush`/`voxelContact`/`shipVisual` rather than a moving target.

- **Phase 2 — Bowsprit collision + crush (first playable win).** New `game/rig.ts` runtime owning a `Rig` per ship; an `accel` supplier (gravity + buoyancy via `sim/gerstner.surfaceHeight`); a node-vs-hull-grid penetration test feeding the existing `½μv²` break (read `sim/crush.ts` for its exact entry point at execution time); arm the bowsprit inside the existing ship-ship proximity gate in `game/voxelContact.ts`. Outcome: the ram bores into a hull instead of phasing through. Verify in-browser at `:5173` by ramming an enemy bow-on (Playwright + a `DEBUG` readback of broken voxels).
- **Phase 3 — Masts wake-on-hit.** Route `Ship.rigImpacts` hits to "impulse at nearest node + `rig.awake = true`"; clear the foot pin when the mast-foot hull cells are gone → topple emerges; awake mast nodes test against nearby hull grids → crush their own deck / an enemy alongside; break-in-half emerges from the WOOD break rule. Retire the canned `fellMast` `t²` animation in `render/shipVisual.ts`.
- **Phase 4 — Chunky voxel cloth sails.** New `render/rigVisual.ts` draws spar segments + a cloth grid mesh from node positions, dropping quads for dead links; replace the alphaMap puncture with link-severing on a ball hit; derive `sailIntegrity[mi]` from the attached-cloth fraction so `game/sailing.ts` keeps working. Retire the alphaMap puncture canvas.
- **Phase 5 — Buoyancy, despawn, perf, cleanup.** Per-node waterlog so a downed rig floats then sinks; detached pieces (via `attachedToPin`) despawn like debris; LOD (fewer relax iterations for distant awake rigs); debounce the deck-collider rebuild as the crush path already does; add the `TUN.rig` dev-panel group and delete the now-dead `mastHp`/discrete `sailIntegrity` code.

---

## Self-Review (against the spec)

**Spec coverage (Phase 1 scope only):** the spec's §"Data model" → Tasks 1–5; §"The solver — one step" → Tasks 2–4; §"Sails in detail" connectivity → Task 5; §"Builder" → Tasks 6–8. The spec's collision-coupling, wake/sleep wiring, rendering, buoyancy, and `TUN.rig` sections are explicitly deferred to the Phase 2–5 roadmap above (with the reason: they touch files under active concurrent edit). No Phase-1 spec requirement is left without a task.

**Placeholder scan:** every code step contains complete, compilable code; no TBD/TODO; every test has real assertions. The roadmap bullets are deliberately *not* numbered executable steps — they are a deferral with justification, to be expanded into their own plans (the skill endorses one-plan-per-subsystem).

**Type consistency:** `Rig`, `RigNode`, `RigLink`, `Vec3`, `NodeFlag`, `LinkKind`, `AccelFn`, `StepOpts`, `RigSpec`, `MastSpec` are defined once and used consistently. `buildRig` returns `Rig`; tests import `NodeFlag`/`LinkKind`/`attachedToPin` from `rigLattice`. `dist` is defined in Task 1 and reused by `relax` and `buildRig`. Node flag bit `0x1` used in the Task 7 test equals `NodeFlag.WOOD`.
