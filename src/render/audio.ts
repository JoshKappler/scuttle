import * as THREE from "three";
import { pickVoiceIndex, windGain, musicTrackForState, type MusicState } from "./audioMath";

/**
 * AudioManager — the whole sound layer, built on Three.js' Web Audio.
 *
 * - one AudioListener on the camera (sound pans/attenuates relative to the active view)
 * - a pool of PositionalAudio voices (world events) + a small 2D pool (UI), so a broadside
 *   or a sustained ram never allocates per-shot (pickVoiceIndex reuses the idle/oldest slot)
 * - looping ocean + wind beds, a crossfading music voice pair, and a global low-pass for the
 *   underwater muffle (listener.gain -> filter -> destination)
 * - master volume rides the listener; settings.masterVolume is finally consumed here
 *
 * Determinism (THE LAW #1): nothing here touches sim/. All hooks call IN from game/render/main.
 * Loads are best-effort — a missing/failed file stays silent and logs once; never throws.
 */

type Vec = { x: number; y: number; z: number };
interface PlayOpts {
  volume?: number;
  rate?: number;
  refDistance?: number;
}

const BASE = "assets/audio/";
// An id maps to ONE file or an ARRAY of interchangeable takes. When it's an array, playAt/playUi pick
// a random take (never the same one twice running) — so a broadside or a string of cannon hits varies
// shot to shot instead of the same canned clip. The four real wood-cracks cover ALL damage (a ball
// boring the hull, a hull grinding another), so impact + crunch share that pool. Shared paths decode
// once (the loader dedupes by path). Drop-in convention + provenance: public/assets/audio/README.md.
const WOOD_CRACKS = [
  "sfx/wood_crack_1.ogg",
  "sfx/wood_crack_2.ogg",
  "sfx/wood_crack_3.ogg",
  "sfx/wood_crack_4.ogg",
];
const MANIFEST: Record<string, string | string[]> = {
  cannon: ["sfx/cannon_1.ogg", "sfx/cannon_2.ogg", "sfx/cannon_3.ogg", "sfx/cannon_4.ogg"],
  impact_wood: WOOD_CRACKS,
  impact_thud: WOOD_CRACKS,
  crunch: WOOD_CRACKS,
  sink: "sfx/sink.wav", // still a procedural placeholder (no real recording dropped in yet)
  coins: "sfx/coins.ogg",
  splash: "sfx/splash.wav", // unused
  gull: "sfx/gull.wav", // MUTED placeholder (no real recording yet) — see PLACEHOLDER_MUTED
  creak: "sfx/creak.ogg",
  rope: ["sfx/rope_1.ogg", "sfx/rope_2.ogg", "sfx/rope_3.ogg"],
  ui_click: "sfx/ui_click.mp3",
  ui_confirm: "sfx/ui_confirm.wav", // placeholder
  ui_buy: "sfx/ui_buy.mp3",
  port_open: "sfx/port_open.ogg",
  ship_ready: "sfx/ship_ready.wav", // placeholder
  ocean_loop: "ambient/ocean_loop.ogg",
  wind_loop: "ambient/wind_loop.ogg",
  menu_theme: "music/menu_theme.ogg",
  sea_ambient: "music/sea_ambient.wav", // unused — at sea is ambience-only (no music track)
  harbor: "music/harbor.ogg",
};

const POS_VOICES = 16;
const UI_VOICES = 6;
const MUSIC_GAIN = 0.4;
const OCEAN_GAIN = 0.28;
const WIND_BASE = 0.4;

// Placeholders still awaiting a real recording that sound worse than silence stay MUTED — the
// synthetic seagull was unpleasant, so `gull` waits. (creak + rope now have real files and play.)
// DELETE an id here the moment its real file lands; the trigger logic in main.ts is untouched.
const PLACEHOLDER_MUTED = new Set<string>(["gull"]);

export class AudioManager {
  readonly listener: THREE.AudioListener;
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer[]>(); // id -> one or more interchangeable takes
  private lastTake = new Map<string, number>(); // last variant played per id (avoid back-to-back repeats)
  private loader = new THREE.AudioLoader();
  private posVoices: THREE.PositionalAudio[] = [];
  private posBusy: number[] = [];
  private uiVoices: THREE.Audio[] = [];
  private uiBusy: number[] = [];
  private ocean: THREE.Audio;
  private wind: THREE.Audio;
  private musicVoices: THREE.Audio[];
  private activeMusic = 0;
  private currentTrack = "";
  private masterFilter: BiquadFilterNode;
  private underwater = false;
  ready: Promise<void>;

  constructor(camera: THREE.Camera, scene: THREE.Scene, settings: { masterVolume: number }) {
    const listener = new THREE.AudioListener();
    camera.add(listener);
    this.listener = listener;
    this.ctx = listener.context;

    // Global low-pass for the underwater muffle: reroute the listener's gain through a filter.
    // At ~22kHz it's effectively a bypass; setUnderwater ramps it down to muffle everything.
    const f = this.ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 22000;
    listener.gain.disconnect();
    listener.gain.connect(f);
    f.connect(this.ctx.destination);
    this.masterFilter = f;

    listener.setMasterVolume(Math.max(0, Math.min(1, settings.masterVolume)));

    for (let i = 0; i < POS_VOICES; i++) {
      const v = new THREE.PositionalAudio(listener);
      v.setRefDistance(18);
      v.setRolloffFactor(1.4);
      scene.add(v);
      this.posVoices.push(v);
      this.posBusy.push(0);
    }
    for (let i = 0; i < UI_VOICES; i++) {
      this.uiVoices.push(new THREE.Audio(listener));
      this.uiBusy.push(0);
    }
    this.ocean = new THREE.Audio(listener);
    this.wind = new THREE.Audio(listener);
    this.musicVoices = [new THREE.Audio(listener), new THREE.Audio(listener)];

    this.ready = this.loadAll();
  }

  private loadPath(path: string, cache: Map<string, Promise<AudioBuffer | null>>): Promise<AudioBuffer | null> {
    let pr = cache.get(path);
    if (!pr) {
      pr = new Promise((res) => {
        this.loader.load(
          BASE + path,
          (buf) => res(buf),
          undefined,
          () => {
            console.warn("[audio] failed to load", BASE + path);
            res(null);
          },
        );
      });
      cache.set(path, pr);
    }
    return pr;
  }

  private async loadAll(): Promise<void> {
    const cache = new Map<string, Promise<AudioBuffer | null>>(); // a shared path decodes once
    await Promise.all(
      Object.entries(MANIFEST).map(async ([id, val]) => {
        const paths = Array.isArray(val) ? val : [val];
        const bufs = (await Promise.all(paths.map((p) => this.loadPath(p, cache)))).filter(
          (b): b is AudioBuffer => b !== null,
        );
        if (bufs.length) this.buffers.set(id, bufs);
      }),
    );
  }

  /** One take for `id`: the only one, or a random variant that isn't the one we just played. */
  private pickTake(id: string): AudioBuffer | null {
    const arr = this.buffers.get(id);
    if (!arr || arr.length === 0) return null;
    if (arr.length === 1) return arr[0];
    const last = this.lastTake.get(id) ?? -1;
    let i = Math.floor(Math.random() * arr.length);
    if (i === last) i = (i + 1) % arr.length;
    this.lastTake.set(id, i);
    return arr[i];
  }

  /** Unlock Web Audio (browsers start the context suspended until a user gesture). */
  resume(): void {
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  setMasterVolume(v: number): void {
    this.listener.setMasterVolume(Math.max(0, Math.min(1, v)));
  }

  /** Pooled positional one-shot at a world point. */
  playAt(id: string, pos: Vec, opts: PlayOpts = {}): void {
    if (PLACEHOLDER_MUTED.has(id)) return; // muted bad placeholder — re-enabled by deleting it from the set
    const buf = this.pickTake(id);
    if (!buf) return;
    const now = this.ctx.currentTime;
    const i = pickVoiceIndex(this.posBusy, now);
    const v = this.posVoices[i];
    if (v.isPlaying) v.stop();
    if (opts.refDistance) v.setRefDistance(opts.refDistance);
    v.position.set(pos.x, pos.y, pos.z);
    v.updateMatrixWorld(true); // refresh the panner position before it sounds
    v.setBuffer(buf);
    v.setVolume(opts.volume ?? 1);
    v.setPlaybackRate(opts.rate ?? 1);
    v.play();
    this.posBusy[i] = now + buf.duration / (opts.rate ?? 1);
  }

  /** Pooled non-positional one-shot (UI / off-screen cues). */
  playUi(id: string, opts: PlayOpts = {}): void {
    if (PLACEHOLDER_MUTED.has(id)) return;
    const buf = this.pickTake(id);
    if (!buf) return;
    const now = this.ctx.currentTime;
    const i = pickVoiceIndex(this.uiBusy, now);
    const v = this.uiVoices[i];
    if (v.isPlaying) v.stop();
    v.setBuffer(buf);
    v.setVolume(opts.volume ?? 0.8);
    v.setPlaybackRate(opts.rate ?? 1);
    v.play();
    this.uiBusy[i] = now + buf.duration;
  }

  /** Start/stop a looping bed. `on=false` just mutes it (keeps it warm for re-fade). */
  ambient(which: "ocean" | "wind", on: boolean, gain?: number): void {
    const v = which === "ocean" ? this.ocean : this.wind;
    const id = which === "ocean" ? "ocean_loop" : "wind_loop";
    const buf = this.buffers.get(id)?.[0];
    if (!buf) return;
    if (on) {
      if (!v.buffer) {
        v.setBuffer(buf);
        v.setLoop(true);
      }
      v.setVolume(gain ?? (which === "ocean" ? OCEAN_GAIN : WIND_BASE));
      if (!v.isPlaying) v.play();
    } else if (v.isPlaying) {
      v.setVolume(0);
    }
  }

  /** Map a sail/speed intensity to the wind bed's loudness. */
  setWind(intensity: number): void {
    if (!this.wind.isPlaying) return;
    this.wind.setVolume(windGain(intensity) * WIND_BASE);
  }

  /** Crossfade the music to the track for `state` (no-op if already on it). An empty track id
   *  (at sea — no music, just ambience) fades the current track out and leaves it silent. */
  music(state: MusicState): void {
    const track = musicTrackForState(state);
    if (track === this.currentTrack) return;
    const now = this.ctx.currentTime;
    if (track === "") {
      const out = this.musicVoices[this.activeMusic];
      if (out.isPlaying) {
        out.gain.gain.cancelScheduledValues(now);
        out.gain.gain.setValueAtTime(out.gain.gain.value, now);
        out.gain.gain.linearRampToValueAtTime(0, now + 1.5);
      }
      this.currentTrack = "";
      return;
    }
    const buf = this.buffers.get(track)?.[0];
    if (!buf) return;
    const incoming = this.musicVoices[1 - this.activeMusic];
    const outgoing = this.musicVoices[this.activeMusic];
    if (incoming.isPlaying) incoming.stop();
    incoming.setBuffer(buf);
    incoming.setLoop(true);
    incoming.play();
    incoming.gain.gain.cancelScheduledValues(now);
    incoming.gain.gain.setValueAtTime(0, now);
    incoming.gain.gain.linearRampToValueAtTime(MUSIC_GAIN, now + 1.5);
    if (outgoing.isPlaying) {
      outgoing.gain.gain.cancelScheduledValues(now);
      outgoing.gain.gain.setValueAtTime(outgoing.gain.gain.value, now);
      outgoing.gain.gain.linearRampToValueAtTime(0, now + 1.5);
    }
    this.activeMusic = 1 - this.activeMusic;
    this.currentTrack = track;
  }

  /** Toggle the global underwater low-pass (ramped, so no click). */
  setUnderwater(on: boolean): void {
    if (on === this.underwater) return;
    this.underwater = on;
    const now = this.ctx.currentTime;
    const p = this.masterFilter.frequency;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(on ? 360 : 22000, now + 0.3);
  }
}
