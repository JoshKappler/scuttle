# Round 12 Pacing Audit (Agent D, Task 7)

> Verified against source at the point Task 6 landed (commit `e474445`, on top of round-12 waves 1 + D tasks 1-6). Every number below was re-derived from the live constants — quoted line numbers may drift; the values are what to trust. **Decision: apply ZERO `TUN` nudges.** Rationale inline per section; the summary is at the bottom.

## 1. Cruise speed vs. the world

Calm-water full-sail equilibrium (from `tests/helpers/yawHarness.ts` `CRUISE`, itself the closed-form
solve of the real constants: `0.019·wind² = 0.04·(1+0.08v)·v·sub + 0.02·v`, wind = 7 m/s at
`main.ts:433`, `sub` = rest submerged fraction at `buoyancy=1.5`):

| tier | cruise m/s | knots | rest sub frac (×1.5 buoyancy) | envelope volume m³ | compartments |
|---|---|---|---|---|---|
| Cutter | 17.7 | 34.4 | 0.377 | 215.1 | 8 |
| Sloop | 20.3 | 39.5 | 0.266 | 449.8 | 9 |
| Brig | 18.5 | 36.0 | 0.311 | 1241.7 | 10 |
| Frigate | 19.6 | 38.1 | 0.272 | 2113.8 | 11 |

(Envelope volumes and compartment counts confirmed by executing `buildCutter/buildSloop/buildBrig/buildFrigate` directly — `grid.dims` matched the round-12-D plan's table exactly, so wave 1 did not touch hull geometry.)

**Finding:** code comments elsewhere (`sailing.ts:86-88`) still say full sail keeps her "in the low-20s of knots" — that's stale; actual cruise is 34-40 kn across every tier (2× the claimed figure). This is a comment-drift finding, not a behavior bug — flagged for a future doc pass, not fixed here (out of this plan's owned files' scope to go comment-hunting outside `ship.ts`/`sailing.ts`/`tunables.ts`, and the two lines I *do* own there don't make this claim).

**World scale:** archipelago radius `FIELD_M=1400`, spawn lagoon `LAGOON_M=150`, harbor `320-460` m from spawn (`HARBOR_MIN/MAX`, `islandField.ts:31-32`) — 17-25 s of sailing at cruise. 8 wild islands sized in buckets `[28,45]/[45,66]/[66,93]` voxel-radius (`WILD_R_MAX = floor(HARBOR_R/1.6)`), rejection-sampled with a 50 m minimum edge gap (`+50` in the spacing check, `islandField.ts` wild-island loop) plus 12 sea stacks (`TUN.hazard.seaStacks: 12`) at a tighter 4-16 m gap. `M_PER_VOX = VOXEL_SIZE·ISLAND_VOXEL_SCALE = 0.25·4 = 1.0` confirmed.

Full-field diameter (2800 m) at frigate cruise (19.6 m/s) ≈ 2.4 min corner-to-corner; harbor-to-field-edge ≈ 1.5-2 min. **Verdict: island density reads fine at the current speed** (open water between clusters, not empty ocean); the *absolute* scale reads a little small for genuinely 34-40 kn hulls — a fast ship can clear the whole named archipelago in a couple of minutes. This is a **structural, deferred** option (scale `FIELD_M`/island count in `islandField.ts`, or retune the inline `0.019` thrust constant in `sailing.ts`) — not something to nudge blind without playtest data, and SP3's own turn-time fix (below) is the round's actual pacing lever.

## 2. Enemy spawn distance

Fleet spawn ring `R = 105` m ahead of the player (`main.ts:474`, frozen file — read-only here). Gun
range: muzzle 150 m/s with quadratic drag 0.0025/m (`TUN.gun`) — a flat-ish shot at low elevation
carries on the order of 200-300 m before the arc drops it into the water, with the max lofted range
(higher elevation, more hang time before the drag bleeds it) reaching further still. Either way,
105 m sits comfortably inside effective range at spawn: **combat opens immediately**, matching the
in-code comment's stated intent ("a broadside's reach out"). No change — and it's a frozen file
(`main.ts`) regardless.

## 3. Reload cadence vs. the SP3 retune

Player battery: `Cannons.RELOAD = 6` s (`cannons.ts:48`), scaled by the reload upgrade
`reloadMul = 0.88^level` (`port.ts:315`, -12%/level). AI battery: a flat 9.5 s, no upgrade path
(`ai.ts:41` — `new Cannons(scene, effects, 9.5)`), confirming enemies reload markedly slower than
the player by design (`ai.ts` comment: "deliberately WORSE than yours"). Ripple spread across a
broadside: `TUN.gun.broadsideSpread = 1.6` s (guns fire in sequence, not simultaneously).
Broadside weight confirmed by reading `shipwright.ts`'s `portXs` arrays directly: **2/4/5/6 guns per
side** (Cutter/Sloop/Brig/Frigate) + **2/4/6/8 bow+stern chasers** (both counts monotonic with tier,
as the in-code comments describe each pass).

Time between effective broadsides is therefore reload (6-9.5 s) plus whatever repositioning it takes
to bring the guns back to bear — and **that repositioning time is exactly what SP3 just cut**:
full-rudder time-to-90° dropped from 7.2 s (Brig) / 9.7 s (Frigate) pre-round-12 to 4.5 s / 5.5 s
post-round-12 (`tests/turnRate.test.ts`). A big-ship broadside-to-broadside cycle used to be
dominated by the turn, not the reload; now the two are comparable. **This retune is the pacing fix
for this axis — no separate reload nudge is warranted.**

## 4. Time-to-kill (rough, from the real bore-energy budget)

Ball kinetic energy at the muzzle: `½·mass·v² = ½·4.3·150² = 48,375 J`, scaled into a break budget
by `TUN.gun.crushEfficiency = 13` → ≈629 kJ of "budget" for the carve to spend cheapest-first
(`sim/crush.ts`, THE LAW #4 — one destruction rule, no scripted damage). Oak cell break energy =
`strength(3) × STRENGTH_TO_JOULES(5000) = 15,000 J/cell` (`sim/materials.ts`); reinforced bow armor
(RAM, strength 4.5) = `22,500 J/cell`. So a fresh muzzle-energy hit on oak bores on the order of
`629,000 / 15,000 ≈ 42` cells before the budget (and velocity, which bleeds via drag over range) runs
out — call it a fist-sized hole clean through a wall into the hold at close range, shrinking as drag
eats the ball's KE with distance (a ball arriving at ~⅔ muzzle speed by mid-range carries roughly
4/9 the KE, so more like a dozen cells — one wall, not a clean through-shot).

A below-the-waterline hit that opens N cells feeds `TUN.flood.inflowScale(0.5) × N ×
√(2g·depth)` m³/s of inflow (`sim/compartments.ts floodStep`) against a pump capacity of
`TUN.flood.pumpRate = 0.3` m³/s (the AI never pumps). A handful of cells is pump-survivable; a wide
gash outpaces it — consistent with `founderSubmerge = 0.6` gating the actual sinking stage on lost
reserve buoyancy, not a single lucky hit.

Rough ladder across the verified compartment counts (Cutter 8 holds / 215 m³ envelope up to
Frigate 11 holds / 2114 m³ envelope): a small hull settles in a couple of well-placed low
broadsides; a Frigate needs several times the total flooded volume and proportionally more holes
before reserve buoyancy is gone. This is a coherent, monotonic tier ladder with the existing
numbers — **no gun/flood constant is obviously out of line, and none should move without
playtest data** (`TUN.gun`/`TUN.flood` are both live dev-panel knobs already, so any future
retune doesn't need a code change — it needs play data first).

## 5. Escalation rate

`sim/fleetSpawn.ts` (frozen — read-only): `threatLevel = min(notoriety/120 + tierIndex·0.25, 3)`.
Confirmed divisor is still 120 (unchanged by wave 1). This is the CLAUDE.md-flagged "balance pass"
follow-up, not part of SP3's mandate, and the file isn't in this plan's owned set — deferred, as
already tracked.

## Nudges applied: none

Every pacing lever inspected sits in one of three buckets:
1. **A frozen file** (`main.ts` spawn ring, `sim/fleetSpawn.ts` escalation divisor, `game/ai.ts`
   reload) — not owned by this plan.
2. **An already-played-in value** (`TUN.gun`, `TUN.flood`) with no evidence from this audit that
   it's mistuned — the derived TTK/flood-rate ladder is coherent across tiers.
3. **The one thing that WAS the bottleneck** — turn/reposition time on the big hulls — and SP3
   (Tasks 1-4 of this plan) already fixed it: Brig/Frigate time-to-90° cut by ~35-45%.

"At most 2-3 conservative nudges" is satisfied by zero: twiddling gun/flood/spawn numbers without
play data is *riskier* than leaving them, and the one number this audit had hard evidence for
moving (turn time) was already this plan's Task 2-4 work, not a new finding.

## Deferred list (structural, out of this plan's scope)

- World scale vs. actual 34-40 kn cruise speed (`islandField.ts` FIELD_M / island count, or a global
  thrust retune in `sailing.ts` — both bigger changes than "a nudge").
- Spawn-ring `R=105` (`main.ts`, frozen — owned by whichever future plan next touches main.ts).
- Escalation divisor 120 (`sim/fleetSpawn.ts`, already tracked in CLAUDE.md's open follow-ups).
- Stale "low-20s of knots" comment in `sailing.ts` (cosmetic — didn't touch it here since fixing it
  isn't a pacing change, just a comment correction; noting it so a future pass catches it).
- Optional dev-panel slider for the new `TUN.phys.rudderLeverExp` (main.ts owns the dev panel —
  hand-off note, see the Task 4 commit / this plan's interface contract).
