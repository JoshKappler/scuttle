# Tycoon Game Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the SCUTTLE demo into a structured open-world pirate tycoon: start menu + Career/Sandbox modes, pause, a real upgrade tree wired to the physics, a Cutter→Sloop→Brig→Frigate shipyard unlocked by defeating ship classes, notoriety-scaled enemy escalation, respawn-with-cost, and an expanded save — while keeping the on-foot captain and removing only the vestigial boarding system.

**Architecture:** A thin game-shell (state machine + DOM menu overlays) wraps the existing live world; `world.step()` runs only in the `playing` phase. The boarding-removal forces one refactor: split `BoardingSystem` into a kept `PlayerCharacter` plus a rehomed `Wallet`/`MessageBus`. New pure, unit-tested modules carry the testable logic (economy upgrades, save state, shipyard rules, tier-spawn weighting); integration into `main.ts` is verified by `npm run build` + in-browser Playwright smoke at `:5173`.

**Tech Stack:** TypeScript, Three.js, Rapier3D (compat), Vite, Vitest. Pure sim/logic modules stay engine-free and unit-tested (the project's "oracle" pattern). No CI — `npm run build` (`tsc --noEmit && vite build`) is the type gate; `npm run test` is vitest.

**Reference:** spec at `docs/superpowers/specs/2026-06-14-tycoon-game-layer-design.md`.

---

## Conventions for every task
- **Worktree:** all work in `.claude/worktrees/tycoon-game-layer` on branch `dev/tycoon-game-layer`. Never touch `main`.
- **Test command:** `npm run test` (vitest, fast). **Type/build gate:** `npm run build`.
- **Commit** after each task with a clear `feat(...)/refactor(...)/test(...)` message + the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- **In-browser checks** (integration tasks): `npm run dev` → Playwright at `http://localhost:5173`; screenshots to projects root; use `DEBUG` globals + single-step readbacks per the GPU-verification memory.

---

# PHASE 1 — Shell & refactor

Outcome: the game is playable exactly as today, but behind a **start menu**, with **pause**, the **port pausing the world**, a **clean wallet/message** decoupled from boarding, the **boarding system removed** (captain kept), and **save scaffolding** (Career/Sandbox slots).

## Task 1.1: `Wallet` + `MessageBus` (pure)

**Files:**
- Create: `src/game/wallet.ts`
- Create: `src/game/messageBus.ts`
- Test: `tests/wallet.test.ts`

- [ ] **Step 1: Write failing tests** (`tests/wallet.test.ts`)
```ts
import { describe, it, expect } from "vitest";
import { Wallet } from "../src/game/wallet";
import { MessageBus } from "../src/game/messageBus";

describe("Wallet", () => {
  it("starts at the given balance and adds", () => {
    const w = new Wallet(100);
    w.add(50);
    expect(w.gold).toBe(150);
  });
  it("spends only when affordable", () => {
    const w = new Wallet(40);
    expect(w.spend(50)).toBe(false);
    expect(w.gold).toBe(40);
    expect(w.spend(30)).toBe(true);
    expect(w.gold).toBe(10);
  });
  it("set overwrites (mirror from economy)", () => {
    const w = new Wallet(0);
    w.set(999);
    expect(w.gold).toBe(999);
  });
});

describe("MessageBus", () => {
  it("holds the latest message until cleared", () => {
    const m = new MessageBus();
    expect(m.current).toBe("");
    m.post("ahoy");
    expect(m.current).toBe("ahoy");
    m.clear();
    expect(m.current).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm run test -- wallet` → FAIL (modules not found).

- [ ] **Step 3: Implement** (`src/game/wallet.ts`)
```ts
/** The player's gold of record (was BoardingSystem.gold). Engine-free. */
export class Wallet {
  constructor(public gold = 0) {}
  add(n: number): void { this.gold += n; }
  set(n: number): void { this.gold = n; }
  spend(n: number): boolean {
    if (this.gold < n) return false;
    this.gold -= n;
    return true;
  }
}
```
(`src/game/messageBus.ts`)
```ts
/** The HUD toast channel (was BoardingSystem.message). Latest-wins. */
export class MessageBus {
  current = "";
  post(msg: string): void { this.current = msg; }
  clear(): void { this.current = ""; }
}
```

- [ ] **Step 4: Run to verify pass** — `npm run test -- wallet` → PASS.

- [ ] **Step 5: Commit** — `git add src/game/wallet.ts src/game/messageBus.ts tests/wallet.test.ts && git commit` → `feat(game): Wallet + MessageBus (rehomed from boarding)`.

## Task 1.2: `GameState` machine (pure)

**Files:**
- Create: `src/game/gameState.ts`
- Test: `tests/gameState.test.ts`

Defines modes/phases and which phase steps the sim. Owns references to `Wallet` + `MessageBus` for convenience (single object the loop reads).

- [ ] **Step 1: Write failing tests** (`tests/gameState.test.ts`)
```ts
import { describe, it, expect } from "vitest";
import { GameState } from "../src/game/gameState";

describe("GameState", () => {
  it("boots in the menu, sim not running", () => {
    const g = new GameState();
    expect(g.phase).toBe("menu");
    expect(g.isSimRunning()).toBe(false);
  });
  it("startGame enters playing in the chosen mode", () => {
    const g = new GameState();
    g.startGame("career");
    expect(g.mode).toBe("career");
    expect(g.phase).toBe("playing");
    expect(g.isSimRunning()).toBe(true);
  });
  it("pause/resume toggles sim without losing mode", () => {
    const g = new GameState();
    g.startGame("sandbox");
    g.pause();
    expect(g.phase).toBe("paused");
    expect(g.isSimRunning()).toBe(false);
    g.resume();
    expect(g.phase).toBe("playing");
    expect(g.mode).toBe("sandbox");
  });
  it("port freezes the sim and returns to playing on leave", () => {
    const g = new GameState();
    g.startGame("career");
    g.enterPort();
    expect(g.phase).toBe("port");
    expect(g.isSimRunning()).toBe(false);
    g.leavePort();
    expect(g.phase).toBe("playing");
  });
  it("quitToMenu resets phase to menu", () => {
    const g = new GameState();
    g.startGame("career");
    g.quitToMenu();
    expect(g.phase).toBe("menu");
  });
  it("isSandbox reflects the mode", () => {
    const g = new GameState();
    g.startGame("sandbox");
    expect(g.isSandbox()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm run test -- gameState` → FAIL.

- [ ] **Step 3: Implement** (`src/game/gameState.ts`)
```ts
import { Wallet } from "./wallet";
import { MessageBus } from "./messageBus";

export type GameMode = "career" | "sandbox";
export type GamePhase = "menu" | "playing" | "port" | "paused";

/** The game-shell state: which mode + phase we're in, and the shared wallet/message.
 *  The render loop reads isSimRunning() to decide whether to advance world.step(). */
export class GameState {
  mode: GameMode = "career";
  phase: GamePhase = "menu";
  readonly wallet = new Wallet(0);
  readonly msg = new MessageBus();

  isSimRunning(): boolean { return this.phase === "playing"; }
  isSandbox(): boolean { return this.mode === "sandbox"; }

  startGame(mode: GameMode): void { this.mode = mode; this.phase = "playing"; }
  pause(): void { if (this.phase === "playing") this.phase = "paused"; }
  resume(): void { if (this.phase === "paused") this.phase = "playing"; }
  enterPort(): void { this.phase = "port"; }
  leavePort(): void { this.phase = "playing"; }
  quitToMenu(): void { this.phase = "menu"; }
}
```

- [ ] **Step 4: Run to verify pass** — `npm run test -- gameState` → PASS.

- [ ] **Step 5: Commit** — `feat(game): GameState mode/phase machine (gates the sim)`.

## Task 1.3: `SaveState` (pure, versioned, slotted)

**Files:**
- Create: `src/game/saveState.ts`
- Test: `tests/saveState.test.ts`

Wraps the economy state + ship tier + unlocked classes + settings. Tolerant deserialize. Pure: takes a `Storage`-like object (so tests pass a fake; game passes `localStorage`).

- [ ] **Step 1: Write failing tests** (`tests/saveState.test.ts`)
```ts
import { describe, it, expect } from "vitest";
import { SaveManager, defaultSave, type SaveState } from "../src/game/saveState";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage;
}

describe("SaveManager", () => {
  it("returns a default when nothing is stored", () => {
    const sm = new SaveManager(fakeStorage());
    const s = sm.load("career");
    expect(s.shipTier).toBe("cutter");
    expect(s.economy.doubloons).toBe(0);
    expect(s.unlockedClasses).toEqual(["cutter"]);
  });
  it("round-trips a save", () => {
    const store = fakeStorage();
    const sm = new SaveManager(store);
    const s = defaultSave("career");
    s.economy.doubloons = 500;
    s.shipTier = "brig";
    s.unlockedClasses = ["cutter", "sloop", "brig"];
    sm.save("career", s);
    const loaded = new SaveManager(store).load("career");
    expect(loaded.economy.doubloons).toBe(500);
    expect(loaded.shipTier).toBe("brig");
    expect(loaded.unlockedClasses).toContain("brig");
  });
  it("career and sandbox slots are independent", () => {
    const store = fakeStorage();
    const sm = new SaveManager(store);
    const c = defaultSave("career"); c.economy.doubloons = 100; sm.save("career", c);
    const s = defaultSave("sandbox"); s.economy.doubloons = 999; sm.save("sandbox", s);
    expect(sm.load("career").economy.doubloons).toBe(100);
    expect(sm.load("sandbox").economy.doubloons).toBe(999);
  });
  it("wipe clears a slot back to default", () => {
    const store = fakeStorage();
    const sm = new SaveManager(store);
    const c = defaultSave("career"); c.economy.doubloons = 100; sm.save("career", c);
    sm.wipe("career");
    expect(sm.load("career").economy.doubloons).toBe(0);
  });
  it("hasSave reports whether a slot exists", () => {
    const store = fakeStorage();
    const sm = new SaveManager(store);
    expect(sm.hasSave("career")).toBe(false);
    sm.save("career", defaultSave("career"));
    expect(sm.hasSave("career")).toBe(true);
  });
  it("migrates a legacy scuttle.economy.v1 blob into career on first load", () => {
    const store = fakeStorage();
    store.setItem("scuttle.economy.v1", JSON.stringify({ version: 1, doubloons: 250, cargo: {}, cargoCapacity: 40, upgrades: {}, notoriety: 3 }));
    const sm = new SaveManager(store);
    const s = sm.load("career");
    expect(s.economy.doubloons).toBe(250);
    expect(s.economy.notoriety).toBe(3);
  });
  it("tolerates garbage JSON → default", () => {
    const store = fakeStorage();
    store.setItem("scuttle.save.career.v1", "{not json");
    expect(new SaveManager(store).load("career").economy.doubloons).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify fail** — `npm run test -- saveState` → FAIL.

- [ ] **Step 3: Implement** (`src/game/saveState.ts`)
```ts
import { Economy, type EconomyState, defaultState as defaultEconomy } from "../sim/economy";
import type { GameMode } from "./gameState";

export const SAVE_VERSION = 1;
export type ShipTierId = "cutter" | "sloop" | "brig" | "frigate";

export interface Settings {
  masterVolume: number; // 0..1
  defaultCamera: 0 | 1 | 2; // matches main.ts camMode
}

export interface SaveState {
  version: number;
  mode: GameMode;
  economy: EconomyState;
  shipTier: ShipTierId;
  unlockedClasses: ShipTierId[];
  settings: Settings;
}

const LEGACY_ECONOMY_KEY = "scuttle.economy.v1";
const slotKey = (mode: GameMode) => `scuttle.save.${mode}.v1`;

export function defaultSettings(): Settings {
  return { masterVolume: 0.8, defaultCamera: 0 };
}

export function defaultSave(mode: GameMode): SaveState {
  return {
    version: SAVE_VERSION,
    mode,
    economy: defaultEconomy(),
    shipTier: "cutter",
    unlockedClasses: ["cutter"],
    settings: defaultSettings(),
  };
}

export class SaveManager {
  constructor(private store: Storage) {}

  hasSave(mode: GameMode): boolean {
    try { return this.store.getItem(slotKey(mode)) != null; }
    catch { return false; }
  }

  load(mode: GameMode): SaveState {
    let raw: string | null = null;
    try { raw = this.store.getItem(slotKey(mode)); } catch { raw = null; }
    if (!raw && mode === "career") {
      const migrated = this.migrateLegacy();
      if (migrated) { this.save("career", migrated); return migrated; }
    }
    return this.parse(raw, mode);
  }

  save(mode: GameMode, s: SaveState): void {
    try { this.store.setItem(slotKey(mode), JSON.stringify(s)); } catch { /* private mode */ }
  }

  wipe(mode: GameMode): void {
    try { this.store.removeItem(slotKey(mode)); } catch { /* ignore */ }
  }

  private migrateLegacy(): SaveState | null {
    let raw: string | null = null;
    try { raw = this.store.getItem(LEGACY_ECONOMY_KEY); } catch { return null; }
    if (!raw) return null;
    const s = defaultSave("career");
    s.economy = Economy.deserialize(raw).state;
    return s;
  }

  private parse(raw: string | null, mode: GameMode): SaveState {
    const d = defaultSave(mode);
    if (!raw) return d;
    let p: unknown;
    try { p = JSON.parse(raw); } catch { return d; }
    if (!p || typeof p !== "object") return d;
    const o = p as Partial<SaveState>;
    return {
      version: SAVE_VERSION,
      mode,
      economy: o.economy ? Economy.deserialize(JSON.stringify(o.economy)).state : d.economy,
      shipTier: (o.shipTier as ShipTierId) ?? d.shipTier,
      unlockedClasses: Array.isArray(o.unlockedClasses) && o.unlockedClasses.length ? (o.unlockedClasses as ShipTierId[]) : d.unlockedClasses,
      settings: { ...d.settings, ...(o.settings ?? {}) },
    };
  }
}
```
> Note: confirm `defaultState` is exported from `economy.ts` (it is, line 64). If the symbol name differs, import the actual one.

- [ ] **Step 4: Run to verify pass** — `npm run test -- saveState` → PASS.

- [ ] **Step 5: Commit** — `feat(game): SaveState (career/sandbox slots, legacy migration)`.

## Task 1.4: Extract `PlayerCharacter` from `BoardingSystem`

**Files:**
- Create: `src/game/playerCharacter.ts`
- Modify: `src/game/boarding.ts` (delete at end of Task 1.5 once unreferenced)
- Test: none (engine-bound; verified by build + in-browser).

`PlayerCharacter` keeps everything the captain needs and drops all boarding. It takes a `MessageBus` for toasts (no internal `message`/`gold`).

- [ ] **Step 1: Create `playerCharacter.ts`** — port the KEPT logic from `boarding.ts`:
  - Fields: `player: Pirate | null`, `playerHp = 5` (vestigial, kept so HUD bar code is stable), `private tmp...`.
  - Constructor `(phys, scene, playerShip: Ship, msg: MessageBus)` — **no enemyShip**, **no chest mesh**.
  - `spawnPlayer()` — unchanged (the captain at the helm).
  - `update(dt, simTime, waves, input, onFoot)` — keep: spawn-on-settle, `player.ship = nearestShip()` **simplified to `this.player.ship = this.playerShip`** (no enemy hull to ride), `player.step`/`idleTick`, kick (C) via `player.kickAnim()` (drop `swing`/enemy damage — no targets), man-overboard ladder handled in main.ts as today. Return value can be `void`.
  - Keep `kick` doing `player.kickAnim()` only (no target list). Keep `swingAnim` callable on LMB-on-foot as a flourish (no damage). Drop `enemies`, `ensureCrew`, `toggleGrapple`, grapple forces, `updateChest`, `setEnemy`, `currentEnemy`, `respawnPlayer` (boarding-specific), `canFight`, `enemiesLeft`, `hasTarget`, `grappled`, `chestCarried`, `chestBanked`.
  - `deckTop`, `midZ` helpers: keep (used by spawn).
```ts
import * as THREE from "three";
import type { Wave } from "../sim/gerstner";
import { Pirate } from "./crew";
import type { Physics } from "./physics";
import type { Ship } from "./ship";
import type { MessageBus } from "./messageBus";

/** The on-foot captain: deck-walking, kick, swim, first/third person. No boarding,
 *  no enemy crew, no chest — those left with the old BoardingSystem. */
export class PlayerCharacter {
  player: Pirate | null = null;
  playerHp = 5; // vestigial (no enemy melee); kept so the HUD hp bar stays valid

  constructor(
    private phys: Physics,
    private scene: THREE.Scene,
    private playerShip: Ship,
    private msg: MessageBus,
  ) {}

  private deckTop(ship: Ship, xM = 4): number {
    return (ship.build.deckYAt(Math.round(xM / 0.25)) + 2) * 0.25;
  }
  private midZ(ship: Ship): number { return ship.build.footprint.zC; }

  /** Re-point the captain at a freshly-built ship (after a ship swap). */
  setShip(ship: Ship): void { this.playerShip = ship; if (this.player) this.player.ship = ship; }

  spawnPlayer(): void {
    if (this.player) return;
    this.player = new Pirate(
      this.phys, this.scene, this.playerShip, "player",
      [4.2, this.deckTop(this.playerShip, 4.2), this.midZ(this.playerShip)],
      0x1d3a52, 0x1c6e6e, "captain",
    );
  }

  update(
    dt: number, simTime: number, waves: Wave[],
    input: { moveX: number; moveZ: number; jump: boolean; sprint: boolean; slash: boolean; kick: boolean },
    onFoot: boolean,
  ): void {
    if (!this.player && simTime > 1.5) this.spawnPlayer();
    if (!this.player) return;
    this.player.ship = this.playerShip; // always your own deck now
    if (onFoot) this.player.step(dt, input.moveX, input.moveZ, input.jump, waves, simTime, input.sprint);
    else this.player.idleTick(dt);
    if (onFoot && input.slash) this.player.swingAnim();   // flourish only
    if (onFoot && input.kick) this.player.kickAnim();
  }
}
```
> Verify `Pirate` method names against `crew.ts` before finalizing (`step`, `idleTick`, `swingAnim`, `kickAnim`, `pin`, `teleport`, `postPose`, `setFirstPerson`, `worldPos`, `body`, `stamina`, `swimming`). Adjust if any differ.

- [ ] **Step 2: Build** — `npm run build` (file compiles in isolation; not yet wired). Expected: PASS (unused module).

- [ ] **Step 3: Commit** — `refactor(game): extract PlayerCharacter (captain w/o boarding)`.

## Task 1.5: Rewire `main.ts` + `port.ts` to wallet/message/character; remove boarding

**Files:**
- Modify: `src/main.ts`
- Modify: `src/game/port.ts`
- Modify: `src/game/ai.ts` (the spawn factory in main.ts sets `boarding.message` — change to `gs.msg.post`)
- Delete: `src/game/boarding.ts` (once unreferenced)

This is the big mechanical swap. Do it in one task, build-verified.

- [ ] **Step 1:** In `main.ts`, construct the shell early (after `physics`/`world`, before fleet/boarding):
```ts
import { GameState } from "./game/gameState";
import { PlayerCharacter } from "./game/playerCharacter";
import { SaveManager } from "./game/saveState";
const gs = new GameState();
const saves = new SaveManager(localStorage);
```
- [ ] **Step 2:** Replace `let boarding: BoardingSystem;` and its construction with:
```ts
const character = new PlayerCharacter(physics, scene, sloop, gs.msg);
```
  (rename the existing dev-spike `character` var — the `CharacterSpike` — to `charSpike` to avoid the name clash.)
- [ ] **Step 3:** Global replace in `main.ts`:
  - `boarding.player` → `character.player`
  - `boarding.message = X` → `gs.msg.post(X)`
  - `boarding.gold` → `gs.wallet.gold`
  - `boarding.playerHp` → `character.playerHp`
  - Delete grapple block (`controls.grapplePressed` → `boarding.toggleGrapple()`), chest/`canFight`/`enemiesLeft`/`grappled`/`chestCarried`/`hasTarget`/`setEnemy`/`currentEnemy` usages and the fleet↔boarding retarget block (lines ~416–425).
  - `boarding.update(dt, t, waves, {…, slash, kick, interact}, onFoot)` → `character.update(dt, t, waves, { moveX: mv.x, moveZ: mv.z, jump: mv.jump, sprint: mv.sprint, slash, kick }, onFoot)`.
  - `boarding.player.pin(...)`, `.swimming`, `.teleport`, `.postPose`, `.setFirstPerson`, `.stamina`, `.attackTimer`, `.rig`, `.fpLookPitch/Yaw`, `.body` → `character.player.*` (unchanged field names).
  - HUD `hints` strings: drop grapple/chest/foes-on-foot text; keep the on-foot/at-wheel split.
  - `slash = boarding.canFight()` → `slash = true` (no chest gating).
- [ ] **Step 4:** `port.ts` — change `PortDeps` to take `wallet: Wallet` + `msg: MessageBus` instead of `boarding: BoardingSystem`; `mirrorGold()` → `this.wallet.set(this.economy.state.doubloons)`; every `this.boarding.message = X` → `this.msg.post(X)`. Update the constructor call in `main.ts` accordingly (`wallet: gs.wallet, msg: gs.msg`).
- [ ] **Step 5:** The fleet spawn factory callbacks (`ship.onMastFelled`, `ship.onRudderHit`) set `boarding.message` → `gs.msg.post(...)`. Same for `sloop.onMastFelled/onRudderHit`.
- [ ] **Step 6:** `updateHud` toast block: read `gs.msg.current`; on fade, `gs.msg.clear()`. Gold line: `String(gs.wallet.gold)`.
- [ ] **Step 7:** Remove `import { BoardingSystem } from "./game/boarding";`; delete `src/game/boarding.ts`. Update `DEBUG` to expose `character`, `gs`, drop `boarding`.
- [ ] **Step 8: Build + test** — `npm run build` (must be green) and `npm run test`.
- [ ] **Step 9: In-browser smoke** — `npm run dev`; sail, take/leave wheel (E), walk deck, kick (C), V camera cycle, fire broadside, make port (E at dock), buy the placeholder upgrade. Screenshot.
- [ ] **Step 10: Commit** — `refactor(game): remove boarding; route gold/toasts via Wallet/MessageBus`.

## Task 1.6: Gate the sim on phase + Esc pause

**Files:** Modify `src/main.ts`

- [ ] **Step 1:** In `renderer.setAnimationLoop`, gate the sim:
```ts
const dt = Math.min(clock.getDelta(), 0.1);
if (gs.isSimRunning()) world.step(dt);
```
  Everything below (LOD, wake, camera, render, HUD) still runs each frame so menus composite over a frozen scene. (Spray/`checkBowSpray` and `effects.update` may stay; they decay harmlessly when frozen — verify no NaN.)
- [ ] **Step 2:** Esc handler in the `keydown` listener:
```ts
if (e.code === "Escape") {
  if (gs.phase === "playing") { gs.pause(); menu.showPause(); controls.releaseLock?.(); }
  else if (gs.phase === "paused") { gs.resume(); menu.hide(); }
}
```
  (`menu` from Task 1.7; if building 1.6 first, stub `menu` calls and finish in 1.7.)
- [ ] **Step 3: Build** — `npm run build` green.
- [ ] **Step 4: Commit** — `feat(game): gate world.step on phase; Esc pause`.

## Task 1.7: Menu overlays (`menuScreen.ts`) + boot to menu

**Files:**
- Create: `src/render/menuScreen.ts`
- Modify: `src/main.ts`, `index.html` (minimal: ensure an overlay root exists or append to body like `portScreen`)

Follow the `portScreen.ts` DOM pattern (fixed overlay div, antique style, button rows). Provide:
```ts
export interface MenuActions {
  onNewCareer(): void;
  onContinue(): void;
  onSandbox(): void;
  onResume(): void;
  onQuitToMenu(): void;
  onSettingsChange(s: Partial<import("../game/saveState").Settings>): void;
}
export interface MenuScreen {
  showStart(hasCareer: boolean): void; // start menu; Continue enabled iff hasCareer
  showPause(): void;                    // Resume / Settings / Quit to Menu
  hide(): void;
  readonly isOpen: boolean;
}
export function createMenuScreen(actions: MenuActions): MenuScreen { /* DOM build */ }
```

- [ ] **Step 1:** Implement `menuScreen.ts` (DOM overlay; title "SCUTTLE", buttons; pause variant). Reuse `portScreen`'s CSS classes/inline styles for consistency.
- [ ] **Step 2:** Wire in `main.ts`:
```ts
const menu = createMenuScreen({
  onNewCareer: () => { saves.wipe("career"); applySave(saves.load("career")); gs.startGame("career"); menu.hide(); },
  onContinue: () => { applySave(saves.load("career")); gs.startGame("career"); menu.hide(); },
  onSandbox: () => { applySave(saves.load("sandbox")); gs.startGame("sandbox"); menu.hide(); },
  onResume: () => { gs.resume(); menu.hide(); },
  onQuitToMenu: () => { saveCurrent(); gs.quitToMenu(); menu.showStart(saves.hasSave("career")); },
  onSettingsChange: (s) => { /* apply + persist in Task 4.2 */ },
});
menu.showStart(saves.hasSave("career"));
```
  Define helper `applySave(s: SaveState)` (loads economy into `port`/`economy`, sets ship tier — tier swap lands in Phase 3; in P1 it just loads economy + mirrors wallet) and `saveCurrent()` (writes current economy+tier into the active slot).
- [ ] **Step 3:** Replace `port.load()` (old direct economy load) with `applySave` driven by the menu choice. Boot no longer auto-plays — it shows the start menu; the world exists but is frozen (`phase==="menu"`).
- [ ] **Step 4:** Make the port open/close drive the phase: in `port.openPort()` path set `gs.enterPort()`; in `onClose`/`closePort` set `gs.leavePort()`. (Add a callback or have main.ts wrap `port.tryDock()`/close.)
- [ ] **Step 5: Build + in-browser** — boot shows menu; New Career → plays; Esc → pause → Resume; make port freezes world; Continue appears after a save.
- [ ] **Step 6: Commit** — `feat(game): start + pause menus; boot to menu; port pauses world`.

**End of Phase 1 gate:** `npm run build` green, `npm run test` green (≥215 + new), in-browser loop verified. Commit a phase checkpoint.

---

# PHASE 2 — Upgrades & economy

Outcome: the real upgrade catalog with effects you can feel; sinking costs you something.

## Task 2.1: Real upgrade catalog + cost scaling (pure)

**Files:**
- Modify: `src/sim/economy.ts`
- Test: `tests/economy.test.ts` (extend existing)

- [ ] **Step 1: Tests** — add:
```ts
import { UPGRADES, Economy, upgradeCost } from "../src/sim/economy";
it("has the tycoon upgrades with maxLevels", () => {
  const ids = UPGRADES.map(u => u.id).sort();
  expect(ids).toEqual(["hold","hull","planks","reload","rudder","speed"].sort());
});
it("cost scales linearly per current level", () => {
  // base * (level+1)
  expect(upgradeCost(UPGRADES.find(u=>u.id==="reload")!, 0)).toBe(UPGRADES.find(u=>u.id==="reload")!.cost);
  expect(upgradeCost(UPGRADES.find(u=>u.id==="reload")!, 2)).toBe(UPGRADES.find(u=>u.id==="reload")!.cost * 3);
});
it("nextCost reflects scaling and returns null at max", () => {
  const e = new Economy({ doubloons: 99999 });
  const u = UPGRADES.find(x=>x.id==="reload")!;
  const first = e.nextCost("reload");
  e.buyUpgrade("reload");
  expect(e.nextCost("reload")).toBe(first! * 2);
  for (let i=0;i<u.maxLevel;i++) e.buyUpgrade("reload");
  expect(e.nextCost("reload")).toBeNull();
});
```
- [ ] **Step 2: Run fail** — `npm run test -- economy` → FAIL.
- [ ] **Step 3: Implement** — replace `UPGRADES` and add `upgradeCost`, and make `nextCost`/`buyUpgrade` use scaling:
```ts
export const UPGRADES: Upgrade[] = [
  { id: "reload", name: "Faster Reload",     description: "−12% cannon reload per level", cost: 180, maxLevel: 4 },
  { id: "hull",   name: "Hull Reinforcement", description: "+25% hull toughness per level", cost: 220, maxLevel: 4 },
  { id: "speed",  name: "Tall Canvas",        description: "+10% top speed per level",      cost: 160, maxLevel: 4 },
  { id: "rudder", name: "Sharper Rudder",     description: "+15% turn rate per level",       cost: 150, maxLevel: 3 },
  { id: "hold",   name: "Larger Hold",        description: "+20 cargo capacity per level",   cost: 200, maxLevel: 3 },
  { id: "planks", name: "Repair Stores",      description: "+4 repair planks per level",     cost: 150, maxLevel: 3 },
];
export function upgradeCost(u: Upgrade, currentLevel: number): number {
  return u.cost * (currentLevel + 1);
}
```
  Update `nextCost(id)` to `return lvl >= u.maxLevel ? null : upgradeCost(u, lvl);` and `buyUpgrade` to spend `upgradeCost(u, lvl)`.
- [ ] **Step 4: Run pass** — `npm run test -- economy` → PASS (fix the two existing placeholder-upgrade tests if they assert old ids).
- [ ] **Step 5: Commit** — `feat(economy): tycoon upgrade catalog + linear cost scaling`.

## Task 2.2: Ship effect hooks (`rudderPower`, `hullToughness`, reload)

**Files:** Modify `src/game/ship.ts`, `src/game/sailing.ts`, `src/game/cannons.ts`, and the carve/impact path (`src/sim/crush.ts` and/or `src/game/voxelContact.ts`, `src/game/cannons.ts` impact).

- [ ] **Step 1:** `ship.ts` — add public fields with defaults: `rudderPower = 1;` `hullToughness = 1;`.
- [ ] **Step 2:** `sailing.ts` rudder line → multiply by `ship.rudderPower`:
```ts
const yaw = this.rudder * flow * mass * 0.5 * ship.rudderEff * ship.rudderPower;
```
- [ ] **Step 3:** Player cannon reload — make the player `Cannons` reload adjustable. Add `cannons.reloadMul = 1` (per-instance) and use `this.reloadS * this.reloadMul` where `portReloadAt` is set (cannons.ts:123). The upgrade sets `cannons.reloadMul = 0.88 ** level`.
- [ ] **Step 4:** Hull durability — locate where a voxel's break-energy is tested in the shared carve (cannon + crush). Read `sim/crush.ts` + `sim/materials.ts` (`STRENGTH_TO_JOULES`) + `game/voxelContact.ts` + cannon impact in `cannons.ts`. Thread a per-ship toughness multiplier: the energy required to break a cell of ship S = base × `S.hullToughness`. Concretely, where the carve consumes the energy budget per cell for a target ship, divide the available budget by `target.hullToughness` (or multiply the cell cost). Apply to BOTH the cannonball impact path and the ship-ship crush path so durability is uniform. If the crush path can't be threaded cleanly in one pass, apply to the cannon-impact path first and leave a `// TODO durability: crush path` note (spec §7.5 fallback).
- [ ] **Step 5: Build** — `npm run build` green.
- [ ] **Step 6: In-browser** — via `DEBUG`: set `DEBUG.sloop.hullToughness = 3`, fire at it (or ram), confirm fewer voxels removed vs default using `DEBUG.contact.debug.removedA/B` and single-step readbacks.
- [ ] **Step 7: Commit** — `feat(ship): rudderPower + hullToughness + per-instance reload multiplier`.

## Task 2.3: Apply upgrades to the live ship (port.ts)

**Files:** Modify `src/game/port.ts`

- [ ] **Step 1:** Extend `applyUpgrades()` to set, from `economy.upgradeLevel(id)`:
  - `economy.cargoCapacity` (exists), `ship.planks` cap (exists),
  - `playerCannons.reloadMul = 0.88 ** lvl("reload")`,
  - `ship.hullToughness = 1 + 0.25 * lvl("hull")`,
  - `ship.rudderPower = 1 + 0.15 * lvl("rudder")`,
  - `sailing.boost = 1 + 0.10 * lvl("speed")`.
  `PortController` needs refs to the player `Cannons` and `SailingController`; add them to `PortDeps` (`cannons`, `sailing`) and pass from main.ts. `applyUpgrades()` is already called on load + after each buy → idempotent and re-applied after ship swap (Phase 3).
- [ ] **Step 2: Build + in-browser** — buy each upgrade at port; confirm: reload bar faster, top speed up, turn sharper, hull tougher, hold bigger, planks restored.
- [ ] **Step 3: Commit** — `feat(port): apply tycoon upgrades to the live ship`.

## Task 2.4: Sinking penalty + respawn (Career)

**Files:** Modify `src/main.ts` (+ small helper)

- [ ] **Step 1:** Add a player-sunk check in `onFixedStep` (after the enemy-salvage loop):
```ts
if (gs.mode === "career" && isSunk(sloop) && !respawning) {
  respawning = true;
  // penalty
  economy.state.cargo = {};
  economy.state.doubloons = Math.floor(economy.state.doubloons * 0.75);
  port.applyUpgrades(); gs.wallet.set(economy.state.doubloons);
  respawnPlayerShip(); // reset hull state + teleport to home port
  gs.msg.post("YOUR SHIP IS LOST — you wash ashore at port, 25% of your gold gone.");
  saveCurrent();
  respawning = false;
}
```
  Sandbox: on `isSunk(sloop)` just `respawnPlayerShip()` with no economy loss.
- [ ] **Step 2:** Implement `respawnPlayerShip()`: the simplest robust path is to **rebuild** the player ship at the home port via the same swap routine Phase 3 introduces. For Phase 2 (before swap exists), reset in place: clear flooding/breaches/waterlog, restore planks/sails/rudder (reuse `port.applyRepair()` made public, or replicate), zero velocity, and `setTranslation` to `islands.nearestDock(...) + seaward offset` (mirror the `?at=harbor` block). Re-seat the captain via `character.spawnPlayer()`/`teleport`.
- [ ] **Step 3: Build + in-browser** — scuttle yourself (dev: ram an island or set waterlog), confirm respawn at port, gold −25%, cargo cleared, upgrades retained.
- [ ] **Step 4: Commit** — `feat(game): career sinking penalty + respawn at home port`.

## Task 2.5: HUD — notoriety + ship tier

**Files:** Modify `index.html` (add a small readout), `src/main.ts` (`updateHud`)

- [ ] **Step 1:** Add to the gold panel (or a new line): notoriety value (`economy.state.notoriety`) and current tier label (`save.shipTier`/`gs`-tracked). Update in `updateHud`.
- [ ] **Step 2: Build + in-browser** — sink ships, watch notoriety climb.
- [ ] **Step 3: Commit** — `feat(hud): notoriety + ship tier readout`.

**End of Phase 2 gate:** build green, tests green, the upgrade-and-survive loop verified in-browser.

---

# PHASE 3 — Ship tiers & escalation

Outcome: a real progression spine — start in a Cutter, sink classes to unlock them, buy up the ladder, face escalating fleets.

## Task 3.1: New hulls `buildCutter` + `buildFrigate`

**Files:** Modify `src/sim/shipwright.ts`

- [ ] **Step 1:** Read `buildSloop` (≈ lines 54–291) and `buildBrig` (≈ 302–577) fully to learn the hull-build contract (`buildHull`/grid dims, `deckYAt`, `footprint`, `cannonPorts`, `masts`, ballast trim, `armorBow`, returned `ShipBuild` fields).
- [ ] **Step 2:** `buildCutter()` — a hull **smaller** than the sloop: shorter grid (~80×26×28), 1 mast, 2–3 guns/side + chasers, shallow hold (1 compartment), light ballast for upright trim. The cheap starter + early prey.
- [ ] **Step 3:** `buildFrigate()` — a hull **larger** than the brig: longer/taller grid (~180×48×50), 2–3 masts, 6–7 guns/side + chasers, more compartments, heavier ballast. The late-game flagship.
- [ ] **Step 4:** Sanity in browser: temporarily make the player each new hull (swap `buildBrig()`), confirm it floats upright at a sane draft, sails, and fires. Tune ballast like the existing builders until trim is good (use the dev readout pitch/heel).
- [ ] **Step 5: Build + commit** — `feat(shipwright): buildCutter + buildFrigate hulls`.

## Task 3.2: Shipyard catalog + rules (pure)

**Files:**
- Create: `src/game/shipyard.ts`
- Test: `tests/shipyard.test.ts`

- [ ] **Step 1: Tests** (`tests/shipyard.test.ts`)
```ts
import { describe, it, expect } from "vitest";
import { SHIP_TIERS, tierOrder, canBuy, nextTier } from "../src/game/shipyard";

describe("shipyard", () => {
  it("orders cutter→sloop→brig→frigate", () => {
    expect(tierOrder()).toEqual(["cutter","sloop","brig","frigate"]);
  });
  it("buy needs gold AND the class unlocked", () => {
    const tier = SHIP_TIERS.find(t=>t.id==="brig")!;
    expect(canBuy(tier, { gold: tier.price, unlocked: ["cutter","sloop","brig"], current: "sloop" }).ok).toBe(true);
    expect(canBuy(tier, { gold: tier.price - 1, unlocked: ["cutter","sloop","brig"], current: "sloop" }).reason).toBe("broke");
    expect(canBuy(tier, { gold: tier.price, unlocked: ["cutter","sloop"], current: "sloop" }).reason).toBe("locked");
  });
  it("cannot buy a tier you already own (current)", () => {
    const tier = SHIP_TIERS.find(t=>t.id==="sloop")!;
    expect(canBuy(tier, { gold: 99999, unlocked: ["cutter","sloop"], current: "sloop" }).reason).toBe("owned");
  });
});
```
- [ ] **Step 2: Run fail.**
- [ ] **Step 3: Implement** (`src/game/shipyard.ts`) — tier metadata + builders + rules:
```ts
import { buildCutter, buildSloop, buildBrig, buildFrigate, type ShipBuild } from "../sim/shipwright";
import type { ShipTierId } from "./saveState";

export interface ShipTier { id: ShipTierId; name: string; price: number; build: () => ShipBuild; }
export const SHIP_TIERS: ShipTier[] = [
  { id: "cutter",  name: "Cutter",  price: 0,    build: buildCutter },
  { id: "sloop",   name: "Sloop",   price: 600,  build: buildSloop },
  { id: "brig",    name: "Brig",    price: 1800, build: buildBrig },
  { id: "frigate", name: "Frigate", price: 4200, build: buildFrigate },
];
export const tierOrder = (): ShipTierId[] => SHIP_TIERS.map(t => t.id);
export const tierById = (id: ShipTierId) => SHIP_TIERS.find(t => t.id === id)!;

export interface BuyCtx { gold: number; unlocked: ShipTierId[]; current: ShipTierId; }
export function canBuy(tier: ShipTier, ctx: BuyCtx): { ok: boolean; reason?: "owned"|"locked"|"broke" } {
  if (tier.id === ctx.current) return { ok: false, reason: "owned" };
  if (!ctx.unlocked.includes(tier.id)) return { ok: false, reason: "locked" };
  if (ctx.gold < tier.price) return { ok: false, reason: "broke" };
  return { ok: true };
}
export function nextTier(current: ShipTierId): ShipTier | null {
  const order = tierOrder(); const i = order.indexOf(current);
  return i >= 0 && i < order.length - 1 ? tierById(order[i+1]) : null;
}
```
  > Requires `buildCutter`/`buildFrigate` exported from shipwright (Task 3.1) and `ShipBuild` type exported.
- [ ] **Step 4: Run pass; commit** — `feat(shipyard): tier catalog + buy/unlock rules`.

## Task 3.3: Ship-swap procedure + centralized player-ship ref

**Files:** Modify `src/main.ts`

The hard part: many systems hold a `sloop` reference. Introduce a single mutable `let player: Ship = sloop;` and route a `swapPlayerShip(tierId)` that rebuilds and repoints.

- [ ] **Step 1:** Audit every `sloop` use (it's the player ship). Replace with a `player` variable where the reference must follow swaps: `world.addShip/removeShip`, `sailing.apply`, `cannons.fireBroadside`, `port` (`port.ship`), `fleet` target, `character.setShip`, HUD reads, wake/profile slot 0, cutaway, camera, seam list, `onMastFelled/onRudderHit`, `spans`, dyn ships. (Keep the historic name `sloop` as the initial value or rename to `player` throughout — prefer rename for clarity.)
- [ ] **Step 2:** Implement `swapPlayerShip(tierId)`:
```ts
function swapPlayerShip(tierId: ShipTierId) {
  const at = player.body.translation();
  const rot = player.body.rotation();
  world.removeShip(player);
  player.visual.dispose?.(); scene.remove(player.visual.group);
  const build = tierById(tierId).build();
  const visual = new ShipVisual(build);
  const fresh = new Ship(physics, build, visual, { x: at.x, y: 0.5, z: at.z });
  fresh.body.setRotation(rot, true);
  fresh.onSevered = (isl) => isl.forEach(i => debris.spawn(i, fresh));
  fresh.onMastFelled = () => gs.msg.post("YOUR MAST GOES BY THE BOARD!");
  fresh.onRudderHit = (hp) => { visual.chipRudder(hp/3); gs.msg.post(hp>0?"rudder hit — she answers slow!":"RUDDER SHOT AWAY!"); };
  world.addShip(fresh);
  player = fresh; sloopVisual = visual; // update visual ref used by HUD/animate
  port.setShip(fresh); fleet.setTarget(fresh); character.setShip(fresh);
  // refresh profile/wake slot 0, spans[0], ocean footprint, seam — recompute from `player`
  rebindPlayerRenderHooks();
  port.applyUpgrades(); // re-apply account-wide upgrades to the new hull
  currentTier = tierId;
}
```
  Add `FleetManager.setTarget(ship)` (set `this.target` — small change in fleet.ts) and ensure `port.setShip` exists (add: `setShip(s){ this.ship = s; }`). Factor the player render-hook setup (profile tex slot 0, `spans[0]`, `ocean.setFootprint`, seam list) into `rebindPlayerRenderHooks()` so swap and init share it.
- [ ] **Step 3: Build + in-browser** — call `DEBUG`-exposed `swapPlayerShip("brig")` mid-game; confirm the new hull sails, fires, floats; camera/HUD/port all follow; no dangling refs to the old body.
- [ ] **Step 4: Commit** — `feat(game): swapPlayerShip + centralized player-ship reference`.

## Task 3.4: Shipyard tab in the port screen + buy wiring

**Files:** Modify `src/render/portScreen.ts`, `src/game/port.ts`, `src/main.ts`

- [ ] **Step 1:** Extend `PortView` with `ships: { id, name, price, state: "owned"|"locked"|"buy", affordable }[]` and render a "Shipyard" section listing tiers with a Buy/locked/owned button. Add `onBuyShip(id)` to `PortActions`.
- [ ] **Step 2:** `port.ts`: `buyShip(id)` → check `canBuy` against `wallet.gold`/`unlockedClasses`/`currentTier`; if ok, `economy.spend(price)`, call an injected `onSwapShip(id)` callback (main.ts passes `swapPlayerShip`), refresh view. Track `unlockedClasses` + `currentTier` (pass getters/refs from main, sourced from the save).
- [ ] **Step 3:** `view()` includes ship rows via `SHIP_TIERS` + `canBuy`.
- [ ] **Step 4: Build + in-browser** — give yourself gold (`DEBUG.economy.state.doubloons = 9999`), unlock (`DEBUG`), buy the next ship at port; confirm swap.
- [ ] **Step 5: Commit** — `feat(port): shipyard tab — buy ships gated by gold + unlock`.

## Task 3.5: Start in Cutter + unlock-on-defeat + persist tier

**Files:** Modify `src/main.ts`, `src/game/port.ts`/`saveState` glue

- [ ] **Step 1:** Player initial build = `buildCutter()` (or driven by loaded `save.shipTier`). `applySave` now also calls `swapPlayerShip(save.shipTier)` if it differs from current.
- [ ] **Step 2:** On enemy sunk (`port.plunder(e)` site), record the defeated enemy's tier into `unlockedClasses` (dedupe) and persist. Enemies must carry their tier — have the fleet spawner tag `ship.tierId` (or map build→tier). Post a toast on first unlock: `"You've proven your guns against the <Tier> — the shipyard will sell you one."`.
- [ ] **Step 3:** `saveCurrent()` writes `economy`, `shipTier=currentTier`, `unlockedClasses`. Save on make-port, pause, and respawn.
- [ ] **Step 4: Build + in-browser** — New Career starts in the Cutter; sink a Sloop → Sloop unlocks; make port → buy Sloop; Continue restores tier + unlocks.
- [ ] **Step 5: Commit** — `feat(game): start in Cutter; unlock classes by defeating them; persist tier`.

## Task 3.6: Notoriety-scaled tiered fleet spawner

**Files:**
- Create: `src/sim/fleetSpawn.ts` (pure weighting) + test `tests/fleetSpawn.test.ts`
- Modify: `src/game/fleet.ts` usage in `src/main.ts`

- [ ] **Step 1: Tests** — pure `pickEnemyTier(notoriety, playerTier, rand)` weighting:
```ts
import { describe, it, expect } from "vitest";
import { tierWeights, pickEnemyTier } from "../src/sim/fleetSpawn";
it("low notoriety favors small ships", () => {
  const w = tierWeights(0, "cutter");
  expect(w.cutter).toBeGreaterThan(w.frigate);
});
it("high notoriety raises big-ship weight", () => {
  const lo = tierWeights(0, "cutter"); const hi = tierWeights(100, "frigate");
  expect(hi.frigate).toBeGreaterThan(lo.frigate);
});
it("pickEnemyTier is deterministic for a given rand", () => {
  expect(pickEnemyTier(0, "cutter", () => 0)).toBe("cutter");
});
```
- [ ] **Step 2: Implement** `fleetSpawn.ts` — return weights per tier as a function of notoriety (0..∞) and player tier, and a deterministic picker over a `rand()`.
- [ ] **Step 3:** In `main.ts`, the `spawnEnemy` factory picks `const tierId = pickEnemyTier(economy.state.notoriety, currentTier, Math.random)`, builds that hull, tags `ship.tierId = tierId`, and (optionally) nudges `TUN.fleet.enemyCount` upward with notoriety bands (career only; sandbox uses the slider). Each enemy still shares LOD via its build; note: ocean profile slot 1 assumes buildSloop — generalize the premium-enemy profile to rebuild per premium tier OR keep slot-1 cut approximate (acceptable; document).
- [ ] **Step 4: Build + in-browser** — early game spawns small hulls; raise `DEBUG.economy.state.notoriety` and confirm bigger hulls appear.
- [ ] **Step 5: Commit** — `feat(fleet): notoriety-scaled tiered enemy spawns`.

**End of Phase 3 gate:** build green, tests green, full progression verified: Cutter → sink → unlock → buy → escalate.

---

# PHASE 4 — Sandbox & polish

## Task 4.1: Sandbox config + sliders panel

**Files:** Modify `src/main.ts`, `src/render/menuScreen.ts` (or a small `sandboxPanel`)

- [ ] **Step 1:** In sandbox mode: all tiers `unlockedClasses = tierOrder()`, give a large starting gold (or make shipyard/upgrades free when `gs.isSandbox()`), and surface a friendly panel with enemy count/tier sliders (reuse the dev-panel control pattern; the `TUN.fleet.enemyCount` slider already exists — expose it without the full dev panel). No career penalties (Task 2.4 already branches on mode).
- [ ] **Step 2:** Sandbox save slot is optional — persist if present, else ephemeral (default: persist to its own slot so settings stick).
- [ ] **Step 3: Build + in-browser** — Sandbox from menu: all ships buyable/free, sliders work, no penalty on sinking.
- [ ] **Step 4: Commit** — `feat(game): sandbox mode (all unlocked, enemy sliders, no stakes)`.

## Task 4.2: Settings persistence + menu/HUD polish + balance pass

**Files:** Modify `src/render/menuScreen.ts`, `src/main.ts`, `index.html`

- [ ] **Step 1:** Settings (master volume, default camera) read/written through the active save's `settings`; apply on load (camera default → initial `camMode`).
- [ ] **Step 2:** Polish: menu styling, HUD next-unlock hint, ensure pointer-lock releases on menu/port/pause and re-grabs on resume.
- [ ] **Step 3:** Balance pass: tune upgrade `base` costs, tier prices, plunder payout vs costs, the 25% penalty, escalation bands so early Cutter play → first Sloop in a satisfying number of kills. Adjust in code constants; re-verify.
- [ ] **Step 4: Build + full smoke** — Playwright end-to-end: menu → New Career → sink → port → upgrade → buy ship → escalate → pause → quit → Continue.
- [ ] **Step 5: Commit** — `feat(game): settings persistence + menu/HUD polish + balance pass`.

**End of Phase 4 gate:** full `npm run build` + `npm run test` green; end-to-end loop verified in-browser; ready for PR to `main`.

---

## Cross-cutting verification checklist (run before declaring done)
- [ ] `npm run build` clean (tsc + vite).
- [ ] `npm run test` green (≥215 baseline + new wallet/gameState/saveState/economy/shipyard/fleetSpawn tests).
- [ ] In-browser at `:5173`: menu → career → sail → sink a small ship → port → buy each upgrade (feel the effect) → buy next ship (swap works) → notoriety escalates fleet → sink yourself → respawn w/ penalty → quit → Continue restores everything → Sandbox unlocked/free.
- [ ] No `boarding` references remain; `DEBUG` exposes `character`, `gs`, `port`, `economy`, `saves`.
- [ ] Determinism intact: gating is at the `world.step` call site only; the sim oracle tests still pass.

## Risks & fallbacks (from spec §7)
- Hull-durability crush-path threading (Task 2.4 / 2.2 step 4): if not cleanly threadable in one pass, ship cannon-impact durability first, note the crush-path TODO.
- Premium ocean profile assumes a sloop enemy (Task 3.6): acceptable approximation if per-tier premium profile is costly; document it.
- `main.ts` is large; do the boarding swap (Task 1.5) as a focused mechanical pass and build-verify immediately.
```
