/**
 * Notoriety-scaled enemy-tier weighting — pure and deterministic. As the player's
 * notoriety climbs (and, mildly, as their own ship grows), the spawn distribution
 * shifts from small, poor prey (cutters/sloops) toward big, rich, dangerous hulls
 * (brigs/frigates). Early on the deep-water tiers are all but absent so the opening
 * is survivable; the tail never fully drops the small ships, for variety.
 *
 * Engine-free: the game layer (`main.ts` spawn factory) calls pickEnemyTier with a
 * `rand()` source and builds the chosen hull.
 */
import type { ShipTierId } from "../game/saveState";

// the ENEMY spawn pool tops out at the frigate — the Man-o'-War is the player's
// rare flagship, not common prey — but INDEX still maps it so a player who sails
// one is handled by the threat math.
const ORDER: ShipTierId[] = ["cutter", "sloop", "brig", "frigate"];
const INDEX: Record<ShipTierId, number> = { cutter: 0, sloop: 1, brig: 2, frigate: 3, manowar: 4 };

/**
 * The "threat tier" the fleet is gravitating toward (0=cutter … 3=frigate), as a
 * continuous value. Grows with notoriety (~+1 tier per 30 infamy) plus a small nudge
 * from the player's own tier so a frigate captain isn't only swarmed by cutters.
 */
function threatLevel(notoriety: number, playerTier: ShipTierId): number {
  const n = Math.max(0, notoriety);
  // ESCALATION-RATE knob: notoriety per +1 enemy tier. rollLoot pays ~tens of infamy
  // per kill (it scales with hull cell-count), so ~120 ≈ a couple of kills per tier —
  // tune this for feel (lower = faster escalation).
  return Math.min(n / 120 + INDEX[playerTier] * 0.25, 3);
}

/** Spawn weight per tier given the current notoriety + player tier. */
export function tierWeights(notoriety: number, playerTier: ShipTierId): Record<ShipTierId, number> {
  const threat = threatLevel(notoriety, playerTier);
  const w = {} as Record<ShipTierId, number>;
  for (const id of ORDER) {
    const d = INDEX[id] - threat;
    // a bell centred on the threat tier; a small floor keeps variety on the near side…
    let weight = Math.max(0.05, Math.exp(-(d * d) / 0.9));
    // …but tiers well ABOVE the current threat stay rare until notoriety catches up
    // (keeps the early game from throwing frigates at a cutter).
    if (d > 1.5) weight = 0.02;
    w[id] = weight;
  }
  return w;
}

/** Pick a tier deterministically from `rand` (a [0,1) source). */
export function pickEnemyTier(notoriety: number, playerTier: ShipTierId, rand: () => number): ShipTierId {
  const w = tierWeights(notoriety, playerTier);
  let total = 0;
  for (const id of ORDER) total += w[id];
  let r = rand() * total;
  for (const id of ORDER) {
    r -= w[id];
    if (r < 0) return id;
  }
  return ORDER[0];
}
