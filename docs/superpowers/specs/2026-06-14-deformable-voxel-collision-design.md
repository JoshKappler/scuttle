# Deformable Voxel Collision — Design Spec

_Date: 2026-06-14. Status: approved direction, awaiting spec review → implementation plan._

**Goal:** One core voxel collision/destruction primitive from which ship-vs-ship ramming, gunnery, flooding, and (later) grounding on terrain all **emerge** — replacing the rigid-body-with-confetti model with true mutual-deformation "crunch" (Teardown / BeamNG feel: both bodies indent, energy is absorbed not transferred, neither rigidly shoves the other before compressing).

**Architecture (2 sentences):** A universal energy→voxels primitive (`crush()`) removes voxels paying per-cell material toughness until an energy budget is spent; on top of it, the hull-vs-hull contact is taken **out of Rapier's rigid solver** and run as a sub-stepped, force-capped **penalty contact** whose over-cap energy feeds `crush()` on both hulls at the actual overlap — so the carve bleeds the spring, the rammer decelerates and digs in, and both hulls dent exactly where they touch.

**Tech stack:** TypeScript, Rapier3D (JS bindings, v0.19.x — native voxel colliders, `setVoxel` O(1)), Three.js, existing `sim/` material + carve + connectivity modules.

---

## North Star (the bar this is judged against)

The project philosophy is **one great core system → specific effects via emergence** (cf. `memory/damage-core-emergence`, and ship attitude being emergent from the per-voxel hull, `CLAUDE.md` THE LAW #2). The design is correct **only if gunnery, flooding, and grounding fall out of the same primitive for free.** If ramming needs its own code path, the design is wrong.

| Effect | Same core, different input |
|---|---|
| Ramming | overlap + relative KE → `crush()` both hulls at the interface |
| Cannonball | ball KE → `crush()` along its entry ray; **penetration depth emerges** |
| Flooding | the holes `crush()` registers, below the waterline, are the ingress |
| Grounding on a reef (later) | identical contact: hull voxel body vs rock voxel body |

---

## Why the current approach fails (what we're replacing)

Rapier is a **rigid-body solver**: it resolves the hull-hull contact as rigid (push apart + transfer momentum) inside `world.step()`. Our destruction code runs *around* that step and can only delete a few voxels afterward — it can't change the rigid response, so we get rigid plow-and-shove plus cosmetic chips. Worse, carving at Rapier's reported contact point (mapped through the ship's *moved* transform a step later, and combined with an over-eager connectivity sever) lands holes in the wrong places — including the "huge chunk on the opposite side." Rapier-JS exposes **no `modify_solver_contacts`** (verified), so we cannot cap its contacts the way Teardown caps its own solver. Therefore: take the hull-hull pair away from Rapier and run our own deformable contact.

---

## Components

### 1. `crush()` — the universal energy→voxels primitive  (`sim/` + `game/ship.ts`)

Conceptual signature:

```
crush(ship, cells: Cell[], energyJoules) -> { removed: Cell[], leftover: number }
```

- Iterates `cells` cheapest-first by **material toughness cost** (`cost = MATERIALS[mat].strength * STRENGTH_TO_JOULES`, the existing model), removing each and subtracting its cost from the budget, until the budget can't afford the next cell.
- Removal routes through the existing **`ship.carveCells`** tail: `grid.remove` + `hull.removeVoxel` (O(1) `setVoxel`) + breach registration + `damageDirty`. **No new removal path.**
- Returns the cells removed and the leftover energy (used by callers: cannonball leftover → small target shove; ram leftover → debris/push).
- **Callers:** ramming (Layer 2 passes the overlap cells + contact energy), cannonball (passes the cells along its entry ray + the ball's ½mv²), terrain later.
- Removed voxels → **dust** (most) + a few **forward-flung debris bodies** (carry momentum away so the target barely moves; existing `debris.ts`). Severed islands ≥ `BIG_SEVER` → wreck body; smaller → dust (existing).
- Breaches registered → **flooding emerges** (the flood system already reads hull openings).

`crush()` is a small generalization of today's `planCarve`/`carveCells`: the difference is the **candidate cells are supplied by the caller** (the real overlap, or the real bore ray) instead of flood-filled from a guessed seed. That single change kills the wrong-location bug.

### 2. The deformable hull-hull contact — "Layer 2"  (new module, e.g. `game/voxelContact.ts`)

**Setup (once):**
- Both hull colliders: `setActiveHooks(ActiveHooks.FILTER_CONTACT_PAIR)`. A physics hook returns, **for the hull-hull pair only**, a `SolverFlags` value **without** `COMPUTE_IMPULSES` → Rapier generates the manifold but applies **no rigid push**. Every other pair (hull↔water, hull↔cannonball, hull↔terrain) keeps `COMPUTE_IMPULSES`.
- `setCcdEnabled(true)` on both hulls; `setSoftCcdPrediction(speed·dt)` so a fast ram is caught before deep penetration.

**Per sub-step** (the manual contact, looped N×/frame at `dt/N`):
1. **Broad cull:** world AABB ∩ AABB of the two ships. No overlap → return (the common case; ~zero cost).
2. **Overlap detection:** transform the *smaller* hull's **surface voxels** into the other hull's grid frame; test the other's **occupancy bitset**. Collect the overlapping cells; take the contact **normal** and **penetration depth `d`** from Rapier's manifold for the pair (`world.contactPair` → `.normal()`, `.contactDist(i)`).
3. **Penalty force (one soft, capped push):** `F = k·d − c·v_n`, clamped to `F_max`. Applied equal-and-opposite at the contact centroid(s) via `applyImpulseAtPoint(F·dt, point, true)`. The **same** force is gentle at small `d` (rafting side-by-side just holds apart, no damage) and capped under a hard ram so it **cannot** transmit a rigid shove.
4. **Carve (the energy sink), SYMMETRIC:** energy above the cap / above per-voxel yield → `crush()` on **both** hulls over the overlap cells, split symmetrically. Removing those cells shrinks `d` → shrinks `F` next step → **the spring is bled, not returned.** The rammer's KE becomes carving (decelerate + dig in); both hulls indent at the contact; the target barely moves.
5. **Bookkeeping:** `combineVoxelStates`/`propagateVoxelChange` between the two voxel colliders to avoid internal-edge ghost contacts after carving; flood-fill sever check stays throttled / off the critical path (existing `flushDamage`).

### 3. Bow ramming zone (material, not a rule)  (`sim/shipwright.ts`, existing `armorBow`)

The energy split is symmetric, but the **bow carries a deliberately durable ramming area**: the forward shell (and a few voxels of stem) are the toughest material (`RAM`, strength 14 ≈ 4.6× oak). Under the symmetric crunch, the bow loses far fewer voxels per joule than the oak side it strikes, so **ramming bow-first wins and the bow survives — emergent from toughness, no special collision case.** This extends the existing `armorBow()` into an explicit reinforced prow (a couple of voxels deep at the very stem), density still tuned to keep trim neutral (THE LAW #2).

### 4. Cannonballs — fully emergent depth  (`game/cannons.ts`)

A ball stops being a fixed bore. On impact it calls `crush()` with energy `½·m_ball·v²` along its entry ray; depth **emerges**: a fast ball punches clean through, a slow one lodges, an iron belt stops it. Leftover energy → the existing small hull-shove impulse. Same primitive as ramming, smaller and faster.

---

## Data model

- Per-ship **occupancy bitset** (`Uint8Array`, 1 bit/voxel or 1 byte/voxel) + a maintained **surface-voxel list**, alongside the grid, updated incrementally on every carve. Drives fast overlap tests (step 2). If `grid.isSolid` proves fast enough at our voxel counts, the bitset is an optimization we can defer — decided during implementation against the harness.
- Everything else (grid, materials, compartments, breaches) is unchanged.

## Energy / momentum model

- `E_impact = ½·μ·v_rel²`, `μ = m₁m₂/(m₁+m₂)` (reduced mass).
- Per-voxel cost = existing `breakEnergy(mat)`.
- Carve until `E` is spent; **leftover** becomes a small target push + debris KE. Carved voxels are flung **forward** (along the impact) as debris so they carry momentum away — that's what lets the target stay nearly put while the rammer slows a lot, with momentum conserved over rammer + debris + target (no physics cheat).

## Stability plan (penalty contacts are finicky — this is non-negotiable)

- **Sub-stepping** N=4–8 (loop cull→force→carve at `dt/N`).
- **Critical damping** `c = 2·√(k·m_eff)`, backed off ~10–20% for spring-feel.
- **Force cap** `F_max` bounds the worst one-frame impulse (Teardown's cap); excess → carving.
- **CCD / soft-CCD** so a fast rammer can't tunnel before detection (the #1 failure mode of manual contacts).
- **Monotonic carving** per contact episode: overlap only ever shrinks → the contact can only lose energy → no trampoline.
- **Hysteresis / min-energy threshold** before carving (no voxel flicker on grazing touch).
- **Clamp** the penetration used in `F` (a momentary deep overlap can't explode).

## Verification harness — BUILD FIRST

Before any tuning, a **live readback** (dev panel + `window.DEBUG`) exposing per-step: overlap voxel count, max penetration, contact-force magnitude, energy spent, voxels removed per hull, rammer Δspeed. Plus a Playwright readback oracle (per `memory/scuttle-gpu-shader-verification`) asserting invariants automatically: no NaN, total energy non-increasing across a contact episode, holes located at the overlap (not elsewhere). **We diagnose by numbers, not by squinting** — last time's bugs were invisible.

## Reused vs replaced

- **Reused:** material/toughness table, `carveCells`, dust + debris (`debris.ts`), breach/flood plumbing, `armorBow` (extended).
- **Replaced:** `game/collisionDestruction.ts` (the impulse-threshold + drag rigid-reaction) → the Layer 2 deformable contact. The capped-impulse-reaction model is retired.
- **Changed:** cannon bore → emergent KE-budget `crush()` along the ray.

## Scope

**v1:** ship-vs-ship deformable crunch (the core) + cannonball through `crush()` (emergent depth) + the harness. Flooding emerges (already reads holes). **Not v1:** terrain/rocks (later — same contact, when rocks exist), fancy debris dynamics, multi-ship (>2) simultaneous crunch optimization (cull handles correctness; perf tuning later).

## Tunables (dev panel, live)

`k` (penalty stiffness), `c` (damping, or auto-critical toggle), `F_max` (force cap), `N` (sub-steps), yield threshold, debris fling strength, master enable (⊘ keeps the old path available until this is proven).

## Risks

- **Penalty-contact stability** → mitigated by the harness + the stability checklist.
- **Overlap-detection perf** → AABB cull + surface voxels + bitset; only ~2 ships collide at once.
- **Buoyancy/attitude interference** → the contact applies forces only at the interface; buoyancy/leeway/attitude (THE LAW) are untouched.
- **Concurrency/git** → build on an isolated branch (ideally a worktree, per `memory/scuttle-concurrent-instances-git`), commit often.

## Testing

- **Unit (deterministic):** `crush()` energy budgeting (correct cell count/order for a budget); overlap detection (given two grids + transforms, correct overlapping set); energy monotonicity across a synthetic contact episode.
- **Live:** the readback harness + the existing ram-test scenario; cannon penetration sweep (slow→fast shows lodge→through).
