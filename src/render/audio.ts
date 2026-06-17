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
const MANIFEST: Record<string, string> = {
  cannon: "sfx/cannon.wav",
  impact_wood: "sfx/impact_wood.wav",
  impact_thud: "sfx/impact_thud.wav",
  crunch: "sfx/crunch.wav",
  sink: "sfx/sink.wav",
  coins: "sfx/coins.wav",
  splash: "sfx/splash.wav",
  gull: "sfx/gull.wav",
  creak: "sfx/creak.wav",
  rope: "sfx/rope.wav",
  ui_click: "sfx/ui_click.wav",
  ui_confirm: "sfx/ui_confirm.wav",
  ui_buy: "sfx/ui_buy.wav",
  port_open: "sfx/port_open.wav",
  ship_ready: "sfx/ship_ready.wav",
  ocean_loop: "ambient/ocean_loop.wav",
  wind_loop: "ambient/wind_loop.wav",
  menu_theme: "music/menu_theme.wav",
  sea_ambient: "music/sea_ambient.wav",
  harbor: "music/harbor.wav",
};

const POS_VOICES = 16;
const UI_VOICES = 6;
const MUSIC_GAIN = 0.4;
const OCEAN_GAIN = 0.28;
const WIND_BASE = 0.4;

// Procedural placeholders that read poorly in play-test (the synthetic "seagull" was ungodly;
// the noise-based "creak"/"rope" came across as bubbling on rudder/tilt). They stay MUTED until a
// real recording is dropped into public/assets/audio/ — DELETE an id here the moment its real file
// lands and it springs back to life (the trigger logic in main.ts is untouched). See that README.
const PLACEHOLDER_MUTED = new Set<string>(["gull", "creak", "rope"]);

export class AudioManager {
  readonly listener: THREE.AudioListener;
  private ctx: AudioContext;
  private buffers = new Map<string, AudioBuffer>();
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

  private loadOne(id: string, path: string): Promise<void> {
    return new Promise((res) => {
      this.loader.load(
        BASE + path,
        (buf) => {
          this.buffers.set(id, buf);
          res();
        },
        undefined,
        () => {
          console.warn("[audio] failed to load", id, BASE + path);
          res();
        },
      );
    });
  }

  private loadAll(): Promise<void> {
    return Promise.all(Object.entries(MANIFEST).map(([id, p]) => this.loadOne(id, p))).then(() => {});
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
    const buf = this.buffers.get(id);
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
    const buf = this.buffers.get(id);
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
    const buf = this.buffers.get(id);
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

  /** Crossfade the music to the track for `state` (no-op if already on it). */
  music(state: MusicState): void {
    const track = musicTrackForState(state);
    if (track === this.currentTrack) return;
    const buf = this.buffers.get(track);
    if (!buf) return;
    const now = this.ctx.currentTime;
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
