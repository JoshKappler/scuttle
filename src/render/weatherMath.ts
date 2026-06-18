// Pure, Three-free weather decision logic so it is unit-testable (mirrors audioMath.ts).
// WeatherController (render/weather.ts) consumes these; nothing here touches sim/ (THE LAW #1).

export const STORM_FULL = 2.6; // seaScale of a full nightmare (== the Stormy pill)

/**
 * Sea-state pill → storminess anchors. Each Sandbox sea level carries roughly HALF the storm of the
 * one above it, with only the calmest level fully clear: Calm→0, Moderate→0.25, Rough→0.5, Stormy→1.
 * (Keys are the four sea-roughness pill values in render/menuScreen.ts.) Interpolated piecewise so a
 * dev-panel seaScale between pills still reads a sensible in-between storm.
 */
const STORM_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [0.45, 0.0], // Calm — fully clear/sunny
  [1.0, 0.25], // Moderate — a little stormy (overcast, no rain yet)
  [1.7, 0.5], // Rough — half the final intensity
  [2.6, 1.0], // Stormy — full nightmare
];
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

/** Sea-roughness scalar → storminess [0,1]. Gradual halving up the sea levels (see STORM_ANCHORS):
 *  clear at Calm, a little stormy at Moderate, half at Rough, full at Stormy. Clamped outside range. */
export function stormFromSeaScale(seaScale: number): number {
  const a = STORM_ANCHORS;
  if (seaScale <= a[0][0]) return a[0][1];
  for (let i = 1; i < a.length; i++) {
    if (seaScale <= a[i][0]) {
      const t = (seaScale - a[i - 1][0]) / (a[i][0] - a[i - 1][0]);
      return lerp(a[i - 1][1], a[i][1], t);
    }
  }
  return a[a.length - 1][1];
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
