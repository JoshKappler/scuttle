// Pure, Three-free audio decision logic so it is unit-testable in vitest
// without a DOM or Web Audio context. AudioManager (render/audio.ts) consumes these.

export type MusicState = "menu" | "playing" | "port" | "paused";

/** Pick a voice slot: first idle (busyUntil <= now), else the one freeing soonest. */
export function pickVoiceIndex(busyUntil: number[], now: number): number {
  let soonest = 0;
  for (let i = 0; i < busyUntil.length; i++) {
    if (busyUntil[i] <= now) return i;
    if (busyUntil[i] < busyUntil[soonest]) soonest = i;
  }
  return soonest;
}

/** Map a sail/speed intensity (0..~5) to a wind-loop gain in [0,1], gentle floor, saturating. */
export function windGain(intensity: number): number {
  const x = Math.max(0, intensity);
  return Math.min(1, 1 - Math.exp(-0.6 * x));
}

/** Which music track id plays in each game phase. "" = no music (at sea is ambience-only —
 *  wind + ocean carry it; a scored track over open-water sailing fought the soundscape). */
export function musicTrackForState(state: MusicState): string {
  switch (state) {
    case "playing": return "";
    case "paused": return ""; // pause menu is silent — music plays ONLY in the main menu
    case "port": return "harbor";
    case "menu":
    default: return "menu_theme";
  }
}

/** Crunch loudness from voxels removed this contact, soft-saturating to 1. */
export function crunchVolume(removed: number): number {
  if (removed <= 0) return 0;
  return Math.min(1, 0.25 + removed / 40);
}

/** Minimum-interval gate (seconds) so a sustained ram doesn't machine-gun a sound. */
export class ThrottleGate {
  private last = -Infinity;
  constructor(private interval: number) {}
  allow(now: number): boolean {
    if (now - this.last >= this.interval) {
      this.last = now;
      return true;
    }
    return false;
  }
}
