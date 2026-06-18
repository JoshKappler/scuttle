/**
 * The ONE definition of "she's gone": a ship has genuinely FOUNDERED only when she's deep under AND
 * waterlogged, or fully saturated outright. `waterlog` only climbs after she's sat ~60% submerged
 * with water in the hull (see Ship.updateFlooding), so it's a true, slow sinking signal.
 *
 * This used to be duplicated — the fleet's wreck check carried this (correct) test while the player's
 * respawn carried a SECOND, looser one: a bare `y < -12 || every-compartment-95%-full`. The bare
 * depth check fired on a TRANSIENT deck-dip (a heel, a swell trough, a ram shove drops the COM low
 * for a moment) and reset a still-afloat ship — exactly the "as soon as my deck dips it resets" bug.
 * One predicate, used by both, so they can never drift again.
 */

export function isFoundered(s: { body: { translation(): { y: number } }; waterlog: number }): boolean {
  return (s.body.translation().y < -12 && s.waterlog > 0.05) || s.waterlog >= 0.45;
}

/** The minimal shape the ENEMY-cull predicate reads off a real {@link Ship}. The enemy rule wants
 *  the HONEST top of the HULL (not the tall SPAR mast tower a raw `aabbWorld` would include — that
 *  keeps a sunk hull "above water" for ages), so it reads `Ship.hullAabbTopWorldY()` + the hull's
 *  length. `waterlog`/`submergedFrac` ride along only for the gated safety fallback. */
export interface FounderingShip {
  body: { translation(): { y: number } };
  waterlog: number;
  /** 0..1 share of the hull envelope below the surface (Ship.submergedFrac). */
  submergedFrac: number;
  /** the max WORLD-SPACE Y over only the HULL voxels, EXCLUDING SPAR masts (id 13) — the honest
   *  "top of the hull" so masts don't keep a fully-sunk ship reading as above water. */
  hullAabbTopWorldY(): number;
  /** the ship's build descriptor; only `lengthM` (hull length, metres) is read here. */
  build: { lengthM: number };
}

/** Sea-surface baseline Y for the enemy cull. The test is "the WHOLE hull is a full ship-length
 *  under, SUSTAINED", which is far below any swell crest/trough, so a flat baseline (the Gerstner
 *  swell mean) is plenty — no need to sample the live wave height here. */
const SEA_Y = 0;

/** How many consecutive fixed steps the "underwater" test must hold before an enemy is DECLARED a
 *  wreck. By the time the test trips, the hull's TOP is already a full ship-length below the sea, so
 *  this is just a debounce against a freak deep swell trough; ~30 steps ≈ 0.5 s at 60 Hz. The "watch
 *  her sink all the way" time comes from the THRESHOLD (whole hull a ship-length under), not this hold. */
export const ENEMY_SINK_HOLD_STEPS = 30;

/**
 * After a wreck is DECLARED ({@link makeEnemyWreck} trips), the FleetManager keeps her in the world
 * this many more fixed steps — STILL STEPPING (buoyancy keeps pulling her under) — before disposing
 * the geometry, so she slides the rest of the way down on screen and her TALL spar masts (which the
 * hull-AABB cull predicate deliberately ignores, so they're typically still grazing the surface when
 * the wreck is declared) dip beneath the waves LAST instead of the whole ship blinking out in one
 * frame. ~180 steps ≈ 3 s at 60 Hz — long enough for the mast tips to cross under for every tier, yet
 * she's far enough down that the disposal is off-screen-ish. The replacement enemy spawn is kicked off
 * the instant she's declared (she leaves the live `units` count immediately), so foes don't appear any
 * later than before — only her carcass lingers a few seconds while it founders out of sight.
 *
 * Step-counted (no wall clock) so it stays deterministic, consistent with the rest of this module.
 */
export const SINK_OUT_GRACE_STEPS = 180;

/**
 * A STRICTER "she's gone" test for ENEMY ships only: keep a sinking hull visible until the WHOLE
 * HULL is a FULL SHIP-LENGTH beneath the sea surface — so she sinks ALL THE WAY down on screen
 * instead of vanishing while half her freeboard still shows. Returns a step-counted predicate with
 * its OWN per-ship counter (a WeakMap, no wall clock → deterministic), so it can be injected into
 * {@link FleetManager} via FleetOptions.isWreck without touching the player's respawn path.
 *
 * "Underwater this step" means the TOP of the hull (excluding the tall spar masts —
 * {@link FounderingShip.hullAabbTopWorldY}) is below `SEA_Y - ship.build.lengthM`, i.e. even the
 * highest remaining HULL voxel is a full ship-length under. She is culled only once that has held
 * for {@link ENEMY_SINK_HOLD_STEPS} steps. The counter resets the instant the hull bobs back above
 * that line, so a still-afloat (or slowly-sinking-but-not-yet-deep) hull is never culled.
 *
 * Safety fallback: a hull that somehow wedges deep but never quite saturates is caught by
 * `waterlog >= 0.5` — but ONLY while the hull top is ALSO already below the sea, so it can never
 * fire at mid-freeboard (the old `waterlog >= 0.5` early-out culled a still-half-showing ship; that
 * is the premature-despawn bug this rewrite kills).
 */
export function makeEnemyWreck(holdSteps = ENEMY_SINK_HOLD_STEPS): (ship: FounderingShip) => boolean {
  const held = new WeakMap<FounderingShip, number>();
  return (ship: FounderingShip): boolean => {
    const hullTop = ship.hullAabbTopWorldY();
    // the WHOLE hull must be a full ship-length under — masts excluded, so a standing mast can't
    // keep a sunk hull "above water".
    const hullUnderSea = hullTop < SEA_Y; // even the highest hull voxel is below the surface
    const fullyUnder = hullTop < SEA_Y - ship.build.lengthM;
    // gated fallback: a deep-but-wedged, saturated hull still founders — but only once she's at
    // least fully under the surface (never at mid-freeboard).
    if (hullUnderSea && ship.waterlog >= 0.5) return true;
    if (!fullyUnder) {
      held.delete(ship); // she bobbed back above the line — restart the count
      return false;
    }
    const n = (held.get(ship) ?? 0) + 1;
    held.set(ship, n);
    return n >= holdSteps;
  };
}
