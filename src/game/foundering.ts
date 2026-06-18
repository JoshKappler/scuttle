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
import * as THREE from "three";

export function isFoundered(s: { body: { translation(): { y: number } }; waterlog: number }): boolean {
  return (s.body.translation().y < -12 && s.waterlog > 0.05) || s.waterlog >= 0.45;
}

/** The minimal shape the ENEMY-cull predicate reads off a real {@link Ship}. Mirrors the real
 *  `Ship.submergedFrac` field + `Ship.aabbWorld(out)` method exactly so a Ship is assignable here. */
export interface FounderingShip {
  body: { translation(): { y: number } };
  waterlog: number;
  /** 0..1 share of the hull envelope below the surface (Ship.submergedFrac). */
  submergedFrac: number;
  /** writes the hull's world-space grid AABB into `out` (Ship.aabbWorld); `out.min/max` are real
   *  THREE.Vector3 (the method calls `.set`/`.min`/`.max` on them), not bare {y} objects. */
  aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }): { min: THREE.Vector3; max: THREE.Vector3 };
}

/** How many consecutive fixed steps the "underwater" test must hold before an enemy is culled.
 *  A swell crest can briefly drop the hull's AABB top below Y=0 or spike submergedFrac while she's
 *  still afloat, so we require it to PERSIST (~30 steps ≈ 0.5 s at 60 Hz) before despawning. */
export const ENEMY_SINK_HOLD_STEPS = 30;

/**
 * A STRICTER "she's gone" test for ENEMY ships only: keep a sinking hull visible until she is
 * essentially fully under, so she doesn't vanish while a third of her freeboard still shows
 * (the loose `waterlog >= 0.45` clause fires at ~60% submerged). Returns a step-counted predicate
 * with its OWN per-ship counter (a WeakMap, no wall clock → deterministic), so it can be injected
 * into {@link FleetManager} via FleetOptions.isWreck without touching the player's respawn path.
 *
 * A ship counts as "underwater this step" when EITHER her hull is almost entirely submerged
 * (`submergedFrac >= 0.97`) OR the top of her world AABB is below sea level (`aabbWorld().max.y < 0`,
 * i.e. even the highest remaining voxel is under). She is culled only once that has held for
 * {@link ENEMY_SINK_HOLD_STEPS} steps. A slow fallback (`waterlog >= 0.5`, above the player bar of
 * 0.45) guarantees a hull that somehow rests just shy of full submersion STILL founders eventually —
 * no permanent limbo. The counter resets the instant she pops back up, so a bobbing-but-afloat hull
 * is never culled.
 */
export function makeEnemyWreck(holdSteps = ENEMY_SINK_HOLD_STEPS): (ship: FounderingShip) => boolean {
  // real Vector3 scratch — Ship.aabbWorld calls .set/.min/.max on out.min/out.max.
  const tmpAabb = { min: new THREE.Vector3(), max: new THREE.Vector3() };
  const held = new WeakMap<FounderingShip, number>();
  return (ship: FounderingShip): boolean => {
    // a fully-saturated hull is gone regardless — keeps a hull that wedges at ~0.95 forever from
    // living on, and matches the spirit of the original (just at a higher, post-player-bar 0.5).
    if (ship.waterlog >= 0.5) return true;
    ship.aabbWorld(tmpAabb);
    const underwater = ship.submergedFrac >= 0.97 || tmpAabb.max.y < 0;
    if (!underwater) {
      held.delete(ship); // she bobbed back up — restart the count
      return false;
    }
    const n = (held.get(ship) ?? 0) + 1;
    held.set(ship, n);
    return n >= holdSteps;
  };
}
