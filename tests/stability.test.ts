import { describe, it, expect } from "vitest";
import { buildSloop } from "../src/sim/shipwright";
import { makeProbes, probeForce, submergedFraction } from "../src/sim/buoyancy";
import { G } from "../src/core/constants";

/**
 * Hydrostatic stability, computed purely from the probe model (no physics
 * engine): at equilibrium draft, a small heel must produce a RESTORING
 * torque about the roll (x) axis. This is the regression test for the
 * "ship turtles on spawn" failure mode.
 */
const ship = buildSloop();
const probes = makeProbes(ship.grid, ship.compartments);
const mass = ship.grid.totalMass();
const com = ship.grid.centerOfMass();

/** Net vertical force and x-torque about the COM for the hull heeled by
 *  `heel` radians about x and floated with the COM at world height comY. */
function hydrostatics(heel: number, comY: number): { force: number; torqueX: number } {
  let force = 0;
  let torqueX = 0;
  const c = Math.cos(heel);
  const s = Math.sin(heel);
  for (const p of probes) {
    // column bottom relative to COM, rotated about x
    const ly = p.local[1] - com[1];
    const lz = p.local[2] - com[2];
    const wy = comY + ly * c - lz * s;
    const f = probeForce(p, wy, 0, 0); // flat water at y=0
    force += f;
    // force acts at the centroid of the submerged segment of the column
    const sub = submergedFraction(p, wy, 0);
    const lyApp = ly + (sub * p.height) / 2;
    const wzApp = lz * c + lyApp * s;
    torqueX += -wzApp * f; // τ = r × F with F vertical
  }
  return { force, torqueX };
}

/** Find the COM height where buoyancy balances weight at the given heel. */
function equilibriumY(heel: number): number {
  let lo = -4;
  let hi = 4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (hydrostatics(heel, mid).force > mass * G) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe("hydrostatic roll stability", () => {
  it("buoyancy can balance the weight (it floats at some draft)", () => {
    const y = equilibriumY(0);
    expect(hydrostatics(0, y).force / (mass * G)).toBeCloseTo(1, 2);
  });

  it("upright equilibrium has near-zero heel torque (symmetry)", () => {
    const y = equilibriumY(0);
    const { torqueX } = hydrostatics(0, y);
    // normalize by a representative righting scale: mg · 1m
    expect(Math.abs(torqueX) / (mass * G)).toBeLessThan(0.02);
  });

  it("heeling 5° produces a RESTORING torque (positive GM)", () => {
    const heel = (5 * Math.PI) / 180;
    const y = equilibriumY(heel);
    const { torqueX } = hydrostatics(heel, y);
    // heel > 0 tips +z side down... restoring torque must oppose the heel
    expect(torqueX * heel).toBeLessThan(0);
    // and be meaningful: effective GM = τ/(mg·sinθ) of at least 0.15 m
    const gm = -torqueX / (mass * G * Math.sin(heel));
    expect(gm).toBeGreaterThan(0.15);
  });

  it("heeling 15° still restores (range of stability)", () => {
    const heel = (15 * Math.PI) / 180;
    const y = equilibriumY(heel);
    const { torqueX } = hydrostatics(heel, y);
    expect(torqueX * heel).toBeLessThan(0);
  });
});
