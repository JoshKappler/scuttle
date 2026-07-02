import { describe, it, expect } from "vitest";
import { rigDriftForce, RIG_DRIFT_CAP_SPEED } from "../src/game/debris";

/**
 * Round-12 SP1 felled-rig wind drift (game/debris.ts). Pure + deterministic — no THREE/Rapier —
 * so this exercises the force law directly rather than a live debris body.
 */
describe("rigDriftForce", () => {
  it("is zero with no exposed canvas area", () => {
    expect(rigDriftForce(0, 1, 8, 0)).toBe(0);
  });

  it("is zero with no surviving (exposed) canvas fraction", () => {
    expect(rigDriftForce(5, 0, 8, 0)).toBe(0);
  });

  it("is zero in a dead calm", () => {
    expect(rigDriftForce(5, 1, 0, 0)).toBe(0);
  });

  it("grows with exposed area", () => {
    const small = rigDriftForce(2, 1, 8, 0);
    const big = rigDriftForce(8, 1, 8, 0);
    expect(big).toBeGreaterThan(small);
  });

  it("grows with the surviving-canvas fraction", () => {
    const half = rigDriftForce(5, 0.5, 8, 0);
    const full = rigDriftForce(5, 1, 8, 0);
    expect(full).toBeGreaterThan(half);
    expect(full).toBeCloseTo(half * 2, 5);
  });

  it("grows with wind speed", () => {
    const slow = rigDriftForce(5, 1, 4, 0);
    const fast = rigDriftForce(5, 1, 12, 0);
    expect(fast).toBeGreaterThan(slow);
  });

  it("eases to zero as the piece's own downwind speed nears the cap — a drift, never a shove", () => {
    const atRest = rigDriftForce(5, 1, 8, 0);
    const almostThere = rigDriftForce(5, 1, 8, RIG_DRIFT_CAP_SPEED * 0.95);
    expect(almostThere).toBeGreaterThan(0);
    expect(almostThere).toBeLessThan(atRest);
    expect(rigDriftForce(5, 1, 8, RIG_DRIFT_CAP_SPEED)).toBe(0);
    expect(rigDriftForce(5, 1, 8, RIG_DRIFT_CAP_SPEED * 5)).toBe(0); // never goes negative past the cap
  });

  it("clamps to full force when the piece drifts UPWIND (never exceeds the at-rest force)", () => {
    const atRest = rigDriftForce(5, 1, 8, 0);
    const upwind = rigDriftForce(5, 1, 8, -3);
    expect(upwind).toBe(atRest);
  });

  it("stays a gentle nudge, well under crush.vBreak-scale forces, for a plausible felled sail", () => {
    // a big severed sail bay (~20 m²), fully exposed, in a stiff 15 m/s breeze.
    expect(rigDriftForce(20, 1, 15, 0)).toBeLessThan(2000);
  });
});
