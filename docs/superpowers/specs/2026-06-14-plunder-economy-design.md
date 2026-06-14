# SCUTTLE — Plunder Economy Framework (design spec)

_2026-06-14 · branch `dev/tycoon-progression` · status: APPROVED, building autonomously_

## North Star (context, not this spec's scope)

SCUTTLE is becoming a **persistent plunder-tycoon**: you're a pirate, money comes
mainly from sinking/boarding ships, and you spend it at ports to grow a fleet and a
stronghold. Persistence is **empire-on-shore**: your wealth, cargo, and upgrades
survive forever; losing the active hull costs only that hull + its hold, never the
empire. Dropped from the first build (deliberately): factions, skill tree, captain
fleet, ship classes/purchasing, crew, multiple regions. The full vision lives above
this spec as the roadmap; **this spec builds only the load-bearing skeleton** of the
plunder→port→spend→persist loop so the rest can bolt on later.

## Goal of THIS spec

Ship a **decoupled economy framework** — not content — that:

1. **Plunder:** turns a ship sinking into loot (doubloons + cargo) that enters a wallet.
2. **Economy core:** a pure, tested model of wallet + cargo hold + upgrade catalog with
   `sell` / `repair` / `buy` transactions.
3. **Port:** a dock-triggered screen to spend (sell cargo, repair, buy upgrades) and
   **save the game**.
4. **Persistence:** the empire (doubloons/cargo/upgrades/notoriety) saves to
   `localStorage` and restores on load.
5. **Compatibility:** plugs into the `dev+voxel-islands` dock and the multi-ship fleet
   without colliding, and keeps the existing `boarding.gold` HUD working untouched.

It is a *framework*: the catalogs (goods, upgrades) start as a tiny placeholder set and
are pure data, trivially extended later.

## Constraints discovered in code (the seams)

- **The wallet already exists and is shared.** `BoardingSystem.gold` (`src/game/boarding.ts:24`)
  is the gold counter; `main.ts:699` renders it to `#gold`; **both** the fleet and islands
  branches reference it. → The economy must treat `boarding.gold` as the canonical gold
  register (mirror to it on every change), not replace it.
- **The plunder seam exists.** `main.ts:375–379`: `if (isSunk(enemy) && !enemyScuttled) { boarding.gold += 150; … }`.
  `isSunk` is `main.ts:233`. → Replace the hardcoded `+= 150` with a `port.plunder(enemy)` call.
- **Dock API (islands branch).** `IslandField.nearestDock(x, z): THREE.Vector3 | null`
  (`src/game/islandField.ts`), harbor identified by `dockWorld !== null`. No docking
  trigger exists yet. → Depend on a tiny `DockProvider` interface that `IslandField`
  already structurally satisfies; ship a dev fallback so the port works on this branch.
- **No persistence anywhere.** Build `localStorage` save/load from scratch.
- **UI pattern.** The dev panel (`src/render/devPanel.ts`) builds its DOM entirely in JS,
  frees pointer-lock on open, and re-grabs on close. The port screen follows the same
  pattern → **no `index.html` edits** (avoids merge collisions). Theme = the antique
  chart-room `.panel` look (leather/brass/parchment, Georgia serif, gold `#d8b24a`).
- **Upgradeable ship fields** (`src/game/ship.ts`): `planks` (repair capacity), `mastHp[]`/
  `mastAlive[]`, `sailIntegrity[]`, `rudderHp`/`rudderEff`, `pumpOn`. These are what
  "repair" restores and what "upgrades" can buff.

## Architecture

Three new modules + one test file. Strict layering matches the repo convention
(`sim/` = pure & deterministic & unit-tested; `game/` = stateful, wired to world/THREE;
`render/` = DOM/visual).

```
src/sim/economy.ts      ← PURE. wallet, cargo, catalog, transactions, (de)serialize, loot roll.  TESTED.
src/game/port.ts        ← PortController: DockProvider iface, dock proximity, save/load,
                          plunder(ship), applies effects to Ship, mirrors boarding.gold.
src/render/portScreen.ts← DOM overlay (chart-room theme); dumb view, driven by a view-model.
tests/economy.test.ts   ← unit tests for the pure core.
main.ts                 ← additive wiring only (construct, load, per-step update, sink hook, DEBUG).
```

### 1. `src/sim/economy.ts` — the pure core (no THREE / Rapier / DOM)

```ts
export type GoodId = string;
export interface Good { id: GoodId; name: string; basePrice: number }

export type UpgradeId = string;
export interface Upgrade {            // pure data; the EFFECT lives in the game layer
  id: UpgradeId; name: string; description: string;
  cost: number;        // cost of the next level (flat for now; framework can scale later)
  maxLevel: number;
}

export interface EconomyState {
  version: number;                    // for save migration
  doubloons: number;
  cargo: Record<GoodId, number>;      // good → units
  cargoCapacity: number;              // total units the hold carries
  upgrades: Record<UpgradeId, number>;// upgrade → level owned
  notoriety: number;                  // accrues with plunder; gates nothing yet (tracked only)
}

export interface LootBundle { doubloons: number; cargo: Record<GoodId, number>; notoriety: number }

// Placeholder catalogs — DATA, extend freely. Intentionally tiny.
export const GOODS: Record<GoodId, Good>   // e.g. rum, silk, spice (3 seed goods)
export const UPGRADES: Upgrade[]           // e.g. "Reinforced Planks", "Larger Hold" (2–3 seed)

export class Economy {
  state: EconomyState;
  constructor(init?: Partial<EconomyState>);   // fills defaults for any missing field

  // queries
  cargoUsed(): number;
  cargoFree(): number;
  priceOf(good: GoodId, mult?: number): number; // basePrice * mult (mult default 1; trade hook)
  upgradeLevel(id: UpgradeId): number;
  nextCost(id: UpgradeId): number | null;       // null when maxed
  canAfford(cost: number): boolean;

  // mutations (all return a small result, never throw on game-logic failure)
  addLoot(loot: LootBundle): { stored: Record<GoodId, number>; lost: Record<GoodId, number> }; // clamps to capacity
  spend(amount: number): boolean;               // generic deduct if affordable
  sellAll(mult?: number): number;               // cargo → doubloons, returns gold gained
  buyUpgrade(id: UpgradeId): { ok: boolean; reason?: "broke" | "maxed" | "unknown" };

  // persistence
  serialize(): string;                          // JSON
  static deserialize(json: string | null): Economy; // tolerant: bad/old/empty → sane defaults
}

// pure, injectable RNG so it's deterministic in tests
export function rollLoot(rand: () => number, shipValue: number): LootBundle;
```

Design notes:
- **Purity = testability.** `Economy` reads/writes only its own `state`. `rollLoot` takes an
  injected `rand` (real `rng` in game, fake in tests). No clocks, no globals.
- **Repair cost is pure but ship-state is not**, so the split is: the controller measures a
  `damage01 ∈ [0,1]` from the live ship and the controller computes the quote
  (`repairQuote(damage01)` is a tiny pure helper exported here), then calls `spend()`.
- **Upgrade effects are NOT here.** Economy only records "level N owned." The game layer
  interprets the level into ship buffs — keeps this file engine-free.

### 2. `src/game/port.ts` — `PortController` (the glue)

```ts
export interface DockProvider {                 // IslandField already satisfies this
  nearestDock(x: number, z: number): { x: number; y: number; z: number } | null;
}

export interface PortDeps {
  economy: Economy;
  ship: Ship;                                   // player ship (effects applied here)
  boarding: BoardingSystem;                     // for gold mirror + toast messages
  ui: PortScreen;
  getPlayerPos(): { x: number; z: number };
  dock?: DockProvider;                          // omitted on this branch → DevDockProvider
  rand?: () => number;                          // loot RNG (defaults to a seeded rng)
}

export class PortController {
  canDock: boolean;
  isOpen: boolean;
  constructor(deps: PortDeps);

  update(dt: number): void;          // proximity → canDock; surface "press E — make port" hint
  tryDock(): void;                   // if canDock && !isOpen → openPort()
  openPort(): void;                  // builds view-model, shows ui, auto-saves
  closePort(): void;                 // hides ui, saves

  plunder(ship: Ship): void;         // rollLoot(value(ship)) → economy.addLoot → mirror gold → toast
                                     // REPLACES the hardcoded boarding.gold += 150
  // port actions (called by the UI)
  sell(): void;                      // economy.sellAll → mirror → refresh ui
  repair(): void;                    // quote from ship damage → spend → restore ship → refresh
  buy(id: UpgradeId): void;          // economy.buyUpgrade → applyUpgrades(ship) → refresh

  save(): void;                      // localStorage["scuttle.economy.v1"] = economy.serialize()
  load(): void;                      // restore economy, mirror gold, re-apply owned upgrades to ship
}
```

Behaviour:
- **Gold mirror invariant:** after any economy mutation, `boarding.gold = economy.state.doubloons`.
  On `load()`, also set it. The existing `#gold` HUD then needs zero changes.
- **`plunder(ship)` is ship-agnostic** (takes any `Ship`), so the fleet branch can call it
  per-enemy. Ship "value" derives from hull size (cell count) → richer ships, richer loot.
- **`DevDockProvider`** (in this file): returns a fixed dock anchor near spawn (e.g. world
  origin) so docking works without the islands branch. When islands merge, pass
  `{ dock: islands }` and delete nothing.
- **Repair** restores `planks` to max, `sailIntegrity`/`mastHp`/`mastAlive` to whole, `rudderHp`/
  `rudderEff` to full — cost scaled by how damaged she was. Pure quote, impure apply.
- **`applyUpgrades(ship)`** maps owned upgrade levels → ship buffs (e.g. "Larger Hold" →
  `economy.state.cargoCapacity`; "Reinforced Planks" → higher max `planks`). Idempotent;
  re-run after load and after each buy.
- **Saving** happens on dock, on each transaction, and on close — "save at the docks."

### 3. `src/render/portScreen.ts` — the overlay

- `createPortScreen(actions: { onSell; onRepair; onBuy(id); onClose }): PortScreen` with
  `open(vm)`, `close()`, `refresh(vm)`, `get isOpen()`. Pattern mirrors `createDevPanel`.
- **View-model** (plain object the controller passes; UI never imports `Economy`):
  `{ portName, doubloons, notoriety, cargo: {name, qty, value}[], cargoUsed, cargoCap,
     repairCost, upgrades: {id, name, desc, level, maxLevel, cost|null, affordable}[] }`.
- Frees pointer-lock on open, re-grabs on close (like the dev panel).
- Chart-room theme: reuse `.panel` palette inline (`#d8b24a` gold, `#d8c9a3` parchment,
  Georgia serif, leather gradient). Buttons styled like `#fs-btn`.
- Sections: **manifest** (cargo + total value + "Sell All"), **repair** (cost + button,
  disabled if undamaged/broke), **upgrades** (list with level/cost/buy), **"Save & Cast Off"**.

### 4. `main.ts` wiring (additive only)

- **Construct** after world/ship/boarding exist:
  `const economy = new Economy(); const portScreen = createPortScreen({…});`
  `const port = new PortController({ economy, ship: sloop, boarding, ui: portScreen, getPlayerPos, rand }); port.load();`
- **Per step** in `world.onFixedStep`: `port.update(dt);` and, in the E-interact branch, if
  `port.canDock` and not at wheel/ladder → `port.tryDock()` (new branch alongside the
  existing wheel/ladder/chest logic; doesn't alter those paths).
- **Sink hook** (`main.ts:375`): replace the `boarding.gold += 150; boarding.message = …`
  body with `port.plunder(enemy);` (keeps the `enemyScuttled` guard).
- **`window.DEBUG`**: add `economy, port` (for Playwright: `DEBUG.port.openPort()` etc.).
- **Dev trigger**: a dev-panel button group "Port (dev)" → "Open Port" calling `port.openPort()`,
  so a human can open it on this branch without islands.

## Persistence shape

`localStorage["scuttle.economy.v1"]` = `economy.serialize()` (the `EconomyState` JSON).
`deserialize` is **version- and shape-tolerant**: missing/extra keys, null, or a parse
error all fall back to defaults (never crashes the boot). Save = the persistent empire;
the world/ship pose is procedural/transient and intentionally NOT saved (matches the
"empire persists, voyage doesn't" model). Owned upgrade levels persist and are re-applied
to the fresh ship on load.

## Compatibility (explicit)

- **No HUD/`index.html` edits** — port UI is built in JS; gold still flows through `boarding.gold`.
- **New files** don't exist on any sibling branch → zero file collisions.
- **`main.ts` edits** are at stable, additive seams; the only behavioural *change* is routing
  the existing sink reward through `plunder()` (a superset of the old `+= 150`).
- **Islands merge** = construct `PortController` with `{ dock: islands }`; `nearestDock` already
  matches `DockProvider`. **Fleet merge** = call `port.plunder(ship)` per sunk enemy.
- **No touching** of physics/sim, destruction, fleet AI, character, or the ocean.

## Testing

- **Unit (`tests/economy.test.ts`, vitest):** addLoot stores & clamps to capacity (overflow
  reported as `lost`); sellAll converts at price and empties hold; buyUpgrade deducts +
  increments + blocks on `broke`/`maxed`; spend respects affordability; repairQuote is
  monotonic in damage; serialize→deserialize round-trips; deserialize tolerates
  null/garbage/old-version; rollLoot is deterministic under a seeded rand and scales with value.
- **In-browser (Playwright @ :5173):** sink the enemy → doubloons rise (`DEBUG.economy.state`);
  `DEBUG.port.openPort()` shows the screen; sell/repair/buy mutate state + gold HUD; save,
  reload page, confirm state restored from `localStorage`.
- **Regression:** `npm run build` (tsc) clean; full `npm run test` green (no existing test touched).

## Out of scope (extension points noted in code)

- Physical floating loot pickups (loot is awarded directly on sink; `addLoot` is the seam a
  future `LootPickupManager` would call).
- Trade price dynamics (flat `basePrice`; `priceOf(mult)` is the hook).
- Ship purchasing/classes, crew, captains, factions, skill tree, multiple ports/regions.
- Notoriety-driven enemy scaling (number is tracked; consumers come with the fleet work).
- Pausing the sim in port (overlay only, like the dev panel).

## Implementation order (this doubles as the plan)

1. `src/sim/economy.ts` + `tests/economy.test.ts` — TDD the pure core to green.
2. `src/render/portScreen.ts` — DOM overlay against a hand-built view-model.
3. `src/game/port.ts` — PortController + DevDockProvider, wired to economy/ship/ui.
4. `main.ts` — construct, `load()`, per-step `update`, E-dock branch, `plunder` swap, DEBUG, dev button.
5. Verify: tsc + vitest + Playwright smoke (plunder→port→sell/repair/buy→save→reload).
6. Commit per layer (stage only my paths), push `dev/tycoon-progression`, open PR for review.
