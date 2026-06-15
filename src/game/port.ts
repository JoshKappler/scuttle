/**
 * PortController — the glue between the pure {@link Economy}, the world/ship, the
 * dock, the save file, and the port UI. This is the only place that knows about
 * all of them; the economy stays engine-free and the UI stays dumb.
 *
 * Compatibility contract:
 *  - The wallet of record is a standalone {@link Wallet} (the HUD reads it). After
 *    every economy mutation we mirror `economy.doubloons → wallet`, and surface
 *    feedback through the {@link MessageBus} toast channel.
 *  - Docking depends only on the tiny {@link DockProvider} interface, which the
 *    islands branch's `IslandField.nearestDock(x,z)` already satisfies. On this
 *    branch we fall back to {@link DevDockProvider} so the loop is testable solo.
 *  - {@link plunder} takes any Ship, so the multi-ship fleet can call it per kill.
 */

import { Economy, GOODS, UPGRADES, DEFAULT_CARGO_CAPACITY, repairQuote, rollLoot } from "../sim/economy";
import { Rng } from "../core/rng";
import type { Ship } from "./ship";
import type { Wallet } from "./wallet";
import type { MessageBus } from "./messageBus";
import type { PortScreen, PortView } from "../render/portScreen";

/** The world-space dock anchor lookup. `IslandField` satisfies this structurally. */
export interface DockProvider {
  nearestDock(x: number, z: number): { x: number; y: number; z: number } | null;
}

/** Stand-in dock for this branch (no islands yet): one fixed anchor near spawn. */
export class DevDockProvider implements DockProvider {
  constructor(private anchor: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }) {}
  nearestDock(): { x: number; y: number; z: number } {
    return { ...this.anchor };
  }
}

export interface PortDeps {
  economy: Economy;
  ship: Ship; // the player ship — upgrade/repair effects land here
  wallet: Wallet; // gold of record (mirrored from economy.doubloons)
  msg: MessageBus; // toast channel for port feedback
  ui: PortScreen;
  getPlayerPos: () => { x: number; z: number };
  dock?: DockProvider; // omit on this branch → DevDockProvider
  rand?: () => number; // loot RNG (defaults to a seeded source)
  portName?: string;
  saveKey?: string;
}

const DOCK_RANGE = 22; // metres within which you may make port
const BASE_PLANKS = 8; // matches Ship.planks default
const SAVE_KEY = "scuttle.economy.v1";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export class PortController {
  canDock = false;

  private economy: Economy;
  private ship: Ship;
  private wallet: Wallet;
  private msg: MessageBus;
  private ui: PortScreen;
  private getPlayerPos: () => { x: number; z: number };
  private dock: DockProvider;
  private rand: () => number;
  private portName: string;
  private saveKey: string;
  private hintShown = false;

  constructor(d: PortDeps) {
    this.economy = d.economy;
    this.ship = d.ship;
    this.wallet = d.wallet;
    this.msg = d.msg;
    this.ui = d.ui;
    this.getPlayerPos = d.getPlayerPos;
    this.dock = d.dock ?? new DevDockProvider();
    const rng = new Rng("plunder");
    this.rand = d.rand ?? (() => rng.next());
    this.portName = d.portName ?? "Hidden Cove";
    this.saveKey = d.saveKey ?? SAVE_KEY;
  }

  get isOpen(): boolean {
    return this.ui.isOpen;
  }

  // ---- per-step: dock proximity + hint ----
  update(_dt: number): void {
    if (this.ui.isOpen) return;
    const p = this.getPlayerPos();
    const d = this.dock.nearestDock(p.x, p.z);
    const near = !!d && Math.hypot(d.x - p.x, d.z - p.z) <= DOCK_RANGE;
    this.canDock = near;
    if (near && !this.hintShown) {
      this.msg.post("press E — make port");
      this.hintShown = true;
    } else if (!near) {
      this.hintShown = false;
    }
  }

  tryDock(): void {
    if (this.canDock && !this.ui.isOpen) this.openPort();
  }

  openPort(): void {
    this.save(); // making port banks your progress
    this.ui.open(this.view());
  }

  closePort(): void {
    this.save();
    this.ui.close();
  }

  // ---- plunder: a sunk ship → loot into the wallet ----
  plunder(ship: Ship): void {
    const loot = rollLoot(this.rand, this.shipValue(ship));
    const res = this.economy.addLoot(loot);
    this.mirrorGold();
    const lost = Object.values(res.lost).reduce((a, b) => a + b, 0);
    const tail = lost > 0 ? ` (hold full — ${lost} lost to the deep)` : "";
    this.msg.post(`PLUNDER — ⛀ ${loot.doubloons} + cargo${tail}. Sail on.`);
  }

  // ---- port actions (called by the UI) ----
  sell(): void {
    this.economy.sellAll();
    this.mirrorGold();
    this.ui.refresh(this.view());
  }

  repair(): void {
    const cost = repairQuote(this.shipDamage01());
    if (cost > 0 && this.economy.spend(cost)) {
      this.applyRepair();
      this.mirrorGold();
    }
    this.ui.refresh(this.view());
  }

  buy(id: string): void {
    if (this.economy.buyUpgrade(id).ok) {
      this.applyUpgrades();
      this.mirrorGold();
    }
    this.ui.refresh(this.view());
  }

  // ---- persistence ("save at the docks") ----
  save(): void {
    try {
      localStorage.setItem(this.saveKey, this.economy.serialize());
    } catch {
      /* storage unavailable (private mode / headless) — skip silently */
    }
  }

  load(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(this.saveKey);
    } catch {
      raw = null;
    }
    this.economy.state = Economy.deserialize(raw).state;
    this.applyUpgrades(); // re-derive capacity & re-apply owned buffs to the fresh ship
    this.mirrorGold();
  }

  // ---- view-model for the dumb UI ----
  private view(): PortView {
    const e = this.economy;
    const cargo = Object.keys(e.state.cargo)
      .filter((id) => e.state.cargo[id] > 0)
      .map((id) => ({
        name: GOODS[id]?.name ?? id,
        qty: e.state.cargo[id],
        value: e.priceOf(id) * e.state.cargo[id],
      }));
    const upgrades = UPGRADES.map((u) => {
      const cost = e.nextCost(u.id);
      return {
        id: u.id,
        name: u.name,
        desc: u.description,
        level: e.upgradeLevel(u.id),
        maxLevel: u.maxLevel,
        cost,
        affordable: cost !== null && e.canAfford(cost),
      };
    });
    return {
      portName: this.portName,
      doubloons: e.state.doubloons,
      notoriety: e.state.notoriety,
      cargo,
      cargoUsed: e.cargoUsed(),
      cargoCap: e.state.cargoCapacity,
      repairCost: repairQuote(this.shipDamage01()),
      upgrades,
    };
  }

  // ---- ship glue ----
  private mirrorGold(): void {
    this.wallet.set(this.economy.state.doubloons);
  }

  private maxPlanks(): number {
    return BASE_PLANKS + 4 * this.economy.upgradeLevel("planks");
  }

  private shipValue(ship: Ship): number {
    let cells = 0;
    for (const c of ship.columns) cells += c.cellY.length;
    return cells > 0 ? cells : 100;
  }

  /** Repairable damage as 0..1 (the things `applyRepair` actually fixes). */
  private shipDamage01(): number {
    const s = this.ship;
    const sail = s.sailIntegrity.length
      ? s.sailIntegrity.reduce((a, v) => a + (1 - v), 0) / s.sailIntegrity.length
      : 0;
    const rudder = clamp01((3 - s.rudderHp) / 3);
    const maxP = this.maxPlanks();
    const planks = maxP > 0 ? clamp01((maxP - s.planks) / maxP) : 0;
    const breach = s.hasBreaches() ? 0.4 : 0;
    return clamp01(Math.max(sail, rudder, planks, breach));
  }

  private applyRepair(): void {
    const s = this.ship;
    for (let i = 0; i < s.sailIntegrity.length; i++) if (s.mastAlive[i]) s.sailIntegrity[i] = 1;
    s.rudderHp = 3;
    s.rudderEff = 1;
    let guard = 64;
    while (s.hasBreaches() && s.planks > 0 && guard-- > 0) s.plugBreach();
    s.planks = this.maxPlanks();
  }

  /** Map owned upgrade levels onto ship/economy buffs. Idempotent. */
  private applyUpgrades(): void {
    this.economy.state.cargoCapacity = DEFAULT_CARGO_CAPACITY + 20 * this.economy.upgradeLevel("hold");
    const maxP = this.maxPlanks();
    if (this.ship.planks < maxP) this.ship.planks = maxP;
  }
}
