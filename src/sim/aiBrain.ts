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
}

export interface AIDecision {
  sailSet: number;
  rudderSign: -1 | 0 | 1;
  fire: "port" | "starboard" | null;
}

const GUN_RANGE = 110; // m — stretched with the round-8 muzzle velocity
const CLOSE_RANGE = 65; // m — run the target down to here before turning abeam
const ABEAM_TOLERANCE = 20; // degrees around ±90

/** Rudder sign that moves the current bearing toward the desired bearing. */
function steerToward(bearingDeg: number, desiredDeg: number): -1 | 0 | 1 {
  // turning starboard (rudderSign +1) yaws the bow toward +bearing targets,
  // i.e. it DECREASES the target's bearing
  const err = bearingDeg - desiredDeg;
  if (Math.abs(err) < 6) return 0;
  return err > 0 ? 1 : -1;
}

export function decideAI(v: AIView): AIDecision {
  // crippled: run with the wind, guns silent. The threshold is HIGH — the
  // captain stays aggressive until genuinely sinking (playtest round 6:
  // "they should be pretty aggressive until they're very damaged")
  if (v.floodFrac >= 0.55) {
    const desired = v.bearingDeg >= 0 ? 180 : -180;
    return { sailSet: 1, rudderSign: steerToward(v.bearingDeg, desired), fire: null };
  }

  // pinned in irons FAR from the fight: bear away from the wind or be
  // anchored forever. Never mid-fight — bearing away there read as fleeing
  // ("the enemy ship still isn't really chasing me", round 6)
  if (Math.abs(v.windBearingDeg) < 32 && v.range > 120) {
    const sign = v.windBearingDeg >= 0 ? -1 : 1; // turn the bow AWAY from the wind
    return { sailSet: 1, rudderSign: sign, fire: null };
  }

  // a broadside that bears is a broadside that fires — even while closing
  let fire: AIDecision["fire"] = null;
  if (v.range <= GUN_RANGE && v.reloadReady && Math.abs(Math.abs(v.bearingDeg) - 90) <= ABEAM_TOLERANCE) {
    fire = v.bearingDeg >= 0 ? "starboard" : "port";
  }

  // the chase: bow on the target at FULL sail until close aboard
  if (v.range > CLOSE_RANGE) {
    return { sailSet: 1, rudderSign: steerToward(v.bearingDeg, 0), fire };
  }

  // close action: ease off and dance the nearer broadside onto them. The
  // desired bearing is just FORWARD of abeam (±85, not ±90) so she spirals
  // gently INWARD and keeps station instead of orbiting out to the horizon
  // (round 10: "just floating off way into the distance"). Full sail here meant
  // minutes-long turning circles spent pointed away (round 8).
  const desired = v.bearingDeg >= 0 ? 85 : -85;
  return { sailSet: 0.72, rudderSign: steerToward(v.bearingDeg, desired), fire };
}
