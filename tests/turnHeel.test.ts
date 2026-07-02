import { describe, it, expect } from "vitest";
import { buildCutter, buildFrigate } from "../src/sim/shipwright";
import { makeProbes, probeForce, submergedFraction } from "../src/sim/buoyancy";
import { G } from "../src/core/constants";
import { TUN } from "../src/core/tunables";
import { turnHeelDeepeningFade } from "../src/game/ship";
import { steadyYawRate, CRUISE } from "./helpers/yawHarness";

// ROUND-12 SP3 turn-heel guard: at the faster turn rates a hard turn must bank dramatically but
// never capsize. Two facts pin that: (1) the G-couple saturates at turnHeelMaxG and fades to ZERO
// at turnHeelCap, so more ω adds no heel torque and the couple cannot push past the cap; (2) the
// hull's hydrostatic righting is still RESTORING at the cap angle, so buoyancy wins there.

describe("turn-heel at round-12 turn rates", () => {
  it("the G-couple input vF·ω is SATURATED at cruise (faster turns add no heel torque)", () => {
    const cutter = steadyYawRate(buildCutter(), CRUISE.cutter) * CRUISE.cutter;
    const frigate = steadyYawRate(buildFrigate(), CRUISE.frigate) * CRUISE.frigate;
    expect(cutter).toBeGreaterThan(TUN.phys.turnHeelMaxG); // ≈25 vs 3
    expect(frigate).toBeGreaterThan(TUN.phys.turnHeelMaxG); // ≈8 vs 3
  });

  it("the deepening fade is full below 60% of the cap and exactly ZERO at/past the cap", () => {
    const cap = TUN.phys.turnHeelCap;
    expect(turnHeelDeepeningFade(0, cap)).toBe(1);
    expect(turnHeelDeepeningFade(cap * 0.6, cap)).toBe(1);
    expect(turnHeelDeepeningFade(cap, cap)).toBe(0);
    expect(turnHeelDeepeningFade(cap + 15, cap)).toBe(0);
    let prev = 1;
    for (let d = cap * 0.6; d <= cap + 1e-9; d += 1) {
      const f = turnHeelDeepeningFade(d, cap);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
  });

  // Hydrostatic righting at the cap angle, probe-model (same method as tests/stability.test.ts):
  // heel the hull turnHeelCap° about x, float it at equilibrium draft, require a RESTORING torque.
  for (const [name, builder] of [
    ["cutter", buildCutter],
    ["frigate", buildFrigate],
  ] as const) {
    it(`${name}: righting torque at turnHeelCap (${TUN.phys.turnHeelCap}°) heel is restoring`, () => {
      const ship = builder();
      const probes = makeProbes(ship.grid, ship.compartments);
      const mass = ship.grid.totalMass();
      const com = ship.grid.centerOfMass();
      const hydro = (heel: number, comY: number) => {
        let force = 0;
        let torqueX = 0;
        const c = Math.cos(heel);
        const s = Math.sin(heel);
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
      };
      const equilibriumY = (heel: number) => {
        let lo = -6;
        let hi = 6;
        for (let i = 0; i < 60; i++) {
          const mid = (lo + hi) / 2;
          if (hydro(heel, mid).force > mass * G) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      };
      const heel = (TUN.phys.turnHeelCap * Math.PI) / 180;
      const { torqueX } = hydro(heel, equilibriumY(heel));
      expect(torqueX * heel).toBeLessThan(0); // opposes the heel → restoring at the cap
    });
  }
});
