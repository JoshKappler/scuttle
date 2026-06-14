# SCUTTLE — Voxel Destruction Core: Design Spec

**Date:** 2026-06-13
**Status:** Approved by user (brainstorming session 2026-06-13); awaiting implementation plan
**Scope:** The ship-vs-ship / projectile destruction core only. Islands/terrain and flooding *tuning* are deferred to their own specs (see §10).

## Context & the problem

Today two ships that collide "just kind of freeze, and maybe some chunks go flying." The root cause is in the code, not the concept: each ship's physics body is a **single coarse cuboid** sized to the whole hull (`src/game/ship.ts:150-154`). When two hulls meet, two solid boxes collide and Rapier stops the interpenetration → freeze. The ramming system (`src/game/ramming.ts`) is an explicit workaround documented in its own header: it watches for box contact and carves a sphere of voxels out of both hulls at the contact point. That changes the *visuals* (severed islands fly off as debris) but never the *collision shape*, so ships can never tear *into* one another, embed, or shear through.

The original design (`docs/superpowers/specs/2026-06-12-scuttle-design.md:113`) already chose Rapier specifically for "native sparse voxel colliders… mutable hulls as a supported engine feature" and called for "update Rapier voxel collider" on each hit. **That jump was never made** — the build is still on the placeholder box. Closing that gap is the heart of this work.

### Goals

Teardown-grade destruction at sea, all of it emergent from physics rather than scripted or preset:

1. Ships **tear into each other**, can become **embedded**, and can be **sheared apart** — driven by the speed and mass behind the impact, with no preset damage amounts.
2. **The bow is tougher than the flanks**, making bow-first ramming a real battle tactic — with *no* armor-zone special-casing; it falls out of materials + authoring.
3. **"The ship is always the ship"**: no amount of damage mechanically separates a controllable part of a vessel. After a hit the ship persists — same rigid body, same control — simply with fewer voxels and an open flood hole. Whatever connected mass is *not* attached to the helm becomes a free-floating voxel chunk that sinks naturally.
4. **Cannon fire and ramming share one destruction mechanic** (physics, not presets).

### Non-negotiables inherited from the project

- **60 fps / 16.6 ms** at 1080p on an integrated-GPU laptop (Iris-Xe class) during a two-ship engagement (`2026-06-12-scuttle-design.md:182`).
- **Deterministic physics** — same seed + input log → identical replay hash. The destruction path must be RNG-free.
- One rigid body per ship; attitude (list/trim/capsize) stays emergent from per-voxel buoyancy + flooding. No scripted sinking.

## Decisions log (brainstorming 2026-06-13)

| Decision | Choice | Rationale |
|---|---|---|
| Scope of this spec | **Destruction core first**; islands + flooding-refinement are separate specs | Tightest path to the riskiest, highest-value piece; the shared voxel-collision foundation must exist before the others consume it |
| Hull collider | **Native Rapier `Voxels` collider**, gated by an upfront perf spike; compound greedy-boxes is the written fallback | True concave voxel-exact collision; embedding/tearing emerge with no special case; `setVoxel` is O(1); it's the feature Rapier was chosen for |
| Ram feel | **Fully physics-derived**, no preset damage amounts — carving scales with speed and mass; resistance from Rapier's own contact impulse | User directive: "all just scaling with speed and mass behind impact… not like playdoh, but not so stiff that boats just deflect" |
| Severed mass | **Helm-anchored ship identity** — the helm-connected component is *always* the ship; non-helm components become free voxel chunks | User directive: "no amount of damage should mechanically separate any controllable part of a ship… the part that isn't attached to the steering wheel becomes just a free floating chunk of voxels" |
| Cannons | **Unified** onto the same `carve` primitive now (not ramming-only) | User choice; removes the preset blast-radius the user dislikes |
| Directional armor | **Emergent** from per-material strength + a reinforced bow in the authored build; no armor-zone code | Cleanest, matches "all physics"; reuses the existing `strength` field |

## Relationship to prior design docs

This spec is the approved successor to the destruction portions of the **unapproved** overnight proposal `2026-06-13-voxel-overhaul-design.md`:

- Its **Phase V1** (ramming asymmetry via preset `bowFactor`/`sideFactor` bite-radius scaling, keeping the coarse box collider) is **superseded** — replaced here by the physics energy model (§1) and a native voxel collider (§2), per the user's 2026-06-13 direction ("all physics, no preset amounts"; native voxels, spike-gated).
- Its **Phase V2** (structural break-off / debris) is **already shipped** in m10 (`debris.ts`, wreck bodies) and is *extended* here — helm-anchored identity (§5) and per-voxel-buoyancy chunks replacing the 150 s timer.
- Its **Phase V3** (voxel masts & sails) and **Phase V4** (in-hull fluid / replace the blue flood bar) are **out of scope** here and remain future work — V4 maps to the deferred flooding-refinement spec (§10); V3 to the voxel masts/sails roadmap item.

`m10-carnage-and-feel.md` (T11 ramming, T12 wrecks) is the *shipped* origin of the current ramming/debris code this spec rebuilds; it is history, not a conflict.

## 1 — The one primitive: `carve(ship, atCell, energy, dir)`

All destruction routes through a single pure-ish function that **spends an energy budget removing voxels**. Each voxel costs `MATERIALS[mat].strength × C` joules (where `C` is one global "joules-per-strength" constant). The carve expands outward from `atCell`, **biased along `dir`** (penetration deeper than lateral spread), always removing the **cheapest reachable frontier voxel next**, debiting the budget until it is exhausted or a per-call voxel cap is hit.

Consequences, all with zero special-casing:

- **Speed²·mass scaling.** The budget is `E = κ · ½ · m_reduced · v_closing²`. Exactly "scaling with the speed and mass behind the impact."
- **Directional armor.** A tough/thick bow voxel costs 4–8× a pine plank, so the *same* budget removes few bow voxels and many soft-flank voxels. The bow survives; the flank caves.
- **No presets.** The `radiusVox = min(2 + closing*0.45, 7)` formula (`ramming.ts:67`) and the cannon blast-radius constant are both deleted.

`carve` reuses the existing post-removal tail of `applyDamage` (`ship.ts:662-708`): breach registration, `findSevered`, mast-step checks, `recomputeMassProperties`, dirty-chunk remesh. In effect, `applyDamage(cell, radiusVox)` is **refactored into** `carve(cell, energy, dir)` — same tail, new front-end.

**Tuning surface:** exactly two knobs set the whole feel — `C` (joules per strength point) and `κ` (fraction of collision KE that becomes destruction vs. elastic bounce). These are where "not play-doh, not deflection" gets dialed.

## 2 — Voxel-collider foundation (spike-gated)

- **Build.** Replace the cuboid at `ship.ts:150` with `ColliderDesc.voxels(coords, { x: VOXEL_SIZE, y: VOXEL_SIZE, z: VOXEL_SIZE })`, where `coords` is an `Int32Array` of solid `(x,y,z)` triplets from `grid.forEachSolid`. Keep collision group `0x0002` (ship/debris world, excluded from the character controller).
- **Mutate.** Inside `carve`, every removed cell → `hullCollider.setVoxel(x, y, z, false)`. The API is O(1) and grows its internal grid automatically (`collider.d.ts:365-369`) — no collider rebuild on damage.
- **Pair.** When two hulls come into proximity, call `combineVoxelStates(other, shiftX, shiftY, shiftZ)` once; after each `setVoxel`, call `propagateVoxelChange(other, ix, iy, iz, …)` against each paired hull (`collider.d.ts:370-405`). This removes the "internal-edge" artifact so a bow can slide along and *lodge in* another hull instead of snagging on phantom interior faces. Active pairs are tracked in the world/ramming update.
- **Why one-frame tunnelling is lower-risk than the Space Engineers precedent.** SE's tunnel bug came from *rebuilding* the physics shape on every change, which discards all contacts. We never rebuild — `setVoxel` mutates in place and `propagateVoxelChange` maintains contact coupling incrementally. This is validated in the spike, not assumed.
- **Deck trimesh stays** (`ship.ts:281-308`) — it is the character-walking surface in a different collision group. Retiring it (characters walk the real voxel collider, deleting the per-hit trimesh rebuild) is a *future* cleanup, explicitly out of scope, to avoid reopening the character-controller tuning the code warns about (`ship.ts:146-148`).
- **Mass/COM** are already regenerated from the grid in `recomputeMassProperties` (`ship.ts:712`); unchanged.

## 3 — Ramming = real contact impulse → carve (the feedback loop)

The perimeter-box hack in `ramming.ts` is deleted wholesale. New path: each step, take the collision's inelastic energy at the contact — the same `½·m_reduced·v_closing²` quantity from §1, sourced from Rapier's reported **contact-force/impulse events** rather than recomputed by hand → `E_d = κ · that` → `carve` **both** hulls from the shared contact point, cheapest-voxel-first across the two frontiers.

The feel emerges from a self-regulating loop:

- **High-energy ram** → carves a tunnel → contacted voxels vanish (`setVoxel false`) → Rapier's contact opens → resistance drops → the bow **eats through and embeds**.
- **Low-energy nudge** → carves little → contact holds → ships **fend off** (fenders, not carnage). The `MIN_CLOSING` threshold concept survives as the lower bound where `E_d` rounds to zero voxels.

Rapier's own contact impulse supplies the deceleration (never play-doh); the carving supplies the penetration (never a pure bounce). A **per-step carve cap** (≈ a few dozen voxels) bounds cost *and* makes a heavy ram visibly grind through over several frames rather than teleport-deleting a hull.

**Embedding is emergent** — if the budget runs out mid-hull, the bow simply rests lodged in the carved notch via ordinary voxel contact + friction. A deliberate "lock for boarding bridge" is deferred to the boarding milestone.

## 4 — Directional armor = authoring, no new systems

No armor-zone code path. Two authoring changes carry it:

1. **Material table** (`src/sim/materials.ts`): reframe `strength` from "cannonball HP a cell soaks" to "joules to break this voxel," and add a reinforced **ram / ironbark** tier with high strength (and suitably high density) for the prow.
2. **Shipwright builds** (`src/sim/shipwright.ts`, `buildBrig`/`buildSloop`): lay the **bow thicker and in the tougher material**.

§1's cheapest-first carve does the rest: a tough, multi-voxel-thick bow drains an impact budget fast and survives; a thin pine flank is cheap and caves. Bigger ship classes get tougher bows purely by authoring — emergent, tunable, zero per-class logic. The existing `IRON`-shrug special case in `applyDamage` (`ship.ts:654-657`) is deleted; it emerges from strength cost.

## 5 — "The ship is always the ship": helm anchor + free chunks

- **Anchor moves keel → helm.** At construction, `helmAnchor` = the keel cell beneath `build.wheelM` (the wheel's local position, `src/sim/shipwright.ts:30`). One change at `ship.ts:107`. `findSevered` already keeps the anchor's connected component and sheds the rest (`src/sim/connectivity.ts:55,73`), and already falls back to the largest component if the anchor cell itself is destroyed (`connectivity.ts:65-71`) — so the wheel can never be "blown off the ship."
- **The ship never loses identity or control** — same rigid body, fewer voxels, an open hole. Nothing re-spawns; no "which half is bigger" logic. A ship cut clean in half just keeps being the helm half, now flooding hard.
- **The cut floods.** `carve` extends the breach-registration in `applyDamage` (`ship.ts:664-688`) to cover **severance**, not just directly-hit cells: any *remaining* hull cell newly exposed to open water below deck registers as a breach for its compartment, so a sheared stump genuinely floods from the cut face.
- **The detached part = a free voxel chunk that sinks naturally.** `onSevered → debris.spawn` already exists (`ship.ts:696`, `src/game/debris.ts`). The 150 s `wreckLift(age)` *timer* (`debris.ts:40,171`) is replaced with **per-voxel buoyancy + physics-based waterlogging**, so the chunk floats, lists, and founders on its own merits — no clock. Small flotsam keeps the cheap single-probe model. (Voxel colliders on chunks — so you can ram a drifting wreck — are an optional stretch, deferred; box colliders are acceptable for v1.)

## 6 — Cannons fold into the same primitive

Cannon hits migrate from `applyDamage(cell, radiusVox)` to `carve(ship, cell, E_ball, dir)`, where `E_ball` is the ball's kinetic energy at impact and `dir` its travel direction. A round shot shrugs off a reinforced bow (few voxels) but holes clean through a thin flank — identical mechanic to ramming, identical material physics. This deletes the preset blast radius and the `IRON`-shrug branch. (`src/game/cannons.ts` is the call site.)

## 7 — Risk & performance

- **Step 1 is a throwaway perf spike** (agreed go/no-go gate): two galleon-class hulls grinding hull-to-hull under sustained carving, frame time measured against 16.6 ms on an Iris-Xe-class GPU. Pass → build on native voxels. Fail → **compound greedy-boxes fallback** (hull as a compound of merged cuboids edited on damage; coarser, engine-agnostic, documented but not built unless needed).
- **The real unknown is voxel-vs-voxel *narrowphase* cost** between two large hulls — *not* the `setVoxel` updates (cheap) or the remesh (already amortized). Spike mitigations if it's marginal: restrict voxel accuracy to the contact region, or coarsen the collider while keeping the visual grid fine.
- **Determinism guard.** `carve` and the contact→energy path must be RNG-free. `debris.ts` currently uses `Math.random` for scatter; that moves out of the deterministic core (or is seeded from sim state) so replay hashes stay stable.
- **Per-step carve cap** doubles as the perf backstop under sustained bombardment.

### Hard-won constraints to honor (from the overnight build log + m10/m11 findings)

- **Never cache a Rapier body/collider reference across frames without a guard.** A despawned body referenced later poisoned the whole physics world (`RuntimeError: unreachable`, m10). Collider pairing (`combineVoxelStates`/`propagateVoxelChange`) holds references to the *other* hull — when a ship or large chunk is removed, every pairing that names it must be torn down that same step. Guard wasm-boundary mutations with try/catch.
- **The iron keel is a strength-8 spine** running the hull's length. Under the energy model it naturally resists carving, so a midship ram won't cleanly bisect a ship until the budget can cut the keel — splits happen through the wooden bow/stern quarters first. This *reads right* ("the keel is the last thing to go") and reinforces helm-anchored identity; don't fight it.
- **Preserve collision-group separation.** The voxel hull stays in group `0x0002` (ship/debris); the KCC filters it out (`~0x0002`); characters keep colliding with the **deck trimesh** only. Putting the hull in the character world reintroduces the "walk on air" / stair-eject bugs (m10 T5).
- **Determinism: the carve + contact→energy path must be RNG-free.** `debris.ts` scatter uses `Math.random`; move it out of the sim core or seed it from sim state so replay hashes hold.
- **Temp-vector discipline.** A reused `THREE.Vector3` temp silently corrupted forces three separate times in this codebase. Every cached temp gets exactly one job per call; grep `tmp` reuse whenever a force or position "vanishes."
- **Keep the suite green.** ~105 vitest tests + `tsc` clean is the standing bar; new carve math joins the unit-tested pure sim modules. `npm test` / `npm run dev`.
- **Existing end-game coupling:** `isSunk` fires at 95% flood, so shearing off a large section can end the encounter before the wreck settles (m10). Acceptable today; note it when testing severance.

## 8 — Testing strategy

- **Pure-function `carve` unit tests** (engine-free): a budget `E` into a uniform material wall removes `N = floor(E / (strength·C))` voxels; a tough wall removes provably fewer than a soft wall for the same `E`; a symmetric budget across a bow/flank pair yields asymmetric penetration.
- **Severance test:** carve amidships → the helm-connected component remains the ship (rigid body + control flag intact) and the remainder is emitted as a chunk; verify the cut face registers breaches.
- **Determinism test:** same seed + input log → identical post-carve grid hash.
- **Perf gate:** the spike's two-galleon frame-time budget, tracked as a number, re-checked under sustained fire.
- **In-browser behavioral check** (per the project's GPU-verification practice — Playwright + readback/screenshot oracle): drive a scripted ram and assert voxels visibly carve and the bow embeds.

## 9 — Data flow (per fixed step)

```
contact-force events (Rapier)
  → E_d = κ · inelastic collision energy
  → carve(both hulls, contact, E_d, normal)
       ├─ setVoxel(false) + propagateVoxelChange   (collision shape)
       ├─ grid.remove + breach-register (incl. cut face)   (sim)
       └─ mark dirty chunks                          (remesh, amortized)
  → findSevered(helmAnchor)
  → non-helm islands → onSevered → debris.spawn (per-voxel buoyancy)
  → recomputeMassProperties
```

Cannon path is identical from `carve(...)` onward; only the energy source differs (ball KE vs. contact impulse).

## 10 — Scope fence (deferred to their own specs)

- **Islands / terrain** — cliffs, rocks, beachable shallows, cover. Separate spec.
- **Flooding *tuning*** — slow-vs-fast breach rates, pump balance, directional-sink granularity. Separate spec. (The cut *producing* the hole and registering breaches is in-scope here; tuning how it floods is not.)
- **Deliberate embed-locking** for boarding bridges — boarding milestone.
- **Retiring the deck trimesh** in favor of the voxel collider — future cleanup.
- **Voxel colliders on debris chunks** — optional stretch.

## 11 — Key references

- Current code: `src/game/ship.ts` (collider `:150`, anchor `:107`, `applyDamage :645`, `recomputeMassProperties :712`, deck trimesh `:281`), `src/game/ramming.ts`, `src/sim/connectivity.ts`, `src/game/debris.ts`, `src/sim/materials.ts`, `src/sim/shipwright.ts` (`wheelM :30`), `src/game/cannons.ts`.
- Rapier voxel API (`@dimforge/rapier3d-compat@0.19.3`): `ColliderDesc.voxels` (`geometry/collider.d.ts:633`), `Collider.setVoxel` (`:369`), `propagateVoxelChange` (`:388`), `combineVoxelStates` (`:405`).
- Teardown research (2026-06-13): connectivity-only destruction, no stress/FEA (Gustafsson, blog.voxagon.se "Cracking destruction" 2014; @voxagonlabs 2021); carve-as-commands + fixed-point determinism (blog.voxagon.se "Teardown Multiplayer" 2026); material = tier/tool capability, not per-voxel HP (teardowngame.com/modding); new bodies get mass/COM trivially from voxels, physics data regenerated not stored (blog.voxagon.se "Quicksave" 2020). Adjacent ship-game patterns: Space Engineers contact re-registration after shape change (Marek Rosa dev blog 2017); Avorion/From-the-Depths helm/root-anchored identity and layered-armor penetration.
- Project north stars: `docs/superpowers/specs/2026-06-12-scuttle-design.md` (§2 stack, §3 simulation layers, §6 risks).
