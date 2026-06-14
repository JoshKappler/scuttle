# Multi-Ship Fleet — design

_Status: approved (design phase). Date: 2026-06-13. Next: implementation plan (writing-plans)._

## Goal

The sea currently holds exactly two ships (the player's brig + one enemy sloop), which
plays thin. This feature lets a **dev-panel slider** raise the number of hostile ships
sailing against the player from `0` up to a fixed ceiling, with a **simple 2-tier LOD** so
the extra hulls cost little, and with **sunk enemies auto-replaced** so the engagement stays
populated. It is the first multi-ship step; it deliberately stays small and is the
foundation a richer "living sea" (factions, neutral traffic, allies) could later build on.

## Motivation

- The two-ship engagement is "a bit boring." More hulls = more to fight.
- Portfolio centerpiece: a sea with several ships maneuvering and firing reads far better
  in a demo than a duel.
- The simulation was built list-based (`GameWorld.ships: Ship[]`), so the cost of "more
  ships" is much smaller than it appears — most of the work is de-singletoning a handful of
  gameplay objects and a bounded ocean-shader change, **not** a GPU rewrite.

## Scope

**In:**
- Up to `MAXVIS = 6` enemy ships, all **hostile to the player only**.
- Full physics (buoyancy, flooding, sailing, collision/destruction) for every spawned ship.
- A dev-panel integer slider `0–6` controlling the maintained enemy count, default `1`
  (so the shipped, no-slider-touched behavior is identical to today).
- **Auto-replace on sink:** a fully-sunk enemy wreck is cleaned up and a fresh enemy sails
  in to restore the target count — this applies even at count `1`.
- 2-tier ocean LOD: premium look for the player + nearest enemy; cheap-but-correct look for
  the rest. No GPU texture-unit ceiling is touched.

**Out (YAGNI — explicitly not in this feature):**
- Factions / ship-vs-ship combat (all AI targets the player; ships ignore each other).
- Allied / friendly ships.
- Formations or fleet-level tactics.
- Instanced distant hulls or simplified distant physics (full physics for all, bounded by
  `MAXVIS`).
- Multi-ship boarding (the player boards one ship at a time).
- Reworking the ocean's per-hull voxel-cut samplers into a texture atlas/array (premium
  stays a fixed 2 slots).
- Per-enemy HUD markers beyond "nearest" + a foe count.

## Why this is small (current coupling, verified)

- **`AICaptain` (`src/game/ai.ts`) is already self-contained.** It owns its own `ship`,
  `SailingController`, and `Cannons` battery, and takes the target as an `update(dt, t,
  waves, wind, target)` argument (`ai.ts:39`). N captains each hunting the player is a
  `.map()` — **no change to `AICaptain`**.
- **Player `Cannons.update(...)` already takes `targets: Ship[]`** and loops it
  (`cannons.ts:136`, `:186`, `:205`). The single-enemy call site just passes the full enemy
  list instead of `[enemy]`.
- **`GameWorld` is list-based** (`world.ts:18–65`): `ships: Ship[]`, `addShip()`, and a
  `for (const ship of this.ships)` fixed-step loop. Per-ship physics/flooding already scale.
- **`SeamMask` takes a hull *list*** (`seamMask.ts:17`) — passing all hull groups gives
  every ship the stencil silhouette rejection for free.
- **The only real bind is `BoardingSystem` (`src/game/boarding.ts`)**, which holds a single
  private `enemyShip` (grapple, chest, salvage, melee). It must become *retargetable*.

## Architecture

### New unit — `src/game/fleet.ts` (`FleetManager`)

Owns the enemy population and the AI that drives it. Single clear purpose: keep the live
enemy set reconciled to the target count and expose LOD ranking. Pure-ish logic with a thin
dependency on `GameWorld`/physics/scene for spawn/despawn, so its reconciliation can be
unit-tested against stubs.

Responsibilities:

1. **Reconcile count** each fixed step toward `TUN.fleet.enemyCount` (clamped `0..MAXVIS`):
   - spawned-count **too low** → spawn one enemy.
   - spawned-count **too high** → despawn the *farthest* enemy that is **not** the active
     boarding/grapple target.
   - One spawn or despawn **per step** (not a burst) so a big slider drag doesn't hitch.
2. **Auto-replace sinks:** a spawned enemy that has fully gone under (`isSunk` →
   `body.translation().y < -12`) is removed via `world.removeShip` and no longer counts as
   spawned; the reconcile step then backfills to target. Net effect: the slider maintains
   "this many live enemies," replacing the dead. (A *sinking-but-not-yet-submerged* wreck
   still counts as spawned, so we don't double-spawn while she goes down.)
3. **Spawn placement:** upwind of the player, fanned around her at ~85–130 m, bow pointed at
   the player — the existing single-enemy placement (`main.ts:160–171`) generalized to a
   fan so multiple ships don't stack.
4. **LOD ranking:** each step, rank living enemies by distance to the camera and expose:
   - `premiumEnemy: Ship | null` — the nearest living enemy, with **~15% distance
     hysteresis** so the assignment doesn't thrash between two similar-range ships.
   - the ordered visible list (all of them, since the count is capped at `MAXVIS`).

Proposed interface:

```ts
class FleetManager {
  readonly enemies: Ship[];                    // living + sinking, spawned order
  premiumEnemy: Ship | null;                   // nearest living enemy (hysteresis)
  constructor(world: GameWorld, physics: Physics, scene: THREE.Scene,
              effects: Effects, makeEnemy: () => Ship, target: Ship);
  reconcile(dt: number): void;                 // spawn/despawn/backfill toward TUN.fleet.enemyCount
  updateAI(dt: number, t: number, waves: Wave[], wind: Wind): void; // drive every captain at the player
  rankLOD(cameraPos: THREE.Vector3): void;     // recompute premiumEnemy + ordering
  boardingTarget: Ship | null;                 // set by main so despawn skips it
}
```

`makeEnemy` is injected (builds `buildSloop` → `ShipVisual` → `Ship`) so the manager owns
*lifecycle* without owning *construction details*, and so tests can pass a stub factory.

### New method — `GameWorld.removeShip(ship)`

Mirror of `addShip` (`world.ts:35`): splice from `ships`, remove `ship.visual.group` from
the scene and dispose its geometries/materials, and remove the Rapier rigid body + colliders
from `physics.world`. Required for despawn and sink-cleanup; only `addShip` exists today.

### Ocean LOD (`src/render/ocean.ts`)

Two tiers, **no texture atlas, no new samplers** (stays under the fragment texture-unit
budget):

- **Premium — 2 slots: player (slot 0) + `premiumEnemy` (slot 1).** Unchanged from today's
  pipeline: voxel-accurate sea-cut (`uProfileTex0/1`), the stern-trail ribbon (`uTrail`,
  64 = 2×32), and the dynamic-wave stamp. Two simplifications make slot-1 reassignment cheap:
  - **All enemies share one `buildSloop` profile texture** (identical geometry), so re-binding
    slot 1 to a different enemy only changes the live pose (`uProfileInvRot[1]`/`uProfileTrans[1]`),
    never the texture. Voxel-destruction divergence on the cut is an accepted minor visual
    approximation (the cut already has +2 m crest clearance).
  - On slot-1 reassignment, **clear `trails[1]`** so the wake ribbon doesn't lace a line
    across the jump from the old ship to the new one.
- **Cheap — slots 2…`MAXVIS`: every other visible enemy.** Bump the uniform arrays
  `uShipA/B[2]→[MAXVIS]`, `uShipC[2]→[MAXVIS]`, and `uProfileOn[2]→[MAXVIS]` (cheap slots
  bind `false` so the analytic-ellipse cut runs instead of the voxel cut), and widen the
  two shader loops (`for s2 < 2` collar/bow in VERT; `for s0 < 2` analytic-ellipse cut +
  `for s < 2` wash in FRAG) to `< MAXVIS`. These ships get the **analytic-ellipse sea-cut + displacement collar
  + bow wave + flank wash** (all just extra loop iterations — negligible GPU) plus the
  **stencil silhouette** via `SeamMask`. They do **not** get a per-ship stern ribbon, a
  dyn-wave stamp, or the voxel cut. This is the pre-voxel look and reads correctly at the
  distances cheap ships occupy.

`ocean.updateShipWake`/`updateHullPose`/`setHullProfile` slot parameters widen from `0 | 1`
to `number`. The dynamic-wave field (`render/dynamicWaves.ts`, `maxShips`) stays at **2**
(premium only).

### Gameplay de-singleton (`src/main.ts`)

- Replace the single `enemy` + `captain` with a `FleetManager` (`fleet`). `main.ts` shrinks:
  spawn/AI/LOD bookkeeping moves into the manager.
- Player cannons: `cannons.update(dt, t, waves, fleet.enemies)` (was `[enemy]`).
- Collision/destruction: `collisionDestruction.update([sloop, ...fleet.enemies])`.
- **Boarding retargets:** `BoardingSystem`'s `enemyShip` becomes settable. Each step (when
  not grappled) point it at `fleet.premiumEnemy`; while grappled, **lock** to the grappled
  ship and set `fleet.boardingTarget` so reconcile won't despawn it.
- **Per-enemy sink/salvage:** replace the single `enemyScuttled` boolean (`main.ts:256`,
  `:401–405`) with a per-ship "salvaged" flag (a `WeakSet<Ship>` or a `Ship.salvaged` field);
  award salvage + post the toast once per enemy as each goes down.
- **HUD:** the enemy marker points at the nearest living enemy; add a small "foes: N"
  readout. (The marker math at `main.ts:666–668` retargets to `fleet.premiumEnemy`.)
- Per-frame ocean/wake/spray/dyn-ship feeds (`feedWake`, `buildDynShips`, `checkBowSpray`,
  `spans`) generalize from the hardcoded `[sloop, enemy]` pair to `[sloop, ...visibleEnemies]`
  for the cheap feeds and `[sloop, premiumEnemy]` for the premium feeds (trail/profile/dyn).

### Dev slider (`src/core/tunables.ts` + `src/render/devPanel.ts`)

Add to `TUN`, following the existing knob-board convention:

```ts
/** Fleet — how many hostile ships the FleetManager keeps sailing against the player
 *  (game/fleet.ts). Integer 0..MAXVIS. Sunk enemies are auto-replaced to hold this
 *  count. Default 1 = the shipped duel. */
fleet: {
  enemyCount: 1,
},
```

Wire an integer slider `0–6` into the dev panel like the other `TUN` sliders. `MAXVIS = 6`
lives as a constant (in `fleet.ts` or `core/constants.ts`) and bounds both the slider max and
the ocean uniform-array sizes.

## Data flow (per fixed step)

1. `world.step` runs buoyancy/flooding/forces for every ship in `world.ships` (player +
   all spawned enemies) — already list-based, unchanged.
2. In `onFixedStep`: `fleet.reconcile(dt)` (spawn/despawn/backfill toward the slider) →
   `fleet.updateAI(...)` (every captain steers + fires at the player) → player input,
   cannons (`fleet.enemies` as targets), collision/destruction (`[sloop, ...enemies]`),
   boarding (retargeted), per-enemy sink/salvage.
3. Per render frame: `fleet.rankLOD(cameraPos)` sets `premiumEnemy`; the ocean feeds split
   premium (slots 0–1: profile/trail/dyn) vs cheap (slots 2…: collar/bow/wash); `SeamMask`
   gets all hull groups; HUD retargets to the nearest enemy.

## Slider semantics (auto-replace)

`TUN.fleet.enemyCount` = the number of enemy ships the `FleetManager` keeps **present**
(alive or actively sinking). Reconciliation each step:

- spawned < target → spawn one (placement fan).
- spawned > target → despawn the farthest non-boarding-target enemy.
- a spawned enemy finishes sinking (`y < -12`) → remove the wreck; spawned drops below
  target → next step backfills. This is the auto-replace, and it operates at any count
  including `1` (kill the lone enemy → a fresh one sails in).

## Error handling & edge cases

- **Despawn vs boarding:** reconcile never removes `fleet.boardingTarget`; it picks the
  next-farthest. If the only removable ship is the boarding target, the despawn is deferred
  until the player releases.
- **In-flight cannonballs** referencing a ship removed mid-flight simply miss (the target
  list is read fresh each `cannons.update`); no dangling reference.
- **Resource leaks:** `removeShip` disposes the visual geometry/materials and the Rapier
  body/colliders. AI captain for a removed ship is dropped from `FleetManager`.
- **Slider thrash:** one spawn/despawn per step smooths big drags; LOD hysteresis prevents
  premium-slot flip-flop and wake-ribbon popping.
- **Count 0:** no enemies; the player sails an empty sea (valid sandbox state). HUD shows
  "foes: 0", no marker.
- **Determinism:** spawning uses the existing seeded `Rng`; the dev slider is a runtime knob
  (like all `TUN`) and is **not** read by the deterministic vitest oracle, so test
  determinism is unaffected (consistent with `tunables.ts`'s contract).

## Testing

- **Unit (`fleet.test.ts`, no GPU):** reconciliation against a stub world/physics/factory —
  count up spawns, count down despawns the farthest, never despawns the boarding target,
  backfill-on-sink restores the target count (including the count-1 auto-replace), clamp to
  `0..MAXVIS`. LOD ranking picks the nearest and respects hysteresis.
- **In-browser (Playwright + readback, per `CLAUDE.md`):** set the slider to 6, confirm (a)
  no sea-through-deck / under-hull void on the cheap ships, (b) a stable wake on the premium
  pair, (c) no GLSL program invalidation (the whole ocean vanishing) from the widened loops/
  arrays. Screenshots land in the projects root.
- **Regression:** keep the ~115 existing vitest tests green; with default `enemyCount: 1`
  the runtime behavior must match today's duel.

## File-by-file change list

- **New** `src/game/fleet.ts` — `FleetManager` (lifecycle + AI fan-out + LOD ranking).
- **New** `src/game/fleet.test.ts` — reconciliation/LOD unit tests.
- `src/game/world.ts` — add `removeShip(ship)`.
- `src/render/ocean.ts` — widen `uShipA/B/C` + the collar/bow/cut/wash loops to `MAXVIS`;
  slot params `0|1 → number`; clear `trails[1]` on premium-slot reassignment.
- `src/game/boarding.ts` — make `enemyShip` retargetable (a `setEnemy`/settable field).
- `src/main.ts` — replace `enemy`/`captain` with `fleet`; player cannons + collision target
  the enemy list; boarding retarget; per-enemy salvage; HUD nearest-enemy + foe count;
  generalize the per-frame ocean/wake/spray/dyn feeds.
- `src/core/tunables.ts` — add `fleet: { enemyCount: 1 }`.
- `src/render/devPanel.ts` — integer `0–6` slider for `TUN.fleet.enemyCount`.
- `src/core/constants.ts` (or `fleet.ts`) — `MAXVIS = 6`.

## Accepted simplifications (recorded so they aren't "bugs" later)

- The premium enemy's voxel sea-cut uses the canonical `buildSloop` profile, ignoring
  per-ship voxel-destruction divergence (minor, within the cut's existing tolerance).
- Cheap ships get the analytic-ellipse cut + stencil, not the voxel cut — correct at range.
- Only **2** ships ever get the dynamic-wave stamp and the stern-trail ribbon (the premium
  pair); the dyn-wave field `maxShips` stays 2.
- `MAXVIS = 6` is a hard ceiling on simultaneous enemies (and the slider max).
