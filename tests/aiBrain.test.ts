import { describe, it, expect } from "vitest";
import { decideAI, type AIView } from "../src/sim/aiBrain";

const base: AIView = {
  range: 200,
  bearingDeg: 0,
  angleOffWindDeg: 90,
  windBearingDeg: 90,
  floodFrac: 0,
  reloadReady: true,
  committedBeam: 0,
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

  it("in engagement range: maneuvers to put the target abeam (broadside-on)", () => {
    // target near dead ahead at 70m → turn so the bearing moves toward ±90
    const d = decideAI({ ...base, range: 70, bearingDeg: 5 });
    expect(d.rudderSign).not.toBe(0);
    expect(d.fire).toBeNull(); // not abeam yet (bearing 5 is outside the firing arc)
    expect(d.sailSet).toBeLessThan(1); // eases off to pace, not a bow-on charge
  });

  it("closes bow-on at FULL sail until inside engagement range", () => {
    // beyond 120m she charges the target bow-on at full canvas
    const d = decideAI({ ...base, range: 150, bearingDeg: 30 });
    expect(d.sailSet).toBe(1);
    expect(d.rudderSign).toBe(1); // turning toward bearing 0
    expect(d.fire).toBeNull(); // out of gun range
  });

  it("presents the broadside instead of chasing from astern once in range", () => {
    // target fine on the bow at 100m → she turns to bring a beam to bear, not
    // charge straight at it
    const d = decideAI({ ...base, range: 100, bearingDeg: 20 });
    // bearing 20 → cheaper beam is starboard (cost |20-90|=70 < |20+90|=110),
    // so she steers to push the target's bearing UP toward +90. Steering
    // starboard DECREASES bearing, so moving 20→90 needs rudder PORT (-1).
    expect(d.committedBeam).toBe(1);
    expect(d.rudderSign).toBe(-1);
    expect(d.sailSet).toBeLessThan(1);
  });

  it("fires the broadside that bears while pacing the target", () => {
    const d = decideAI({ ...base, range: 70, bearingDeg: 85 });
    expect(d.fire).toBe("starboard");
  });

  it("stays in the fight even pointed near the wind at mid range", () => {
    // wind near the bow but inside engagement range → no bear-away, she fights
    const d = decideAI({ ...base, range: 80, bearingDeg: 10, windBearingDeg: 8 });
    expect(d.rudderSign).not.toBe(0); // maneuvering for the broadside, not stalled
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

  it("in irons FAR out: bears away from the wind before anything else", () => {
    // wind dead ahead, target far ahead — must NOT keep pointing at the wind
    const d = decideAI({ ...base, range: 200, bearingDeg: 0, windBearingDeg: 5 });
    expect(d.rudderSign).toBe(-1); // wind slightly to starboard → fall off to port
    const d2 = decideAI({ ...base, range: 200, bearingDeg: 0, windBearingDeg: -5 });
    expect(d2.rudderSign).toBe(1);
  });

  it("irons rule yields to combat in engagement range", () => {
    const d = decideAI({ ...base, range: 30, bearingDeg: 88, windBearingDeg: 0 });
    expect(d.fire).toBe("starboard");
  });

  it("badly flooded: stays and fights, does NOT flee downrange", () => {
    // the flee/disengage branch was removed — a crippled captain holds station
    // and keeps firing instead of sailing off out of reach.
    const d = decideAI({ ...base, range: 60, bearingDeg: 90, floodFrac: 0.6 });
    expect(d.fire).toBe("starboard"); // still firing the bearing broadside
    expect(d.sailSet).toBeLessThan(1); // pacing the target, not running downwind
  });

  it("commits to a beam and does not thrash side to side (hysteresis)", () => {
    // committed to starboard; target swings just past dead astern to the port
    // bow. A small port advantage must NOT flip the committed beam.
    const stay = decideAI({ ...base, range: 90, bearingDeg: -5, committedBeam: 1 });
    expect(stay.committedBeam).toBe(1);
    // but a clear port advantage (target well to port) does flip it
    const flip = decideAI({ ...base, range: 90, bearingDeg: -80, committedBeam: 1 });
    expect(flip.committedBeam).toBe(-1);
  });
});
