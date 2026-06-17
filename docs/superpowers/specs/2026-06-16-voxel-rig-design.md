# Voxel Rig — masts, spars, bowsprit & sails as a breakable lattice

_Date: 2026-06-16. Status: design approved, pre-plan._

> Supersedes the mesh-based rig in `2026-06-13-voxel-masts-design.md`. The rig is
> currently pure decoration (a `THREE.Group` per mast with a canned `t²` topple,
> `PlaneGeometry` sails with an alphaMap "puncture" canvas, and a **static
> bowsprit with no collision** that phases through everything it hits). This
> replaces all of that with one emergent system.

## Goal

Make the masts, yards (the horizontal sail spars), bowsprit (the forward ram
spar) and sails **physical**, following SCUTTLE's North Star: *one simple rule,
realistic behavior emerges*. Concretely:

- The bowsprit/ram and the masts stop phasing through things — they collide and
  **bore into / crush** what they hit, reusing the existing destruction rule.
- Masts get their own physics: when their support is shot or rammed away they
  **topple**, can **break in half**, and **crush whatever they land on** (their
  own deck or an enemy alongside) on the way down.
- Sails become a **breakable cloth lattice** ("a graph of coordinates rendered
  as a sheet"): a cannonball severs links instead of painting a hole, and a
  cut-off region **flaps** from whatever still holds it or **detaches** and blows
  away — rather than the old clunky fold-over animation.

## Decisions (locked with the user)

1. **Simulation model: static until disturbed.** During normal sailing the rig
   is the cheap static geometry it is today (zero added CPU). A mast/sail only
   spins up the live solver when something actually hits it; it sleeps again once
   settled or sunk. This is the perf contract — the frame is already CPU-bound on
   buoyancy ("a couple of big ships = low fps"), so idle rigs must cost nothing.
2. **Sail style: chunky voxel cloth.** A coarse (~8×6) grid of cloth points
   joined by breakable links, pinned to the yards. Tears run along grid lines
   into blocky chunks — matches SCUTTLE's voxel aesthetic and is the cheapest
   cloth option.
3. **Damage: full crush coupling.** The rig feeds the **existing** `½·μ·v²`
   energy-budget break (`sim/crush.ts` / `game/voxelContact.ts`). No new damage
   system: the ram bores, falling masts crush decks, masts snap where
   overstressed.

## Core idea — one primitive, one rule

Both the spars and the cloth are the **same primitive**: point-masses joined by
breakable distance links. Wood links are stiff with a high break threshold;
cloth links are weaker and finer.

**The one rule:** during constraint relaxation, if a link's strain
`|len − rest| / rest` exceeds its `breakStrain`, **delete the link** instead of
satisfying it.

Everything falls out of that rule:

- foot/heel link gone → the spar **topples**,
- a mid-trunk link gone → it **breaks in half**,
- cloth links gone → the sail **tears**,
- a region left hanging by a single pin → it **flaps / luffs**,
- a region with no pins left → it **detaches** and blows away, then sinks.

## Architecture

### Data model (`sim/rigLattice.ts`, pure & unit-tested)

In ship-local meters.

```ts
const enum NF { WOOD = 1, CLOTH = 2, FOOT = 4, WET = 8 }       // node flags

interface RigNode {
  pos: Vec3; prev: Vec3;        // Verlet state
  mass: number;
  pinTo: number | -1;           // index of a node this is glued to (yard lacing / foot)
  flags: number;
}
interface RigLink {
  a: number; b: number;
  rest: number;                 // rest length
  breakStrain: number;          // |len-rest|/rest beyond which the link deletes
  kind: 0 /*WOOD*/ | 1 /*CLOTH*/;
  alive: boolean;
}
interface Rig {
  nodes: RigNode[];
  links: RigLink[];
  awake: boolean;
  sleepTimer: number;           // seconds of near-zero KE; sleeps past a threshold
}
```

- **Spars** (mast trunk, each yard, the bowsprit) = short chains of `WOOD`
  nodes; stiff links, high `breakStrain`. The trunk's base node is a `FOOT`
  pinned to the deck; each yard's center pins to the trunk; the bowsprit's heel
  pins to the bow.
- **Cloth** = an ~8×6 grid of `CLOTH` nodes with weak links plus light diagonal
  links (shear resistance, so it doesn't collapse to spaghetti). The top and
  bottom rows `pinTo` the yard nodes they're laced to — so the cloth physically
  hangs off the spar lattice.

### Builder (`sim/rigBuild.ts`, pure)

Builds a `Rig` from the existing `ShipBuild` — the same `build.masts` (x, z, h)
and the same bowsprit geometry `render/shipVisual.ts` already uses to draw. No
duplicated magic constants; the lattice is derived from the geometry that draws
today, so it lines up with the hull.

### Runtime (`game/rig.ts`)

Per-ship owner of the `Rig`: wake/sleep bookkeeping, collision wiring into the
crush rule, per-node buoyancy, and the bridge to rendering. Owned by `Ship`.

### Rendering (`render/rigVisual.ts`)

Drives meshes from node positions:

- **Spars:** keep the cylinder look, drawn as segments between consecutive node
  positions, so a snapped mast visibly bends and separates. (A blockier
  voxel-box spar is a trivial swap if preferred later.)
- **Cloth:** one grid mesh whose vertices follow the cloth nodes; broken links
  drop the corresponding quads, so a tear is a real hole. Reuses the existing
  sail texture/material and the warm back-light shader.

## The solver — one step (deterministic, `FIXED_DT`)

Position-Verlet (stable, oracle-friendly):

1. **Integrate** each free node: `next = pos + (pos − prev)·damp + accel·dt²`,
   where `accel = gravity + wind + buoyancy`.
2. **Relax** links over a few iterations; **break** any over-strained link (the
   one rule).
3. **Collide** awake nodes vs hull voxel grids → crush (below).
4. **Pins:** keep pinned nodes glued to their anchor; release a pin if its
   anchor voxel/node is gone.

Forces:

- **Gravity** always.
- **Wind:** a deterministic function of time + heading, pushing `CLOTH` nodes
  along the sail normal. This is what makes an intact sail belly and a severed
  strip luff.
- **Buoyancy:** per-node Archimedes using the Gerstner **swell** sampler **only**
  (never the visual cascade/FFT — THE LAW), with a waterlog term so a downed mast
  floats briefly then sinks.

## Wake / sleep (the perf contract)

- **Asleep (default):** rig renders as the static mesh; the solver does not run.
  Every rig on every ship in normal sailing.
- **Wake triggers:**
  - a cannonball swept-segment hit — the existing `Ship.rigImpacts` test still
    finds the hit (cheap, works against rest geometry while asleep), but now
    resolves to "apply an impulse at the nearest node(s) + wake" instead of
    `puncture/hitSail/hitMast`;
  - a ram/topple contact;
  - a hull crush near a mast foot.
- **Sleep:** when kinetic energy stays near zero for ~1.5 s (a settled wreck on
  deck) or all nodes have sunk, the rig sleeps again (or the detached piece
  despawns like debris). Typically only 1–2 rigs are awake at once.

## Collision coupling — reuse `½·μ·v²`

When an **awake** node penetrates a hull voxel grid with closing speed `v`, call
the same energy-budget break used by `sim/crush.ts`: it spends `½·m·v²` breaking
the cheapest voxels in the path; the node sheds that momentum as the reaction.

- **Bowsprit ram:** the bowsprit is the one piece that stays "armed" even while
  asleep, **gated by the existing ship-ship proximity check** in
  `world.contact` / `game/voxelContact.ts` (so it costs nothing until two hulls
  are close). On contact it wakes and bores into the enemy hull — killing the
  phase-through.
- **Falling mast:** while awake it already tests against nearby grids, so it
  crushes its **own** deck or an **enemy** alongside on the way down, for free.

An anti-vaporize clamp mirrors `crush.maxStepEnergy` so a teleport-deep overlap
can't pulverize a whole hull in one step.

## Sails in detail

- Pinned top & bottom to yard nodes; wind bellies the intact sheet.
- A cannonball **severs the links it passes between** (replacing the alphaMap
  hole).
- Connected-component logic — the same idea as `sim/connectivity.ts` used for
  hull flooding — decides what is still attached: a region hanging by one yard
  **flaps**; a fully-severed region **detaches**, blows downwind briefly, then
  falls and sinks.
- **Drive feedback:** `sailIntegrity[mi]` becomes a *derived* readout = the
  fraction of cloth cells still pinned and catching wind, so `game/sailing.ts`
  keeps working unchanged (less canvas → less pull; a felled mast → 0).

## Files

**New**

- `sim/rigLattice.ts` — model + one-step solver + break rule (pure, tested).
- `sim/rigBuild.ts` — build a `Rig` from a `ShipBuild` (pure).
- `game/rig.ts` — per-ship runtime: wake/sleep, crush wiring, buoyancy.
- `render/rigVisual.ts` — node-driven spar + cloth meshes.

**Edited (surgical)**

- `game/ship.ts` — own a `Rig`; route `rigImpacts` → wake + node impulse; derive
  `sailIntegrity` from the lattice.
- `game/cannons.ts` — replace `puncture` / `hitSail` / `hitMast` calls with node
  impulses + wake.
- `game/voxelContact.ts` / `game/world.ts` — arm the bowsprit inside the existing
  ship-ship proximity gate.
- `render/shipVisual.ts` — remove the canned `fellMast` topple and the alphaMap
  puncture; hand rig drawing to `rigVisual`.
- `core/tunables.ts` — add a `TUN.rig` dev-panel group.

**Retired**

- the `t²` `fellMast` topple animation,
- the alphaMap puncture canvas,
- discrete `mastHp` / `sailIntegrity` decrement (now emergent).

## Determinism, testing, perf

- **Determinism:** fixed-step, Gerstner-swell-only buoyancy, deterministic wind
  → replay-safe; honors THE LAW (no cascade/FFT into physics).
- **Tests (vitest oracle):**
  - an over-strained link breaks; an under-strained one holds;
  - foot link removed → the trunk chain topples (foot node leads the fall);
  - a cloth column cut → connected-components returns two pieces;
  - a fast node spends its KE carving N voxels and stops (energy bound);
  - a settled rig (near-zero KE) sleeps after the timer.
- **Perf:** only awake rigs cost anything (~a few hundred nodes each); distant
  awake rigs run fewer relaxation iterations (LOD); the walkable-deck collider
  rebuild after a crush is **debounced** exactly like the existing crush path so a
  toppling mast doesn't thrash it.

## Tunables (`TUN.rig`, live dev-panel — not read by the vitest oracle)

Starting values to feel-test (like `TUN.crush`): `woodBreakStrain`,
`clothBreakStrain`, `relaxIters`, `verletDamp`, `windForce`, `wakeImpulse`,
`sleepKE`, `sleepTime`, `nodeBuoyancy`, `waterlogRate`, `maxStepEnergy`.

## Known tradeoffs / risks

- Tuning `breakStrain` so a mast "snaps dramatically but not from a stiff breeze"
  needs feel-testing via the `TUN.rig` panel.
- Cloth + crush interacting could cascade; the energy budget + an anti-vaporize
  clamp cap it.
- **Out of scope (v1):** rig-to-rig collisions (two masts striking each other) —
  only rig↔hull and rig↔sea are handled. Can be added later.

## Phasing (early playable wins first)

1. **Lattice core + tests** — `sim/rigLattice.ts` + `sim/rigBuild.ts`, pure, no
   rendering. Prove the rule with the oracle.
2. **Bowsprit as a spar with collision + crush** — fixes the #1 complaint (the
   ram phasing through) first, end-to-end.
3. **Masts wake-on-hit** — topple, break in half, crush decks.
4. **Chunky voxel cloth sails** — tear / detach / flap, replacing the alphaMap
   puncture; wire `sailIntegrity` derivation.
5. **Buoyancy + despawn for fallen rig, perf LOD, retire the canned
   `fellMast` / `puncture` paths.**
