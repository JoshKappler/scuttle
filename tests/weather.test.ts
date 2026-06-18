import { describe, it, expect } from "vitest";
import { WeatherController, type WeatherSinks } from "../src/render/weather";

function fakeSinks() {
  const calls = { storm: [] as number[], flash: [] as number[], rain: [] as number[], swell: [] as number[], bolts: 0, thunder: [] as number[] };
  const sinks: WeatherSinks = {
    sky: { setStorm: (s) => calls.storm.push(s), setFlash: (f) => calls.flash.push(f) },
    clouds: { setStorm: () => {} },
    ocean: { setStorm: () => {}, setFlash: () => {} },
    rain: { setIntensity: (i) => calls.rain.push(i), update: () => {} },
    lightning: { spawnBolt: () => { calls.bolts++; }, update: () => {}, flash: () => 0, flashDir: () => [0, 1] },
    audio: { ambient: () => {}, setWind: () => {}, thunder: (v) => calls.thunder.push(v) },
    applySwell: (s) => calls.swell.push(s),
    baseWind: () => 0,
  };
  return { sinks, calls };
}
const cam = { x: 0, y: 2, z: 0 } as any;

describe("WeatherController", () => {
  it("eases storminess toward the fixed target", () => {
    const { sinks } = fakeSinks();
    const w = new WeatherController(sinks);
    w.setMode("fixed", 1);
    for (let i = 0; i < 600; i++) w.update(0.1, i * 0.1, cam, true);
    expect(w.storminess).toBeGreaterThan(0.95);
  });
  it("dynamic mode drives the swell from the front, within [calm, full]", () => {
    const { sinks, calls } = fakeSinks();
    const w = new WeatherController(sinks, () => 0.99); // rng: never fires lightning
    w.setMode("dynamic");
    for (let i = 0; i < 50; i++) w.update(0.1, i * 0.1, cam, true);
    expect(calls.swell.length).toBeGreaterThan(0);
    for (const s of calls.swell) {
      expect(s).toBeGreaterThanOrEqual(0.6);
      expect(s).toBeLessThanOrEqual(2.6);
    }
  });
  it("fires bolts + schedules thunder at full storm, none when inactive", () => {
    const { sinks, calls } = fakeSinks();
    const w = new WeatherController(sinks, () => 0.0001); // rng: always fires when rate>0
    w.setMode("fixed", 1);
    for (let i = 0; i < 50; i++) w.update(0.1, i * 0.1, cam, true);
    expect(calls.bolts).toBeGreaterThan(0);
    expect(calls.thunder.length).toBeGreaterThan(0);
    const before = calls.bolts;
    for (let i = 0; i < 50; i++) w.update(0.1, i * 0.1, cam, false); // inactive (menu/pause)
    expect(calls.bolts).toBe(before);
  });
});
