import { describe, it, expect } from "vitest";
import { buildManOfWar } from "../src/sim/shipwright";
import { makeProbes, probeForce, submergedFraction } from "../src/sim/buoyancy";
import { G, WATER_DENSITY } from "../src/core/constants";

const ship = buildManOfWar();
const probes = makeProbes(ship.grid, ship.compartments);
const mass = ship.grid.totalMass();
const com = ship.grid.centerOfMass();

/** Net vertical force and x-torque about the COM for the hull heeled by `heel`
 *  radians about x and floated with the COM at world height comY. */
function hydrostatics(heel: number, comY: number): { force: number; torqueX: number } {
  let force = 0, torqueX = 0;
  const c = Math.cos(heel), s = Math.sin(heel);
  for (const p of probes) {
    const ly = p.local[1] - com[1];
    const lz = p.local[2] - com[2];
    const wy = comY + ly * c - lz * s;
    const f = probeForce(p, wy, 0, 0);
    force += f;
    const sub = submergedFraction(p, wy, 0);
    const lyApp = ly + (sub * p.height) / 2;
    const wzApp = lz * c + lyApp * s;
    torqueX += -wzApp * f;
  }
  return { force, torqueX };
}
function equilibriumY(heel: number): number {
  let lo = -6, hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (hydrostatics(heel, mid).force > mass * G) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe("man-o'-war flotation (emergent, tuned ballast)", () => {
  it("rides with real freeboard: ~0.45 of the envelope submerged (not awash, not corky)", () => {
    const ratio = mass / (WATER_DENSITY * ship.envelopeVolume);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.5);
  });

  it("heeling 5° produces a RESTORING torque (positive GM — she will not turtle)", () => {
    const heel = (5 * Math.PI) / 180;
    const y = equilibriumY(heel);
    const { torqueX } = hydrostatics(heel, y);
    expect(torqueX * heel).toBeLessThan(0);
    const gm = -torqueX / (mass * G * Math.sin(heel));
    expect(gm).toBeGreaterThan(0.15);
  });

  it("heeling 15° still restores (range of stability)", () => {
    const heel = (15 * Math.PI) / 180;
    const y = equilibriumY(heel);
    expect(hydrostatics(heel, y).torqueX * heel).toBeLessThan(0);
  });
});
