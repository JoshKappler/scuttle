import { describe, it, expect } from "vitest";
import { turnHeelTorque } from "../src/sim/heel";

/** Convention under test: bow on +X, +Y up (right-handed). Positive yaw
 *  rate swings the bow toward −Z; positive returned torque (about the
 *  forward axis) rolls the +Z rail DOWN — i.e. away from the turn center. */
describe("turn-induced heel (round 7)", () => {
  it("turning under way rolls the ship OUTWARD, away from the turn center", () => {
    expect(turnHeelTorque(10, 0.2, 500e3, 3)).toBeGreaterThan(0);
  });

  it("turning the other way rolls her the other way", () => {
    expect(turnHeelTorque(10, -0.2, 500e3, 3)).toBeLessThan(0);
  });

  it("no way on → no turn heel; no turn → no heel", () => {
    expect(turnHeelTorque(0, 0.5, 500e3, 3)).toBe(0);
    expect(turnHeelTorque(12, 0, 500e3, 3)).toBe(0);
  });

  it("sternway flips the lean (backing through a turn leans inward)", () => {
    expect(Math.sign(turnHeelTorque(-6, 0.2, 500e3, 3))).toBe(-1);
  });

  it("clamps lateral acceleration so collision spins can't slam her flat", () => {
    expect(turnHeelTorque(30, 2, 500e3, 3)).toBe(500e3 * 4 * 3);
    expect(turnHeelTorque(-30, 2, 500e3, 3)).toBe(-500e3 * 4 * 3);
  });

  it("scales linearly with speed, rate, mass and arm below the clamp", () => {
    expect(turnHeelTorque(10, 0.1, 2, 5)).toBeCloseTo(10);
    expect(turnHeelTorque(5, 0.1, 2, 5)).toBeCloseTo(5);
  });
});
