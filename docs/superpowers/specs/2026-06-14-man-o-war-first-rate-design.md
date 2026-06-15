# Man-o'-War (first-rate) — a bigger ship class — design

_Status: approved (design phase). Date: 2026-06-14. Branch: `feat/ship-of-the-line`. Next: implementation plan (writing-plans)._

## Goal

Add a third, **much larger** ship class to SCUTTLE — a three-gun-deck **first-rate man-o'-war**,
modeled on the *Sovereign of the Seas* (English, 1637) — built with the **same procedural-voxel
design principles** as the existing sloop and brig (`src/sim/shipwright.ts`). She becomes a
**player-sailable flagship**: a real step up in size, firepower, and presence from the brig.

## Reference (real ship)

*Sovereign of the Seas* (1637) — the first warship with three full gun decks:

| | Real ship | This class (game-scaled) |
|---|---|---|
| Gun-deck length | 51 m | ~50 m |
| Beam | 14.6 m | ~14 m |
| Depth in hold | 5.9 m | ~5 m (keel → lower gun deck) |
| Gun decks | 3 | **3 firing tiers** |
| Guns | ~100 | **44 broadside + 4 chasers = 48** |
| Rig | 3 masts, full-rigged | **3 masts + bowsprit** |

The brig is deliberately a "realistically sized" 34 m vessel, so this class is scaled to keep
that proportion — ~50 m reads as *huge* next to her without ballooning the voxel grid. Sources:
[Sovereign of the Seas (Wikipedia)](https://en.wikipedia.org/wiki/English_ship_Sovereign_of_the_Seas),
[Rated Navy ships, 17th–19th c. (RMG)](https://www.rmg.co.uk/stories/maritime-history/rated-navy-ships-17th-19th-centuries),
[Vasa (Wikipedia)](https://en.wikipedia.org/wiki/Vasa_(ship)).

## Motivation

- The sea has two hull *shapes* (sloop, brig). A genuinely bigger third class — a towering
  three-decker — is the most impressive single thing a naval demo can show.
- It exercises the engine's generality: `Ship` (`src/game/ship.ts`) derives mass / COM / inertia
  / buoyancy / flooding entirely from the voxel grid, so a new `ShipBuild` is a new ship with
  **no change to the simulation core** — this feature proves that.
- A flagship the player can earn/captain is the natural payoff for the roguelite's progression
  ("M5 the run"); this lays the hull groundwork even though the *economy* to earn her is out of scope.

## Scope

**In:**
- A new `buildManOfWar(): ShipBuild` in `src/sim/shipwright.ts`, alongside `buildSloop`/`buildBrig`,
  leaving both existing (delicately tuned) hulls **untouched**.
- **Three gun decks** (lower / middle / weather), each with a real broadside battery, plus
  **bow chasers and stern chasers** (front and back guns, exactly like the sloop and brig).
- A **raised quarterdeck aft** (helm + great cabin) and a **forecastle forward**, both via `deckYAt(x)`.
- **Emergent** flotation: iron ballast tuned live so she floats level at draft ≈ 0.45 with a
  **positive metacentric height** (she must not turtle — THE LAW #2). A stability test guards this.
- **Player-sailable**: she handles like a flagship (ponderous, momentum-heavy) after a light
  sailing/helm/camera tuning pass.
- A **dev-panel ship-class selector** so the player can switch between the brig and the man-o'-war
  (brig stays the default; today's behavior is unchanged unless you flip it).
- Tests: a `manOfWar.test.ts` mirroring `brig.test.ts` / `draft.test.ts` / `stability.test.ts`.

**Out (YAGNI):**
- **Independent by-deck firing.** A full broadside fires all three port (or starboard) tiers at
  once — the iconic image, and it falls out of the existing firing code for free. Firing one deck
  at a time would need a deck index in the battery key; not now.
- **An economy / progression to *earn* her.** The selector swaps the player ship; "buy/capture
  the flagship mid-run" is M5, separate.
- **Enemy man-o'-war / fleet of them.** The fleet system (`docs/.../multi-ship-fleet-design.md`)
  spawns `buildSloop` enemies; this class is the player flagship only. (The build fn is generic,
  so a future pass *could* hand her to the AI, but that is not wired here.)
- **Bowsprit/spritsail as a rigged, load-bearing spar.** A bowsprit may appear as visual rigging;
  the `masts` array stays three vertical masts (consistent with the current `ShipBuild` + the
  concurrent voxel-masts work).
- **Poop deck / full great-cabin interior fit-out.** The quarterdeck encloses a walkable great
  cabin (for the stern chasers); no furniture.

## The build pattern she follows (unchanged principles)

Identical to `buildSloop`/`buildBrig`: analytic curves → rasterized voxel shell → iron ballast →
transverse bulkheads → gun ports → bulwark fence with embrasures → grated hatches → masts →
`armorBow` → `weldToSingleComponent` → compartment + leak audit → return a `ShipBuild`. Every
field of the `ShipBuild` interface (`shipwright.ts:13`) is produced the same way; nothing in
`Ship`, `cannons`, `sailing`, `world`, or the buoyancy oracle needs to learn about her.

### Dimensions (VOXEL_SIZE = 0.25 m)

```
nx = 208, ny = 54, nz = 60          grid ≈ 674k cells (~2.4× the brig's 281k)
x0 = 4        stern transom station (low x = AFT, bow at HIGH x — brig convention)
L  = 200      gun-deck length → 50 m
halfBeamMax = 28 → beam 14.0 m;  cz = (nz-1)/2 = 29.5
```

Vertical layout (voxel y; ×0.25 = metres):

```
keel rocker .... y ≈ 2–8   (egg-section bottom, deepest amidships)
lower gun deck . y = 20     (~5.0 m)  guns at the waterline belt — heaviest tier
middle gun deck  y = 28     (~7.0 m)
weather deck ... y = 36     (~9.0 m)  the open main deck (this is ShipBuild.deckY)
quarterdeck/    y = 44      (~11.0 m) raised one ~2 m story, aft AND forward (forecastle)
  forecastle
cap rail ....... y ≈ 48     (~12.0 m) tall, dry topsides — a true high-charged first-rate
```

### Hull form

Same **egg section** (widest at ~62% of depth, rounded narrow bottom, tumblehome above) and
**fuller-aft plan** as the brig, scaled up. The keel-rocker and half-beam curves are the brig's,
re-tuned for the larger envelope. `deckYAt(x)` returns the **raised level at *both* ends**: the
aft quarterdeck (low x, helm + great cabin) and the forward forecastle (high x), with the open
weather deck in the waist between them — the classic ship-of-the-line silhouette. The singular
`ShipBuild.quarterdeck` field reports the **aft break** as today (no external consumer reads it
beyond reporting; `deckYAt` is the abstraction everything uses — verified: mast feet, helm,
boarding spawn, ladders all call `deckYAt`).

### Armament — three firing tiers + chasers

The key insight: `Cannons.fireBroadside(ship, key, …)` (`cannons.ts:118`) fires **every loaded
gun that bears for `key`, regardless of its height**. So placing ports at three y-levels with the
same `side` makes **all three tiers fire together as one broadside** — no change to `cannons.ts`,
`gunnery.ts`, or the aim arc. This is both the authentic full-broadside and the simplest code.

Ports (each entry is `{x, y, z, side, facing?}` per `ShipBuild.cannonPorts`):

- **Lower gun deck** — 8 per side, `y ≈ 21`, **framed openings in the side shell** (the shell
  voxel stays solid; the r17 framed-gunport render at `shipVisual.ts:587` draws the port and the
  barrel pokes through). Heaviest guns, at the belt.
- **Middle gun deck** — 8 per side, `y ≈ 29`, same enclosed framed-port treatment.
- **Weather deck** — 6 per side, `y = deckY+1 ≈ 37`, **behind bulwark embrasures** exactly like
  the brig's waist battery (the fence leaves gaps for the barrels).
- Broadside total: **(8 + 8 + 6) × 2 = 44 guns.**

**Front and back guns (explicit — like the sloop and brig):**
- **2 bow chasers** — `facing: "fore"`, firing forward from under the **forecastle** (high x),
  mirroring the brig's pair (`shipwright.ts:543`).
- **2 stern chasers** — `facing: "aft"`, firing aft from the **great cabin** under the quarterdeck
  (low x), mirroring the brig (`shipwright.ts:545`).

Grand total **48 guns**. Ports per side are placed with the same `Math.floor(cz)+hb` /
`Math.ceil(cz)-hb` split the brig uses so the two batteries are **exactly symmetric** about the
true centerline.

### Rig — three masts

`masts: [{x, z, h}]` on the centerline (bow at high x):

```
mizzen  x ≈ x0 + 0.22·L   h ≈ 22   (aft)
main    x ≈ x0 + 0.48·L   h ≈ 32   (tallest)
fore    x ≈ x0 + 0.74·L   h ≈ 26   (forward)
```

Heights scale up from the brig's 21/18. A bowsprit is visual-only rigging (out of scope as a spar).

### Ballast & stability (emergent — THE LAW #2)

Three gun decks are a lot of top-weight. As with the brig, iron ballast goes in **deep z/t-bands
following the fuller-aft center of buoyancy** — but more of it, in more tiers, tuned **live** in the
dev panel until:

- draft ≈ **0.45** of hull depth (tall dry topsides, not awash),
- the COM sits **well below** the center of buoyancy → **positive metacentric height** (stiff, she
  rights herself), and
- fore-aft COM↔COB gap ≈ 0 → **level trim** (no bow/stern lean).

The numbers are **not hard-set**; we tune mass/placement until the right attitude *emerges*. The
*Vasa* (1628) capsized on her maiden voyage from exactly this failure — too tall, too little low
ballast — so this class gets a **stability test asserting positive GM** (she must not turtle) in
addition to the draft/level checks.

### Player integration

- **Sailing/handling:** she carries more sail (three masts) → more driving force, but ~3× the
  brig's mass → ponderous acceleration and momentum-heavy, wide turns. The rudder authority and
  sail-force scaling get a light tuning pass so she *feels* like a flagship (powerful but
  unwieldy), not a sluggish brig. All emergent from mass + rudder lever; no scripted motion.
- **Helm:** `wheelM` on the quarterdeck aft (`x ≈ x0 + 0.08·L`), y from `deckYAt`.
- **Camera:** the chase camera may need a slightly larger standoff for the bigger hull — a small
  constant tweak, verified in-browser.
- **Ocean sea-cut:** the player hull's footprint drives the ocean cutaway
  (`main.ts:135` — keyed to `build.grid`); swapping the player build regenerates the profile
  texture automatically. No shader change (the cut samples whatever grid it's given).

### Ship-class selector

`main.ts:131` builds the player ship via `buildBrig()`. Add a `TUN.player.shipClass`
(`"brig" | "manOfWar"`, default `"brig"`) and a dev-panel dropdown; `main.ts` picks the builder
from it. Default unchanged → shipped behavior identical until you flip the selector. (Runtime knob,
not read by the deterministic oracle — consistent with `tunables.ts`.)

## Build-code structure

Approach **A** (chosen): `buildManOfWar` is **standalone**, leaving the two tuned hulls untouched.
The sloop and brig already duplicate several **mechanical, untuned** passes; extract just those into
small shared helpers that the new ship (and, opportunistically, the existing ones if it's risk-free)
can call — **without** touching the tuned curves or ballast:

- `rasterizeShell(grid, inside, deckPlanes)` — OAK shell + PINE deck rule.
- `bulwarkFence(grid, inside, deckYAt, { embrasureXs, skipZs })` — toe course / cap rail / posts
  with embrasures (the brig's fence logic, parameterized by which deck level).
- `leakAudit(grid, inside, compartments, deckY)` — the interior-leak check both ships run verbatim.

The **tuned** parts — `keelY`, `halfBeam`, `sectionHalfBeam`, and the iron ballast bands — stay
**bespoke and inline** per hull (they are the emergent-attitude tuning; THE LAW #2). This removes
duplication where it is safe and keeps the delicate physics isolated. Rejected: a full
`buildHull(config)` refactor (Approach B) — it would rewrite the two already-tuned hulls and risk
capsizing them for no benefit to this feature.

## Data flow (unchanged core)

A `buildManOfWar()` `ShipBuild` flows through the exact existing path: `new ShipVisual(build)` →
`new Ship(physics, build, visual, spawn)` → `world.addShip(ship)`. `Ship` computes mass/COM/inertia/
columns from the grid; `world.step` runs buoyancy/flood/forces per ship; `Cannons` reads
`build.cannonPorts`; `ShipVisual` meshes the grid + renders carriages/barrels/framed gunports/masts/
helm. The only new wiring is the **selector** choosing the builder and the **handling tune**.

## Testing

- **`tests/manOfWar.test.ts`** (deterministic, no GPU), mirroring the existing ship tests:
  - **Single 6-connected solid** after `weldToSingleComponent` (no floating internals) — like `weld.test.ts`.
  - **Zero interior leaks** (`interiorLeaks` empty) — every below-deck air region is a compartment.
  - **Symmetric batteries** — for each broadside row, the port/starboard ports mirror about `cz`.
  - **Chasers present** — ≥1 `facing:"fore"` and ≥1 `facing:"aft"` port (front/back guns exist).
  - **Three gun-deck tiers** — broadside ports occupy three distinct y-levels.
  - **Floats level** — via `buildHullProfile`/buoyancy oracle: draft within ~0.40–0.50, fore-aft
    trim ≈ 0 (like `draft.test.ts`).
  - **Positive metacentric height / no turtle** — COM below COB; righting moment positive at small
    heel (like `stability.test.ts`). This is the *Vasa* guard.
- **In-browser (Playwright + readback, per `CLAUDE.md`):** select the man-o'-war; confirm she
  floats level with tall topsides, renders three tiers of gunports, fires a full triple-tier
  broadside, the bow/stern chasers bear, and no sea-through-deck artifact on the bigger footprint.
  Screenshots land in the projects root.
- **Regression:** the ~115 existing tests stay green (default selector = brig → today's behavior).

## File-by-file change list

- `src/sim/shipwright.ts` — **new** `buildManOfWar()`; extract `rasterizeShell` / `bulwarkFence` /
  `leakAudit` helpers (used by the new ship; existing hulls untouched unless retrofit is risk-free).
- `src/render/shipVisual.ts` — ensure carriages + barrels + the r17 framed-gunport window render
  correctly for **interior-deck** broadside ports (today the framed port is used for chasers; the
  three-tier broadside reuses it). Mast/helm placement already generic via `deckYAt`/`wheelM`.
- `src/core/tunables.ts` — `player: { shipClass: "brig" }`; any handling knobs the tune needs.
- `src/render/devPanel.ts` — ship-class dropdown (`brig` / `manOfWar`).
- `src/main.ts` — pick the player builder from `TUN.player.shipClass`; light camera-standoff tweak.
- `src/game/sailing.ts` (+ `ship.ts` if needed) — flagship handling tune (sail force / rudder
  authority scale with the larger hull) — **emergent**, no scripted clamps.
- **new** `tests/manOfWar.test.ts` — the checks above.

## Accepted simplifications (recorded so they aren't "bugs" later)

- A side's whole broadside (all three tiers) fires **together**; no by-deck fire control.
- The man-o'-war is the **player** flagship; enemies remain `buildSloop` (fleet system unchanged).
- **48 guns** (44 broadside + 4 chasers) is the game-scaled count, not the historical ~100 —
  chosen for clarity and a sane carriage/reload-timer budget (~3.4× the brig).
- Bowsprit and poop deck are visual/omitted; the rig is three vertical masts.
- The ~674k-cell grid (~2.4× the brig) is a one-instance player-ship cost; acceptable, watched
  in the in-browser pass.
