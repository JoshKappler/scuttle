import { describe, it, expect } from "vitest";
import { decideAI, type AIView } from "../src/sim/aiBrain";

const base: AIView = {
  range: 200,
  bearingDeg: 0,
  angleOffWindDeg: 90,
  windBearingDeg: 90,
  floodFrac: 0,
  reloadReady: true,
};

describe("AI captain brain", () => {
  it("far away: full sail, steers toward the target", () => {
    const d = decideAI({ ...base, range: 200, bearingDeg: 40 });
    expect(d.sailSet).toBe(1);
    expect(d.rudderSign).toBe(1); // turn starboard toward +bearing
    expect(d.fire).toBeNull();
  });

  it("far away, target to port: steers port", () => {
    expect(decideAI({ ...base, range: 200, bearingDeg: -40 }).rudderSign).toBe(-1);
  });

  it("in range: maneuvers to put the target abeam", () => {
    // target dead ahead at 60m → keep turning so bearing moves toward ±90
    const d = decideAI({ ...base, range: 60, bearingDeg: 5 });
    expect(d.rudderSign).not.toBe(0);
    expect(d.fire).toBeNull(); // not abeam yet
  });

  it("fires the correct broadside when target is abeam and loaded", () => {
    expect(decideAI({ ...base, range: 60, bearingDeg: 88 }).fire).toBe("starboard");
    expect(decideAI({ ...base, range: 60, bearingDeg: -92 }).fire).toBe("port");
  });

  it("holds fire while reloading", () => {
    expect(decideAI({ ...base, range: 60, bearingDeg: 90, reloadReady: false }).fire).toBeNull();
  });

  it("holds fire out of range", () => {
    expect(decideAI({ ...base, range: 150, bearingDeg: 90 }).fire).toBeNull();
  });

  it("in irons: bears away from the wind before anything else", () => {
    // wind dead ahead, target also ahead — must NOT keep pointing at the wind
    const d = decideAI({ ...base, range: 200, bearingDeg: 0, windBearingDeg: 5 });
    expect(d.rudderSign).toBe(-1); // wind slightly to starboard → fall off to port
    const d2 = decideAI({ ...base, range: 200, bearingDeg: 0, windBearingDeg: -5 });
    expect(d2.rudderSign).toBe(1);
  });

  it("irons rule yields to combat at close range", () => {
    const d = decideAI({ ...base, range: 30, bearingDeg: 88, windBearingDeg: 0 });
    expect(d.fire).toBe("starboard");
  });

  it("badly flooded: flees downrange and never fires", () => {
    const d = decideAI({ ...base, range: 60, bearingDeg: 90, floodFrac: 0.6 });
    expect(d.fire).toBeNull();
    expect(d.sailSet).toBe(1);
    // steering pushes bearing toward ±180 (target astern)
    expect(d.rudderSign).toBe(-1); // target at +90 → turn port to put it astern
  });
});
