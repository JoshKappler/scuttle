# SCUTTLE — Audio System + Sprint Cleanup — Design Spec

_Date: 2026-06-16 · Branch: `worktree-man-o-war` · Author: Claude (Opus 4.8)_

## Why

A full project review (2026-06-16) found the build green (`tsc` clean, 294 tests pass) but two things stand out: the game has **zero audio** despite `SaveState.settings.masterVolume` already being persisted-but-unused, and the fast sprint left a thin layer of **dead "boarding" code** behind. This spec covers both:

- **Part A — Sprint cleanup:** delete the unambiguously-dead boarding remnants (boarding is `GONE` per CLAUDE.md doctrine and is never to be restored).
- **Part B — Audio + music + settings:** a complete first-class audio pass (SFX, ambience, music) built on Three.js' Web Audio, wiring the dead `settings` fields to a real settings panel.

Scope chosen with the user: **full audio incl. music**, **CC0 + Sonniss** asset licensing, **and** a minimal settings panel.

---

## ⚠️ Hard exclusion — do NOT touch island/terrain destruction

Another agent is concurrently implementing **island voxel destruction**. This spec **must not modify or delete** anything in that area:

- `sim/islandCollider.ts` (`surfaceBandVoxels`) — **leave it**. My review flagged it as "unwired," but it is exactly the surface the other agent may revive. Out of bounds.
- `game/islandTarget.ts`, `game/voxelContact.ts` terrain branch, `sim/islandwright.ts`, `render/islandVisual.ts`, `game/islandField.ts`, `sim/surfaceSet.ts` — **read-only** for us. We may *call into* `voxelContact`'s existing crunch hook for audio, but we change none of its logic.

If audio wiring ever appears to need a change in those files, stop and flag it instead.

---

## Part A — Sprint cleanup (dead boarding code)

All of the following are remnants of the deleted boarding system. CLAUDE.md lists boarding under **"GONE — intentionally removed, do NOT restore."** These are safe, mechanical deletions.

| # | File | What | Action |
|---|------|------|--------|
| A1 | `game/fleet.ts:44` | `boardingTarget: Ship \| null` field | Remove field |
| A2 | `game/fleet.ts:108` | `if (u.ship === this.boardingTarget) continue;` in `farthestDespawnable()` | Remove the skip line |
| A3 | `tests/fleet.test.ts:79-93` | test `"never despawns the boarding target"` | Remove the test |
| A4 | `game/player.ts:33` | `grapplePressed = false` field | Remove field |
| A5 | `game/player.ts:84` | `if (e.code === "KeyG") this.grapplePressed = true;` | Remove handler (verify `KeyG` is unused elsewhere first) |
| A6 | `main.ts:600` | `controls.grapplePressed = false; // legacy G …` | Remove the now-orphaned consume line |
| A7 | `game/crew.ts:195` | comment referencing the deleted `DEBUG.boarding.player.fpArmPose` | Reword comment (no code change) |

**Deliberately kept:**
- `game/playerCharacter.ts:19` `playerHp = 5` — vestigial but the on-foot HUD health bar reads it. Keep; the existing comment already explains it.
- `dev/voxelSpike.ts` — dev-only, gated by `?spike`, and already code-split into its own lazy chunk (not in the main bundle). Harmless; out of scope.

**Verification for Part A:** `npm run build` (tsc must stay clean) + `npm run test` (the suite drops by exactly one test and stays green). Grep `boardingTarget`, `grapplePressed`, `KeyG` to confirm zero remaining references.

---

## Part B — Audio system

### B.0 Guiding constraints

1. **Determinism (THE LAW #1):** `sim/` stays pure — no Three.js / Web-Audio imports there, ever. Every audio hook lives in `game/`, `render/`, or `main.ts`.
2. **Zero new runtime deps:** Three.js is already bundled and ships `AudioListener` / `Audio` / `PositionalAudio` / `AudioLoader` (Web Audio under the hood). No Howler.
3. **Browser-gated:** Web Audio starts suspended; nothing plays until a user gesture. Audio failures must never break the game loop (load/decode errors degrade to silence, logged once).
4. **Idiomatic wiring:** ride the existing `effects` feedback handle where the codebase already routes per-event feedback (cannons, voxelContact), and call the manager directly from `main.ts` where it already detects events.

### B.1 Architecture — `render/audio.ts` `AudioManager`

A single module, instantiated once in `main.ts`, owns all sound.

**Responsibilities:**
- Create one `THREE.AudioListener`, `camera.add(listener)` (`main.ts:88`) so sound pans/attenuates relative to the active camera (char-3rd / char-1st / ship-orbit all just work).
- **Buffer registry:** load + `decodeAudioData` a small named set of `AudioBuffer`s once at boot via `THREE.AudioLoader`, keyed by id (e.g. `"cannon"`, `"crunch"`, `"coins"`). Decoded buffers are shared across all voices.
- **Voice pool:** a fixed ring of reusable `THREE.PositionalAudio` voices (default pool ~16). `playAt(id, position, {volume, detune, refDistance})` grabs the next free/oldest voice, retargets it, and plays — **no per-shot allocation** during a sustained broadside or ram. A non-positional `THREE.Audio` channel handles UI/2D cues.
- **Master volume:** `listener.setMasterVolume(settings.masterVolume)` — this is what finally consumes the dead save field. Re-applied whenever the setting changes.
- **Autoplay unlock:** `listener.context.resume()` on the first user gesture (the start-menu button click / pointer-lock), which the game already requires.
- **Category buses (optional, simple):** group gains for `sfx` / `ambient` / `music` so music/ambience can duck or crossfade independently under the master. v1 can implement as per-source gain multipliers if a full bus graph is overkill.

**Public surface (sketch):**
```
class AudioManager {
  constructor(camera, settings)
  ready: Promise<void>            // resolves when the core buffers are decoded
  resume()                        // unlock on first gesture
  setMasterVolume(v)              // settings → listener
  playAt(id, pos, opts?)          // pooled positional one-shot
  playUi(id, opts?)               // non-positional one-shot
  ambient(id, on, {gain})         // start/stop a looping bed (ocean, wind)
  setWind(intensity01)            // map sail/speed → wind loop gain + detune
  music(state)                    // 'menu' | 'playing' | 'port' → crossfade
  setUnderwater(on)               // toggle a low-pass filter on the listener
}
```

### B.2 Event → sound mapping (concrete hook points)

All hook sites already exist — most need a one-line call.

| Event | Sound | Hook site (verified) | Notes |
|-------|-------|----------------------|-------|
| Cannon fires | `cannon` (boom) | `game/cannons.ts:158` next to `effects.muzzleFlash` | positional at muzzle `m.pos`; slight random `detune` per barrel |
| Cannonball hits hull/terrain | `impact_wood` / `impact_thud` | cannons ball→carve impact (same module) | positional at impact; volume ∝ carve energy |
| Ship-ship / ship-terrain crunch | `crunch` (splinter) | `game/voxelContact.ts:267` (`removed > 0`, by `effects.impactDebris`) | positional at contact centroid; volume ∝ `removed`, throttled so a sustained ram doesn't machine-gun |
| Enemy sinks | `sink` (groan + bubbles) | `main.ts:734` (`isSunk(e)`) | positional at the wreck |
| Player sinks | `sink` (louder/2D) | `main.ts:747` | 2D so it reads even off-screen |
| Plunder / coins | `coins` | `main.ts:736` (`port.plunder`) | UI 2D cue |
| Make port / open port screen | `port_open` | `main.ts:443` / `port.openPort` | UI cue |
| Buy / sell / upgrade / buy-ship | `ui_confirm` / `ui_buy` | `render/portScreen.ts` button callbacks | per-action |
| Ship swap (shipyard) | `ship_ready` | `main.ts:505-540` `swapPlayerShip` | one-shot |
| Generic UI button | `ui_click` | `render/menuScreen.ts` + `render/portScreen.ts` buttons | shared helper |
| Bow spray / splash | `splash` | `render/spray.ts` emit | low-priority, rate-limited |

### B.3 Ambience

- **Ocean bed:** one looping `ambient("ocean", true)` while phase is `playing`/`port`, faded out in `menu`/`paused`. Gentle, omnipresent (non-positional).
- **Wind by sail:** `setWind(intensity)` maps current sail set / hull speed (already available in `sailing`) to a wind-loop gain + slight detune — louder under full canvas.
- **Underwater filter:** `setUnderwater(true)` inserts a `BiquadFilterNode` low-pass on the listener when the captain is swimming / camera dips below the waterline (the swim state already exists in `playerCharacter`).

### B.4 Music

- State-driven, single crossfading music voice via `music(state)`:
  - `menu` → menu theme
  - `playing` → calm/tense sea ambient bed (low, non-intrusive)
  - `port` → quiet harbor cue (or duck to a soft bed)
- Crossfade on `GameState` phase transitions (the phase machine already exists in `game/gameState.ts`). Music is the most taste-dependent asset; v1 ships a small set and the manager makes swapping tracks a one-file change.

### B.5 Settings panel (consumes the dead save fields)

Add a minimal **Settings** sub-panel to the pause overlay (`render/menuScreen.ts`, which already owns start + pause overlays):

- **Master Volume** slider (`<input type=range>` 0–100) → `audio.setMasterVolume(v/100)` live + write `settings.masterVolume`, persisted via the existing `saveCurrent()` path (`main.ts:494`).
- **Default Camera** select (Char-3rd / Char-1st / Ship-orbit) → write `settings.defaultCamera`; applied to `camMode` at game start (`main.ts` currently hardcodes the start camera — read the setting instead).
- Both fields are already in `SaveState.settings` (`saveState.ts:15-18,33`), loaded at `main.ts:480` and saved at `main.ts:494` — we just add the consumers, closing the loop my review flagged.

### B.6 Assets

**Layout** (new):
```
public/assets/audio/
  sfx/        cannon, impact_wood, impact_thud, crunch, sink, coins,
              splash, ui_click, ui_confirm, ui_buy, port_open, ship_ready
  ambient/    ocean_loop, wind_loop
  music/      menu_theme, sea_ambient, harbor
```
- **Format:** OGG Vorbis (small, well-supported in the Chrome/Edge launcher target). Mono for positional SFX (panner needs mono to spatialize), stereo for ambience/music.
- **Sources & licensing (per the user's CC0 + Sonniss choice):**
  - **CC0 (preferred, zero attribution):** Kenney (UI + generic impacts), OpenGameArt CC0, Freesound CC0 filter, BigSoundBank — used for UI, coins, splash, generic impacts.
  - **Sonniss GDC bundle (royalty-free, commercial-OK, *not* CC0):** the marquee naval sounds — cannon boom, wood splinter/crunch, ocean, wind. Higher fidelity.
  - **Music:** prefer CC0 (OpenGameArt) where a fitting calm-sea track exists; otherwise a royalty-free bed. Avoid CC-BY tracks (e.g. Kevin MacLeod) to keep attribution simple — or, if used, list them.
- **Licensing hygiene (Steam endgame):** append every asset's source + license to `public/assets/CREDITS.md`; add a `public/assets/audio/LICENSE-sonniss.txt` retaining the Sonniss bundle license text. No raw SFX is ever resold. Net effect: commercial-safe with a clean paper trail.

### B.7 File-by-file change list

**New:**
- `src/render/audio.ts` — `AudioManager` (listener, registry, voice pool, buses, ambience, music, underwater filter).
- `public/assets/audio/**` — the sound files.
- `public/assets/audio/LICENSE-sonniss.txt` — Sonniss license note.

**Edited:**
- `src/main.ts` — instantiate `AudioManager`; attach listener to camera; resume on first gesture; call event hooks (sink/plunder/port/swap); drive `music(state)` + ambience on phase changes; apply `settings.defaultCamera` at start.
- `src/game/cannons.ts` — `audio.playAt("cannon", muzzle)` at fire; impact cue at carve.
- `src/game/voxelContact.ts` — crunch cue alongside the existing `effects.impactDebris` (no logic change to the crush rule).
- `src/render/spray.ts` — rate-limited splash cue.
- `src/render/menuScreen.ts` — Settings sub-panel + UI-click cues.
- `src/render/portScreen.ts` — per-action UI cues.
- `public/assets/CREDITS.md` — audio credits.
- `window.DEBUG` (`main.ts`) — expose `audio` for live testing.

### B.8 Testing

- **Determinism preserved:** because audio never enters `sim/`, the deterministic oracle and all 294 existing tests are unaffected — they must stay green.
- **Unit-testable (no Web Audio):** the *pure* pieces only — e.g. the wind-intensity → gain mapping and the music-state → track selection as pure functions, voice-pool selection logic (next-free/oldest) with a fake voice. These get small vitest tests. We do **not** try to unit-test Web Audio playback.
- **Manual / in-browser:** load + decode succeeds (no console errors), cannon/crunch/coins/sink/UI all fire, master-volume slider audibly works and persists across reload, default-camera setting applies on new game, ambience fades with phase. Verify in the live Chrome launcher per CLAUDE.md.
- **Build gate:** `npm run build` + `npm run test` green before push.

---

## Risks & open questions

- **Asset curation time (music):** finding a *fitting* sea/menu track is the slowest, most subjective step. Mitigation: the manager makes tracks a one-file swap; ship a decent placeholder bed and iterate.
- **Bundle / load weight:** audio files add to download. Mitigation: OGG + modest bitrate, lazy-load music/ambience after core SFX so first-playable isn't blocked. (Separately, the review found an *unrelated* "ineffective dynamic import" bloating the main JS bundle — **not** in this spec's scope; noted for a later pass.)
- **Crunch spam:** a sustained ram fires `impactDebris` many times/sec. Mitigation: rate-limit + min-interval on the crunch voice, volume ∝ removed.
- **Positional mono requirement:** any stereo file routed through `PositionalAudio` won't spatialize. Mitigation: keep SFX mono; ambience/music use the 2D `Audio` channel.

## Out of scope (future passes)

- The main-bundle code-split / `crew.ts` ineffective-dynamic-import fix (review finding, separate task).
- The end-game threat ceiling (enemies cap at Frigate; review finding — a balance/design task).
- Surfacing notoriety in the HUD (review finding).
- Anything island/terrain destruction (owned by the other agent).

## Definition of done

1. Part A deletions landed; grep-clean of boarding remnants; build + tests green (one fewer test).
2. `AudioManager` live: cannon, crunch, impact, coins, sink, UI, port all audible and positioned correctly.
3. Ocean + wind ambience and state-based music play and fade with game phase.
4. Settings panel adjusts master volume (live + persisted) and default camera (applied on new game).
5. Licensing recorded in `CREDITS.md` + Sonniss note; all assets commercial-safe.
6. `npm run build` + `npm run test` green; verified in the live browser.
