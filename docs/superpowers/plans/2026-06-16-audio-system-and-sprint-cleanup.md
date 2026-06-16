# Audio System + Sprint Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give SCUTTLE a complete first-class audio layer (SFX, ambience, music) and a settings panel, and delete the dead boarding code the sprint left behind.

**Architecture:** One browser-only `AudioManager` (`src/render/audio.ts`) built on Three.js' Web Audio (`AudioListener` on the camera, a pool of `PositionalAudio` voices). Pure decision logic lives in a Three-free `src/render/audioMath.ts` so it is unit-testable. Gameplay hooks ride the existing `effects` feedback handle (cannons, voxelContact) and direct calls from `main.ts`/screen modules. `sim/` stays pure (determinism — THE LAW #1).

**Tech Stack:** TypeScript, Three.js Web Audio, Vite, vitest. Synthesized starter WAV assets via a Node script, with documented drop-in slots for premium (Sonniss/Kenney) audio.

**Spec:** `docs/superpowers/specs/2026-06-16-audio-system-and-sprint-cleanup-design.md`

---

## File Structure

**New:**
- `src/render/audioMath.ts` — pure helpers (voice-pool pick, wind→gain, music-state→track, crunch volume, throttle gate). No Three import.
- `src/render/audio.ts` — `AudioManager` class (Three Web Audio).
- `scripts/gen-audio.mjs` — Node synth that writes the starter WAV assets.
- `public/assets/audio/{sfx,ambient,music}/*.wav` — generated starters.
- `public/assets/audio/README.md` — drop-in instructions + manifest mapping.
- `public/assets/audio/LICENSE-sonniss.txt` — license note (used once Sonniss files are dropped in).
- `tests/audioMath.test.ts` — unit tests for the pure helpers.

**Modified:**
- `src/main.ts` — instantiate `AudioManager`; listener on camera; resume on first gesture; event hooks (sink/coins/port/swap); phase→music/ambience; apply `settings.defaultCamera`; `DEBUG.audio`.
- `src/render/effects.ts` — hold an optional `AudioManager` and forward `cannonBoom`/`impact`/`crunch`.
- `src/game/cannons.ts` — cannon boom at fire; impact at ball→hull.
- `src/game/voxelContact.ts` — crunch at the existing `impactDebris` site.
- `src/render/spray.ts` — rate-limited splash.
- `src/render/menuScreen.ts` — Settings sub-panel + UI-click cue.
- `src/render/portScreen.ts` — per-action UI cues.
- `public/assets/CREDITS.md` — audio credits.

---

## Task 1: Part A — delete dead boarding code

**Files:**
- Modify: `src/game/fleet.ts` (remove `boardingTarget` field + its use)
- Modify: `src/game/player.ts` (remove `grapplePressed` field + `KeyG` setter)
- Modify: `src/main.ts` (remove the legacy-G consume line)
- Modify: `src/game/crew.ts` (reword the stale `DEBUG.boarding` comment)
- Test: `tests/fleet.test.ts` (remove the obsolete test)

- [ ] **Step 1: Grep the blast radius**

Run: grep for `boardingTarget`, `grapplePressed`, `KeyG` across `src/` and `tests/`. Confirm the only sites are the ones listed in the spec (fleet.ts:44/108, player.ts:33/84, main.ts:600, tests/fleet.test.ts:79-93). If `KeyG` appears anywhere else, stop and reassess.

- [ ] **Step 2: Remove the field + its use in `fleet.ts`**

Delete the `boardingTarget: Ship | null = null;` field (line ~44) and the `if (u.ship === this.boardingTarget) continue;` line inside `farthestDespawnable()` (line ~108).

- [ ] **Step 3: Remove `grapplePressed` in `player.ts`**

Delete the `grapplePressed = false;` field (line ~33) and the `if (e.code === "KeyG") this.grapplePressed = true;` handler (line ~84).

- [ ] **Step 4: Remove the orphaned consume in `main.ts`**

Delete `controls.grapplePressed = false; // legacy G …` (line ~600).

- [ ] **Step 5: Reword the stale comment in `crew.ts:195`**

Replace the `DEBUG.boarding.player.fpArmPose` reference with a note that the FP arm pose is baked (no live DEBUG hook).

- [ ] **Step 6: Remove the obsolete test in `tests/fleet.test.ts`**

Delete the entire `"never despawns the boarding target"` test block (lines ~79-93).

- [ ] **Step 7: Build + test**

Run: `npm run build` (tsc must be clean) and `npm run test` (suite drops by exactly one test, stays green).
Expected: build exits 0; tests green; grep for the three identifiers now returns nothing.

- [ ] **Step 8: Commit**

```bash
git add src/game/fleet.ts src/game/player.ts src/main.ts src/game/crew.ts tests/fleet.test.ts
git commit -m "chore: remove dead boarding remnants (boardingTarget, grapplePressed, KeyG)"
```

---

## Task 2: Pure audio helpers + tests (`audioMath.ts`)

**Files:**
- Create: `src/render/audioMath.ts`
- Test: `tests/audioMath.test.ts`

These are Three-free pure functions so vitest can exercise the decision logic without Web Audio.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/audioMath.test.ts
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
    expect(musicTrackForState("playing")).toBe("sea_ambient");
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
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npx vitest run tests/audioMath.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `audioMath.ts`**

```typescript
// src/render/audioMath.ts
// Pure, Three-free audio decision logic so it is unit-testable.

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

/** Which music track id plays in each game phase. */
export function musicTrackForState(state: MusicState): string {
  switch (state) {
    case "playing": return "sea_ambient";
    case "port": return "harbor";
    case "menu":
    case "paused":
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
    if (now - this.last >= this.interval) { this.last = now; return true; }
    return false;
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run tests/audioMath.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/render/audioMath.ts tests/audioMath.test.ts
git commit -m "feat(audio): pure voice-pool/wind/music/crunch helpers with tests"
```

---

## Task 3: Synthesized starter assets + manifest + licensing

**Files:**
- Create: `scripts/gen-audio.mjs`
- Create (generated): `public/assets/audio/{sfx,ambient,music}/*.wav`
- Create: `public/assets/audio/README.md`
- Create: `public/assets/audio/LICENSE-sonniss.txt`
- Modify: `public/assets/CREDITS.md`

- [ ] **Step 1: Write the generator `scripts/gen-audio.mjs`**

Synthesizes 22.05 kHz 16-bit mono WAVs (small, license-clean originals). Covers every id the manifest will reference.

```javascript
// scripts/gen-audio.mjs
// Generates original, license-clean starter audio (22.05kHz mono WAV).
// Run: node scripts/gen-audio.mjs   (re-runnable; overwrites)
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const SR = 22050;
const root = "public/assets/audio";

function wav(samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2);
  }
  return buf;
}
const N = (sec) => Math.floor(sec * SR);
const env = (i, n, a = 0.01, r = 0.2) => {
  const t = i / SR, T = n / SR;
  const atk = Math.min(1, t / a);
  const rel = Math.min(1, (T - t) / r);
  return Math.max(0, Math.min(atk, rel));
};
const noise = () => Math.random() * 2 - 1;
const save = (rel, samples) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, wav(samples));
  console.log("wrote", p, (samples.length / SR).toFixed(2) + "s");
};

// ---- SFX ----
function cannon() {
  const n = N(0.6), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const thump = Math.sin(2 * Math.PI * (90 - 50 * t) * t) * Math.exp(-6 * t);
    const crack = noise() * Math.exp(-25 * t);
    out[i] = (thump * 0.8 + crack * 0.5) * env(i, n, 0.001, 0.25);
  }
  return out;
}
function band(n, decay, lp) {
  const out = new Array(n); let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += (noise() - prev) * lp;
    out[i] = prev * Math.exp(-decay * (i / SR)) * env(i, n, 0.001, 0.05);
  }
  return out;
}
function sink() {
  const n = N(1.3), out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const groan = Math.sin(2 * Math.PI * (120 - 60 * t) * t) * 0.5;
    const bub = noise() * 0.25 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 7 * t));
    out[i] = (groan + bub) * env(i, n, 0.02, 0.4);
  }
  return out;
}
function blips(freqs, sec) {
  const n = N(sec), out = new Array(n).fill(0), step = n / freqs.length;
  freqs.forEach((f, k) => {
    for (let j = 0; j < step; j++) {
      const i = Math.floor(k * step + j);
      out[i] += Math.sin(2 * Math.PI * f * (j / SR)) * Math.exp(-12 * (j / SR)) * 0.6;
    }
  });
  return out;
}
function chime(freqs, sec, decay) {
  const n = N(sec), out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    for (const f of freqs) out[i] += Math.sin(2 * Math.PI * f * t) * Math.exp(-decay * t);
    out[i] = (out[i] / freqs.length) * env(i, n, 0.005, sec * 0.5);
  }
  return out;
}
function loopNoise(sec, lp, amp) {
  const n = N(sec), out = new Array(n); let prev = 0;
  for (let i = 0; i < n; i++) {
    prev += (noise() - prev) * lp;
    const swell = 0.6 + 0.4 * Math.sin(2 * Math.PI * (1 / sec) * (i / SR));
    out[i] = prev * amp * swell;
  }
  // crossfade ends for a seamless loop
  const f = N(0.2);
  for (let i = 0; i < f; i++) { const a = i / f; out[i] = out[i] * a + out[n - f + i] * (1 - a); }
  return out;
}
function pad(chord, sec) {
  const n = N(sec), out = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const lfo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.2 * t);
    for (const f of chord) out[i] += Math.sin(2 * Math.PI * f * t);
    out[i] = (out[i] / chord.length) * 0.5 * lfo;
  }
  const f = N(0.3);
  for (let i = 0; i < f; i++) { const a = i / f; out[i] = out[i] * a + out[n - f + i] * (1 - a); }
  return out;
}

save("sfx/cannon.wav", cannon());
save("sfx/impact_wood.wav", band(N(0.25), 18, 0.5));
save("sfx/impact_thud.wav", band(N(0.2), 30, 0.15));
save("sfx/crunch.wav", band(N(0.35), 10, 0.6));
save("sfx/sink.wav", sink());
save("sfx/coins.wav", blips([880, 1175, 1568, 1319], 0.5));
save("sfx/splash.wav", band(N(0.3), 12, 0.7));
save("sfx/ui_click.wav", chime([1200], 0.05, 60));
save("sfx/ui_confirm.wav", chime([784, 1175], 0.18, 14));
save("sfx/ui_buy.wav", blips([1047, 1319, 1568], 0.35));
save("sfx/port_open.wav", chime([523, 659, 784], 0.6, 4));
save("sfx/ship_ready.wav", chime([392, 523, 659, 784], 0.8, 3));
save("ambient/ocean_loop.wav", loopNoise(3, 0.04, 0.5));
save("ambient/wind_loop.wav", loopNoise(3, 0.02, 0.4));
save("music/menu_theme.wav", pad([196, 233, 294], 6));
save("music/sea_ambient.wav", pad([147, 220, 247], 6));
save("music/harbor.wav", pad([262, 330, 392], 6));
console.log("done");
```

- [ ] **Step 2: Run the generator**

Run: `node scripts/gen-audio.mjs`
Expected: prints each written file; populates `public/assets/audio/{sfx,ambient,music}/`.

- [ ] **Step 3: Write the drop-in README (the manifest contract)**

`public/assets/audio/README.md` documents: every id, its current starter file, and that a premium replacement just needs the same path (or a manifest edit in `src/render/audio.ts`). Note Sonniss files are royalty-free (not CC0) and their license lives in `LICENSE-sonniss.txt`; Kenney/OpenGameArt/Freesound files are CC0. Mirror the existing `README_DROP_HERE.md` tone.

- [ ] **Step 4: Add `LICENSE-sonniss.txt` placeholder + update `CREDITS.md`**

`LICENSE-sonniss.txt`: a short header noting "paste the Sonniss #GameAudioGDC bundle license here when premium naval SFX are dropped in." `CREDITS.md`: add an Audio section crediting the synthesized starters as original (project-owned) and listing the intended premium sources.

- [ ] **Step 5: Commit**

```bash
git add scripts/gen-audio.mjs public/assets/audio public/assets/CREDITS.md
git commit -m "feat(audio): synthesized starter SFX/ambience/music + drop-in manifest & licensing"
```

---

## Task 4: `AudioManager` core + wire into `main.ts`

**Files:**
- Create: `src/render/audio.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Implement `AudioManager` (`src/render/audio.ts`)**

Holds the listener, a manifest (id→path), decoded buffers, a positional voice pool sized 16, a 2D channel, ambience loops, a crossfading music voice, an underwater low-pass, and master volume. Uses `audioMath` for voice picking / wind / music / crunch. Loads are best-effort: a failed fetch/decode logs once and that id stays silent. Key methods (full impl written here during execution): `constructor(camera, settings)`, `ready`, `resume()`, `setMasterVolume(v)`, `playAt(id,pos,opts?)`, `playUi(id,opts?)`, `ambient(id,on,gain?)`, `setWind(intensity)`, `music(state)`, `setUnderwater(on)`. The voice pool tracks `busyUntil[]` and calls `pickVoiceIndex(busyUntil, ctx.currentTime)`; positional voices are mono buffers attached to pooled `PositionalAudio` objects re-parented to a moving `Object3D` at the event position. Music crossfade ramps the outgoing gain to 0 and the incoming to its target over ~1.5 s.

- [ ] **Step 2: Instantiate + attach in `main.ts`**

After the camera (`main.ts:88`): `const audio = new AudioManager(camera, settings);`. Resume the context on the first start-menu click / pointer-lock gesture (`audio.resume()`). Apply master volume from `settings.masterVolume`. Expose `DEBUG.audio = audio`.

- [ ] **Step 3: Build + browser smoke test**

Run: `npm run build` (tsc clean). Then load the live build and in the console: `DEBUG.audio.playUi("coins")` and `DEBUG.audio.playAt("cannon", DEBUG.sloop.body.translation())`.
Expected: build exits 0; both calls produce audible sound after a click (context resumed); no console errors.

- [ ] **Step 4: Commit**

```bash
git add src/render/audio.ts src/main.ts
git commit -m "feat(audio): AudioManager (listener, voice pool, master volume) wired into main"
```

---

## Task 5: Cannon, impact & crunch hooks via `effects`

**Files:**
- Modify: `src/render/effects.ts`
- Modify: `src/game/cannons.ts`
- Modify: `src/game/voxelContact.ts`

- [ ] **Step 1: Add audio forwarding to `EffectsSystem`**

Give `effects` an optional `audio?: AudioManager` ref (set from `main.ts`: `effects.audio = audio`). Add `cannonBoom(pos)`, `impact(pos, intensity)`, `crunch(pos, removed)` that no-op if `audio` is unset, else call `audio.playAt(...)`. `crunch` uses a private `ThrottleGate(0.06)` + `crunchVolume(removed)` so a sustained ram is rate-limited.

- [ ] **Step 2: Cannon boom + ball impact in `cannons.ts`**

At `cannons.ts:158` (next to `this.effects.muzzleFlash(m.pos, m.dir)`): add `this.effects.cannonBoom(m.pos)`. At the ball→hull carve site, add `this.effects.impact(hitPos, energy)` (use the existing impact position + carve energy already computed there).

- [ ] **Step 3: Crunch in `voxelContact.ts`**

At the existing `if (this.effects && TUN.crush.fling > 0 && removed > 0)` block (~line 267), add `this.effects.crunch(this.pt2, removed)` (the position is already set on `this.pt2`). No change to the crush math.

- [ ] **Step 4: Build + browser verify**

Run: `npm run build`. In the live build: fire a broadside (boom per gun), ram an enemy/island (crunch, rate-limited), land a hit (impact).
Expected: build clean; sounds positioned and not machine-gunning; existing 294 tests still green (`npm run test`).

- [ ] **Step 5: Commit**

```bash
git add src/render/effects.ts src/game/cannons.ts src/game/voxelContact.ts
git commit -m "feat(audio): cannon/impact/crunch sfx via the effects feedback handle"
```

---

## Task 6: Event hooks (sink, coins, port, swap) + splash

**Files:**
- Modify: `src/main.ts`
- Modify: `src/render/spray.ts`

- [ ] **Step 1: Hook the gameplay events in `main.ts`**

- Enemy sunk (`main.ts:734`, `isSunk(e)`): `audio.playAt("sink", enemyPos)`.
- Plunder (`main.ts:736`): `audio.playUi("coins")`.
- Player sink (`main.ts:747`): `audio.playUi("sink", { volume: 1 })` (2D so it reads off-screen).
- Open port (`main.ts:443` / `port.openPort`): `audio.playUi("port_open")`.
- Ship swap (`main.ts:505-540`, `swapPlayerShip`): `audio.playUi("ship_ready")`.

- [ ] **Step 2: Splash in `spray.ts`**

Where bow spray is emitted, add a rate-limited `audio.playAt("splash", sprayPos, { volume })` (own `ThrottleGate(0.25)`; pass `audio` into the spray system or call via a module-level ref set in `main.ts`). Keep it subtle.

- [ ] **Step 3: Build + verify**

Run: `npm run build`. In the live build: sink an enemy (groan), collect plunder (coins), dock (port chime), buy a ship (ready cue), sail fast (occasional splash).
Expected: clean build; each event audible once at the right moment.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts src/render/spray.ts
git commit -m "feat(audio): sink/coins/port/ship-swap cues + bow splash"
```

---

## Task 7: Ambience, wind, underwater filter & music

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Ambience + music driven by phase**

In the main loop / phase-change path: when phase becomes `playing` or `port`, `audio.ambient("ocean", true)`; in `menu`/`paused`, fade it out. Each frame, `audio.setWind(sailIntensity)` where `sailIntensity` comes from the existing `sailing`/hull speed. Drive music with `audio.music(musicTrackForState(phase))` on phase transitions (the manager crossfades). Use the `GameState` phase already available.

- [ ] **Step 2: Underwater filter**

When the captain is swimming or the active camera is below the waterline (the swim state exists in `playerCharacter`), call `audio.setUnderwater(true)`, else `false`.

- [ ] **Step 3: Build + verify**

Run: `npm run build`. In the live build: ocean bed under sailing; wind rises with full canvas; music crossfades menu→sea→harbor on dock; dipping underwater muffles the mix.
Expected: clean build; transitions are smooth (no clicks/pops), ambience ducks in menu.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat(audio): ocean/wind ambience, underwater low-pass, phase-driven music"
```

---

## Task 8: Settings panel + UI click cues (consumes dead save fields)

**Files:**
- Modify: `src/render/menuScreen.ts`
- Modify: `src/render/portScreen.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Settings sub-panel in the pause overlay (`menuScreen.ts`)**

Add a "Settings" button to the pause overlay opening a panel with: a **Master Volume** `<input type=range>` (0–100) and a **Default Camera** `<select>` (Char-3rd / Char-1st / Ship-orbit). On change: volume → `audio.setMasterVolume(v/100)` + write `settings.masterVolume`; camera → write `settings.defaultCamera`. Both persist via the existing `saveCurrent()` path. Wire a `ui_click` cue on the panel's buttons.

- [ ] **Step 2: Apply `defaultCamera` at game start (`main.ts`)**

Where the start camera is currently hardcoded, initialise `camMode` from `settings.defaultCamera` instead.

- [ ] **Step 3: UI cues in `portScreen.ts`**

Add `audio.playUi("ui_buy")` on buy/sell/upgrade/buy-ship and `audio.playUi("ui_confirm")` on "Save & Cast Off"; `ui_click` on generic buttons. Pass `audio` into `portScreen`/`menuScreen` (constructor or a setter) consistent with how they already receive their deps.

- [ ] **Step 4: Build + verify (persistence)**

Run: `npm run build` + `npm run test`. In the live build: open Settings, drag volume → mix changes live; reload → volume persists; set Default Camera, start a new game → that camera is active; port buttons click.
Expected: clean build, green tests, settings persist across reload.

- [ ] **Step 5: Commit**

```bash
git add src/render/menuScreen.ts src/render/portScreen.ts src/main.ts
git commit -m "feat(audio): settings panel (master volume + default camera) + UI cues"
```

---

## Task 9: Final verification, docs & push

**Files:**
- Modify: `CLAUDE.md` (index the new audio layer)
- Modify: memory (`MEMORY.md` + a worklog note)

- [ ] **Step 1: Full gate**

Run: `npm run build` (tsc clean) and `npm run test` (green; +audioMath tests, −1 boarding test).
Expected: both pass.

- [ ] **Step 2: Live end-to-end pass**

In the Chrome launcher: menu music → start → ocean/wind, broadside booms, ram crunch, sink groan, plunder coins, dock (port chime + harbor music), Settings volume live+persisted, default-camera applied, underwater muffle. No console errors; fps unaffected (audio is cheap).

- [ ] **Step 3: Update `CLAUDE.md`**

Add a short bullet under "What's in the build": the audio layer (AudioManager, Web Audio, settings panel) and that `sim/` stays pure. Note the drop-in asset slots. Keep the index honest.

- [ ] **Step 4: Commit + push to main**

```bash
git add CLAUDE.md
git commit -m "docs: index the audio layer in CLAUDE.md"
git push origin HEAD:main
```

- [ ] **Step 5: Save a memory worklog**

Write a `project` memory noting the audio layer landed (architecture + drop-in asset convention) and add the index line to `MEMORY.md`.

---

## Self-Review

- **Spec coverage:** Part A cleanup → Task 1. AudioManager/listener/pool/master-volume/resume → Task 4. Event→sound map → Tasks 5–6. Ambience/wind/underwater/music → Task 7. Settings panel (both dead fields) → Task 8. Assets + licensing → Task 3. Determinism (sim pure) → respected (all hooks in game/render/main; pure logic in audioMath). Testing → Task 2 (unit) + per-task build/browser verify. All spec sections map to a task.
- **Placeholders:** none — pure-function code and the generator are written in full; integration steps name exact files/lines and the one-line calls to add.
- **Type consistency:** method names (`playAt`, `playUi`, `ambient`, `setWind`, `music`, `setUnderwater`, `setMasterVolume`, `resume`) are used identically across Tasks 4–8; `audioMath` exports (`pickVoiceIndex`, `windGain`, `musicTrackForState`, `crunchVolume`, `ThrottleGate`) match Task 2 and their consumers.
- **Asset-sourcing deviation (noted):** the spec said download CC0+Sonniss; in this environment Task 3 instead generates license-clean synthesized starters and exposes drop-in slots for premium audio — the engine is identical, only the placeholder files get upgraded later.
