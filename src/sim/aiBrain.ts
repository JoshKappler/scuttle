/**
 * AI captain decision logic — pure and unit-tested. The game-side adapter
 * (game/ai.ts) builds the view from physics state and applies the decision.
 */
export interface AIView {
  range: number; // m to target
  bearingDeg: number; // target bearing off own bow, -180..180 (+ starboard)
  angleOffWindDeg: number; // own bow vs wind-from direction
  /** Bearing of the wind's SOURCE off own bow, -180..180 (+ starboard). */
  windBearingDeg: number;
  floodFrac: number; // own worst compartment fill 0..1
  reloadReady: boolean;
  /**
   * The beam the captain is currently committed to presenting (+1 starboard,
   * -1 port, 0 = not yet committed). Carried by the adapter so the broadside
   * choice has hysteresis and never thrashes side to side frame to frame.
   */
  committedBeam?: -1 | 0 | 1;
  /**
   * The TARGET's heading relative to our own bow, -180..180 (0 = she heads the
   * same way we do, ±180 = dead opposite, +90 = she heads off toward our
   * starboard). Lets the captain run a PARALLEL broadside PASS — pace her
   * beam-to-beam on a matched course — instead of pivoting to keep her abeam,
   * which read as a nose-chase that mirrored the player's every turn.
   */
  targetHeadingDeg?: number;
}

export interface AIDecision {
  sailSet: number;
  rudderSign: -1 | 0 | 1;
  fire: "port" | "starboard" | null;
  /** The beam now committed for the broadside (feed back in next tick). */
  committedBeam: -1 | 0 | 1;
}

const GUN_RANGE = 110; // m — stretched with the round-8 muzzle velocity
// Broadside engagement band. Once inside ENGAGE_RANGE the captain stops
// charging bow-on and turns to present her beam, then PACES the target at a
// standoff so most of her guns bear (age-of-sail line-engagement, not a stern
// chase). STANDOFF is the range she tries to hold; the band around it lets her
// edge in/out without constantly fighting the helm.
const ENGAGE_RANGE = 120; // m — start presenting the broadside at/under this
const STANDOFF = 85; // m — preferred broadside range (mid of a sensible 60–120 band)
const STANDOFF_BAND = 20; // m — dead-band around STANDOFF before correcting range
// Hysteresis on the beam choice: only flip to the other beam if it is a clearly
// smaller turn (target has crossed well past dead-ahead/dead-astern). Without
// this the captain would oscillate port/starboard whenever the bearing hovers
// near 0 or ±180.
const BEAM_FLIP_MARGIN = 25; // degrees the new beam must beat the committed one by

/** Wrap an angle to -180..180. */
function wrap180(a: number): number {
  return (((a + 180) % 360) + 360) % 360 - 180;
}

/** Rudder sign that moves the current bearing toward the desired bearing. */
function steerToward(bearingDeg: number, desiredDeg: number): -1 | 0 | 1 {
  // turning starboard (rudderSign +1) yaws the bow toward +bearing targets,
  // i.e. it DECREASES the target's bearing
  const err = bearingDeg - desiredDeg;
  if (Math.abs(err) < 6) return 0;
  return err > 0 ? 1 : -1;
}

/**
 * Pick which beam (port -1 / starboard +1) to present at a target on the given
 * bearing, given the currently committed beam. Picks whichever beam is the
 * smaller turn, but stays committed unless the other beam wins by a clear
 * margin (hysteresis → no port/starboard thrash near the bow/stern line).
 *
 * To present the STARBOARD beam the target must sit to starboard (+90), so the
 * turn cost is |bearing - 90|; for port it is |bearing + 90|.
 */
function chooseBeam(bearingDeg: number, committed: -1 | 0 | 1): -1 | 0 | 1 {
  const costStbd = Math.abs(bearingDeg - 90);
  const costPort = Math.abs(bearingDeg + 90);
  if (committed === 1) return costPort + BEAM_FLIP_MARGIN < costStbd ? -1 : 1;
  if (committed === -1) return costStbd + BEAM_FLIP_MARGIN < costPort ? 1 : -1;
  // not yet committed: take the cheaper beam outright.
  return costStbd <= costPort ? 1 : -1;
}

export function decideAI(v: AIView): AIDecision {
  const committed: -1 | 0 | 1 = v.committedBeam ?? 0;

  // pinned in irons FAR from the fight: bear away from the wind or be
  // anchored forever. Never mid-fight — bearing away there read as fleeing
  // ("the enemy ship still isn't really chasing me", round 6). NOTE: this is
  // an anti-stuck nudge gated to long range, NOT a flee — she resumes the
  // attack the moment she has steerage and closes to engagement range.
  if (Math.abs(v.windBearingDeg) < 32 && v.range > ENGAGE_RANGE) {
    const sign = v.windBearingDeg >= 0 ? -1 : 1; // turn the bow AWAY from the wind
    return { sailSet: 1, rudderSign: sign, fire: null, committedBeam: 0 };
  }

  // OUT OF ENGAGEMENT RANGE: close the distance bow-on at full sail. (No flee
  // branch — a flooded/crippled captain stays in the fight too; the old
  // floodFrac>=0.55 "run downrange" disengage was removed so the enemy never
  // sails off out of reach.)
  if (v.range > ENGAGE_RANGE) {
    return { sailSet: 1, rudderSign: steerToward(v.bearingDeg, 0), fire: null, committedBeam: 0 };
  }

  // IN ENGAGEMENT RANGE: run a BROADSIDE PASS alongside her. Commit to a beam
  // (with hysteresis), then steer to MATCH her course — run parallel (or, when
  // that's the smaller turn, anti-parallel) so we PACE her beam-to-beam instead
  // of pivoting to keep her abeam. The old "hold the target at ±90" steering
  // orbited the target: as the player turned, the captain spun to follow, so the
  // player could never line up a side shot ("it just chases / mirrors me"). Now
  // a gentle off-beam bias slides us onto the standoff line without that spin.
  const beam = chooseBeam(v.bearingDeg, committed);

  // a broadside that bears is a broadside that fires — fire whichever side the
  // target is actually on (within the firing arc), independent of the pass.
  let fire: AIDecision["fire"] = null;
  if (v.range <= GUN_RANGE && v.reloadReady) {
    if (v.bearingDeg > 30 && v.bearingDeg < 150) fire = "starboard";
    else if (v.bearingDeg < -30 && v.bearingDeg > -150) fire = "port";
  }

  // course-match: the turn that aligns our bow with HER heading (parallel) or her
  // reciprocal (anti-parallel). Prefer parallel; only take the reciprocal when it
  // is a clearly smaller turn, so a target hovering near beam-on doesn't flip the
  // pass back and forth.
  const headRel = v.targetHeadingDeg ?? 0;
  const parErr = wrap180(headRel); // turn to run the SAME way she does
  const antiErr = wrap180(headRel - 180); // turn to run the OPPOSITE way
  const courseErr = Math.abs(antiErr) + 20 < Math.abs(parErr) ? antiErr : parErr;

  // off-beam bias: how far the target sits off the chosen beam (+ → turn toward
  // her to bring her onto it). Range lean nudges the bias in/out so she paces the
  // standoff band instead of drifting away or boring in. Both scaled down so they
  // trim the matched course rather than overpower it back into an orbit.
  const offBeam = v.bearingDeg - beam * 90;
  let rangeLean = 0;
  if (v.range > STANDOFF + STANDOFF_BAND) rangeLean = -beam * 12; // too far → angle bow inward to close
  else if (v.range < STANDOFF - STANDOFF_BAND) rangeLean = beam * 12; // too close → angle bow outward to open

  const desiredTurn = courseErr * 0.7 + (offBeam + rangeLean) * 0.4;
  const rudderSign: -1 | 0 | 1 = Math.abs(desiredTurn) < 6 ? 0 : desiredTurn > 0 ? 1 : -1;

  // Ease the sail in the engagement band: full-canvas turning circles spent
  // minutes pointed away (round 8). 0.72 keeps steerage while pacing.
  return {
    sailSet: 0.72,
    rudderSign,
    fire,
    committedBeam: beam,
  };
}
