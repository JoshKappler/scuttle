import { describe, it, expect } from "vitest";
import { Economy, GOODS, UPGRADES, rollLoot, repairQuote } from "../src/sim/economy";
import { Rng } from "../src/core/rng";

const firstGood = Object.keys(GOODS)[0];
const firstUpgrade = UPGRADES[0];

describe("Economy — defaults & queries", () => {
  it("starts with an empty wallet, empty hold, and zero notoriety", () => {
    const e = new Economy();
    expect(e.state.doubloons).toBe(0);
    expect(e.cargoUsed()).toBe(0);
    expect(e.state.notoriety).toBe(0);
    expect(e.cargoFree()).toBe(e.state.cargoCapacity);
    expect(e.state.cargoCapacity).toBeGreaterThan(0);
  });

  it("accepts partial initial state and fills the rest with defaults", () => {
    const e = new Economy({ doubloons: 500 });
    expect(e.state.doubloons).toBe(500);
    expect(e.cargoUsed()).toBe(0);
    expect(e.state.cargoCapacity).toBeGreaterThan(0);
  });

  it("priceOf scales with the market multiplier", () => {
    const e = new Economy();
    const base = GOODS[firstGood].basePrice;
    expect(e.priceOf(firstGood)).toBe(base);
    expect(e.priceOf(firstGood, 2)).toBe(base * 2);
    expect(e.priceOf("not-a-good")).toBe(0);
  });
});

describe("Economy — plunder intake (addLoot)", () => {
  it("adds doubloons and notoriety", () => {
    const e = new Economy();
    e.addLoot({ doubloons: 120, cargo: {}, notoriety: 7 });
    expect(e.state.doubloons).toBe(120);
    expect(e.state.notoriety).toBe(7);
  });

  it("stores cargo up to capacity and reports the overflow as lost", () => {
    const e = new Economy({ cargoCapacity: 5 });
    const res = e.addLoot({ doubloons: 0, cargo: { [firstGood]: 8 }, notoriety: 0 });
    expect(e.cargoUsed()).toBe(5);
    expect(res.stored[firstGood]).toBe(5);
    expect(res.lost[firstGood]).toBe(3);
    expect(e.cargoFree()).toBe(0);
  });
});

describe("Economy — transactions", () => {
  it("sellAll converts the hold to doubloons at price and empties it", () => {
    const e = new Economy();
    e.addLoot({ doubloons: 0, cargo: { [firstGood]: 3 }, notoriety: 0 });
    const gained = e.sellAll();
    expect(gained).toBe(3 * GOODS[firstGood].basePrice);
    expect(e.state.doubloons).toBe(gained);
    expect(e.cargoUsed()).toBe(0);
  });

  it("spend deducts when affordable and refuses when broke", () => {
    const e = new Economy({ doubloons: 50 });
    expect(e.spend(30)).toBe(true);
    expect(e.state.doubloons).toBe(20);
    expect(e.spend(100)).toBe(false);
    expect(e.state.doubloons).toBe(20);
  });

  it("buyUpgrade deducts, raises the level, and blocks when broke", () => {
    const rich = new Economy({ doubloons: firstUpgrade.cost });
    const ok = rich.buyUpgrade(firstUpgrade.id);
    expect(ok.ok).toBe(true);
    expect(rich.upgradeLevel(firstUpgrade.id)).toBe(1);
    expect(rich.state.doubloons).toBe(0);

    const broke = new Economy({ doubloons: 0 });
    expect(broke.buyUpgrade(firstUpgrade.id)).toEqual({ ok: false, reason: "broke" });
    expect(broke.upgradeLevel(firstUpgrade.id)).toBe(0);
  });

  it("buyUpgrade blocks at max level and nextCost goes null", () => {
    const e = new Economy({ doubloons: firstUpgrade.cost * (firstUpgrade.maxLevel + 2) });
    for (let i = 0; i < firstUpgrade.maxLevel; i++) {
      expect(e.buyUpgrade(firstUpgrade.id).ok).toBe(true);
    }
    expect(e.upgradeLevel(firstUpgrade.id)).toBe(firstUpgrade.maxLevel);
    expect(e.nextCost(firstUpgrade.id)).toBeNull();
    expect(e.buyUpgrade(firstUpgrade.id)).toEqual({ ok: false, reason: "maxed" });
  });

  it("buyUpgrade rejects an unknown upgrade id", () => {
    const e = new Economy({ doubloons: 9999 });
    expect(e.buyUpgrade("no-such-upgrade")).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("repairQuote", () => {
  it("is zero with no damage and rises monotonically with damage", () => {
    expect(repairQuote(0)).toBe(0);
    expect(repairQuote(1)).toBeGreaterThan(repairQuote(0.5));
    expect(repairQuote(0.5)).toBeGreaterThan(0);
  });
});

describe("Economy — persistence", () => {
  it("serialize → deserialize round-trips the full state", () => {
    const e = new Economy({ doubloons: 333 });
    e.addLoot({ doubloons: 0, cargo: { [firstGood]: 2 }, notoriety: 4 });
    e.buyUpgrade(firstUpgrade.id);
    const back = Economy.deserialize(e.serialize());
    expect(back.state).toEqual(e.state);
  });

  it("deserialize tolerates null, garbage, and partial JSON", () => {
    expect(Economy.deserialize(null).state.doubloons).toBe(0);
    expect(Economy.deserialize("}{ not json").state.doubloons).toBe(0);
    const partial = Economy.deserialize(JSON.stringify({ doubloons: 77 }));
    expect(partial.state.doubloons).toBe(77);
    expect(partial.state.cargoCapacity).toBeGreaterThan(0);
  });
});

describe("rollLoot", () => {
  it("is deterministic for a given rand sequence", () => {
    const a = new Rng("seed-x");
    const b = new Rng("seed-x");
    expect(rollLoot(() => a.next(), 200)).toEqual(rollLoot(() => b.next(), 200));
  });

  it("yields more doubloons for a more valuable ship under the same draw", () => {
    const small = rollLoot(() => new Rng("s").next(), 100);
    const big = rollLoot(() => new Rng("s").next(), 2000);
    expect(big.doubloons).toBeGreaterThan(small.doubloons);
    expect(big.cargo).toBeTypeOf("object");
    expect(big.notoriety).toBeGreaterThanOrEqual(1);
  });
});
