/**
 * Turn-induced heel (playtest round 7: "calculate lateral g forces based on
 * forward velocity and turn angle" — and the lean must be OUTWARD; "turning
 * hard right and the ship is actually leaning to the right" read as wrong).
 *
 * Physics: a ship turning at yaw rate ω with forward speed v needs a
 * centripetal acceleration a = v·ω, supplied by the keel's lateral grip —
 * which acts LOW on the hull, well below the center of mass. The inertial
 * reaction on everything above rolls her away from the turn center, exactly
 * like a car body on its springs.
 *
 * Convention (three.js right-handed, +Y up, bow on local +X): positive yaw
 * rate swings the bow toward local −Z; the turn center is on the −Z side;
 * the keel force points −Z below the COM, so the reaction torque about the
 * forward axis is POSITIVE — it rolls the +Z rail down, away from the turn.
 *
 * @param vFwd    signed forward speed, m/s
 * @param yawRate body angular velocity about world +Y, rad/s
 * @param mass    ship mass, kg
 * @param armM    effective lever arm (COM height above the lateral-force
 *                center), m — the tuning knob
 * @param maxLatAccel clamp on v·ω so collisions/spins can't slam her flat
 * @returns torque about the ship's forward axis, N·m (right-hand rule)
 */
export function turnHeelTorque(
  vFwd: number,
  yawRate: number,
  mass: number,
  armM: number,
  maxLatAccel = 4,
): number {
  const aLat = Math.min(Math.max(vFwd * yawRate, -maxLatAccel), maxLatAccel);
  return mass * aLat * armM;
}
