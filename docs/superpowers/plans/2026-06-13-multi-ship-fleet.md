# Multi-Ship Fleet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dev-panel slider raise the number of hostile ships (0–6) sailing against the player, with a simple 2-tier ocean LOD and auto-replacement of sunk enemies.

**Architecture:** A new `FleetManager` (`src/game/fleet.ts`) owns the enemy ships + their AI captains, reconciles the live count to `TUN.fleet.enemyCount` each step (spawn/despawn/backfill-on-sink), and ranks ships by camera distance to pick which two get the premium ocean treatment. `main.ts` delegates to it; the ocean shader's per-ship slots widen from 2 to `MAXVIS = 6` (cheap collar/bow/ellipse-cut), while the voxel sea-cut + stern ribbon + dyn-wave stamp stay on the premium pair (player + nearest enemy).

**Tech Stack:** TypeScript, Three.js (GLSL ES 1.00 ocean shader), Rapier3D, Vite, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-13-multi-ship-fleet-design.md`

**Branch:** Create `dev/multi-ship-fleet` off `main` before Task 1 (the spec was committed on `dev/kaykit-character`; cherry-pick it onto the new branch). See Task 0.

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1: Branch off main and bring the spec along**

```bash
cd /c/Users/joshu/Onedrive/Desktop/Projects/scuttle
git checkout main
git checkout -b dev/multi-ship-fleet
git checkout dev/kaykit-character -- docs/superpowers/specs/2026-06-13-multi-ship-fleet-design.md
git add docs/superpowers/specs/2026-06-13-multi-ship-fleet-design.md
git commit -m "docs: bring fleet spec onto dev/multi-ship-fleet branch"
```

- [ ] **Step 2: Bring this plan along too** (it is also being committed on the kaykit branch as it is written)

```bash
git checkout dev/kaykit-character -- docs/superpowers/plans/2026-06-13-multi-ship-fleet.md
git add docs/superpowers/plans/2026-06-13-multi-ship-fleet.md
git commit -m "docs: bring fleet plan onto dev/multi-ship-fleet branch"
```

(If the plan file isn't on the kaykit branch yet at execution time, skip Step 2 — it's already in the working tree.)

---

### Task 1: `MAXVIS` constant + `TUN.fleet`

**Files:**
- Modify: `src/core/constants.ts` (append)
- Modify: `src/core/tunables.ts:128` (add `fleet` block before the closing `};`)

- [ ] **Step 1: Add the `MAXVIS` constant**

Append to `src/core/constants.ts`:

```ts
/** Max simultaneous VISIBLE ships the ocean shader carries per-ship slots for
 *  (player + up to MAXVIS-1 enemies). Bounds the dev-panel fleet slider AND the
 *  ocean uniform-array sizes (render/ocean.ts uShipA/B/C, uProfileOn). The premium
 *  voxel-cut + stern-ribbon + dyn-wave still only ever use the first 2 slots. */
export const MAXVIS = 6;
```

- [ ] **Step 2: Add the `fleet` tunable**

In `src/core/tunables.ts`, insert before the final closing `};` (currently line 128–129):

```ts
  /** Fleet — how many hostile ships the FleetManager (game/fleet.ts) keeps sailing
   *  against the player. Integer 0..MAXVIS. Sunk enemies are auto-replaced to hold
   *  this count (true even at 1). Default 1 = the shipped duel. The dev panel drives
   *  this live; like every TUN knob it is NOT read by the deterministic vitest oracle. */
  fleet: {
    enemyCount: 1,
  },
```

- [ ] **Step 3: Verify the build typechecks**

Run: `npm run build`
Expected: PASS (`tsc --noEmit` clean, vite build succeeds).

- [ ] **Step 4: Commit**

```bash
git add src/core/constants.ts src/core/tunables.ts
git commit -m "feat(fleet): add MAXVIS constant and TUN.fleet.enemyCount"
```

---

### Task 2: `GameWorld.removeShip`

**Files:**
- Modify: `src/game/world.ts:35-38` (add `removeShip` after `addShip`)
- Test: `src/game/world.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/game/world.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { GameWorld } from "./world";
import { makeWaves } from "../sim/gerstner";
import { Rng } from "../core/rng";
import type { Ship } from "./ship";
import type { Physics } from "./physics";

function fakeShip(): Ship {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  return { visual: { group }, body: {} } as unknown as Ship;
}

function fakeWorld() {
  const scene = new THREE.Scene();
  const removeRigidBody = vi.fn();
  const physics = { world: { removeRigidBody }, RAPIER: {} } as unknown as Physics;
  const waves = makeWaves(new Rng("test"), 4);
  return { world: new GameWorld(physics, waves, scene), scene, removeRigidBody };
}

describe("GameWorld.removeShip", () => {
  it("removes the ship from the list, the scene, and the physics world", () => {
    const { world, scene, removeRigidBody } = fakeWorld();
    const ship = fakeShip();
    world.addShip(ship);
    expect(world.ships).toContain(ship);
    expect(scene.children).toContain(ship.visual.group);

    world.removeShip(ship);
    expect(world.ships).not.toContain(ship);
    expect(scene.children).not.toContain(ship.visual.group);
    expect(removeRigidBody).toHaveBeenCalledWith(ship.body);
  });

  it("is a no-op for a ship that was never added", () => {
    const { world, removeRigidBody } = fakeWorld();
    expect(() => world.removeShip(fakeShip())).not.toThrow();
    expect(removeRigidBody).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- world.test`
Expected: FAIL — `world.removeShip is not a function`.

- [ ] **Step 3: Implement `removeShip`**

In `src/game/world.ts`, add immediately after `addShip` (after line 38):

```ts
  /** Remove a ship: drop it from the sim list, the scene (disposing its visual
   *  geometry/materials), and the Rapier world (which also frees its colliders).
   *  Used by the FleetManager for despawn + sunk-wreck cleanup. No-op if absent. */
  removeShip(ship: Ship): void {
    const i = this.ships.indexOf(ship);
    if (i === -1) return;
    this.ships.splice(i, 1);
    this.scene.remove(ship.visual.group);
    ship.visual.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
    this.physics.world.removeRigidBody(ship.body);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -- world.test`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/game/world.ts src/game/world.test.ts
git commit -m "feat(fleet): GameWorld.removeShip (list + scene + physics teardown)"
```

---

### Task 3: `FleetManager`

**Files:**
- Create: `src/game/fleet.ts`
- Test: `src/game/fleet.test.ts`

`FleetManager` owns enemy units (ship + AI captain), reconciles count toward `TUN.fleet.enemyCount`, culls sunk wrecks (auto-replace), and ranks for LOD. It depends only on small injected interfaces so it is unit-testable with no GPU/physics.

- [ ] **Step 1: Write the failing tests**

Create `src/game/fleet.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { FleetManager, type EnemyUnit, type FleetWorld } from "./fleet";
import { TUN } from "../core/tunables";
import type { Ship } from "./ship";

// minimal fake ship with a movable position + a wreck flag
function fakeShip(x: number, y = 0, z = 0): Ship & { _y: number } {
  const s: any = {
    _y: y,
    visual: { group: new THREE.Group() },
    body: { translation: () => ({ x, y: s._y, z }) },
  };
  return s;
}

function fakeWorld(): FleetWorld & { ships: Ship[] } {
  return {
    ships: [] as Ship[],
    addShip(s: Ship) { this.ships.push(s); },
    removeShip(s: Ship) {
      const i = this.ships.indexOf(s);
      if (i >= 0) this.ships.splice(i, 1);
    },
  };
}

const noopCaptain = { update() {}, sailing: { rudder: 0, sailSet: 0 } } as unknown as EnemyUnit["captain"];

function makeFleet(spawnAt: () => Ship) {
  const world = fakeWorld();
  const target = fakeShip(0, 0, 0); // the player at the origin
  let n = 0;
  const spawn = (): EnemyUnit => {
    n++;
    return { ship: spawnAt(), captain: noopCaptain };
  };
  const isWreck = (s: Ship) => (s as any)._y < -12;
  const fleet = new FleetManager({ world, target, spawn, isWreck, maxVis: 6 });
  return { fleet, world, target, spawnCount: () => n };
}

describe("FleetManager.reconcile", () => {
  it("spawns one ship per step up to the target count", () => {
    let i = 0;
    const { fleet, world } = makeFleet(() => fakeShip(10 + i++));
    TUN.fleet.enemyCount = 3;
    fleet.reconcile(); expect(world.ships.length).toBe(1);
    fleet.reconcile(); expect(world.ships.length).toBe(2);
    fleet.reconcile(); expect(world.ships.length).toBe(3);
    fleet.reconcile(); expect(world.ships.length).toBe(3); // steady
  });

  it("despawns the FARTHEST ship when the count drops", () => {
    const near = fakeShip(5), mid = fakeShip(20), far = fakeShip(100);
    const ships = [near, mid, far];
    let i = 0;
    const { fleet, world } = makeFleet(() => ships[i++]);
    TUN.fleet.enemyCount = 3;
    fleet.reconcile(); fleet.reconcile(); fleet.reconcile();
    expect(world.ships.length).toBe(3);
    TUN.fleet.enemyCount = 2;
    fleet.reconcile();
    expect(world.ships).not.toContain(far);   // farthest gone first
    expect(world.ships).toContain(near);
    expect(world.ships).toContain(mid);
  });

  it("never despawns the boarding target", () => {
    const near = fakeShip(5), far = fakeShip(100);
    const ships = [near, far];
    let i = 0;
    const { fleet, world } = makeFleet(() => ships[i++]);
    TUN.fleet.enemyCount = 2;
    fleet.reconcile(); fleet.reconcile();
    fleet.boardingTarget = far;               // we're grappled to the far one
    TUN.fleet.enemyCount = 1;
    fleet.reconcile();
    expect(world.ships).toContain(far);       // protected
    expect(world.ships).not.toContain(near);  // next-farthest removed instead
  });

  it("clamps the target to maxVis", () => {
    let i = 0;
    const { fleet, world } = makeFleet(() => fakeShip(10 + i++));
    TUN.fleet.enemyCount = 99;
    for (let s = 0; s < 20; s++) fleet.reconcile();
    expect(world.ships.length).toBe(6);
  });

  it("auto-replaces a sunk wreck (even at count 1)", () => {
    let i = 0;
    const made: (Ship & { _y: number })[] = [];
    const { fleet, world } = makeFleet(() => { const s = fakeShip(10 + i++); made.push(s); return s; });
    TUN.fleet.enemyCount = 1;
    fleet.reconcile();
    expect(world.ships.length).toBe(1);
    made[0]._y = -50;                         // she founders
    fleet.reconcile();                        // wreck culled this step
    expect(world.ships).not.toContain(made[0]);
    fleet.reconcile();                        // backfilled next step
    expect(world.ships.length).toBe(1);
    expect(world.ships[0]).toBe(made[1]);
  });
});

describe("FleetManager.rankLOD", () => {
  it("picks the nearest living enemy as the premium ship", () => {
    const near = fakeShip(5), far = fakeShip(100);
    const ships = [far, near];
    let i = 0;
    const { fleet } = makeFleet(() => ships[i++]);
    TUN.fleet.enemyCount = 2;
    fleet.reconcile(); fleet.reconcile();
    fleet.rankLOD(new THREE.Vector3(0, 0, 0));
    expect(fleet.premiumEnemy).toBe(near);
  });

  it("holds the current premium ship within the hysteresis band", () => {
    const a = fakeShip(10), b = fakeShip(11);
    const ships = [a, b];
    let i = 0;
    const { fleet } = makeFleet(() => ships[i++]);
    TUN.fleet.enemyCount = 2;
    fleet.reconcile(); fleet.reconcile();
    fleet.rankLOD(new THREE.Vector3(0, 0, 0)); // a (10) is premium
    expect(fleet.premiumEnemy).toBe(a);
    // b becomes marginally closer (9.9 vs 10) — within 15% band, keep a
    (b as any).body.translation = () => ({ x: 9.9, y: 0, z: 0 });
    fleet.rankLOD(new THREE.Vector3(0, 0, 0));
    expect(fleet.premiumEnemy).toBe(a);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -- fleet.test`
Expected: FAIL — cannot resolve `./fleet`.

- [ ] **Step 3: Implement `FleetManager`**

Create `src/game/fleet.ts`:

```ts
import type * as THREE from "three";
import type { Wave } from "../sim/gerstner";
import type { Wind } from "./sailing";
import type { AICaptain } from "./ai";
import type { Ship } from "./ship";
import { TUN } from "../core/tunables";
import { MAXVIS } from "../core/constants";

/** One hostile unit: a ship and the AI captain that sails + fires her. */
export interface EnemyUnit {
  ship: Ship;
  captain: AICaptain;
}

/** The slice of GameWorld the fleet needs — kept narrow so the manager is
 *  unit-testable against a stub. */
export interface FleetWorld {
  addShip(ship: Ship): void;
  removeShip(ship: Ship): void;
}

export interface FleetOptions {
  world: FleetWorld;
  /** the player ship — distance reference for despawn + AI target. */
  target: Ship;
  /** builds one ship + captain, positioned in the world but NOT yet added. */
  spawn: () => EnemyUnit;
  /** true once a ship has foundered below the sea and should be culled. */
  isWreck?: (ship: Ship) => boolean;
  maxVis?: number;
}

/**
 * Owns the hostile fleet: keeps the live count reconciled to TUN.fleet.enemyCount
 * (spawning one ship per step, despawning the farthest, culling + auto-replacing
 * sunk wrecks), drives every captain at the player, and ranks ships by camera
 * distance to expose the nearest as the premium-LOD ship.
 */
export class FleetManager {
  readonly units: EnemyUnit[] = [];
  /** nearest living enemy (with hysteresis) — gets the premium ocean slot 1. */
  premiumEnemy: Ship | null = null;
  /** set by the caller to the grappled ship so reconcile won't despawn it. */
  boardingTarget: Ship | null = null;

  private readonly world: FleetWorld;
  private readonly target: Ship;
  private readonly spawn: () => EnemyUnit;
  private readonly isWreck: (ship: Ship) => boolean;
  private readonly maxVis: number;

  constructor(opts: FleetOptions) {
    this.world = opts.world;
    this.target = opts.target;
    this.spawn = opts.spawn;
    this.isWreck = opts.isWreck ?? ((s) => s.body.translation().y < -12);
    this.maxVis = opts.maxVis ?? MAXVIS;
  }

  /** Living + sinking enemy ships, in spawn order. */
  get enemies(): Ship[] {
    return this.units.map((u) => u.ship);
  }

  private remove(unit: EnemyUnit): void {
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
    if (this.premiumEnemy === unit.ship) this.premiumEnemy = null;
    this.world.removeShip(unit.ship);
  }

  /** One step of population control: cull foundered wrecks, then move the live
   *  count ONE toward the target (so a big slider drag never hitches). */
  reconcile(): void {
    // 1. cull every foundered wreck (the auto-replace foundation).
    for (let i = this.units.length - 1; i >= 0; i--) {
      if (this.isWreck(this.units[i].ship)) this.remove(this.units[i]);
    }

    // 2. step the live count one toward the (clamped) target.
    const want = Math.max(0, Math.min(this.maxVis, Math.round(TUN.fleet.enemyCount)));
    if (this.units.length < want) {
      const unit = this.spawn();
      this.world.addShip(unit.ship);
      this.units.push(unit);
    } else if (this.units.length > want) {
      const victim = this.farthestDespawnable();
      if (victim) this.remove(victim);
    }
  }

  /** The farthest unit from the player that isn't the boarding target. */
  private farthestDespawnable(): EnemyUnit | null {
    const p = this.target.body.translation();
    let best: EnemyUnit | null = null;
    let bestD = -1;
    for (const u of this.units) {
      if (u.ship === this.boardingTarget) continue;
      const t = u.ship.body.translation();
      const d = (t.x - p.x) ** 2 + (t.z - p.z) ** 2;
      if (d > bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** Drive every captain to sail + fire at the player. */
  updateAI(dt: number, t: number, waves: Wave[], wind: Wind): void {
    for (const u of this.units) u.captain.update(dt, t, waves, wind, this.target);
  }

  /** Recompute the nearest living enemy (the premium-LOD ship) relative to the
   *  camera, with a 15% hysteresis band so it doesn't thrash between two ships
   *  at similar range (which would pop the wake ribbon). */
  rankLOD(cameraPos: THREE.Vector3): void {
    let best: Ship | null = null;
    let bestD = Infinity;
    for (const u of this.units) {
      const t = u.ship.body.translation();
      const d = (t.x - cameraPos.x) ** 2 + (t.z - cameraPos.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = u.ship;
      }
    }
    const cur = this.premiumEnemy;
    if (cur && this.enemies.includes(cur) && best) {
      const t = cur.body.translation();
      const dCur = (t.x - cameraPos.x) ** 2 + (t.z - cameraPos.z) ** 2;
      // keep the incumbent unless the new best is >15% closer (≈1.32× in d²).
      if (dCur <= bestD * 1.32) return;
    }
    this.premiumEnemy = best;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test -- fleet.test`
Expected: PASS (all reconcile + rankLOD cases).

- [ ] **Step 5: Restore the tunable default** (the tests mutate `TUN.fleet.enemyCount`; make sure no other test depends on it — the default is 1)

Run: `npm run test`
Expected: PASS — the full suite (~115 + new) stays green.

- [ ] **Step 6: Commit**

```bash
git add src/game/fleet.ts src/game/fleet.test.ts
git commit -m "feat(fleet): FleetManager (reconcile/auto-replace/LOD rank) + tests"
```

---

### Task 4: Retargetable boarding

**Files:**
- Modify: `src/game/boarding.ts` (constructor field, add `setEnemy`/`currentEnemy`/`hasTarget`, guard grapple/chest)

The boarding system is hard-bound to one `enemyShip`. Make it retargetable and safe when there is no live enemy (count 0 or its target was culled).

- [ ] **Step 1: Add the `hasTarget` flag**

In `src/game/boarding.ts`, after `message = "";` (line 28) add:

```ts
  /** false when there is no live enemy to board (fleet count 0, or the current
   *  target was culled). Grapple + chest pickup no-op while false. */
  hasTarget = true;
```

- [ ] **Step 2: Make `enemyShip` retargetable + expose the current target**

Add these methods inside the class (e.g. after `shipsRange()` at line 123):

```ts
  /** The enemy ship boarding currently acts on (grapple/chest). */
  currentEnemy(): Ship {
    return this.enemyShip;
  }

  /** Point boarding at a new enemy. Locked while grappled or carrying the chest
   *  (you don't swap the ship you're lashed to). Moves the prize chest to the new
   *  target's quarterdeck. Pass force=true to retarget unconditionally (used when
   *  the old target was culled out from under us). */
  setEnemy(ship: Ship, force = false): void {
    if (ship === this.enemyShip) return;
    if (!force && (this.grappled || this.chestCarried)) return;
    this.enemyShip.visual.group.remove(this.chest);
    ship.visual.group.add(this.chest);
    this.chest.position.set(4.2, this.deckTop(ship), 4);
    this.enemyShip = ship;
  }
```

- [ ] **Step 3: Guard grapple + chest on `hasTarget`**

In `toggleGrapple()` (line 125), add a guard at the top:

```ts
  toggleGrapple(): void {
    if (!this.hasTarget) {
      this.message = "no ship to grapple";
      return;
    }
```

In `update(...)`, the grapple force block currently begins `if (this.grappled) {` (line 159). Change to:

```ts
    if (this.grappled && this.hasTarget) {
```

In `updateChest(...)` (line 329) the pickup path begins after the carry branch. Add a guard before the pickup `if (!interact) return;` (line 350):

```ts
    if (!this.hasTarget) return;
    if (!interact) return;
```

- [ ] **Step 4: Verify the build typechecks**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/boarding.ts
git commit -m "feat(fleet): retargetable boarding (setEnemy/currentEnemy/hasTarget)"
```

---

### Task 5: Ocean LOD — widen per-ship slots to `MAXVIS`

**Files:**
- Modify: `src/render/ocean.ts` (shader arrays/loops, uniforms init, `updateShipWake` trail guard, add `resetTrail`, widen slot param types)

The cheap tier (collar + bow wave + analytic-ellipse cut + flank wash) widens from 2 slots to `MAXVIS`; the premium tier (voxel cut `uProfileTex0/1`, stern ribbon `uTrail`, dyn-wave) stays at 2.

- [ ] **Step 1: Pass `MAXVIS` into the shader defines**

At the top of `ocean.ts`, add to the imports (line 1–4 area):

```ts
import { MAXVIS } from "../core/constants";
```

In the `ShaderMaterial` `defines` (currently `defines: { NWAVES: swell.length, NCASC }` at line 627), add `MAXVIS`:

```ts
    defines: { NWAVES: swell.length, NCASC, MAXVIS },
```

- [ ] **Step 2: Widen the VERTEX-shader ship uniforms + collar/bow loop**

In `VERT`, change the two ship uniform declarations (lines 126–127):

```glsl
uniform vec4 uShipA[MAXVIS]; // bow x, bow z, fwdX, fwdZ
uniform vec4 uShipB[MAXVIS]; // speed, halfL, halfB, 0
```

Change the collar/bow loop header (line 239) from `for (int s2 = 0; s2 < 2; s2++)` to:

```glsl
  for (int s2 = 0; s2 < MAXVIS; s2++) {
```

- [ ] **Step 3: Widen the FRAGMENT-shader ship uniforms + cut/wash loops**

In `FRAG`, change the ship uniform declarations (lines 331–333):

```glsl
uniform vec4 uShipA[MAXVIS]; // bow x, bow z, fwdX, fwdZ
uniform vec4 uShipB[MAXVIS]; // speed, halfL, halfB, 0
uniform vec2 uShipC[MAXVIS]; // keel world-Y, deck-top world-Y (hull vertical span)
```

Change the `uProfileOn` declaration (line 342) from `uniform float uProfileOn[2];` to:

```glsl
uniform float uProfileOn[MAXVIS];    // 1 per slot when that hull's profile cut is live
```

> Note: `uProfileInvRot/uProfileTrans/uProfileSize` and `uProfileTex0/1` stay sized 2 — only the premium pair has a voxel cut. The loop below reads `uProfileOn` for the ellipse-cut decision; the voxel-cut blocks stay hand-unrolled for slots 0 and 1 only.

Change the analytic-ellipse cut loop header (line 359) from `for (int s0 = 0; s0 < 2; s0++)` to:

```glsl
  for (int s0 = 0; s0 < MAXVIS; s0++) {
```

Change the flank-wash loop header (line 502) from `for (int s = 0; s < 2; s++)` to:

```glsl
  for (int s = 0; s < MAXVIS; s++) {
```

> The stern-trail loop (`for (int i = 0; i < 63; ...)`, line 528) and its `uTrail[64]` stay unchanged — only the premium pair (slots 0,1 → trail halves 0,1) feeds it.

- [ ] **Step 4: Size the JS uniform arrays to `MAXVIS`**

In the `uniforms` object (lines 660–664), replace the four fixed-length arrays:

```ts
      uShipA: { value: Array.from({ length: MAXVIS }, () => new THREE.Vector4()) },
      uShipB: { value: Array.from({ length: MAXVIS }, () => new THREE.Vector4()) },
      uShipC: { value: Array.from({ length: MAXVIS }, () => new THREE.Vector2(0, -1)) },
      uTrail: { value: Array.from({ length: 64 }, () => new THREE.Vector4()) },
      uProfileOn: { value: Array.from({ length: MAXVIS }, () => 0) },
```

(`uTrail` stays 64; `uProfileTex0/1`, `uProfileInvRot/Trans/Size` stay sized 2 — leave those lines as-is.)

- [ ] **Step 5: Guard the trail bookkeeping to the premium pair + add `resetTrail`**

In `updateShipWake` (line 706), the trail logic must only run for slots 0 and 1 (the only `uTrail` halves). Wrap the trail section. Replace the body from `const trail = trails[slot];` (line 714) through the trail `for` loop (line 733) with:

```ts
      // stern ribbon only for the premium pair (slots 0,1 = uTrail halves).
      if (slot < 2) {
        const trail = trails[slot];
        const sx = centerX - fwdX * (halfL + 0.8);
        const sz = centerZ - fwdZ * (halfL + 0.8);
        const last = trail[trail.length - 1];
        if (speed > 1.5 && (!last || Math.hypot(sx - last.x, sz - last.z) > 1.2)) {
          trail.push({ x: sx, z: sz, t: time, w: Math.min(speed / 8, 0.9) });
        }
        while (trail.length > 31 || (trail.length > 0 && time - trail[0].t > 7)) trail.shift();
        const u = mat.uniforms.uTrail.value as THREE.Vector4[];
        const base = slot * 32;
        for (let i = 0; i < 32; i++) {
          const pt = trail[i];
          if (pt) u[base + i].set(pt.x, pt.z, time - pt.t, pt.w);
          else u[base + i].set(0, 0, 0, 0);
        }
      }
```

Add a `resetTrail` method to the returned object (next to `setHullProfile`, after line 744) so the premium slot-1 ribbon can be cleared when it reassigns to a different ship:

```ts
    resetTrail(slot) {
      trails[slot] = [];
      const u = mat.uniforms.uTrail.value as THREE.Vector4[];
      const base = slot * 32;
      for (let i = 0; i < 32; i++) u[base + i].set(0, 0, 0, 0);
    },
```

- [ ] **Step 6: Add a `clearSlot` method + widen slot param types in the interface**

In the `Ocean` interface (lines 27–76), change the slot param types on `updateShipWake`, `setHullProfile`, `updateHullPose` from `slot: 0 | 1` to `slot: number`, and add:

```ts
  /** Free a per-ship slot so the shader skips it (sets halfL<0.5 + profileOn=0). */
  clearSlot(slot: number): void;
  /** Clear the stern-trail ribbon for a premium slot (0|1) on reassignment. */
  resetTrail(slot: number): void;
```

In the returned implementation object, add `clearSlot` (next to `resetTrail`):

```ts
    clearSlot(slot) {
      (mat.uniforms.uShipB.value as THREE.Vector4[])[slot].set(0, 0, 0, 0); // halfL=0 → skipped
      (mat.uniforms.uShipC.value as THREE.Vector2[])[slot].set(0, -1);      // deck<=keel → skipped
      (mat.uniforms.uProfileOn.value as number[])[slot] = 0;
    },
```

- [ ] **Step 7: Verify the build typechecks**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/render/ocean.ts
git commit -m "feat(fleet): widen ocean per-ship slots to MAXVIS (cheap tier) + clearSlot/resetTrail"
```

> The shader runtime correctness (no GLSL program invalidation, no sea-through-deck) is verified in Task 8's in-browser pass — `tsc` cannot catch GLSL errors.

---

### Task 6: Wire the fleet into `main.ts`

**Files:**
- Modify: `src/main.ts` (imports; replace single enemy/captain with FleetManager; per-frame LOD feed; cannons/collision targets; boarding retarget; per-enemy salvage; HUD)

This is the integration task — no new unit tests (it's wiring); verified in-browser in Task 8. Make the edits as discrete hunks.

- [ ] **Step 1: Add imports**

Add near the other game imports (after line 17 `import { AICaptain } from "./game/ai";`):

```ts
import { FleetManager, type EnemyUnit } from "./game/fleet";
import { MAXVIS } from "./core/constants";
```

- [ ] **Step 2: Replace the hardcoded enemy + its profile binding + captain + DEBUG with the fleet**

Delete the single-enemy block (lines 155–177: `enemyBuild`/`enemyVisual`/`enemy`/the rotation block/`world.addShip(enemy)`/`enemyProfile`/`ocean.setHullProfile(1, …)`). Replace with:

```ts
  // The hostile fleet (game/fleet.ts). All enemies are buildSloop hulls, so they
  // share ONE profile texture for the premium voxel sea-cut — bind it to slot 1
  // once; only the live pose changes as the nearest enemy (premium ship) swaps.
  const enemyProfile = makeProfileTex(buildSloop().grid);
  ocean.setHullProfile(1, enemyProfile.tex, enemyProfile.sizeX, enemyProfile.sizeZ);

  // factory: build one enemy sloop + AI captain, positioned upwind in a wide fan
  // around the player, bow pointed at her (the old single-enemy placement, fanned).
  const spawnEnemy = (): EnemyUnit => {
    const build = buildSloop();
    const visual = new ShipVisual(build);
    const ang = (Math.random() - 0.5) * Math.PI * 1.2; // spread across the upwind arc
    const dist = 85 + Math.random() * 45; // 85..130 m
    const dx = waves[0].dirX;
    const dz = waves[0].dirZ;
    const ox = dx * Math.cos(ang) - dz * Math.sin(ang);
    const oz = dx * Math.sin(ang) + dz * Math.cos(ang);
    const pc = sloop.body.translation();
    const ship = new Ship(physics, build, visual, { x: pc.x - ox * dist, y: 0.2, z: pc.z - oz * dist });
    const etr = ship.body.translation();
    const ea = -Math.atan2(pc.z - etr.z, pc.x - etr.x);
    ship.body.setRotation({ x: 0, y: Math.sin(ea / 2), z: 0, w: Math.cos(ea / 2) }, true);
    ship.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, ship));
    ship.onMastFelled = () => (boarding.message = "her mast goes by the board!");
    ship.onRudderHit = (hp) => {
      visual.chipRudder(hp / 3);
      boarding.message = hp > 0 ? "her rudder is hit!" : "her rudder hangs in splinters!";
    };
    const captain = new AICaptain(ship, scene, effects);
    return { ship, captain };
  };

  const fleet = new FleetManager({ world, target: sloop, spawn: spawnEnemy });
  // which enemy currently holds premium ocean slot 1 (for trail-reset on swap).
  let premiumSlot1: Ship | null = null;
  // enemies that have been salvaged once (per-ship, so each sinking pays out once).
  const salvaged = new WeakSet<Ship>();
```

> `debris`, `boarding`, and `effects` are referenced by the factory but defined later in the file. Move the `const debris = …`, `const effects = …`, `const spray`/`cannons`, and `const boarding = …` declarations (lines 207–221) to ABOVE this block. Specifically: relocate lines 207–221 (`effects` through `boarding`) to just before the `const enemyProfile = …` line, and DELETE the now-duplicated `const captain = new AICaptain(enemy, …)` line (220) entirely. Order after the move: `effects, spray, cannons, debris, sloop.onSevered, (no enemy.onSevered), boarding`, then the fleet block.

- [ ] **Step 3: Fix the dangling player `onSevered` + boarding constructor**

The player line `sloop.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, sloop));` (line 217) stays. DELETE the enemy one (line 218). The `BoardingSystem` constructor (line 221) currently takes `(physics, scene, effects, sloop, enemy)`. There is no longer a startup `enemy`; seed boarding with the first spawned enemy by reconciling once before constructing boarding is circular (boarding is referenced by the factory). Instead, seed with a throwaway and let the per-frame retarget fix it:

Change the boarding construction to spawn one enemy first via the world+fleet, then bind:

```ts
  // seed one enemy so boarding always has a valid initial target, then let the
  // per-frame retarget track the nearest. (TUN.fleet.enemyCount default 1 keeps it.)
  fleet.reconcile();
  const seedEnemy = fleet.enemies[0] ?? sloop; // sloop is a harmless fallback if count 0
  const boarding = new BoardingSystem(physics, scene, effects, sloop, seedEnemy);
```

> Move this AFTER the fleet block but the factory references `boarding`. Resolve the cycle: declare `let boarding: BoardingSystem;` before the factory, assign it here. Change the factory's `boarding.message`/`boarding` refs are fine since they run later (at spawn time boarding is assigned). Update the relocation in Step 2 accordingly: declare `let boarding: BoardingSystem;` where `boarding` was, assign `boarding = new BoardingSystem(...)` here.

- [ ] **Step 4: Remove the now-invalid `captain`, `enemyVisual`, `enemyProfile`(old), `enemy` references throughout**

The following lines reference the deleted singletons and must change:

- Line 200 `const seam = new SeamMask([sloop.visual.group, enemy.visual.group]);` → seam now needs all hull groups, rebuilt per frame. Replace with a mutable seam fed each frame:

```ts
  const seam = new SeamMask([sloop.visual.group]);
```

  and add a setter call each frame (Step 7). (Add a `setHulls` to SeamMask — see Step 4b.)

- Lines 224–233 (`enemy.onMastFelled`, `enemy.onRudderHit`) — DELETE (now set per-spawn in the factory). Keep the `sloop.*` ones.
- Line 394 `collisionDestruction.update([sloop, enemy]);` → `collisionDestruction.update([sloop, ...fleet.enemies]);`
- Line 393 `cannons.update(dt, t, waves, [enemy]);` → `cannons.update(dt, t, waves, fleet.enemies);`
- Line 336 `captain.update(dt, t, waves, wind, sloop);` → `fleet.updateAI(dt, t, waves, wind);`
- Lines 401–405 (`isSunk(enemy)` salvage) → per-enemy (Step 6).
- Line 519 `for (const s of [sloop, enemy]) s.visual.setCutaway(...)` → `for (const s of [sloop, ...fleet.enemies]) s.visual.setCutaway(...)`
- Lines 526–544 DEBUG: replace `enemy,` and `captain,` with `fleet,`.
- Line 867 `const spans = [hullSpan(sloop), hullSpan(enemy)];` → `const spans = [hullSpan(sloop), hullSpan(buildSloopSpanShip())];` — but `hullSpan` takes a Ship. Simpler: compute the enemy span from any spawned enemy lazily, or from a sample. Replace with:

```ts
  const enemySpanSample = hullSpan(fleet.enemies[0] ?? sloop);
  const spans = [hullSpan(sloop), enemySpanSample];
```

  (All enemies are buildSloop, so one span serves every cheap slot. If count starts 0, falls back to the player span harmlessly.)

- [ ] **Step 4b: Make `SeamMask` hull list mutable**

In `src/render/seamMask.ts`, change `constructor(private hulls: THREE.Object3D[]) {}` (line 17) to:

```ts
  constructor(private hulls: THREE.Object3D[]) {}

  /** Replace the set of hull silhouettes painted into the stencil (fleet changes). */
  setHulls(hulls: THREE.Object3D[]): void {
    this.hulls = hulls;
  }
```

- [ ] **Step 5: Replace the per-frame wake/profile feed with the LOD split**

The render loop currently does (lines 1173–1176):

```ts
    feedWake(0, sloop);
    feedWake(1, enemy);
    checkBowSpray(0, sloop, dt);
    checkBowSpray(1, enemy, dt);
```

`feedWake` (lines 873–904) feeds both `uShipA/B/C` (collar/bow/wash/ellipse) AND `updateHullPose` (voxel cut). Split it: keep `feedWake` for the premium pair (it calls `updateHullPose`), and add a `feedCheap` for ellipse-only slots that does everything `feedWake` does EXCEPT `updateHullPose`. Add after `feedWake` (after line 904):

```ts
  // cheap-tier feed: collar/bow/flank-wash + analytic-ellipse cut (via uShipC),
  // no voxel pose, no stern ribbon (updateShipWake guards the trail to slots <2).
  const feedCheap = (slot: number, ship: Ship) => {
    const v = ship.body.linvel();
    const speed = ship.submergedFrac < 0.05 ? 0 : Math.hypot(v.x, v.z);
    const rot = ship.body.rotation();
    wakeF.set(1, 0, 0).applyQuaternion(new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w));
    wakeF.y = 0;
    wakeF.normalize();
    const fp = ship.build.footprint;
    ship.localToWorld([(fp.minX + fp.maxX) / 2, 2.5, fp.zC], wakeV);
    const tr = ship.body.translation();
    const span = spans[1]; // every enemy is a buildSloop
    ocean.updateShipWake(
      slot, wakeV.x, wakeV.z, wakeF.x, wakeF.z, speed,
      ship.build.lengthM / 2, ship.build.beamM / 2, world.simTime,
      tr.y + span.keel, tr.y + span.deck,
    );
  };
```

Replace the four feed lines (1173–1176) with:

```ts
    // ---- per-frame fleet LOD ----
    fleet.rankLOD(camera.position);
    const premium = fleet.premiumEnemy;
    if (premium !== premiumSlot1) {
      ocean.resetTrail(1); // the premium enemy swapped — don't lace the ribbon across the jump
      premiumSlot1 = premium;
    }
    feedWake(0, sloop);                 // slot 0: player (voxel cut + ribbon + pose)
    checkBowSpray(0, sloop, dt);
    if (premium) {
      feedWake(1, premium);            // slot 1: nearest enemy (premium)
      checkBowSpray(1, premium, dt);
    } else {
      ocean.clearSlot(1);
    }
    // cheap slots 2..: the remaining visible enemies (collar/bow/wash/ellipse)
    let slot = 2;
    for (const e of fleet.enemies) {
      if (e === premium) continue;
      if (slot >= MAXVIS) break;
      feedCheap(slot, e);
      slot++;
    }
    for (; slot < MAXVIS; slot++) ocean.clearSlot(slot);
```

> The premium enemy uses `feedWake`, which calls `ocean.updateHullPose(1, …)` — that re-poses the shared enemy profile texture onto whichever ship is premium. Correct, since all enemies are geometrically identical.

- [ ] **Step 6: Per-enemy AI animate + salvage; reconcile + boarding retarget in the fixed step**

In `world.onFixedStep` (the `(t, dt) => {…}` body), after `fleet.updateAI(...)` (replacing line 336), add reconcile + boarding retarget:

```ts
    fleet.reconcile();
    // keep boarding pointed at a live enemy; release the grapple if its target was culled.
    const live = fleet.enemies;
    boarding.hasTarget = live.length > 0;
    if (boarding.hasTarget && !live.includes(boarding.currentEnemy())) {
      boarding.grappled = false;
      boarding.setEnemy(fleet.premiumEnemy ?? live[0], true);
    } else if (boarding.hasTarget && !boarding.grappled && !boarding.chestCarried && fleet.premiumEnemy) {
      boarding.setEnemy(fleet.premiumEnemy);
    }
    fleet.boardingTarget = boarding.grappled ? boarding.currentEnemy() : null;
```

Replace the salvage block (lines 401–405) with a per-enemy sweep:

```ts
    // r-fleet: each enemy pays salvage once as she goes down; the voyage continues
    // (non-terminal) and the FleetManager backfills the wreck.
    for (const e of fleet.enemies) {
      if (isSunk(e) && !salvaged.has(e)) {
        salvaged.add(e);
        boarding.gold += 150;
        boarding.message = `SHE'S SCUTTLED — salvaged 150g from the flotsam. Sail on.`;
      }
    }
```

> DELETE the `enemyScuttled` variable (line 256) and its remaining references.

In the render loop, replace `enemyVisual.animate(world.simTime, captain.sailing.rudder, captain.sailing.sailSet);` (line 1199) with a per-unit animate:

```ts
    for (const u of fleet.units) {
      u.ship.visual.animate(world.simTime, u.captain.sailing.rudder, u.captain.sailing.sailSet);
    }
```

- [ ] **Step 7: Per-frame seam hull list + buildDynShips premium pair + HUD nearest enemy**

In the render loop, before `seam.write(...)` (line 1309), refresh the hull list:

```ts
    seam.setHulls([sloop.visual.group, ...fleet.enemies.map((e) => e.visual.group)]);
```

Change `buildDynShips` (lines 921–948): it builds `[sloop, enemy]`. Make the second entry the premium enemy (or just the player when none). Replace the `const ships = [sloop, enemy];` line and the `for (let i = 0; i < 2; i++)` with a premium-pair build:

```ts
  const buildDynShips = (): DynShip[] => {
    const ships = [sloop, fleet.premiumEnemy].filter(Boolean) as Ship[];
    const out: DynShip[] = [];
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i];
      const d = _dynShips[i];
      // …unchanged body of the loop, using `ship` and `d`…
      out.push(d);
    }
    return out;
  };
```

> Keep the existing per-ship math inside the loop verbatim; only the source list (`ships`) and the returned slice (`out`, length 0–2) change. `dynWaves` `maxShips` stays 2.

For the HUD enemy marker (lines 666–668 in `updateHud`), it reads `const et = enemy.body.translation();`. Add a module-scoped `let primaryEnemy: Ship | null = null;` near the fleet declaration, set it each frame (`primaryEnemy = fleet.premiumEnemy;` — add to the LOD block in Step 5), and change the marker code to:

```ts
    if (primaryEnemy) {
      const et = primaryEnemy.body.translation();
      const enemyBearing = Math.atan2(et.z - tr.z, et.x - tr.x) - heading;
      hudEls.enemyMarker.style.opacity = "1";
      hudEls.enemyMarker.style.transform = `rotate(${(enemyBearing * 180) / Math.PI}deg)`;
    } else {
      hudEls.enemyMarker.style.opacity = "0";
    }
```

Append a foe count to the wheel hints string (line 732, the `: \`${lockHint}W/S sails …\`` branch) by adding before the closing backtick:

```
 · foes ${fleet.enemies.length}
```

- [ ] **Step 8: Verify the build typechecks**

Run: `npm run build`
Expected: PASS. Fix any remaining references to `enemy`, `enemyVisual`, `enemyBuild`, `captain`, or `enemyScuttled` (search the file: `grep -nE "enemy(Visual|Build|Scuttled)?\b|captain\b" src/main.ts` should only show `enemyProfile`, `spawnEnemy`, `fleet.*`, `primaryEnemy`, and the `ramTest` block).

> The `ramTest` dev helper (lines 1018–1078) references `enemy.body…` heavily. Repoint it at the first live enemy: at the top of `ramTest`, add `const enemy = fleet.enemies[0]; if (!enemy) { boarding.message = "no enemy to ram"; return; }` and leave the rest unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/main.ts src/render/seamMask.ts
git commit -m "feat(fleet): wire FleetManager into main (LOD feed, targets, boarding, salvage, HUD)"
```

---

### Task 7: Dev-panel fleet slider

**Files:**
- Modify: `src/main.ts` (add a "Fleet" group to the `createDevPanel([...])` call)

- [ ] **Step 1: Add the Fleet slider group**

In the `createDevPanel([...])` array (line 1080), add a group (e.g. right after the "Sailing" group, line 1099):

```ts
    {
      title: "Fleet",
      controls: [
        // how many hostile ships to keep sailing against you (0..MAXVIS). Sunk
        // enemies are auto-replaced. Drag live — they spawn/despawn one per step.
        { type: "slider", label: "enemies", obj: TUN.fleet, key: "enemyCount", min: 0, max: MAXVIS, step: 1 },
      ],
    },
```

- [ ] **Step 2: Verify the build typechecks**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(fleet): dev-panel slider for TUN.fleet.enemyCount (0..MAXVIS)"
```

---

### Task 8: Full verification (tests + in-browser)

**Files:** none (verification only)

- [ ] **Step 1: Unit + type suite green**

Run: `npm run test`
Expected: PASS — the full suite (~115 existing + world/fleet additions).

Run: `npm run build`
Expected: PASS.

- [ ] **Step 2: In-browser smoke (Playwright MCP at :5173)**

Start the dev server (`npm run dev`) and drive the browser per `CLAUDE.md`'s in-browser-verify protocol. Confirm:
  - **Default (count 1):** identical to today — one enemy hunts you, full wake + voxel cut.
  - **Slider → 6:** six enemies spawn one-per-step, fanned upwind, bows turned toward you; the nearest has the full wake ribbon, the rest have collar/bow/wash; **no sea-through-deck / no under-hull void** on the cheap ships; the ocean does **not** vanish (GLSL program valid — the widened loops/arrays compiled).
  - **Slider → 0:** sea empties; HUD enemy marker hides; "foes 0".
  - **Auto-replace:** sink an enemy (ram test or broadside); the wreck disappears below the sea and a fresh enemy sails in to restore the count, even at count 1.
  - **Premium swap:** sail past two enemies; the nearest takes the wake ribbon and it does not lace a streak across the swap (resetTrail fired).
  - Take a screenshot to the projects root for the record.

- [ ] **Step 3: Commit any fixups from the browser pass**

```bash
git add -A
git commit -m "fix(fleet): in-browser verification fixups"
```

(Only if the smoke pass surfaced issues.)

---

## Self-Review notes (addressed)

- **Spec coverage:** FleetManager + reconcile/auto-replace/LOD (T3) ✔; `removeShip` (T2) ✔; ocean 2-tier LOD widen-to-MAXVIS (T5) ✔; gameplay de-singleton — cannons/collision/AI/boarding/salvage/HUD (T6) ✔; dev slider (T1+T7) ✔; tests (T2/T3) + in-browser (T8) ✔; all four accepted simplifications honored (shared enemy profile tex bound once at T6S2; cheap = ellipse cut at T5; dyn-wave/ribbon premium-only at T5/T6S7; MAXVIS hard cap at T1/T3) ✔.
- **Type consistency:** `EnemyUnit{ship,captain}`, `FleetWorld{addShip,removeShip}`, `FleetOptions`, `FleetManager.{units,enemies,premiumEnemy,boardingTarget,reconcile,updateAI,rankLOD}`, `Ocean.{clearSlot,resetTrail}`, `BoardingSystem.{setEnemy,currentEnemy,hasTarget}`, `SeamMask.setHulls` — names used identically across tasks.
- **Known cross-file cycle (T6S2/S3):** the spawn factory references `boarding`/`debris`/`effects`, which are declared later today; the plan relocates those declarations above the fleet block and uses a `let boarding` forward declaration. Watch this during execution.
```
