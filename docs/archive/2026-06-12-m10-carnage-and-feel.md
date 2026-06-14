# M10 — Carnage & Feel (playtest round 7)

> Worklist plan for round-7 feedback. Execute top to bottom on dev/m10-carnage-and-feel,
> commit per task, verify each fix in the running game (Playwright) before moving on.

**Goal:** voxel-physics carnage (sail/rudder/mast damage, ramming, hull splitting) + a feel
pass (aim, heel, character, camera, UI) from playtest round 7.

## Round-7 item → task map

| # | Feedback | Task |
|---|----------|------|
| 1 | red line veers right of where the gun shoots | T2 barrel-true: drop inherited ship velocity from BOTH ball and arc |
| 2 | aim left/right inverted (vertical fine) | T2 screen-relative traverse: sign flips with aimed side |
| 3 | balls pass through sails; tear holes, slow them | T9 sail hit test + hole decals + per-mast integrity → thrust |
| 4 | rudder holes hurt maneuverability | T10 rudder hit box → rudderEff multiplier on yaw torque |
| 5 | ramming brutally damages both ships | T11 pair contact detection → mutual applyDamage ∝ closing speed |
| 6 | shoot out mast bottom → whole mast falls | T9 mast foot integrity + direct mast hits → fall animation, thrust 0 |
| 7 | ram hard enough → ship splits in half | T12 large severed islands become floating wreck bodies that founder |
| 8 | 3P zoom sometimes locked, scroll dead | T2 wheel listener window-level (HUD panels were eating it) |
| 9 | cannons too far outboard, front wheels off the deck; too small | T3 GUN_SCALE 1.25 + pull pivot inboard 0.4 m (gunnery + visual stay locked) |
| 10 | antique UI "didn't do anything" | T14 much bolder antique skin + verify by screenshot |
| 11 | captain's arm spasming at the wheel | T6 helm pose applied once per RENDER frame after all fixed steps |
| 12 | pitch-black shadows | T2 hemisphere fill up, exposure up, shadow-only darkness capped |
| 13 | heel random / wrong direction / not enough | T4 turn heel torque: T = −m·v_fwd·ω_y·ARM about fwd axis (outward lean) |
| 14 | jump+land → walk on air, stairs eject you | T5 hull cuboid collision groups (KCC ignores it; top sits 1.1 m proud of deck) |
| 15 | jump too high | T5 jump v 5.6 → 4.6 |
| 16 | sprint on Shift + stamina bar | T5 + T14 |
| 17 | spyglass: animation, circular brass viewport, lens feel, scroll zoom | T13 overlay + wheel-FOV |
| 18 | sea visible inside the hull through the hatch | T8 ocean discards inside each hull footprint (gated by flood state); compartment water boxes always-on when flooded |
| 19 | slash + kick animations missing | T7 clip fallback / post-mixer overlay (verify what captain.glb actually has) |
| 20 | fullscreen | T14 F key + brass button → requestFullscreen |

## Tasks

- **T1** branch + this plan committed.
- **T2 feel batch** — `player.ts`: wheel listener on window; `aimSideSign` field; traverse
  `+= movementX * 0.06 * -aimSideSign`; spyglass wheel→FOV (8..28°). `main.ts`: set
  `controls.aimSideSign = aimSide()` each step; arc drops `velocityAtPoint`; spy FOV from
  controls. `cannons.ts`: launch drops baseVel. `crew.ts`: jump 4.6. `sky.ts`: hemisphere
  0.55→0.85; `main.ts` exposure 0.85→1.0.
- **T3 guns** — `gunnery.ts`: GUN_SCALE 1.25, BASE constants exported for the visual,
  scaled constants for the math; pivotLocal z: `(port.z+0.5 − side·2.6)·VS − side·0.2`.
  `shipVisual.ts`: pivot.scale = GUN_SCALE, same inboard shift, elev offsets use BASE.
- **T4 heel** — new `src/sim/heel.ts`: `turnHeelTorque(vFwd, omY, mass, arm)` pure +
  `tests/heel.test.ts` (right turn at speed → lean LEFT/outward). `sailing.ts`: apply about
  fwd axis, ARM ≈ 3.0, clamp lateral accel ±4 m/s²; sail heel 0.012→0.015.
- **T5 character** — `ship.ts`: hull cuboid `.setCollisionGroups(0x0002_FFFF)`.
  `crew.ts`: `computeColliderMovement(collider, desired, undefined, 0xFFFF_FFFD)`;
  sprint (×1.6 while sprint flag + stamina>0), stamina 1.0, drain 0.28/s, regen 0.16/s
  after 0.8 s; jump 4.6. `player.ts` footMove returns sprint (ShiftLeft). `boarding.ts`
  passes it through.
- **T6 helm pose** — `crew.ts`: remove helmPose from idleTick; add `postPose()` called
  once per render frame from `main.ts` after `world.step` (offsets ride the final mixer
  state exactly once).
- **T7 combat anims** — inspect captain.glb clips live; `pirateModel.ts`: fallback chain
  attack→punch→hit when a pattern misses + expose `has(key)`; `crew.ts`: post-mixer arm
  swing overlay when the rig lacks the clip.
- **T8 dry interior** — `ocean.ts`: per-ship ellipse discard from uShipA/uShipB (always,
  not just cutaway), gated by uShipB[i].w = dryness (1 dry → 0 as flood>~75% or hull
  founders) fed from `main.ts` feedWake. `shipVisual.ts` updateWater: visible whenever
  fill>1% (drop cutawayActive gate).
- **T9 sails & masts** — `shipVisual.ts`: per-mast Group refactor (mast+yards+sails under
  one foot-pivot), per-sail records {mesh,mastIdx,w,h,localX,centerY,centerZ}, hole API
  (canvas alphaMap per sail) + `fellMast(mi)` fall animation. New `src/game/rigDamage.ts`:
  segment-vs-sail-plane and segment-vs-mast-cylinder tests in ship-local space (pure,
  tested). `ship.ts`: mastSailIntegrity[], mastAlive[], mastHp 2, foot-cell census +
  check in applyDamage → onMastFelled. `sailing.ts`: per-mast thrust × integrity, skip
  dead masts. `cannons.ts`: per-ball sail test (no kill, hole + integrity hit) + mast
  cylinder test (kill, hp−−). Toasts.
- **T10 rudder** — rudder box in `rigDamage.ts`; ship.rudderEff 1→0.15 over 3 hits;
  `sailing.ts` yaw × rudderEff; visual: chip the blade (scale.y down per hit).
- **T11 ramming** — new `src/game/ramming.ts`: each fixed step, hull-rect perimeter
  samples of A in B's frame (and vice versa); contact when inside with margin; closing
  speed from velocityAtPoint diff; > 4 m/s → applyDamage both at contact (radius
  2 + speed·0.45, cap 7), splinter burst, 1.2 s pair cooldown. Wire in `main.ts`
  onFixedStep for [sloop, enemy].
- **T12 wrecks** — new `src/game/wreck.ts`: WreckManager.spawn(island, srcShip) for
  islands ≥ 250 cells (else debris as today): mini-grid → meshChunk visual, dynamic body
  + cuboid collider, inherited velocity, buoyancy at 4 probes with waterlog decay → it
  lists, settles, founders; despawn deep/old. `main.ts` onSevered routes big/small.
  `tests/wreck.test.ts`: split detection via findSevered on a bar grid + size routing.
- **T13 spyglass** — `index.html`: #spyglass overlay (circular mask, brass double ring,
  vignette, subtle chromatic rim); CSS scale/opacity raise animation; `main.ts`: show
  while Q, FOV lerp to controls.spyFov; hint line.
- **T14 UI/fullscreen** — bolder antique: corner plates, panel headers (SHIP / GUNS / GOLD),
  parchment texture gradients, thicker brass, compass lacquer; stamina bar (#stam-bar);
  fullscreen on F + ⛶ button (pointer-events:auto); hints updated.
- **T15 verification sweep** — Playwright: aim sign both sides, line≡ball, heel direction
  table (hard right at speed → port-down), levitation repro attempt, sprint drain, sail
  holes + speed drop, rudder kill → turn rate drop, ram → mutual carve + breaches, mast
  fall, split wreck afloat, dry hold screenshot, spyglass + UI + fullscreen screenshots.
- **T16 finish** — all tests green, merge --no-ff to main, tag m10-carnage-and-feel, push.

## Numbers to verify at the end

- ball vs arc drift ≤ 0.05 m with ship at speed (now barrel-true).
- hard right at ~20 kn: roll sign = port-down (outward), magnitude 8–14°.
- sprint: ~5.4 m/s for ~3.5 s, stamina empties → walk speed until 25% regen.
- 5 sail hits on one mast ≈ −30% that mast's drive.
- ram at 8 m/s: both hulls breached (≥40 voxels each), flooding starts.
- mast falls when foot < 50% or 2 direct ball hits.
- split: island ≥ 250 cells becomes a wreck body that floats then founders.
