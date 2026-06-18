// Pure, Three-free weather decision logic so it is unit-testable (mirrors audioMath.ts).
// WeatherController (render/weather.ts) consumes these; nothing here touches sim/ (THE LAW #1).

export const STORM_CLEAR = 1.0; // seaScale at/below which it's fully clear ("the regular one")
export const STORM_FULL = 2.6; // seaScale of a full nightmare (== the Stormy pill)
export const SEA_CALM = 0.6; // swell scale at storminess 0 in Career (gentle, not glassy)
const RAIN_START = 0.25; // storminess at which rain begins
const LIGHT_START = 0.55; // storminess at which lightning begins
const THUNDER_REF = 250; // m — thunder half-volume distance scale
const SOUND_MPS = 343;

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Sea-roughness scalar → storminess [0,1]. Clear through Moderate (≤1.0), full at Stormy (2.6). */
export function stormFromSeaScale(seaScale: number): number {
  return smoothstep(STORM_CLEAR, STORM_FULL, seaScale);
}
/** Career: storminess → swell-amplitude scale fed to applySeaScale. */
export function seaScaleFromStorm(storminess: number): number {
  return lerp(SEA_CALM, STORM_FULL, clamp01(storminess));
}

export interface FrontParams {
  period: number;
  intensity: number;
}
/** Deterministic smooth weather-front drift in [0,1]: mostly fair, occasional storms. */
export function weatherFront(t: number, p: FrontParams): number {
  const a = Math.sin((2 * Math.PI * t) / p.period);
  const b = Math.sin((2 * Math.PI * t) / (p.period * 0.37) + 1.3);
  const raw = 0.5 + 0.5 * (0.6 * a + 0.4 * b); // wandering 0..1
  const shaped = Math.pow(clamp01(raw), 2.2); // bias toward calm → storms are events
  return clamp01(shaped * p.intensity);
}

export function rainIntensity(s: number): number {
  return smoothstep(RAIN_START, 1.0, s);
}
export function rainGain(s: number): number {
  return clamp01(0.15 + 0.85 * rainIntensity(s)); // audible floor once raining
}
export function lightningRatePerSec(s: number): number {
  if (s <= LIGHT_START) return 0;
  const x = (s - LIGHT_START) / (1 - LIGHT_START); // 0..1 above the threshold
  return 0.6 * x * x; // up to ~1 strike / 1.7 s at full storm
}
export function thunderDelaySec(distanceM: number): number {
  return Math.max(0, distanceM) / SOUND_MPS;
}
export function thunderVolume(distanceM: number): number {
  return clamp01(1 / (1 + Math.max(0, distanceM) / THUNDER_REF));
}
export function windStormBoost(s: number): number {
  return 3 * smoothstep(0.2, 1.0, s);
}

export interface SkyStormParams {
  sunDim: number;
  darken: number;
  sunCrush: number;
}
export function skyStormParams(s: number): SkyStormParams {
  return {
    sunDim: smoothstep(0.1, 1.0, s),
    darken: smoothstep(0.1, 1.0, s),
    sunCrush: smoothstep(0.2, 0.9, s),
  };
}
export interface CloudStormParams {
  coverage: number;
  density: number;
  speed: number;
  darken: number;
}
export function cloudStormParams(s: number): CloudStormParams {
  return {
    coverage: lerp(0.5, 0.97, s),
    density: lerp(0.7, 1.0, s),
    speed: lerp(0.6, 1.8, s),
    darken: smoothstep(0.1, 1.0, s),
  };
}
