import { describe, it, expect } from "vitest";
import { segmentBoxHit } from "../src/sim/rigDamage";

describe("rig damage geometry (rudder box)", () => {
  const RUDDER = { min: { x: -2, y: 0.5, z: 4.6 }, max: { x: 0.5, y: 4.5, z: 5.4 } };

  it("a ball raking the stern passes through the rudder box", () => {
    expect(segmentBoxHit({ x: -6, y: 2, z: 5 }, { x: 4, y: 2.5, z: 5 }, RUDDER)).toBe(true);
  });

  it("shots wide or high of the blade miss it", () => {
    expect(segmentBoxHit({ x: -6, y: 2, z: 8 }, { x: 4, y: 2, z: 8 }, RUDDER)).toBe(false);
    expect(segmentBoxHit({ x: -6, y: 6, z: 5 }, { x: 4, y: 6, z: 5 }, RUDDER)).toBe(false);
  });

  it("a segment that starts and ends inside the box still hits", () => {
    expect(segmentBoxHit({ x: -1, y: 2, z: 5 }, { x: -0.5, y: 2.2, z: 5.1 }, RUDDER)).toBe(true);
  });
});
