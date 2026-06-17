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
