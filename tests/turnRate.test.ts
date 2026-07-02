import { describe, it, expect } from "vitest";
import { buildCutter, buildSloop, buildBrig, buildFrigate } from "../src/sim/shipwright";
import { TUN } from "../src/core/tunables";
import { YAW_ADDED_MASS } from "../src/game/ship";
import { timeTo90, CRUISE } from "./helpers/yawHarness";

// ROUND-12 SP3 CHARACTERIZATION: pins the CURRENT shipped handling before the retune.
// EXPECTED TO CHANGE: the retune tasks (inertia → yawDamp → rudder lever) update EXPECT +
// the knob-pin step by step until the spec targets land (Cutter 2–3 s, Frigate 5–6 s).
const builds = {
  cutter: buildCutter(),
  sloop: buildSloop(),
  brig: buildBrig(),
  frigate: buildFrigate(),
} as const;
type Tier = keyof typeof builds;

// predicted (1-DOF model, verified numerically): cutter 2.47, sloop 2.98, brig 5.20, frigate 6.78
const EXPECT: Record<Tier, [number, number]> = {
  cutter: [2.1, 2.9],
  sloop: [2.6, 3.4],
  brig: [4.7, 5.7],
  frigate: [6.3, 7.3],
};

describe("turn rate — time to 90° heading at cruise, full rudder (deterministic 1-DOF yaw model)", () => {
  it("pins the shipped handling knobs (a tunables drift fails HERE, loudly)", () => {
    expect(TUN.phys.yawDamp).toBe(0.4);
    expect(TUN.phys.rudderGain).toBe(2.0);
    expect(TUN.phys.rudderLowFloor).toBe(2.5);
    expect(YAW_ADDED_MASS).toBe(1.3);
  });

  for (const tier of Object.keys(builds) as Tier[]) {
    it(`${tier}: t90 within band [${EXPECT[tier][0]}, ${EXPECT[tier][1]}] s`, () => {
      const t = timeTo90(builds[tier], CRUISE[tier]);
      expect(t).toBeGreaterThan(EXPECT[tier][0]);
      expect(t).toBeLessThan(EXPECT[tier][1]);
    });
  }

  it("t90 is strictly monotonic up the tiers (bigger = statelier)", () => {
    const t = (Object.keys(builds) as Tier[]).map((k) => timeTo90(builds[k], CRUISE[k]));
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
  });
});
