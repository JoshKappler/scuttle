# SCUTTLE — Tycoon Game Layer — Design Spec

**Date:** 2026-06-14
**Status:** Approved by user (brainstorming session 2026-06-14); user authorised autonomous implementation
**Branch:** `dev/tycoon-game-layer` (worktree off `main`)
**Supersedes:** the roguelite/leaderboard framing of `2026-06-12-scuttle-design.md` *for the game-loop layer only*. The sim/physics/ocean/destruction foundations from that spec and the consolidated build stand unchanged.

---

## 1. Context & goal

SCUTTLE today is a beautiful, physically rich **demo without a game**: per-voxel ship physics, ship-to-ship cannon combat against AI, flooding/sinking, a voxel archipelago with a harbour, and a working dock→port economy framework — but it boots straight into a sandbox with no menu, no structure, no goals, no persistence, and a vestigial on-foot **boarding** system left over from a much earlier design.

This spec turns the demo into a **structured open-world pirate tycoon**: sink ships → earn gold → make port → repair / upgrade / buy bigger ships → sail out stronger against tougher prey. It adds the missing game shell (start menu, modes, pause, save), a real upgrade tree with effects that hook into the existing physics, a ladder of buyable ship tiers, and notoriety-scaled enemy escalation. It removes boarding while **keeping the on-foot captain** (deck-walking, armour, kick, first/third person) — the captain just spends most of his time at the wheel now, and there are no enemy crews to board.

### Goals (priority order)
1. **Structured, fun core loop** — a legible greed-vs-survival tycoon loop, not a tech demo.
2. **Player agency at the menu** — choose how to play (Career vs Sandbox) before dropping in.
3. **Earned progression** — bigger ships and stronger upgrades are won by sinking boats and spending gold.
4. **Persistence** — a Career save that survives a reload; Sandbox kept separate.
5. **Low regression risk** — wrap and extend the working sim; do not rewrite it.

### Non-goals (v1)
Multiplayer, leaderboards / daily-seed (the old roguelite framing is retired), crew management/morale, factions, deep trade-route economy, enemy on-foot characters / melee, ship-builder mode.

---

## 2. Current state (ground truth, `main` @ 491ef4d)

Verified against code during the brainstorming session.

**Exists & works:**
- Boot: `src/main.ts` `main()` (async) → `renderer.setAnimationLoop(() => world.step(dt))`; `GameWorld.step` (`src/game/world.ts`) runs a fixed-step accumulator calling `onFixedStep(simTime, FIXED_DT)` where sailing, AI, cannons, ramming, port, etc. are driven.
- Ship-to-ship cannon combat: enemy `AICaptain` (`src/game/ai.ts`) chases + fires; `FleetManager` (`src/game/fleet.ts`) reconciles a live fleet to `TUN.fleet.enemyCount` (default 1, clamp `0..MAXVIS=6`), auto-replacing wrecks.
- Economy core (pure, tested): `src/sim/economy.ts` — doubloons, cargo (capacity), upgrade catalog, notoriety, `rollLoot`, `repairQuote`, serialize/deserialize.
- Dock→port loop (wired): `src/game/port.ts` `PortController` is constructed in `main.ts` with the real `IslandField` as its `DockProvider`; `port.update(dt)` runs each step; **E** → `port.tryDock()` opens the port; `port.plunder(ship)` fires when an enemy `isSunk`; sell / repair / buy upgrade work; economy saved to `localStorage["scuttle.economy.v1"]`.
- Port UI: `src/render/portScreen.ts` — a DOM overlay (`z-index` panel over the canvas), the reusable pattern for menus. HUD is static DOM in `index.html` updated from `main.ts`. Toast = `#toast`, fed by `boarding.message`.

**Absent (the gap this spec fills):**
- No title/start menu, no game-state machine (MENU/PLAYING/PORT/PAUSED), no pause. The **port screen does not pause the world** (a bug we will fix).
- Only two hulls: `buildBrig()` (player) and `buildSloop()` (enemy) in `src/sim/shipwright.ts`. No ship tiers, no buying/swapping ships.
- The two catalog upgrades are placeholders ("Larger Hold", "Reinforced Planks") — not the combat/sailing upgrades wanted.
- Save persists economy only — not the chosen ship, unlocks, or settings.
- The on-foot **boarding** system (`src/game/boarding.ts`) is wired in and **owns the gold wallet (`boarding.gold`) and the toast (`boarding.message`)** — so it cannot simply be deleted; the wallet and message must be rehomed. It also owns the player character (`boarding.player: Pirate`), which we are **keeping**.

**Upgrade-effect hooks (verified real):**
- Cannon reload → `Cannons` constructor param `reloadS` (per-instance; default `Cannons.RELOAD = 6`). Lower = faster.
- Top speed → `SailingController.boost` (per-controller thrust multiplier; already used by the dev panel).
- Turning → rudder yaw torque is `this.rudder * flow * mass * 0.5 * ship.rudderEff` in `sailing.ts`. `rudderEff` also encodes rudder *damage*, so the upgrade needs a **separate** multiplier (new `ship.rudderPower`, default 1) to stay independent of damage.
- Hull durability → damage emerges from voxels breaking against material toughness (`sim/materials.ts` `STRENGTH_TO_JOULES`, `TUN.crush.toughness`, `gun.crushEfficiency`). A per-ship durability upgrade needs a **new per-ship toughness multiplier** threaded into the carve/impact energy budget (the deepest hook; see §7.5).

---

## 3. Decisions log (this session)

| Decision | Choice |
|---|---|
| Main mode | **Career**: persistent open-world tycoon with a save; **Sandbox** is a separate no-stakes mode |
| Sinking stakes (Career) | **Non-terminal**: respawn at home port; lose all cargo + a % of *carried* (un-banked) gold; banked gold, ship tier, and upgrades survive |
| Ship acquisition | **Buy at the shipyard with gold, gated by having sunk a ship of that class** (combines "earned by taking down boats" + "buy bigger ships") |
| Difficulty/world | **Notoriety-scaled escalation** in one open sea — enemy tier mix + count grow with notoriety and the player's current ship |
| Boarding vs character | **Remove boarding** (grapple, enemy crew, chest-carry between ships, prize chest); **keep the on-foot captain** (deck-walk, armour, kick, FP/3P, helm↔foot toggle) |
| Upgrade persistence | **Account-wide captain upgrades** — re-applied to whatever hull you sail, so buying a bigger ship keeps your investment |
| Ship ladder | **Cutter → Sloop → Brig → Frigate** (start in the Cutter; Sloop & Brig exist; Cutter & Frigate are new hull authoring) |

---

## 4. Architecture approach

A **thin game-shell over the existing live world**, plus the one refactor the boarding-removal forces. We do **not** rewrite `main.ts` into a scene system (high regression risk on a working sim). Three moves:

1. **Game-state machine** wrapping the live world; `world.step()` runs only in `PLAYING`. Menus are DOM overlays reusing the `portScreen`/`devPanel` pattern.
2. **Forced refactor**: split today's `BoardingSystem` into a kept `PlayerCharacter` system + rehomed `Wallet`/`MessageBus`; strip boarding-only code.
3. **Content** added incrementally on the solid sim: ship tiers + shipyard, real upgrade catalog, notoriety-scaled escalation, sinking-with-a-cost.

### Module boundaries (new / changed)
- `src/game/gameState.ts` — **new**. The mode + state machine (`Mode = "career" | "sandbox"`, `Phase = "menu" | "playing" | "port" | "paused"`), owns the `Wallet` (gold of record) and a `MessageBus` (toasts). Single source of truth the loop reads to decide whether to step.
- `src/game/playerCharacter.ts` — **new** (extracted from `boarding.ts`). Owns the captain `Pirate`, deck-walk, armour, kick, FP/3P, helm↔foot. No grapple, no enemy crew, no chest transfer.
- `src/game/saveState.ts` — **new**. Versioned `SaveState` (economy + ship tier + unlocked classes + settings), per-slot (career / sandbox), localStorage-backed, tolerant deserialize (mirrors the economy pattern).
- `src/game/shipyard.ts` — **new**. The ship-tier catalog (tier → builder + price + stats), purchase/unlock rules, and the ship-swap procedure.
- `src/render/menuScreen.ts` — **new**. Start menu + pause menu + settings DOM overlay (same style as `portScreen`).
- `src/sim/economy.ts` — **changed**. Replace the placeholder `UPGRADES` with the real catalog; add per-level cost scaling helper. Stays pure & tested.
- `src/game/port.ts` — **changed**. Add a shipyard tab; apply the real upgrade effects; route gold through `Wallet` instead of `boarding.gold`; pause-aware open/close.
- `src/sim/shipwright.ts` — **changed**. Add `buildCutter()` and `buildFrigate()`; keep `buildSloop()`/`buildBrig()`.
- `src/game/fleet.ts` — **changed**. Spawn a **tier mix** weighted by notoriety/player ship instead of always a sloop.
- `src/game/ship.ts` / `sailing.ts` / `cannons.ts` — **changed (small)**. Add `ship.rudderPower` and `ship.hullToughness` multipliers; let the player `Cannons` accept an upgrade-driven `reloadS`; thread `hullToughness` into the carve/impact budget.
- `src/main.ts` — **changed**. Wire the state machine, gate the loop, swap `boarding.*` references to `PlayerCharacter` + `Wallet` + `MessageBus`, mount the menus, handle respawn-on-sink.

---

## 5. Design detail

### 5.1 Modes & the state machine
Boot to a **Start Menu** (no auto-drop-in):
- **New Career** — wipes the career slot, starts in the Cutter at the home port with 0 gold.
- **Continue** — shown only if a career save exists; loads it.
- **Sandbox** — separate slot; free play (§5.8).
- **Settings** — volume, camera default, etc. (minimal; persisted).

`Phase` transitions: `menu → playing`; `playing ⇄ port` (E at dock / leave); `playing ⇄ paused` (Esc); `paused → menu` (quit to menu). `world.step()` is called **only in `playing`**. Opening the port or pausing freezes the sim (fixes today's no-pause bug). The render loop still draws (frozen frame) so overlays composite over the scene.

### 5.2 Boarding removal + character keep
Extract `PlayerCharacter` from `BoardingSystem`:
- **Keep**: the captain `Pirate`, deck-walking in the ship's local frame, armour tiers + effects, kick (C), first/third person (V), helm↔foot toggle (T), E-to-interact (take helm / make port).
- **Remove**: grapple (G) and all grapple state, enemy-crew NPC array + spawning, chest pickup/carry-between-ships, the prize-chest mesh, and any cross-ship boarding logic.
- **Rehome**: `gold` → `Wallet` (in `gameState.ts`); `message` → `MessageBus`. `PortController`, the HUD, and `plunder()` read/write these instead of `boarding.*`.
- Files removed once unreferenced: the boarding-only parts of `boarding.ts` (file becomes `playerCharacter.ts` or boarding.ts is gutted to it). Character model files (`crew.ts`, `characterPack.ts`, `render/*Model.ts`) are **kept** — they power the captain.

### 5.3 Enemy escalation (notoriety-scaled)
One open sea. `FleetManager.spawn` becomes a **tiered spawner**: it picks an enemy tier from a weighted distribution driven by `notoriety` and the player's current ship tier, and positions it. Early game = mostly Cutters/Sloops (small, poor, easy). As notoriety rises, the distribution shifts toward Brigs/Frigates (bigger, richer, tougher) and `enemyCount` target may rise within `MAXVIS`. `plunder()` already scales loot by hull cell count (`shipValue`); tiers therefore pay out proportionally. AI behaviour (chase/fire/flee) is unchanged per ship.

### 5.4 Ship tiers & the shipyard
Ladder (smallest→largest): **Cutter, Sloop, Brig, Frigate**, each a `ShipTier { id, name, build(), price, sailClass, gunsPerSide, ... }` in `shipyard.ts`. Player **starts in the Cutter**. The **Shipyard** is a new tab/section in the port screen listing the next tiers with price and lock state. A tier is **buyable** when: `gold ≥ price` **and** the player has sunk ≥1 ship of that tier (`unlockedClasses`). Buying:
1. deduct gold, set current tier in save,
2. build the new hull, transfer the player to it (new `Ship`, keep world position/heading near the dock, re-add to world, repoint camera/character/cannons/sailing/port),
3. re-apply account-wide upgrades to the new ship,
4. dispose the old ship.

New hull authoring (`shipwright.ts`): `buildCutter()` (smaller than the sloop — ~1 mast, 2–3 guns/side, the cheap starter + early prey) and `buildFrigate()` (bigger than the brig — taller sides, 6–7 guns/side, the late-game flagship). Follow the existing analytic-hull + ballast-trim + cannon-port + mast conventions in `buildSloop`/`buildBrig`.

### 5.5 Upgrade tree (real effects, account-wide)
Replace placeholder `UPGRADES` with:

| id | Name | Effect | Hook |
|---|---|---|---|
| `reload` | Faster Reload | −reload time per level | player `Cannons.reloadS` |
| `hull` | Hull Reinforcement | +durability (harder to hole) per level | `ship.hullToughness` × in carve/impact |
| `speed` | Tall Canvas | +top speed per level | `SailingController.boost` |
| `rudder` | Sharper Rudder | +turn rate per level | `ship.rudderPower` × in rudder torque |
| `hold` | Larger Hold | +cargo capacity per level | `economy.cargoCapacity` (exists) |
| `planks` | Repair Stores | +repair planks per level | `ship.planks` cap (exists) |

Per-level cost scales **linearly: `cost(nextLevel) = base * (currentLevel + 1)`** (level 0→1 costs `base`, 1→2 costs `2·base`, …), implemented in a pure economy helper and unit-tested; balance-tune `base` per upgrade in P4. Upgrades are **account-wide**: stored in `EconomyState.upgrades`, re-applied by an extended `PortController.applyUpgrades()` to whatever ship is current (including after a ship swap and after load). `repair()` already restores sails/rudder/planks/breaches.

### 5.6 Economy & loop tuning
- Sink → `plunder()` adds gold + cargo scaled by tier (existing `rollLoot`/`shipValue`).
- Port → sell cargo / repair / buy upgrade / buy ship; **saving happens on making port** (as today) and on pause.
- **Sinking penalty (Career)**: on `isSunk(player)` → enter a brief `RESPAWN` handoff → respawn a fresh (full-health) hull of the **current tier** at the **home port** (the harbour town dock — the single existing harbour; v1 has one home port); **clear all cargo** and **deduct 25% of current gold** (v1 has no separate "bank", so the wallet is the carried gold; tune the 25% in P4); keep upgrades, tier, unlocks, notoriety. Sandbox: respawn intact, no loss.
- **Notoriety** is the visible progression meter; HUD shows notoriety and the next unlock/tier hint.

### 5.7 Save system
`SaveState` (versioned, tolerant deserialize):
```
{ version, mode, economy: EconomyState, shipTier, unlockedClasses[], settings }
```
- `economy` is a **sub-object** of `SaveState` (not a separate key). Slots: `scuttle.save.career.v1`, `scuttle.save.sandbox.v1`. On first boot, **migrate** any legacy `scuttle.economy.v1` into the career slot's `economy`, then ignore the old key.
- `New Career` wipes career slot; `Continue` loads it; Sandbox uses its own slot.
- **Not persisted**: live ship damage / position / fleet state — on load you appear afloat at the home port in your current tier (keeps it simple and robust).

### 5.8 Sandbox mode
Same `playing` phase with a `sandbox` flag: all tiers + upgrades available (unlocked + affordable, or free-buy), gold unconstrained, live enemy **tier/count sliders** (surfacing the dev-panel knobs in a friendly panel), no career stakes, its own save slot (or ephemeral). It is the old free-play, now with the full content set exposed.

### 5.9 UI
- `menuScreen.ts`: start menu, pause menu, settings — DOM overlays in the existing antique chart-room style (reuse `portScreen` CSS/structure).
- Port screen: add a **Shipyard** section (tiers, prices, lock state, buy) beside sell/repair/upgrades.
- HUD additions: notoriety readout, current ship tier, next-unlock hint. Toast now reads from `MessageBus`.

---

## 6. Phasing (each phase independently buildable & testable)

- **P1 — Shell & refactor**: `gameState.ts` (Mode/Phase + Wallet + MessageBus), gate `world.step`, start/pause menus, port-pauses-world; extract `PlayerCharacter` and strip boarding; rehome wallet+toast; `saveState.ts` scaffolding (career/sandbox slots, New/Continue). *Game is fully playable as today, now behind a menu with pause and a clean wallet.*
- **P2 — Upgrades & economy**: real `UPGRADES` catalog + cost scaling (pure, tested); wire effects (`reloadS`, `boost`, `rudderPower`, `hullToughness`, hold, planks); sinking penalty + respawn; HUD notoriety/tier. *The upgrade-and-survive loop is real.*
- **P3 — Ship tiers & escalation**: `buildCutter`/`buildFrigate`; `shipyard.ts` catalog + unlock/buy + ship-swap; tiered notoriety-scaled fleet spawner; start-in-Cutter. *Full progression spine.*
- **P4 — Sandbox & polish**: sandbox config + sliders panel; menu/HUD polish; balance pass on prices/costs/escalation; settings persistence.

---

## 7. Technical notes / risks

1. **`main.ts` is large and central.** The refactor touches many `boarding.*` references. Mitigate by introducing `Wallet`/`MessageBus`/`PlayerCharacter` with the *same* read/write shape the loop already uses, so the swap is mechanical, then deleting boarding-only branches.
2. **Ship swap mid-world** must repoint every system holding a `Ship` reference (camera, character anchor, cannons owner, sailing controller, port `ship`, fleet `target`, AI target). Centralise the player-ship reference so the swap updates one place.
3. **State machine must not break the fixed-step determinism** the sim oracle relies on — gating is at the `world.step` call site, not inside the sim.
4. **New hulls** must pass the existing buoyancy/trim expectations (they float upright, sit at a sane draft). Verify in-browser per the GPU/feel rules; author ballast like the existing builders.
5. **Hull-durability upgrade is the deepest hook**: a per-ship `hullToughness` multiplier must scale the energy required to break a voxel in both cannon impact (`carve`/`gun.crushEfficiency`) and ship-ship crush (`crush`/`voxelContact`). Keep it a single multiplier read where the per-cell break energy is computed so both paths honour it. If wiring proves risky, fall back to scaling only cannon-impact durability in v1 and note it.
6. **No CI**: `npm run test` does not type-check — run `npm run build` (`tsc --noEmit && vite build`) before any merge. Verify shader/feel changes in-browser at `:5173`.

---

## 8. Testing strategy

- **Pure-core unit tests** (vitest): economy upgrade catalog + cost scaling + effects-as-data; save serialize/deserialize round-trip + version tolerance; shipyard unlock/affordability/purchase rules; tier-spawn weighting given notoriety (seeded RNG). Keep the existing 215 green.
- **State-machine tests**: transitions (menu→playing→port→paused→menu), `world.step` gating flag.
- **Type/build gate**: `npm run build` clean before merge.
- **In-browser smoke (Playwright at :5173)**: boot → start menu visible → New Career → sail → sink a small ship → make port → buy an upgrade → see effect → (later) buy a ship → swap. Readback oracle for any physics/feel claims; screenshots to projects root.

---

## 9. Out of scope (v1)
Multiplayer; leaderboards / daily-seed; crew management; factions; deep trade economy; enemy on-foot/melee; ship-builder. The deterministic sim keeps the multiplayer/leaderboard door open for later without paying for it now.
