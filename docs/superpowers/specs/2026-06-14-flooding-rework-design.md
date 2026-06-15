# Flooding rework — head-driven flow, waterline equilibrium, fluid surface

_Design spec — 2026-06-14. Branch `dev/flood-rework` (isolated worktree). Do **not** push to `main`._

## Problem

The current flooding model produces three wrong behaviours the player flagged:

1. **Fills to 100%, then sinks fast.** `breachInflow(area, depth)` is single-tank Torricelli —
   it depends only on how deep the hole is below the *external* sea surface and caps fill at the
   full compartment volume. Any underwater hole therefore floods the whole compartment regardless
   of the water already inside. There is no equilibrium, so a holed hull slowly maxes out and then
   falls off the `waterlog`/buoyancy cliff all at once.
2. **Capsized water stays trapped.** `floodStep` only ever *adds* breach inflow or *exchanges*
   between compartments by fill-fraction. Water can never leave through a breach, so a flipped or
   heavily-heeled hull keeps every drop.
3. **Blocky "light blue voxels."** `render/compartmentFluid.ts` stacks translucent cubes; the top
   surface is a stair-step that reads as jello, not fluid.

## Goal

A holed ship should **settle to an equilibrium at the waterline and usually survive**, listing as
the floodwater shifts; **water should drain back out** when a breach ends up above the pool (heel,
capsize, over-fill); and the flooded water should **look like a real fluid surface**. She should
only *founder* from severe or progressive damage (deep breaches, multiple compartments, downflooding
through deck hatches), not from a single waterline nick.

Determinism is preserved: physics still samples only the analytic Gerstner swell; `floodStep` stays
a pure, deterministic integrator for the vitest oracle.

## Core idea — the two-reservoir submerged orifice

Stop treating a breach as a hole into the open sea. Treat it as an orifice between **two
reservoirs**: the sea (free surface `seaY` at the hole's x,z) and the compartment's own rising
**pool** (world-horizontal free surface `poolY`). Per hole, with the hole centre at world height
`holeY`:

```
extHead = max(0, seaY  − holeY)     // sea covering the hole
intHead = max(0, poolY − holeY)     // internal pool covering the hole
Q       = sign(extHead − intHead) · Cd · A · √(2·g·|extHead − intHead|)   // m³/s, + = inflow
```

`Cd ≈ 0.6` (sharp-edged hole). This single signed formula gives, for free:

- **Decelerating fill that stops at the waterline** — as `poolY → seaY` the driving head → 0
  (equilibrium). A waterline nick fills only to the hole's level; a deep breach fills until the
  internal level reaches the sea level (which, for a compartment wholly below the waterline, means
  it fills completely — correctly more dangerous than a nick).
- **Outflow / drain** — when the pool tops the sea at the hole (`intHead > extHead`) `Q` goes
  negative and water leaves. Fixes the "trapped when flipped" bug.
- **Wetness gate** — hole above both surfaces ⇒ `extHead = intHead = 0 ⇒ Q = 0`. Heeling to lift a
  breach clear of the sea genuinely slows the leak (emergent damage control).

The same function drives **inter-compartment openings** and **deck hatches**: each is just an
orifice with a head from each side (`poolY − openingY`).

## Architecture — who computes what

`game/world.ts` already calls, per fixed step: `ship.updateFlooding(dt, swell, t)` then
`ship.applyForces(swell, t)`. We keep that seam.

### `sim/compartments.ts` — pure deterministic integrator (the oracle)

Replace `breachInflow(area, depth)` with a signed two-reservoir orifice:

```ts
export function orificeFlow(area: number, extHead: number, intHead: number): number {
  const e = Math.max(0, extHead), i = Math.max(0, intHead);
  const dh = e - i;
  if (dh === 0) return 0;
  return Math.sign(dh) * DISCHARGE * area * Math.sqrt(2 * 9.81 * Math.abs(dh));
}
```

Breach inputs carry **already-resolved heads** (so `floodStep` needs no world transform and stays
deterministic):

```ts
export interface BreachInput { compartmentId: number; area: number; extHead: number; intHead: number; }
```

`floodStep(compartments, openings, breaches, dt)` (signature unchanged):
- breaches: `c.waterVolume = clamp(c.waterVolume + orificeFlow(area, extHead, intHead)·dt, 0, c.volume)`
  — note the **lower clamp at 0**, which is the drain path.
- openings: kept exactly as today (fill-fraction-difference exchange, `EXCHANGE_HEAD_SCALE`). The
  inter-compartment path is **not** broken — only the sea↔compartment breach path needed the
  two-reservoir rule — so reworking openings to head-driven flow is deliberately out of scope here.

### `game/ship.ts` — attitude-aware head resolver + free-surface weight

`updateFlooding` gains a **pool-geometry pass** (only for compartments that hold water or have a
breach/opening — usually none, so normally skipped):

- For each such compartment compute, under the current body pose, the **world-horizontal pool**:
  rank its interior cells by world-Y (reuse the renderer's "rotated-y only" trick), take
  `wetCount = round(fill·n)` lowest; `poolY` = world-Y of the highest wet cell; cache the wet-cell
  **local centroid** for the weight pass. Throttle/cache: recompute only when fill or attitude
  changed materially (same tilt-key idea as the renderer); skip dry compartments entirely.
- Per breach **cell** (not aggregated — a low hole floods while a high hole drains): resolve
  `seaY = surfaceHeight(swell, hx, hz, t)`, `extHead`, `intHead`; push one `BreachInput`
  (`area = VOXEL_SIZE² · flood.inflowScale`). Hatches: one input at the coaming-lip height (two-way —
  floods in when the sea tops the coaming, drains out the same lip when she rolls it under).
- Call `floodStep` (openings still handled inside it, fill-fraction-driven, unchanged).
- **Founder trigger retie:** today `waterlog` ramps when total fill > 0.9. Re-tie it to **loss of
  reserve buoyancy** — ramp only when `this.submergedFrac` (last step's) exceeds
  `flood.founderSubmerge` (≈0.6, i.e. she's lost most of her freeboard). With equilibrium in place a
  single nick never reaches this; only progressive/severe flooding does. Keeps "settle & survive."

`applyForces` flood-weight loop (currently one lumped force at the *geometric* centroid) moves the
floodwater weight to the cached **wet-cell centroid** (which pools to the low side). This is the
free-surface effect: the shifting mass produces the destabilising low-side moment, so list — and
asymmetric-flood capsize — *emerge* from the existing per-voxel solver. Net magnitude unchanged
(`waterVolume·ρ·g` down).

### `render/compartmentFluid.ts` — animated fluid surface + foam

Keep the wet body as instanced cubes (cheap depth/occlusion, mostly hidden), but **replace the
visible top with a world-level animated surface**:

- Identify **surface cells** = wet cells within ~1 voxel of `poolY`. Render them as an
  `InstancedMesh` of up-facing tiles placed at **world height `poolY`** with **world-up orientation**
  (per-instance inverse-rotation of the ship pose, so the surface stays level as she heels — the
  whole point, since flooding *causes* heel). Footprint-exact by construction (tiles only where wet
  cells are), so no stencil/clip-plane work.
- Material: ocean-matched translucent water with `onBeforeCompile` adding scrolling sine-ripple
  normal perturbation (animated specular) and a **foam line** at footprint-edge tiles (per-instance
  `aEdge` attribute, animated noise threshold). Advance `uTime` each frame.
- Recompute throttled exactly as now (tilt-key + fill delta). Water is **not** clipped by the
  cutaway plane — we want to see it in cutaway and through breaches.

## Tunables (`core/tunables.ts → TUN.flood`)

- keep `inflowScale` (0.15) — breach-area → flow-rate pacing knob (already scales the rate linearly,
  so a separate `Cd` tunable is redundant; the oracle's `Cd = 0.6` stays a fixed constant).
- add `founderSubmerge` (0.6) — submerged-fraction past which reserve buoyancy is "gone" and
  `waterlog` ramps to the final plunge (with hysteresis: recovers below 0.7× it if drained/pumped).

## Tests (`tests/compartments.test.ts`)

Rewrite around `orificeFlow` + the new inputs:
- inflow grows with external head; **equal heads ⇒ zero** (equilibrium); **intHead > extHead ⇒
  negative** (outflow); both ≤ 0 ⇒ zero (dry gate).
- `floodStep`: a breach with `extHead>0, intHead=0` adds water, clamped to capacity; a breach with
  `intHead>extHead` **drains** but never below 0; equilibrium step is a no-op.
- openings equalise by head and conserve mass.
- keep "sealed compartment stays dry" / "never exceeds capacity".

## Out of scope (future)

Permeability `μ` per compartment type; shallow-water/height-field sloshing waves; SPH; bulkhead
subdivision as an upgrade. The free-surface-effect capsize lever already emerges; tuning compartment
layout for it is a later pass.

## Files

`sim/compartments.ts`, `game/ship.ts` (`updateFlooding` + flood-weight loop), `render/compartmentFluid.ts`,
`core/tunables.ts`, `tests/compartments.test.ts`.

## Verification

`npm run test` (oracle green) + `npm run build` (tsc — vitest does not type-check). Then in-browser
at `:5173` via Playwright: hole a ship, confirm it settles & lists rather than instant-sinks; heel/
capsize and confirm water drains; eyeball the fluid surface + foam. (User feel-tests at home.)
