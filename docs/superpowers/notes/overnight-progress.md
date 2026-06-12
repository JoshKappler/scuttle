# Overnight build log — 2026-06-12 (autonomous session)

Branch: `dev/m1-m2-floats-and-sinks`. Plan: `docs/superpowers/plans/2026-06-12-m1-m2-floats-and-sinks.md`.
Dev server: `npm run dev` (was running on port 5180). Tests: `npm test` (62 passing).
Debug: `window.DEBUG = { sloop, hulk, world, cannons }` in the browser console.

## Done (plan Tasks 0–11)

- Scaffold: Vite + TS + three 0.184 + @dimforge/rapier3d-compat 0.19 + vitest.
- `sim/` is pure + unit-tested: rng, gerstner (CPU-invertible), voxelGrid,
  shipwright (procedural sloop), compartments (detection + flooding),
  buoyancy (probes), ballistics, connectivity.
- Ocean: GLSL Gerstner matching CPU params exactly; Sky addon; sun-glint
  sparkle via fragment normal detail.
- Ship: greedy-meshed chunks w/ vertex AO; mast/boom/sail/bowsprit dressing;
  per-compartment translucent water boxes (flood legibility v0).
- Physics: one rapier body/ship; probe buoyancy; ship-frame split drag
  (low fwd / high lateral keel / heavy heave); sailing (irons/reach curve,
  mast-point thrust → heel, rudder w/ low-speed floor); W/S/A/D + orbit cam.
- Cannons: broadside batteries (F), pooled manually-integrated balls,
  segment-march voxel impact, blast removal, splinter/smoke/splash particles.
- Severed-island detection → floating voxel debris bodies (wood floats).
- Flooding: per-cell breach registry from damage adjacency; Bernoulli inflow;
  bulkhead-hole openings; hatch downflooding past a 0.4 m coaming; flooded
  water = weight at water centroid (NOT lift scaling — see below).

## Hard-won physics findings (do not relearn these)

1. **Capsize #1 — top-heavy:** deck mass alone gives negative GM. Fix: iron
   keel ballast in `shipwright.ts`.
2. **Capsize #2 — probe application point:** applying buoyancy at column
   BOTTOMS is destabilizing when heeled (application points swing to the high
   side). Must apply at the **centroid of the submerged column segment**.
   Regression: `tests/stability.test.ts` (pure-math GM check, no rapier).
3. **Double-counting:** scaling probe lift by flood fraction AND adding water
   weight is wrong (full submerged compartment must net zero). We use
   **weight-only** (probes always displace; water = cargo at centroid).
4. **Sinkability:** a flooded wooden hull floats awash unless solid mass >
   solid displacement → ballast sized so she actually goes down
   (test: "fully flooded she SINKS").
5. **Freeboard vs downflooding:** too-heavy ballast → waves top the hatch
   coamings and the ship self-floods. Ballast amount + 0.4 m coaming are
   the balance; verified dry in calm + sailing.
6. **Vector aliasing:** `localToWorld(local, out)` must be alias-safe —
   passing `this.tmpV` as `out` previously corrupted hatch positions and
   pre-flooded every ship (flood [1,1,1] at spawn).

## Verified end-to-end (browser, numbers logged)

Waterline broadside (elevation ~0° at 30 m; 5° default is for range) →
solids drop → flood 0.02 → 1.00 accelerating over ~70 s (Bernoulli) →
stern trim to ~12° → deck dips → hatch downflooding starts filling the NEXT
compartment. Fully flooded ship sinks at ~0.7 m/s terminal. All emergent.

## Remaining in this plan

ALL DONE — M1+M2 merged to main (tag `m2-it-sinks`), plus M3 (tag
`m3-it-fights-back`): AI captain duels (pure tested brain in
`sim/aiBrain.ts`, adapter `game/ai.ts`), RMB elevation aiming, Q spyglass,
R plank repairs (4 s channel), P pump, win/lose banners + Enter restart.
Verified live: AI closed from 104 m, maneuvered abeam, landed broadsides;
player flooded to 20 % and was plugged + pumped dry. 69 tests green.

## M4 core DONE (tag `m4-boarding`) + playtest polish

Post-playtest polish: visible cannons at ports, 2x sail speed (~20 kn full
sail), bigger seas + whitecaps, bow wake spray, hatch coamings raised 0.55 m.
M4: `game/crew.ts` (Pirate: kinematic capsule + deck-carry + swim-ish state +
ragdoll-lite death), `game/boarding.ts` (enemy crew AI, slash/kick combat,
grapple via anchored pull forces, physical gold chest carry/bank ±500),
ship deck trimesh colliders rebuilt on damage. On-foot mode: T toggle,
WASD/Space/F slash/C kick/E grab. Win: bank the chest + clear the deck, or
sink her (forfeits most gold). All verified via staged browser telemetry.

## Remaining from spec (M5+)

Weapons/armor loadouts + swim-weight rules, muskets, first-person toggle,
swimming/diving + wreck salvage, sharks, ship-stealing, ports + upgrade
tree + parrot + crew hiring, roguelite voyage chain + leaderboard + daily
seed, real character models (Quaternius CC0), sound. Spec:
`docs/superpowers/specs/2026-06-12-scuttle-design.md`.

## M4 balance/feel debt

- Enemy crew don't pursue across ships until grappled/close (by design) but
  also never retreat; no telegraphs on slashes (cd-only balance).
- Kick is displacement-burst, not impulse — works but reads subtle; consider
  brief ragdoll on kick for comedy/physics payoff.
- Carried chest renders hoisted overhead (cartoony per spec) — could swap to
  two-handed front carry with slow-walk anim later.
- Crew don't ride ship teleports (irrelevant in production; affects tests).

## Known rough edges / tuning debt

- Hulk drifts (no anchor force) — add station-keeping or anchor flag for AI.
- Default broadside elevation (5°) is a long-range setting; player needs an
  aim control (camera-pitch → elevation) in M3.
- Heave/pitch in waves can look bouncy on sampled data; verify visually and
  consider raising angular drag `ka` slightly if it reads jittery.
- Sail visual doesn't reflect sailSet/wind side; boom is static.
- Ocean foam is subtle; breach splash jets not yet at breach POSITIONS
  (particles only at impact time).
- `npm run build` warns about chunk size (three.js) — fine for now.

## Round-2 playtest response (tag `m5-playtest-round2`, on GitHub)

Repo: https://github.com/JoshKappler/scuttle. All 15 feedback items addressed
except: compass click-to-seek (passive enemy marker instead), arm animation
on the wheel (capsule pirates have no arms yet), billow doesn't flip by tack.
New control model: always-present captain, E takes/leaves the wheel (helm
gated), V first person, 3P = bird's-eye on ship. Bugs fixed: swim oscillation
(damped spring), crew spawn race, AI irons pinning (tested), cutaway
ocean-through-hull (bilge backdrop), fullscreen sizing (ResizeObserver).
Feel: +heel, +freeboard (deck raised — tests held), steerage floor in irons.
Visuals: gaff rig laced to mast + cloth + billow, wood-grain shader, stern
rudder + spoked wheel answering the helm, styled HUD + compass + aim arc.

## Round-4 playtest response — m7 "seaworthy" (branch dev/m7-seaworthy)

All 19 round-4 items addressed. New hard-won findings (do not relearn):

- **Angular damping must gate on "wet", not submergedFrac**: a healthy hull
  draws only ~0.18 of her envelope, so `sub * k` silently throttled pitch
  damping to 18% strength. `wet = min(sub*5, 1)`. Measured: pitch p2p 15.4°
  → 5.5°, mean trim −4.2° → 0.07° (with speed²-proportional bow lift).
- **Characters are TRANSFORM-FOLLOWING, not velocity-carried**: anchor the
  body in ship-local space while grounded; each step starts from the carried
  anchor (full 6-DOF) + input through the KCC; re-anchor after. Velocity
  carry lags a frame → decks rise through boots; vertical-only fixes hop but
  not clip. Walk test: 15 m bow-ward at sea, local-y band 17 cm, zero
  excursions. `teleport()` re-anchors (respawn/ladder) or the next carry
  yanks you back.
- **Never PRUNE nodes from a cloned GLB** to drop a sibling character —
  animation bindings break (captain rendered as nothing). HIDE instead
  (visible=false) and measure normalize-bounds over visible meshes only.
- **Quaternius Pirate Kit**: clip names are NLA-mangled — match by substring
  (Idle/Walk/Run/Sword/Punch/HitReact/Death/Jump). captain.glb holds TWO
  characters (Barbarossa + Ernest) — hide "ernest". Henry ships holding a
  LUTE (Weapon_Lute) — hide non-weapon `Weapon_*` props. 41/45-joint rigs,
  embedded atlas, ~650 KB each. Vendored under public/assets (CC0).
- **Cutaway = shader discard, not clip planes**: clip planes can't express
  "footprint hole + bounded camera-side wedge" (union of intersections).
  Ocean fragment shader discards inside the hull box and in a ≤4.5-beam
  wedge on the camera side of the cut plane; dark abyss disc at y=−9 fills
  the trench (skybox-below-sea glows white otherwise). Flood boxes are
  emissive — unlit water in a shadowed bilge reads as more darkness.
- **Voxel texturing**: ship-local planar UVs picked by dominant face axis
  (greedy quads have no UVs); modulate vertex tint AROUND 1
  (`0.55 + tex*1.5`) — absolute multiply crushes everything to black.
- Orbit camera now targets worldCom (body origin = grid CORNER, 13 m aft).
- Fence bulwark: posts every 3rd cell + at staircase corners of the curved
  taper (diagonal ring steps would leave floating cap cells that sever as
  debris on the first hit). Embrasures (no rail) ±1 cell around each port.
- Wind floor 0.5 on every heading (arcade rule, round 4) — irons gone.
- Pointer lock: free mouse looks, RMB lays the guns (elev + traverse ±12°),
  muzzleWorld() in game/gunnery.ts is the ONE source of muzzle pos/dir for
  projectile, arcs, and barrel meshes.
- Stern ladder + E-climb (swimming only) recovers an overboard captain.

Deferred: billow doesn't flip by tack; FP hands; enemy crew look great but
boarding combat anims unverified under grapple; kick-over-rail needs hop
tuning; lute pirates would honestly be funnier.

## Round-5 playtest response — m8 "helm and trim" (branch dev/m8-helm-and-trim)

User refs: tall-ship cross-sections — hull = wide oval, top ~20% cut for the
deck, waterline near the widest belt. Findings (do not relearn):

- **ALIASING BIT AGAIN (3rd time)**: `rotUp = this.tmpF.set(0,1,0)…` aliased
  `fwd` in sailing.apply — thrust pointed straight UP; both ships drifted at
  2 kn. Every cached temp vector gets ONE job per call. Grep for `tmp` reuse
  whenever a force silently vanishes.
- **Restoring controllers, not one-signed boosts**: the round-4 "bow lift"
  (∝v², bow-up only) torqued her past vertical at full sail — she looped.
  Replaced with a saturating trim term: ±4° error band around level, force
  ∝ v² · clamp(−pitch). Verified 45 s at 100% sail: max tilt 8.8°, upY never
  < 0.99. Thrust also gates on up.y so a capsized rig can't push.
- **Egg hull section** (oval widest at 62% of depth, 32% bottom, 76% deck
  tumblehome) + deckY 16→20 (5 m hold) + 4 iron tiers + effective densities
  430/310 → waterline at 47% of hull height, 0.375 envelope submerged,
  22-26 kn at full sail (thrust 0.016→0.019 pays the wetted drag). All 71
  tests held through the reshape unchanged.
- **G-force banking**: ALL lateral drag at keel depth (2.2 m below COM,
  coeff 1.7) + lateral wind force on the canvas applied 3.5 m up the mast =
  18.9° lean in a hard turn at speed, ~0° on a dead run. The old split
  (some lateral at COM + 60% extra at keel) double-counted and felt random.
- **Ballistics inherit velocityAtPoint(muzzle)** (linear + ω×r); aim arcs
  integrate the same vector, so the preview IS the shot. Per-port reload
  clocks (Map by ship+port); broadside = all loaded guns on the side;
  fireOne for deck gunnery (F beside a cannon, arcs show that gun).
- **Helm set-and-hold**: A/D walk the rudder, it stays; no auto-center; HUD
  needle (#rudder-ind). Leaving the wheel changes nothing now.
- **FP look**: separate fpYaw/fpPitch (orbit mapping inverted left-right —
  orbit drag convention ≠ FPS), ±1.5 rad pitch, eye at +0.95, whole model
  hidden in FP (head-shrink left the uniform interior visible at eye level).
- **Jump anchor**: hold ship-frame attach the WHOLE air time (2.5 s cap),
  detach only outside the hull footprint — the 0.5 s timeout expired
  mid-jump and flung players off the stern at ship speed.
- Mast = real cylinder collider on the ship body (KCC respects it).
- Water boxes render only during cutaway (could bleed through hull from
  below otherwise); ocean cutaway wedge is now TRANSLUCENT (alpha 0.22)
  over a brighter abyss disc — "see down to the water level", no void.
- Quaternius cannon GLB on articulated pivots (yaw-then-pitch Euler — a
  shortest-arc quaternion flipped port carriages upside down); rig wood +
  sail fabric use real ambientCG photos.
