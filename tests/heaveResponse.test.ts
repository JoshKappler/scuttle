import { describe, it, expect } from "vitest";
import { heaveDampingCoef } from "../src/game/ship";
import { TUN } from "../src/core/tunables";
import { G, WATER_DENSITY, FIXED_DT } from "../src/core/constants";

// ROUND-12 SP5 GUARD. Characterizes the CURRENT heave response so the stiffness decoupling
// (factoring TUN.phys.buoyancy out of the damping pairing) provably does not change the feel.
// The 1-DOF model matches applyForces exactly for pure heave at full wetness (wet = 1):
//   m·z̈ = −k_true·z − c·ż,  k_true = ρ·g·A·TUN.phys.buoyancy  (the per-cell lift slope:
//   liftPerCell/VOXEL_SIZE per straddling column, summed = ρ·g·A_waterplane·buoyancy),
//   c = heaveDampingCoef(A, m)  (applyForces' cArea·(vY·aSub) term at wet = 1).
// Representative brig-scale numbers — the assertions are ratio/shape-based, so the exact
// scale only needs to be realistic.
const AREA = 120; // m² wet waterplane
const MASS = 5.2e5; // kg

function trueStiffness(area: number): number {
  return WATER_DENSITY * G * area * TUN.phys.buoyancy;
}

/** Drop from z0 above equilibrium, integrate semi-implicit Euler at the fixed step.
 *  Returns first-overshoot fraction and the 5% settle time. */
function stepResponse(k: number, c: number, m: number, z0 = 0.5) {
  let z = z0, v = 0, minZ = 0, settle = 0;
  for (let i = 0; i < 60 * 60; i++) {
    v += ((-k * z - c * v) / m) * FIXED_DT;
    z += v * FIXED_DT;
    const t = (i + 1) * FIXED_DT;
    if (z < minZ) minZ = z;
    if (Math.abs(z) > 0.05 * z0) settle = t;
  }
  return { overshoot: -minZ / z0, settle };
}

describe("heave step response (round-12 SP5 guard — must stay green through the decoupling)", () => {
  it("damping pairs with the TRUE sim stiffness at ζ = 0.2 (the shipped feel)", () => {
    const c = heaveDampingCoef(AREA, MASS);
    const zeta = c / (2 * Math.sqrt(trueStiffness(AREA) * MASS));
    expect(zeta).toBeGreaterThan(0.199);
    expect(zeta).toBeLessThan(0.201);
  });

  it("absolute coefficient is pinned to the shipped calibration (hardcoded on purpose)", () => {
    // Deliberately NOT read from TUN: 0.2 (ζ) and 1.5 (buoyancy) are the shipped round-11 feel.
    // If either knob or formula moves WITHOUT exact compensation, this fails.
    const shipped = 2 * 0.2 * Math.sqrt(WATER_DENSITY * G * AREA * 1.5 * MASS);
    expect(heaveDampingCoef(AREA, MASS) / shipped).toBeCloseTo(1, 3);
  });

  it("step response: ~52.7% first overshoot, 5% settle in ~6.5–9.5 s (ζ=0.2 signature)", () => {
    const r = stepResponse(trueStiffness(AREA), heaveDampingCoef(AREA, MASS), MASS);
    // ζ=0.2 theory: overshoot = e^(−πζ/√(1−ζ²)) ≈ 0.527; band tolerates dt=1/60 integration error.
    expect(r.overshoot).toBeGreaterThan(0.5);
    expect(r.overshoot).toBeLessThan(0.55);
    // envelope 5% time = ln(20)/(ζ·ωn) ≈ 8.0 s at ωn = √(k_true/m) ≈ 1.87 rad/s
    expect(r.settle).toBeGreaterThan(5.5);
    expect(r.settle).toBeLessThan(9.5);
  });
});
