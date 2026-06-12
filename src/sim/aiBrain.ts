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

const GUN_RANGE = 90; // m
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
  // crippled: run with the wind, guns silent
  if (v.floodFrac >= 0.5) {
    const desired = v.bearingDeg >= 0 ? 180 : -180;
    return { sailSet: 1, rudderSign: steerToward(v.bearingDeg, desired), fire: null };
  }

  // pinned in irons: bear away from the wind FIRST or we're anchored forever
  // (this is how the playtest enemy got lost over the horizon)
  if (Math.abs(v.windBearingDeg) < 32 && v.range > 40) {
    const sign = v.windBearingDeg >= 0 ? -1 : 1; // turn the bow AWAY from the wind
    return { sailSet: 1, rudderSign: sign, fire: null };
  }

  // closing: aim the bow at the target
  if (v.range > GUN_RANGE) {
    return { sailSet: 1, rudderSign: steerToward(v.bearingDeg, 0), fire: null };
  }

  // gun range: bring the nearer broadside to bear
  const desired = v.bearingDeg >= 0 ? 90 : -90;
  const rudderSign = steerToward(v.bearingDeg, desired);

  let fire: AIDecision["fire"] = null;
  if (v.reloadReady && Math.abs(Math.abs(v.bearingDeg) - 90) <= ABEAM_TOLERANCE) {
    fire = v.bearingDeg >= 0 ? "starboard" : "port";
  }

  return { sailSet: 0.75, rudderSign, fire };
}
