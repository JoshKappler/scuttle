import { describe, it, expect } from "vitest";
import { SHIP_TIERS, tierOrder, tierById, canBuy, nextTier } from "../src/game/shipyard";

describe("shipyard catalog", () => {
  it("orders cutter → sloop → brig → frigate", () => {
    expect(tierOrder()).toEqual(["cutter", "sloop", "brig", "frigate"]);
  });
  it("the cutter is the free starter; bigger hulls cost more", () => {
    expect(tierById("cutter").price).toBe(0);
    const prices = SHIP_TIERS.map((t) => t.price);
    for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeGreaterThan(prices[i - 1]);
  });
  it("every tier has a working builder", () => {
    for (const t of SHIP_TIERS) expect(t.build().grid.dims.length).toBe(3);
  });
});

describe("shipyard — canBuy", () => {
  it("buys when gold suffices AND the class is unlocked", () => {
    const brig = tierById("brig");
    expect(canBuy(brig, { gold: brig.price, unlocked: ["cutter", "sloop", "brig"], current: "sloop" }).ok).toBe(true);
  });
  it("refuses when broke", () => {
    const brig = tierById("brig");
    expect(canBuy(brig, { gold: brig.price - 1, unlocked: ["cutter", "sloop", "brig"], current: "sloop" })).toEqual({
      ok: false,
      reason: "broke",
    });
  });
  it("refuses when the class isn't unlocked", () => {
    const brig = tierById("brig");
    expect(canBuy(brig, { gold: 99999, unlocked: ["cutter", "sloop"], current: "sloop" })).toEqual({
      ok: false,
      reason: "locked",
    });
  });
  it("refuses the tier you already sail", () => {
    const sloop = tierById("sloop");
    expect(canBuy(sloop, { gold: 99999, unlocked: ["cutter", "sloop"], current: "sloop" })).toEqual({
      ok: false,
      reason: "owned",
    });
  });
});

describe("shipyard — nextTier", () => {
  it("steps up the ladder and stops at the top", () => {
    expect(nextTier("cutter")?.id).toBe("sloop");
    expect(nextTier("brig")?.id).toBe("frigate");
    expect(nextTier("frigate")).toBeNull();
  });
});
