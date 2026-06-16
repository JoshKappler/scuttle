/**
 * The shipyard catalog + purchase rules — engine-free and unit-tested. Maps each
 * ship tier to its hull builder, price, and a display name, and decides whether a
 * tier can be bought given the player's gold, unlocked classes, and current hull.
 *
 * Acquisition rule (the two player phrases combined): a bigger hull is BOUGHT with
 * gold, but a tier is only unlockable once you've SUNK a ship of that class — so you
 * earn the right to buy it by taking boats down. `canBuy` enforces gold + unlock +
 * not-already-owned; the unlock list itself is maintained by the game layer.
 */
import { buildCutter, buildSloop, buildBrig, buildFrigate, buildManOfWar, type ShipBuild } from "../sim/shipwright";
import type { ShipTierId } from "./saveState";

export interface ShipTier {
  id: ShipTierId;
  name: string;
  price: number; // doubloons (cutter is the free starter)
  build: () => ShipBuild;
}

/** Ordered smallest → largest. The order IS the ladder. */
export const SHIP_TIERS: ShipTier[] = [
  { id: "cutter", name: "Cutter", price: 0, build: buildCutter },
  { id: "sloop", name: "Sloop", price: 600, build: buildSloop },
  { id: "brig", name: "Brig", price: 1800, build: buildBrig },
  { id: "frigate", name: "Frigate", price: 4200, build: buildFrigate },
  { id: "manowar", name: "Man-o'-War", price: 9000, build: buildManOfWar },
];

export const tierOrder = (): ShipTierId[] => SHIP_TIERS.map((t) => t.id);
export const tierById = (id: ShipTierId): ShipTier => SHIP_TIERS.find((t) => t.id === id)!;

export interface BuyCtx {
  gold: number;
  unlocked: ShipTierId[];
  current: ShipTierId;
}

export type BuyReason = "owned" | "locked" | "broke";

export function canBuy(tier: ShipTier, ctx: BuyCtx): { ok: boolean; reason?: BuyReason } {
  if (tier.id === ctx.current) return { ok: false, reason: "owned" };
  if (!ctx.unlocked.includes(tier.id)) return { ok: false, reason: "locked" };
  if (ctx.gold < tier.price) return { ok: false, reason: "broke" };
  return { ok: true };
}

/** The next tier up from `current`, or null if already at the top. */
export function nextTier(current: ShipTierId): ShipTier | null {
  const order = tierOrder();
  const i = order.indexOf(current);
  return i >= 0 && i < order.length - 1 ? tierById(order[i + 1]) : null;
}
