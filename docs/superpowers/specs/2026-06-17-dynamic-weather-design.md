# Dynamic Weather (storms tied to sea roughness) — design

_2026-06-17. Status: approved design, pre-implementation._

## Goal

Make the weather scale with how rough the seas are. A calm/regular sea is
**completely clear**; the wildest sea is an **absolute thunderstorm nightmare** —
darker and denser clouds that blot out the sun, rain (visual + audio), and
cinematic lightning (forked bolts + a flash that lights the water and hulls +
distance-delayed thunder). Plus a parallel performance pass on the
collision/ram hitch.

Decisions taken with the user:

- **Modes:** Sandbox keeps pinning weather to the chosen "Seas" pill; **Career
  gets dynamic weather** — storms roll in and ease off over a voyage.
- **Gameplay impact:** **atmospheric only.** No mechanical fog-of-war or aim
  penalty. Heavy rain + cloud naturally reduce how far you can see at the
  extremes; that is the only "visibility" effect. **No new physics forces.**
- **Lightning:** **cinematic** — forked bolts, a flash that visibly lights the
  scene from the strike direction, distance-delayed thunder.

## North star: one master signal

Everything is driven by a single eased scalar **`storminess ∈ [0,1]`**.
`0` = the current clear look; `1` = full nightmare. The visuals and audio are
pure functions of `storminess`; only *who sets the target and the swell* differs
by mode. This keeps the whole feature coherent and live-tunable from one knob.

### Mapping (pure, in `weatherMath.ts`)

- `stormFromSeaScale(seaScale)` = `smoothstep(STORM_CLEAR, STORM_FULL, seaScale)`
  with `STORM_CLEAR = 1.0`, `STORM_FULL = 2.6`.
  - Calm `0.45` → `0` (glassy clear)
  - Moderate `1.0` → `0` (clear — "the regular one")
  - Rough `1.7` → `≈0.44` (overcast, building rain, no lightning yet)
  - Stormy `2.6` → `1.0` (full nightmare)
- `seaScaleFromStorm(storminess)` = `lerp(SEA_CALM, STORM_FULL, storminess)`,
  `SEA_CALM = 0.6`. Used in Career to drive the swell from the rolling weather.

Thresholds live as named constants so the "clear through Moderate" vs
"clear only at Calm" choice is a one-line change.

### Mode behaviour

- **Sandbox** (`mode: "fixed"`): on Set Sail, `targetStorminess =
  stormFromSeaScale(cfg.seaRoughness)`, held fixed. The swell stays exactly the
  pill the player chose (`applySeaScale(cfg.seaRoughness)` as today) — Sandbox is
  the precise sea you asked for; storminess only drives look + sound.
- **Career** (`mode: "dynamic"`): `targetStorminess = weatherFront(simTime)` — a
  smooth deterministic time-noise (sum of incommensurate sines, shaped to sit
  mostly in fair weather with occasional builds to a storm and back). The swell
  follows: `seaScale = seaScaleFromStorm(storminess)`, pushed via
  `applySeaScale(seaScale)` + a throttled `ocean.refreshSwell()` (≤4 Hz, only on
  meaningful change). Front frequency + peak intensity are tunable/capped so
  Career combat is mostly calm with real storms as events, not constant chaos.

`storminess` always **eases** toward its target (slow attack/release) so weather
— and in Career the swell height — never snaps.

## Components

### WeatherController (`render/weather.ts`) — the hub (lead-owned)

Owns `storminess`, the mode/target logic, the lightning schedule + thunder timer
queue, and fans the signal out to the leaf modules each frame. Leaf modules are
dumb: the controller computes params from `weatherMath` and pushes them in, so
the leaf subsystems do **not** depend on each other or on `weatherMath`.

```
class WeatherController {
  storminess: number
  setMode(mode: "fixed" | "dynamic", fixedTarget?: number): void
  update(dt, simTime, cameraPos, phase): void   // eases storminess, drives all sinks, schedules strikes/thunder
  triggerStrike(): void                          // debug
}
```

Dependencies are injected (constructor) so it is testable and main.ts wires the
real instances: `{ sky, clouds, ocean, rain, lightning, audio, applySwell }`,
where `applySwell(seaScale)` wraps `applySeaScale(waves, …) + ocean.refreshSwell()`
(lead provides — it touches the shared wave array + the ocean).

Per frame the controller:
1. eases `storminess` toward the target (Career: recompute target from `weatherFront`).
2. Career only: `applySwell(seaScaleFromStorm(storminess))`, throttled.
3. `sky.setStorm(storminess)`, `clouds.setStorm(storminess)`, `ocean.setStorm(storminess)`, `rain.setIntensity(rainIntensity(storminess))`.
4. lightning schedule: Poisson with rate `lightningRatePerSec(storminess)`; on fire pick `(dirX,dirZ,distance)`, `lightning.spawnBolt(...)`, and enqueue a thunder one-shot at `now + thunderDelaySec(distance)` with `thunderVolume(distance)`.
5. read `lightning.flash()` (+ dir) and push to `sky.setFlash(f)` / `ocean.setFlash(f, dir)`.
6. audio beds: `audio.ambient("rain", storminess > 0, rainGain(storminess))`, wind boost `windStormBoost(storminess)`; fire due thunder from the timer queue.

### `weatherMath.ts` — pure helpers (subagent A, unit-tested)

`stormFromSeaScale`, `seaScaleFromStorm`, `weatherFront(simTime, params)`,
`rainIntensity`, `rainGain`, `lightningRatePerSec`, `thunderDelaySec`,
`thunderVolume`, `windStormBoost`, and param-curve helpers for sky/cloud
(`skyStormParams`, `cloudStormParams`). All deterministic, no Three, no DOM —
mirrors `audioMath.ts`.

### Sky + sun (`render/sky.ts`) — subagent D

- Add `uStorm` to the dome shader: lerp zenith + horizon toward a dark slate;
  fade/crush the sun disc + halo as storm rises (sun blotted out).
- Add `uFlash` (0..1): a brief whole-sky brighten on a strike.
- New `SkySetup.setStorm(s)` and `setFlash(f)`.
- Dim + grey `sunLight.intensity` and `fillLight.intensity` toward a low
  overcast level as storm rises (so lit hulls go flat/grey, not sunny).
- Env cube already re-bakes each frame → the water's reflection darkens for free.

### Clouds (`render/clouds.ts`) — subagent D

- `setStorm(s)`: drive coverage → ~0.95, density → ~1.0, faster drift (the
  controller writes these, dev panel still tracks them via `TUN.gfx.clouds`).
- Add `uStorm` to the shader: darken cloud bases toward charcoal and kill the
  fair-weather sunlit/bloomy tops so they read as a heavy overcast that hides
  the sun.

### Ocean storm hooks (`render/ocean.ts`) — subagent E (scoped edit)

- `setStorm(s)`: a `uStorm` uniform — darken/desaturate the water body and add a
  subtle rain-dapple (small high-freq normal perturbation) gated by `s`. Reuse
  existing chop where possible; do **not** touch physics or the swell.
- `setFlash(f, dirX, dirZ)`: a `uFlash` + direction uniform — a brief specular
  brighten on the water from the strike side (the lightning lighting the sea).
- Pure-visual; obeys THE LAW #1.

### Rain (`render/rain.ts`, new) — subagent B

- A camera-locked volume of GPU-instanced streaks (instanced quads/lines),
  recycled as they fall; `setIntensity(0..1)` scales active count + opacity +
  streak length, with a slight wind slant. `update(dt, cameraPos)` advances +
  recenters on the camera. Added to the main scene; `dispose()`.
- Tuned so heavy rain naturally cuts visibility at the extremes (no fog mechanic).

### Lightning (`render/lightning.ts`, new) — subagent C

- `spawnBolt(dirX, dirZ, distance, intensity)`: build a procedural forked bolt
  (midpoint-displacement polyline → thin additive emissive geometry, cloud→sea),
  ~150 ms fade with a sub-flicker; optionally a brief scene flash light.
- `flash(): number` + `flashDir(): [x,z]`: the live flash envelope the controller
  reads and pushes to sky/ocean (keeps flash-shape logic here, uniform-push in
  the controller).
- `update(dt)` advances fades; `dispose()`. Scheduling/Poisson lives in the
  controller (it owns timing + thunder), keeping this a dumb visual.

### Audio (`render/audio.ts` + `audioMath.ts` + `scripts/gen-audio.mjs`) — subagent F

- Generalize the looping-bed API to include **rain** (currently `ocean`/`wind`):
  `ambient("rain", on, gain)`; rain gain ∝ storminess.
- **Thunder** one-shots: add `thunder` (a few interchangeable takes) to the
  manifest; a `thunder(volume)` UI-style play (non-positional — thunder envelops).
  Boost the wind bed in storm.
- Extend the procedural generator to synth `rain_loop` + `thunder_1..n` (WAV
  placeholders), consistent with the existing placeholder convention; real CC0
  audio drops in later via the manifest. Pure decisions (gain/curves) added to
  `audioMath.ts` with tests.

## Performance workstream (parallel, profile-first) — lead

The user reports a hitch on ram/collision and suspects Rapier. Ship-vs-ship and
ship-vs-terrain are deliberately **out** of Rapier's rigid solver (`physics.ts`
contact filter); the ram cost is the voxel crush + downstream recompute. Plan:

1. **Measure on a live ram** via `DEBUG.world.timing`
   (`flood/buoy/contact/flush/rapier/visual`) and single-step
   `DEBUG.world.step(1/60)` readbacks (immune to headless time-compression).
2. **Fix the dominant cost.** Strong candidates from the code:
   - **Deck-collider trimesh rebuild** (`ship.flushDamage` → `rebuildDeckCollider`):
     a genuine *Rapier-side* cost (building a Rapier trimesh collider mid-ram,
     ~41 ms historically; debounced but may still spike) — the real version of
     the user's "Rapier" intuition.
   - Carve + remesh (`tm.contact` / `tm.visual`), buoyancy (`tm.buoy`).
   - Rapier broad-phase / contact-gen if debris bodies accumulate (audit collider
     counts + debris cap).
3. Targeted fixes only on what the profile shows; re-measure to confirm a real
   win (no speculative rewrites). Likely levers: further debounce/cheapen the
   collider rebuild, incremental remesh, debris cap, scratch reuse.

## Dev / debug

- **`TUN.weather`** (live dev-panel block): `override` (−1 = auto, else force
  storminess), `rain`, `lightning`, `cloudDark`, `skyDark`, `windBoost`,
  `frontPeriod`, `frontIntensity`. All read live by the controller.
- **`DEBUG.weather`**: the controller (set storminess, `triggerStrike()`, freeze).

## THE LAW / determinism

All weather lives in `render/` + `game/`/`main.ts`. `sim/` stays pure. The only
physics input touched is **swell amplitude**, via the existing `applySeaScale`
path (already a supported runtime operation) — deterministic given `storminess`
and never read by the vitest oracle. No new forces (atmospheric-only).

## Testing

- `weatherMath` + the new `audioMath` helpers unit-tested in vitest (mappings,
  front noise bounds, Poisson rate, thunder delay/volume, curves).
- In-browser Playwright screenshots at `storminess` 0 / 0.5 / 1.0 (and a forced
  strike) per the project's shader-verify rule; screenshots to the projects root.
- `npm run build` (tsc) **and** `npm run test` green before every push.

## Concrete integration points (main.ts)

- Construct `WeatherController` after sky/clouds/ocean/audio exist (~scene setup,
  near line 231/276). Inject `applySwell` wrapping `applySeaScale(waves, …)` +
  `ocean.refreshSwell()`.
- On Set Sail (~1902): Sandbox → `weather.setMode("fixed",
  stormFromSeaScale(cfg.seaRoughness))` (keep the existing `applySeaScale`);
  Career → `weather.setMode("dynamic")`.
- Render loop (~2194–2215, by `ocean.setChop` / `clouds.update`): call
  `weather.update(dt, world.simTime, camera.position, gs.phase)` and
  `rain.update` / `lightning.update`.
- Audio block (~1944–1992): rain bed + wind boost driven by storminess; thunder
  fired from the controller's queue. Respect the phase gate (no rain in menu).
- Add `TUN.weather` to `tunables.ts`; bind sliders in `devPanel.ts`; expose
  `DEBUG.weather`.

## Implementation phasing

- **P1** WeatherController + `weatherMath` + sky/sun/cloud darkening + wiring
  (the core clear→storm arc; Sandbox + Career drift).
- **P2** Rain (visual + audio bed).
- **P3** Lightning (bolts + flash + thunder).
- **P4** Performance profile + targeted fixes.

Parallelizable, file-disjoint work packages (new files + scoped single-file
edits) let leaf modules be built by concurrent subagents to the contracts above,
with the lead owning `tunables.ts` + `main.ts` + `weather.ts` (the hubs),
integration, and all in-browser verification. Each phase builds/tests/pushes to
`main` before play-test (workflow standard).

## Risks / notes

- Concurrent-instance worktree: stage only weather files; `ship.ts`/`crush.ts`/
  `crush.test.ts` are mid-edit by a sibling — do not touch. `audio.ts` is
  currently clean but the audio area is "hot" (user dropping real recordings);
  keep audio changes additive and re-check before integrating.
- Career dynamic swell must ease (no amplitude jumps that jolt hulls); throttle
  the GPU `refreshSwell`.
- Lightning bolt geometry can look janky — keep it thin, additive, fast-fading,
  and infrequent except at full storm.
- Rain instance count is the perf lever for the rain itself; scale with
  storminess and respect the adaptive-quality governor if needed.
