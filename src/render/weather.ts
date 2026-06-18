import * as THREE from "three";
import { TUN } from "../core/tunables";
import {
  clamp01,
  seaScaleFromStorm,
  weatherFront,
  rainIntensity,
  rainGain,
  lightningRatePerSec,
  thunderDelaySec,
  thunderVolume,
  windStormBoost,
} from "./weatherMath";

/**
 * WeatherController — the weather hub. Owns one eased `storminess` [0,1] and fans it out to the
 * dumb leaf sinks (sky, clouds, ocean, rain, lightning, audio) each frame, schedules lightning
 * strikes (+ distance-delayed thunder), and in Career drives the swell from the rolling weather.
 *
 * Sandbox: setMode("fixed", stormFromSeaScale(pill)) — storminess held at the chosen sea.
 * Career: setMode("dynamic") — a deterministic weather-front drift; the swell follows storminess.
 *
 * THE LAW #1: nothing here touches sim/. The only physics input is swell amplitude, via the
 * injected applySwell (which wraps the existing sim/gerstner.applySeaScale + ocean.refreshSwell).
 */
export interface WeatherSinks {
  sky: { setStorm(s: number): void; setFlash(f: number): void };
  clouds: { setStorm(s: number): void };
  ocean: { setStorm(s: number): void; setFlash(f: number, dx: number, dz: number): void };
  rain: { setIntensity(i: number): void; update(dt: number, cam: THREE.Vector3): void };
  lightning: {
    spawnBolt(dx: number, dz: number, distance: number, intensity: number, originX?: number, originZ?: number): void;
    update(dt: number): void;
    flash(): number;
    flashDir(): [number, number];
  };
  audio: {
    ambient(which: "ocean" | "wind" | "rain", on: boolean, gain?: number): void;
    setWind(i: number): void;
    thunder(volume: number): void;
  };
  /** Re-scale the swell amplitude (wraps sim/gerstner.applySeaScale + ocean.refreshSwell). */
  applySwell: (seaScale: number) => void;
  /** The non-storm wind intensity (sail/speed) so the storm boost adds on top. */
  baseWind: () => number;
}

export class WeatherController {
  storminess = 0;
  private target = 0;
  private mode: "fixed" | "dynamic" = "fixed";
  private pending: { at: number; vol: number }[] = [];
  private clock = 0;
  private lastSwell = -1;
  private swellThrottle = 0;

  constructor(
    private s: WeatherSinks,
    private rng: () => number = Math.random,
  ) {}

  setMode(mode: "fixed" | "dynamic", fixedTarget = 0): void {
    this.mode = mode;
    if (mode === "fixed") this.target = clamp01(fixedTarget);
  }

  /** active = at sea (playing/port). In menu/pause we freeze schedules + mute rain. */
  update(dt: number, simTime: number, cam: THREE.Vector3, active: boolean): void {
    this.clock += dt;
    // target storminess
    if (TUN.weather.override >= 0) this.target = clamp01(TUN.weather.override);
    else if (this.mode === "dynamic")
      this.target = weatherFront(simTime, { period: TUN.weather.frontPeriod, intensity: TUN.weather.frontIntensity });
    // ease (frame-rate independent)
    const k = 1 - Math.exp(-TUN.weather.ease * dt * 6);
    this.storminess += (this.target - this.storminess) * k;
    const s = this.storminess;

    // Career: the swell follows storminess (throttled GPU re-upload, only on meaningful change)
    this.swellThrottle -= dt;
    if (this.mode === "dynamic" && this.swellThrottle <= 0) {
      const sea = seaScaleFromStorm(s);
      if (Math.abs(sea - this.lastSwell) > 0.01) {
        this.s.applySwell(sea);
        this.lastSwell = sea;
      }
      this.swellThrottle = 0.25;
    }

    // fan out the visuals
    this.s.sky.setStorm(s * TUN.weather.skyDark);
    this.s.clouds.setStorm(s * TUN.weather.cloudDark);
    this.s.ocean.setStorm(s);
    this.s.rain.setIntensity(active ? rainIntensity(s) * TUN.weather.rain : 0);
    this.s.rain.update(dt, cam);
    this.s.lightning.update(dt);

    // push the lightning flash to sky + sea (the bolt lighting the scene)
    const f = this.s.lightning.flash();
    this.s.sky.setFlash(f);
    const fd = this.s.lightning.flashDir();
    this.s.ocean.setFlash(f, fd[0], fd[1]);

    // audio beds
    this.s.audio.ambient("rain", active && rainIntensity(s) > 0.02, rainGain(s) * TUN.weather.rain);
    this.s.audio.setWind(this.s.baseWind() + (active ? windStormBoost(s) * TUN.weather.windBoost : 0));

    if (active) {
      // schedule strikes (Poisson over dt)
      const rate = lightningRatePerSec(s) * TUN.weather.lightning;
      if (rate > 0 && this.rng() < rate * dt) this.fireStrike(cam, s);
      // fire any thunder now due
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.clock >= this.pending[i].at) {
          this.s.audio.thunder(this.pending[i].vol);
          this.pending.splice(i, 1);
        }
      }
    }
  }

  private fireStrike(cam: THREE.Vector3, s: number): void {
    const ang = this.rng() * Math.PI * 2;
    const dist = 150 + this.rng() * 900;
    const dx = Math.cos(ang),
      dz = Math.sin(ang);
    this.s.lightning.spawnBolt(dx, dz, dist, s, cam.x, cam.z);
    this.pending.push({ at: this.clock + thunderDelaySec(dist), vol: thunderVolume(dist) });
  }

  /** Debug: force a strike now (dev panel "strike now" button). */
  triggerStrike(cam: THREE.Vector3): void {
    this.fireStrike(cam, Math.max(0.6, this.storminess));
  }
}
