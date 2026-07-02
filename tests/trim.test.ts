import { describe, it, expect } from "vitest";
import { buildBrig, type ShipBuild } from "../src/sim/shipwright";
import { makeProbes, probeForce, submergedFraction, type Probe } from "../src/sim/buoyancy";
import { IRON, OAK } from "../src/sim/materials";
import { G } from "../src/core/constants";

/**
 * FORE-AFT TRIM (round 12 SP5 — closes the known oracle blind spot): shifting ballast
 * fore/aft must produce a right-signed, sensible equilibrium pitch. Pure probe hydrostatics
 * (same harness as stability.test.ts / manOfWarFloat.test.ts — no physics engine).
 * Conventions: bow = +x (rudder hangs off the low-x stern post); pitch is rotation about the
 * world z-axis, POSITIVE = bow-UP ((lx,ly) → (lx·c − ly·s, lx·s + ly·c) lifts +x for s > 0).
 */
function hydro(probes: Probe[], com: [number, number, number], pitch: number, comY: number) {
  let force = 0, torqueZ = 0;
  const c = Math.cos(pitch), s = Math.sin(pitch);
  for (const p of probes) {
    const lx = p.local[0] - com[0];
    const ly = p.local[1] - com[1];
    const wy = comY + lx * s + ly * c;
    const f = probeForce(p, wy, 0, 0); // flat water at y = 0
    force += f;
    // force acts at the centroid of the SUBMERGED segment (stability.test.ts invariant)
    const sub = submergedFraction(p, wy, 0);
    const lyApp = ly + (sub * p.height) / 2;
    const wxApp = lx * c - lyApp * s;
    torqueZ += wxApp * f; // τ = r × F, F vertical: τz = +rx·Fy — τz > 0 lifts the bow
  }
  return { force, torqueZ };
}

function equilibriumY(probes: Probe[], com: [number, number, number], mass: number, pitch: number): number {
  let lo = -5, hi = 5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (hydro(probes, com, pitch, mid).force > mass * G) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Longitudinal righting is restoring (huge waterplane I about z), so τz decreases with pitch:
 *  bisect for the zero crossing, re-floating at each candidate pitch. */
function equilibriumPitch(probes: Probe[], com: [number, number, number], mass: number): number {
  let lo = -0.2, hi = 0.2; // rad (±11.5° — far beyond any sane brig trim)
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const y = equilibriumY(probes, com, mass, mid);
    if (hydro(probes, com, mid, y).torqueZ > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Move ballast by material swap, mass-conserving (mirrors shipwright.lowerBallast's approach):
 *  the K aft-most IRON cells become OAK and the K fore-most OAK cells at/below the ballast band
 *  become IRON (forward = true), or mirrored. Geometry (solidity) is untouched, so the probes
 *  stay valid — only mass and COM move: exactly "shifting ballast". */
function shiftBallast(build: ShipBuild, k: number, forward: boolean): void {
  const iron: [number, number, number][] = [];
  let ironTopY = 0;
  build.grid.forEachSolid((x, y, z, mat) => {
    if (mat === IRON) { iron.push([x, y, z]); if (y > ironTopY) ironTopY = y; }
  });
  const oak: [number, number, number][] = [];
  build.grid.forEachSolid((x, y, z, mat) => {
    if (mat === OAK && y <= ironTopY) oak.push([x, y, z]);
  });
  expect(iron.length).toBeGreaterThanOrEqual(2 * k); // the brig must carry real iron ballast
  expect(oak.length).toBeGreaterThanOrEqual(2 * k);  // ...and real oak in the bilge band
  const byXyz = (a: [number, number, number], b: [number, number, number]) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  iron.sort(byXyz);
  oak.sort(byXyz);
  const donors = forward ? iron.slice(0, k) : iron.slice(-k);      // iron leaves the far end
  const receivers = forward ? oak.slice(-k) : oak.slice(0, k);     // iron arrives at the near end
  for (const [x, y, z] of donors) build.grid.set(x, y, z, OAK);
  for (const [x, y, z] of receivers) build.grid.set(x, y, z, IRON);
}

const K = 120; // cells swapped ≈ 120·(7800−430)·0.25³ ≈ 13.8 t of ballast moved fore/aft

describe("fore-aft trim equilibrium (round-12 SP5 — the oracle blind spot)", () => {
  it("the stock brig floats near even keel", () => {
    const build = buildBrig();
    const probes = makeProbes(build.grid, build.compartments);
    const pitch0 = equilibriumPitch(probes, build.grid.centerOfMass(), build.grid.totalMass());
    expect(Math.abs((pitch0 * 180) / Math.PI)).toBeLessThan(1.0);
  });

  it("ballast shifted FORWARD → bow-DOWN equilibrium pitch of sensible magnitude", () => {
    const build = buildBrig();
    const probes = makeProbes(build.grid, build.compartments);
    const m0 = build.grid.totalMass();
    const pitch0 = equilibriumPitch(probes, build.grid.centerOfMass(), m0);
    shiftBallast(build, K, true);
    expect(build.grid.totalMass()).toBeCloseTo(m0, 3); // the swap is mass-conserving
    const pitchF = equilibriumPitch(probes, build.grid.centerOfMass(), build.grid.totalMass());
    const dDeg = ((pitchF - pitch0) * 180) / Math.PI;
    expect(dDeg).toBeLessThan(-0.1); // right SIGN: nose goes DOWN
    expect(dDeg).toBeGreaterThan(-8); // sensible MAGNITUDE (est. ~−0.8° for ~14 t over ~15 m)
  });

  it("ballast shifted AFT → bow-UP, mirrored sign", () => {
    const build = buildBrig();
    const probes = makeProbes(build.grid, build.compartments);
    const m0 = build.grid.totalMass();
    const pitch0 = equilibriumPitch(probes, build.grid.centerOfMass(), m0);
    shiftBallast(build, K, false);
    expect(build.grid.totalMass()).toBeCloseTo(m0, 3);
    const pitchA = equilibriumPitch(probes, build.grid.centerOfMass(), build.grid.totalMass());
    const dDeg = ((pitchA - pitch0) * 180) / Math.PI;
    expect(dDeg).toBeGreaterThan(0.1);
    expect(dDeg).toBeLessThan(8);
  });
});
