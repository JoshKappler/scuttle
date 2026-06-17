import { describe, it, expect } from "vitest";
import { pickVoiceIndex, windGain, musicTrackForState, crunchVolume, ThrottleGate } from "../src/render/audioMath";

describe("pickVoiceIndex", () => {
  it("returns the first idle voice", () => {
    // busyUntil[i] > now means in use; pick the first <= now
    expect(pickVoiceIndex([0, 5, 0], 3)).toBe(0);
    expect(pickVoiceIndex([5, 0, 5], 3)).toBe(1);
  });
  it("when all busy, steals the one freeing soonest (smallest busyUntil)", () => {
    expect(pickVoiceIndex([9, 4, 7], 3)).toBe(1);
  });
});

describe("windGain", () => {
  it("is 0 at rest and clamps to <=1 at full canvas", () => {
    expect(windGain(0)).toBeCloseTo(0, 5);
    expect(windGain(1)).toBeGreaterThan(0);
    expect(windGain(5)).toBeLessThanOrEqual(1);
  });
  it("is monotonic in intensity", () => {
    expect(windGain(0.8)).toBeGreaterThan(windGain(0.2));
  });
});

describe("musicTrackForState", () => {
  it("maps phases to track ids", () => {
    expect(musicTrackForState("menu")).toBe("menu_theme");
    expect(musicTrackForState("playing")).toBe(""); // at sea = ambience only, no music track
    expect(musicTrackForState("port")).toBe("harbor");
    expect(musicTrackForState("paused")).toBe("menu_theme");
  });
});

describe("crunchVolume", () => {
  it("scales with wood removed and clamps to 1", () => {
    expect(crunchVolume(0)).toBe(0);
    expect(crunchVolume(2)).toBeGreaterThan(0);
    expect(crunchVolume(10000)).toBeLessThanOrEqual(1);
  });
});

describe("ThrottleGate", () => {
  it("allows the first call and blocks until the interval passes", () => {
    const g = new ThrottleGate(0.1); // 100ms
    expect(g.allow(0)).toBe(true);
    expect(g.allow(0.05)).toBe(false);
    expect(g.allow(0.11)).toBe(true);
  });
});
