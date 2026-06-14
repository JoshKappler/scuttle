/**
 * The plunder economy — PURE core (no THREE / Rapier / DOM / clocks / globals).
 *
 * This is the deterministic, unit-tested model behind the tycoon loop: a wallet
 * (doubloons), a cargo hold, an upgrade catalog, and the transactions that move
 * value between them (plunder in, sell/repair/buy out). The game layer
 * (`game/port.ts`) wires this to the world, the ship, the dock and localStorage;
 * the UI (`render/portScreen.ts`) renders a view-model. Keeping this file
 * engine-free is what lets the whole economy be tested like the sim oracle.
 *
 * The catalogs below (GOODS, UPGRADES) are deliberately a tiny placeholder set:
 * this ships the FRAMEWORK, not the content. Add rows freely — nothing here
 * hard-codes their count.
 */

export type GoodId = string;
export interface Good {
  id: GoodId;
  name: string;
  basePrice: number; // doubloons per unit at a neutral market (mult = 1)
}

export type UpgradeId = string;
export interface Upgrade {
  id: UpgradeId;
  name: string;
  description: string;
  cost: number; // flat cost of the next level (framework can scale per-level later)
  maxLevel: number;
}

export interface EconomyState {
  version: number; // bumped when the save shape changes; deserialize tolerates drift
  doubloons: number;
  cargo: Record<GoodId, number>; // good → units held
  cargoCapacity: number; // total units the hold carries
  upgrades: Record<UpgradeId, number>; // upgrade → level owned
  notoriety: number; // accrues with plunder; gates nothing yet (tracked for later)
}

export interface LootBundle {
  doubloons: number;
  cargo: Record<GoodId, number>;
  notoriety: number;
}

export const ECONOMY_VERSION = 1;
export const DEFAULT_CARGO_CAPACITY = 40;
export const REPAIR_FULL_COST = 120; // doubloons to bring a wholly-wrecked hull back to new

/** Seed goods — placeholder content, pure data. */
export const GOODS: Record<GoodId, Good> = {
  rum: { id: "rum", name: "Rum", basePrice: 12 },
  spice: { id: "spice", name: "Spice", basePrice: 25 },
  silk: { id: "silk", name: "Silk", basePrice: 40 },
};

/** Seed upgrades — placeholder content, pure data. Effects are applied in the game layer. */
export const UPGRADES: Upgrade[] = [
  { id: "hold", name: "Larger Hold", description: "+20 cargo capacity per level", cost: 200, maxLevel: 3 },
  { id: "planks", name: "Reinforced Planks", description: "+4 repair planks per level", cost: 150, maxLevel: 3 },
];

export function defaultState(): EconomyState {
  return {
    version: ECONOMY_VERSION,
    doubloons: 0,
    cargo: {},
    cargoCapacity: DEFAULT_CARGO_CAPACITY,
    upgrades: {},
    notoriety: 0,
  };
}

/** Cost to repair a hull at damage fraction `damage01` ∈ [0,1]. 0 at no damage, monotonic. */
export function repairQuote(damage01: number): number {
  const d = Math.min(1, Math.max(0, damage01));
  return Math.round(d * REPAIR_FULL_COST);
}

/**
 * Generate loot for a ship of the given `shipValue` (e.g. hull cell count).
 * `rand` is an injected [0,1) source (a seeded `Rng.next` in game, a fake in
 * tests) so this is fully deterministic. Richer ships drop more doubloons.
 */
export function rollLoot(rand: () => number, shipValue: number): LootBundle {
  const v = Math.max(0, shipValue);
  const doubloons = Math.round(v * 0.5 * (0.6 + rand() * 0.8));
  const ids = Object.keys(GOODS);
  const pick = ids.length ? ids[Math.floor(rand() * ids.length) % ids.length] : undefined;
  const qty = 1 + Math.floor(rand() * 3); // 1..3 units
  const cargo: Record<GoodId, number> = {};
  if (pick) cargo[pick] = qty;
  const notoriety = Math.max(1, Math.round(v / 50));
  return { doubloons, cargo, notoriety };
}

export class Economy {
  state: EconomyState;

  constructor(init?: Partial<EconomyState>) {
    const d = defaultState();
    this.state = {
      version: ECONOMY_VERSION,
      doubloons: init?.doubloons ?? d.doubloons,
      cargo: { ...(init?.cargo ?? d.cargo) },
      cargoCapacity: init?.cargoCapacity ?? d.cargoCapacity,
      upgrades: { ...(init?.upgrades ?? d.upgrades) },
      notoriety: init?.notoriety ?? d.notoriety,
    };
  }

  // ---- queries ----
  cargoUsed(): number {
    let n = 0;
    for (const k in this.state.cargo) n += this.state.cargo[k];
    return n;
  }
  cargoFree(): number {
    return Math.max(0, this.state.cargoCapacity - this.cargoUsed());
  }
  priceOf(good: GoodId, mult = 1): number {
    const g = GOODS[good];
    return g ? g.basePrice * mult : 0;
  }
  upgradeLevel(id: UpgradeId): number {
    return this.state.upgrades[id] ?? 0;
  }
  nextCost(id: UpgradeId): number | null {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u) return null;
    return this.upgradeLevel(id) >= u.maxLevel ? null : u.cost;
  }
  canAfford(cost: number): boolean {
    return this.state.doubloons >= cost;
  }

  // ---- mutations ----
  /** Take plunder in. Cargo stores up to capacity; the overflow is reported as `lost`. */
  addLoot(loot: LootBundle): { stored: Record<GoodId, number>; lost: Record<GoodId, number> } {
    this.state.doubloons += loot.doubloons;
    this.state.notoriety += loot.notoriety;
    const stored: Record<GoodId, number> = {};
    const lost: Record<GoodId, number> = {};
    let free = this.cargoFree();
    for (const id of Object.keys(loot.cargo)) {
      const want = loot.cargo[id];
      const take = Math.max(0, Math.min(want, free));
      if (take > 0) {
        this.state.cargo[id] = (this.state.cargo[id] ?? 0) + take;
        stored[id] = take;
        free -= take;
      }
      const miss = want - take;
      if (miss > 0) lost[id] = miss;
    }
    return { stored, lost };
  }

  /** Generic deduct if affordable. */
  spend(amount: number): boolean {
    if (!this.canAfford(amount)) return false;
    this.state.doubloons -= amount;
    return true;
  }

  /** Sell the whole hold at `mult` × base price; returns the doubloons gained. */
  sellAll(mult = 1): number {
    let total = 0;
    for (const id of Object.keys(this.state.cargo)) total += this.priceOf(id, mult) * this.state.cargo[id];
    this.state.cargo = {};
    this.state.doubloons += total;
    return total;
  }

  buyUpgrade(id: UpgradeId): { ok: boolean; reason?: "broke" | "maxed" | "unknown" } {
    const u = UPGRADES.find((x) => x.id === id);
    if (!u) return { ok: false, reason: "unknown" };
    if (this.upgradeLevel(id) >= u.maxLevel) return { ok: false, reason: "maxed" };
    if (!this.canAfford(u.cost)) return { ok: false, reason: "broke" };
    this.state.doubloons -= u.cost;
    this.state.upgrades[id] = this.upgradeLevel(id) + 1;
    return { ok: true };
  }

  // ---- persistence ----
  serialize(): string {
    return JSON.stringify(this.state);
  }

  /** Tolerant of null / parse errors / partial or old-version JSON → sane defaults. */
  static deserialize(json: string | null): Economy {
    if (!json) return new Economy();
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return new Economy();
    }
    if (!parsed || typeof parsed !== "object") return new Economy();
    return new Economy(parsed as Partial<EconomyState>);
  }
}
