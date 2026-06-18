# Flooding + cutaway rewrite — 2026-06-18 (round 8)

Ground-up rewrite of interior flooding after ~12 failed patch attempts. User mandate:
"Rip up the floorboards and put down your own." Tested on the live Vercel build, not localhost.

## Symptoms → root causes (verified in code)

| Symptom (user's words) | Root cause | Where |
|---|---|---|
| "It's syrup — water should slosh when she pitches" | Level clamp is in **ship-local** space, body parented under the hull group → surface tilts with the deck | `render/compartmentFluid.ts:96` |
| "Mechanical threshold for when it spills" | `equalizeFlooding` moves water once a hold is half-full (`SEEP_FILL_GATE=0.5`) — a fake rule | `sim/compartments.ts:223` |
| "White ballast / cutting into the void — bone-dry, only with X" | Cutaway leak: at grazing angles the sightline escapes the navy backdrop + abyss disc to the bright **sky** | `render/ocean.ts` cutout + `main.ts` abyss |
| "Looks flooded everywhere / segmented blocks" | One merged body at a single global level can't represent real per-hold water | `render/compartmentFluid.ts` |

The iron-emissive theory is dead: ballast iron is `[0.07,0.07,0.08]` (near-black navy); nothing inside
the hull is white in code. The white is the **sky leaking through the cut**, not a material.

## Goals (the user's mental model)

1. **Slosh.** Water surface stays world-horizontal; pools to the low end as she pitches/heels.
2. **Physical spill.** A few voxels removed from the **top** of each bulkhead. When a hold's level rises
   above that gap it overflows into the adjacent hold — no threshold, "it just wants to go there because
   it's water." One system that also covers shot-through holes.
3. **Simple look.** Calm-day ocean surface on **top** at the water level; **solid single color** below.
   "Where the water is is as simple as where the voxels aren't," bounded by the waterline + the hole.
4. **No white in the cutaway.** Below the waterline reads deep-blue solid water; above it, dark dry
   interior. "Anything solid stays solid, including water — just half of it not rendered."

## Design

### Part A — flood water render (`render/compartmentFluid.ts`, rewrite)
- **One solid body per compartment** (not one merged body). Each fills to its **own** world level.
- **World-horizontal level cut**: in the vertex shader, transform to world first, then
  `wp.y = min(wp.y, uWorldLevelY)`. Box built floor→(deckY + margin) so the clamp always forms a flat
  top even under heel. This is the slosh — the regression, reversed.
- **Per-compartment world level** comes from the sim's existing `poolY` (`ship.updateFloodGeom`),
  exposed to the render. No pose math duplicated in the shader beyond the clamp.
- **Look:** top slice (fragments at `≈uWorldLevelY`) gets the calm-day ocean surface stolen from
  `getOceanLook` — low reflection, gentle ripple. Everything below is solid navy, darkening with depth.
  Opaque (`transparent:false`, `depthWrite`, `DoubleSide`) so it cannot flicker; the solid body under the
  lid is what stops it reading as a lone "silk sheet" at grazing angles. Cutaway clip plane kept.
- Visible only where the opaque hull is open (shot holes + the cutaway), per compartment with water.

### Part B — compartment spill (`sim/shipwright.ts` + `sim/compartments.ts` + `game/ship.ts`)
- **`stampBulkheads` gains a top gap**: stamp `y < deckY - GAP` (GAP ≈ 2–3 voxels), leaving the top open.
- **Detect-before-carve**: `findCompartments` runs on FULL bulkheads (holds stay separate, watertight →
  real trim + survivability), THEN the gap voxels are carved (visible slot, walkable).
- **Sill overflow replaces `equalizeFlooding`** (deleted with its constants): each adjacent pair gets an
  opening at the gap's local-Y sill. `floodStep`'s opening loop becomes sill-aware — flow only when a
  hold's fill level rises above the sill, `sign(Δh)·Cd·A·√(2g·|Δh|)` on the over-sill heads. Shot-through
  bulkhead openings (`registerBreaches`) reuse the same opening type with `sillY` = the hole's y.
- Pure, deterministic, mass-conserving. One rule for designed gaps AND battle damage.

### Part C — cutaway white (`render/ocean.ts` + `main.ts`)
- Below the external waterline the cutaway must read **solid deep-blue, no escape to sky**. Close the
  backdrop/abyss so no grazing sightline through the cut reaches the sky; ensure the keel cross-section
  caps solid (no holes). Above the waterline, the dark dry interior shows as today.
- Not browser-verifiable by this agent (user keeps me out of Playwright) → make it robust by
  construction; the user confirms the white is gone on the live build.

## Invariants (must hold)
- `sim/` stays deterministic — update the vitest oracle; no `Math.random`/wall-clock in sim.
- THE LAW: (1) physics rides only analytic Gerstner swell; (2) attitude emergent from voxels;
  (3) leeway drag at COM; (4) destruction is one energy rule. None of this touches them.
- Develop on `main`; `npm run build` (tsc) + `npm run test` green; commit + push before the user tests.
- Stage only own paths (never `git add -A`); a concurrent agent shares the working dir.

## Risks
- Calm-ocean top could re-introduce the "silk sheet" → keep reflection low; the solid body below is the
  guard. Tunable down if needed.
- Per-compartment world levels can show a step at a bulkhead when fills differ — that is physically
  correct (the user WANTS to see the spill); it equalizes once overflow runs.
- Part C is the one I cannot pixel-verify; treat as robust-by-construction + user verification.
