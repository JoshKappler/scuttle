import { describe, it, expect } from "vitest";
import {
  stormFromSeaScale,
  seaScaleFromStorm,
  weatherFront,
  rainIntensity,
  rainGain,
  lightningRatePerSec,
  thunderDelaySec,
  thunderVolume,
  windStormBoost,
  skyStormParams,
  cloudStormParams,
} from "../src/render/weatherMath";

describe("storminess mapping", () => {
  it("scales by halves across the sea levels — clear at Calm, full at Stormy", () => {
    expect(stormFromSeaScale(0.45)).toBeCloseTo(0, 5); // Calm — fully clear
    expect(stormFromSeaScale(1.0)).toBeCloseTo(0.25, 5); // Moderate — a little stormy (¼)
    expect(stormFromSeaScale(1.7)).toBeCloseTo(0.5, 5); // Rough — half the final
    expect(stormFromSeaScale(2.6)).toBeCloseTo(1, 5); // Stormy — full nightmare
  });
  it("is monotonic and clamps outside the sea-level range", () => {
    expect(stormFromSeaScale(0.2)).toBe(0); // below Calm → still clear
    expect(stormFromSeaScale(3.5)).toBe(1); // above Stormy → capped at full
    expect(stormFromSeaScale(1.35)).toBeGreaterThan(stormFromSeaScale(0.7)); // rising between anchors
    expect(stormFromSeaScale(2.15)).toBeGreaterThan(stormFromSeaScale(1.35));
  });
  it("seaScaleFromStorm spans calm..full and is monotonic", () => {
    expect(seaScaleFromStorm(0)).toBeCloseTo(0.6, 5);
    expect(seaScaleFromStorm(1)).toBeCloseTo(2.6, 5);
    expect(seaScaleFromStorm(0.5)).toBeGreaterThan(seaScaleFromStorm(0.2));
  });
});

describe("weatherFront", () => {
  it("stays within [0,1] and is 0 at zero intensity", () => {
    for (let t = 0; t < 600; t += 7) {
      const v = weatherFront(t, { period: 140, intensity: 1 });
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(weatherFront(t, { period: 140, intensity: 0 })).toBe(0);
    }
  });
});

describe("derived curves", () => {
  it("rain starts only once it's a bit stormy and saturates", () => {
    expect(rainIntensity(0.1)).toBe(0);
    expect(rainIntensity(1)).toBeCloseTo(1, 5);
    expect(rainGain(1)).toBeGreaterThan(rainGain(0.4));
  });
  it("lightning is none until mid-storm then grows ~quadratically", () => {
    expect(lightningRatePerSec(0.4)).toBe(0);
    expect(lightningRatePerSec(1)).toBeGreaterThan(lightningRatePerSec(0.7));
  });
  it("thunder delay is distance/speed-of-sound; volume falls with distance", () => {
    expect(thunderDelaySec(343)).toBeCloseTo(1, 3);
    expect(thunderVolume(0)).toBeGreaterThan(thunderVolume(1000));
  });
  it("wind boost rises with storm", () => {
    expect(windStormBoost(0)).toBe(0);
    expect(windStormBoost(1)).toBeGreaterThan(windStormBoost(0.5));
  });
  it("sky/cloud params darken with storm", () => {
    expect(skyStormParams(1).sunDim).toBeGreaterThan(skyStormParams(0).sunDim);
    expect(cloudStormParams(1).coverage).toBeGreaterThan(cloudStormParams(0).coverage);
    expect(cloudStormParams(1).darken).toBeGreaterThan(cloudStormParams(0).darken);
  });
});
