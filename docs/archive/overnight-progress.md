# Overnight build log — 2026-06-12 (autonomous session)

> ⚠️ **HISTORICAL — 2026-06-12 (M1–M2). Describes systems since REMOVED/OVERHAULED.**
> Enemy crew, the LOST-AT-SEA/PRIZE end-game, the 6 physics levers, the per-column probe
> buoyancy, and the pre-cascade ocean described below are **gone** as of round 17. Read
> `CLAUDE.md` for current state; **when this file disagrees with the code, the code wins.**
> Kept as a dated record of how M1–M2 were built.

Branch: `dev/m1-m2-floats-and-sinks`. Plan: `docs/superpowers/plans/2026-06-12-m1-m2-floats-and-sinks.md`.
Dev server: `npm run dev` (port **5173** — vite default; the "5180" once noted was wrong). Tests: `npm test`.
Debug: `window.DEBUG` in the browser console (current keys in CLAUDE.md; the old `hulk` is now `enemy`).

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

## m9 — brig and broadsides (rounds 6 + 6.5) — do not relearn

- Quaternius cannon GLB is ONE merged mesh with ~37 deg of elevation baked into the sculpt: it can NEVER articulate. Replaced with a procedural trunnion gun BUILT FROM gunnery.ts constants (BORE_UP/TRUNNION_OUT/TIP_FROM_TRUNNION) — the math and the model share the numbers by construction. Ball-vs-arc drift 0.01 m; origin within ~0.2 m of the visible bore.
- Broadside STAGGER made later balls launch from a muzzle that had MOVED since the arc was drawn — stagger is now 0 (round 6 wanted simultaneous fire anyway).
- Aim arcs include inherited ship velocity, so at speed the line tilts off the barrel axis BY DESIGN (it is the true splash prediction). Round 6.5 made it red+dashed. If the lead keeps reading as a bug, offer a barrel-true toggle.
- Player ship = buildBrig (34 m, deckY 24, qDeckY 33, 5 ports/side, 2 masts, 571 t, draft 43%, 24.1 kn, 6 deg hard-turn lean). Enemy keeps buildSloop. ShipBuild now carries deckYAt/quarterdeck/wheelM/footprint — NOTHING may hardcode hull dims (the crew overboard check, boarding spawns, bowsprit, cutaway hole all did and broke).
- qX1 must be the last station with t < qT (floor(x0 + qT*(L-1) - eps)) — round() put the break wall one station outside the quarterdeck and the door carved air.
- Even-nz grids: cz is *.5 — Math.round(cz±k) breaks port/starboard mirror symmetry (round half-up). Use floor/ceil pairs.
- Idle characters now ride the anchor EXACTLY (skip KCC when grounded+no input) — collide-and-slide shaved centimeters per step during hard turns. Caveat: a blast hole under a perfectly idle character won't drop them until they move.
- Combat clips strip .position tracks (root motion displaced the mesh off the capsule — "clips you towards the back").
- AI: fire check runs BEFORE the chase branch (passing broadsides); in-irons bear-away only at range > 120 or it reads as fleeing; close to 55 m at full sail then dance abeam at 0.85.
- Wake: ocean shader, not sprites — stern-path ring buffer (31 pts/ship, vec4 x,z,age,strength) laced with foam in FRAG (width starts at SHIP BEAM), bow mound + flank ridge in VERT. Hard along-bands read as "abruptly cuts off" — use smoothstep develop/taper everywhere.
- Sail billow must scale per sail (aBelly vertex attribute = width*0.17) — a fixed 1 m belly on a 15 m course reads flat.
- Helmsman: pin 0.45 m aft of the wheel + post-mixer arm pose (UpperArm/LowerArm L/R bones, rotation.x -= ~1.05) — poses applied in idleTick stick for the frame; setInterval experiments race the mixer.
- Cutaway on the brig: interior reads VERY dark + a boxy shadow ring + hull outline through the sea floor remain — user says pivot away for now; revisit with proper interior lighting later.

## m10 — carnage & feel (playtest round 7)

**Shipped:** screen-relative aim traverse (sign flips with aimed side — it was inverted on
one broadside only); barrel-true ball AND arc (inherited ship velocity removed from both
after three rounds of "the line veers"); window-level zoom wheel (HUD panels were eating
wheel events — the "sometimes locked" zoom); guns ×1.25 and pulled 0.4 m inboard (wheels
on planks, constants shared so bore ≡ math survives scaling via group scale + base/scaled
constant pairs); turn-G heel `T = m·(v·ω)·arm` about the fwd axis (sailing.ts, arm 4.2 →
~10° outward at 20+ kn; unit-tested sign convention in tests/heel.test.ts); hull-box vs
character collision split (cuboid group 0x0002, KCC filter ~0x0002 — the box top stood
1.1 m proud of the brig waist deck = the jump-landing "walk on air" + stair ejection);
sprint (shift, ×1.62, stamina drain 0.3/s ungated from computedGrounded which flickers
on a heaving deck) + antique stamina bar; helm pose applied ONCE per render frame against
a captured mixer snapshot (idempotent — per-substep `-=` offsets were the arm spasm);
full-length slash/kick one-shots via playFresh() (0.28 s timers had cut the Sword clip at
the wind-up; clips were present all along); rig damage: sail rect/mast cylinder/rudder box
segment tests (sim/rigDamage.ts, pure + tested), canvas-alphaMap shot holes, per-mast
sailIntegrity scaling thrust, mast HP 2 + foot-census fall (whole mast group topples and
slides into the sea), rudderEff 0.15..1 on yaw torque; ramming (perimeter-sample contact
+ closing speed > 4 m/s → waterline bites through applyDamage on BOTH hulls); severed
islands ≥ 250 cells become foundering wrecks (corner-probe buoyancy, wreckLift decay —
floats listing ~40 s then goes under); dry hold (ocean discarded inside each hull's
waterline ellipse, gated by flood state so the sea closes back over a foundering ship) +
compartment water boxes always-on; spyglass brass viewport overlay + wheel-zoomed FOV;
fullscreen on F; bolder antique skin.

**Hard-won:**
- `Material.clone()` does NOT copy onBeforeCompile (or customProgramCacheKey). The
  per-sail material clones silently lost the billow injection — sails went paper-flat for
  half the session. Build per-instance materials from a factory that assigns the injector.
- Rapier wasm: holding a reference to a removed body (despawned wreck in a camera-lock
  interval) → `RuntimeError: unreachable` + the whole physics world poisoned. Never cache
  rapier bodies across frames in test harness code; guard with try/catch.
- The iron keel ballast resists blast fringes BY DESIGN (sphere fringe skips IRON), so a
  midship cut leaves an iron spine bridging the halves — splits happen through wood
  sections (bow quarters), which reads right anyway: the keel is the last thing to go.
- isSunk fires on 95% flood — sawing a third of the hull off legitimately ends the game
  ("PRIZE SUNK") before the wreck show finishes. Fine for now.
- computedGrounded() flickers ~75% duty on a deck in a seaway — never gate per-second
  resource drains (or anything cumulative) on it.
- Ships that sink keep falling forever (enemy ended at y −2012 still stepping). Cheap
  freeze below ~−60 m is future polish.
- Playwright camlock intervals race the render loop's camera writes — monkey-patching
  `controls.updateCamera = () => {}` first makes framing deterministic.

**Verified numbers:** traverse delta = expected on both sides; ball speed 52.6 m/s at
120 ms (pure muzzle + drag — no ship-velocity term); heel +7.6° at 21.7 kn and rising
(arm 4.2), outward, sign-stable; ram at 12 m/s closing: 622/302 voxels, both hulls
breached + flooding; clean bow amputation → 1096-cell wreck floating at −2.4 m; mast
fall animates with punctured sails attached; stamina 1→0.62 over ~1.9 s sprint; arm bone
steady at −2.3 rad ±0.08 idle sway at the wheel; fullscreen toggles via real F press.

---

## m11 — Blue Water & Thunder (playtest round 8)

**Shipped:** 16-wave seeded directional spectrum (long swell tight to the wind, chop
scattered — no visible tiling) replacing the 4-wave loop; camera-centered polar ocean
mesh (~0.8 m verts at the hull → 40 m at the horizon, ~25k verts vs the old 160k uniform
plane) following the camera CONTINUOUSLY (the 10 m position snap was the round-8
"stutter") with per-wave distance fade so short waves drop out before the ring spacing
aliases them; physics rides a SWELL-ONLY subset (λ ≥ 14 m) so the hull answers the
rollers, not the chop — the round-8 "substantial" feel without faking inertia; bow swell
mound + flank ridge in the vertex shader, wake trail segments that ramp in (no pop), bow
plunge spray. Ship-velocity ballistics: the ball carries the ship's velocity at the
muzzle AND the aim arc integrates from the identical initial state, so line ≡ ball
underway (round-7 had stripped the carry to match a carry-less line; round 8 wanted both
the carry AND a matching line). Muzzle speed 55→72, blast 1.7→2.1, impulse 6→9. Muzzle
flash (additive flame + embers + pooled point-light pop) and impact burst (splinters +
sparks + smoke + flash). Guns 1.25×→1.6× and pulled inboard/aft (wheels were over the
edge). IBL sky environment (PMREM) so PBR shade reads as dim wood, not void. Frozen-
quaternion helm grip. 3P yaw sign flipped to match first person. Enemy spawns 160 m
pre-aimed + longer gun range / slower close-action so she closes instead of fleeing.
Forward-lean cured by walking the iron ballast ~1.7 m aft under the fuller-aft centre of
buoyancy. F-key fullscreen now surfaces its rejection reason + re-grabs pointer lock.

**Hard-won:**
- NEVER round-trip a source file through PowerShell `Get-Content -Raw | Set-Content
  -Encoding utf8` — it double-encodes existing UTF-8 (every em-dash/⌀/− in the comments
  became mojibake). Corrupted shipwright.ts mid-session; `git checkout --` saved it.
  All source edits go through the Edit tool.
- `Material.clone()` lesson's cousin: a 16-wave Gerstner sum spends most of its time near
  the MIDDLE of its range, so foam/whitecap crest thresholds tuned for a 4-wave sum
  boil the whole sea white. Raise thresholds (0.62/0.8) when you raise the wave count.
- Spreading a FIXED total amplitude across 16 waves starves the long swell — the bob
  driver dropped to 0.27 m and "the ship barely bobs". Key amplitude to the LONGEST wave
  (SWELL_AMP) with a falloff toward the chop, don't normalize the sum.
- IBL environment is strong ambient: env intensity 0.72 + hemisphere 1.3 bleached the
  dark oak hull to "a light birch". 0.28 env + 0.9 hemi + shadow.intensity 0.85 lifts the
  shade without washing the tone.
- A 90 m swell's phase speed (~23 kn) matches the brig's hull speed → she surf-locks on a
  wave back for minutes. L_MAX 70 m so she overtakes the sea.
- postPose overriding only rotation.x let the idle clip keep playing the bone's y/z under
  it — THAT was the "arm spasm all the time". Freeze the whole quaternion once on taking
  the wheel; apply grip + rudder lean from the frozen pose; the mixer gets no say.

**Verified numbers:** rest trim −1.86° bow-down → +0.34° (level), hard turn +0.93° bow
never buries (draft ~0.51); drifting heave 1.89 m p2p / pitch 4.35° / roll 2.9° (was
near-flat); longest wave amp 0.27 m → 0.64 m, total sea 2.66 m; aim line ≡ ball to 0.07 m
mid-flight at 21 kn with full 10.8 m/s carry; ball world speed 68.7 = √(67.9² + 10.8²)
(bore + ship); muzzle flash spawns 125 fire-layer particles + flash light to 58 intensity;
bow plunge crosses the spray threshold 5×/3 s at 25 kn; helm arm 0.032° frame-to-frame at
fixed rudder, 34° spread port↔starboard; enemy closes 148 m → 58 m from spawn; suite 105
green. Open: F-fullscreen needs a real browser to confirm (headless lies); sunk ships
still fall forever.

## Round 9 (playtest m11) — wood, bob, guns, rudder, sails, water

- **Violent bob — the real bug:** heave drag was gated on raw `submergedFrac` (~0.2 for a
  healthy hull), throttling it to ~0.5/s. The buoyancy spring (ω_n≈2 rad/s) was therefore
  ζ≈0.15 — she resonated and bobbed clean out of the sea on a modest swell. The *angular*
  damping was fixed to use `wet=min(sub·5,1)` back in round 4; heave was missed. Gate heave
  on `wet`, raise the coefficient to ~4.5 (near-critical). DON'T swap physics engines — the
  engine was never the problem, the integration was under-damped.
- **Wood still "light birch" → "darker pirate wood":** it's the bright plank photo × the
  strong afternoon sun, not the base color. Darkening oak alone wasn't enough; you must cut
  the texture lift (`0.4+tex*1.05` → `0.26+tex*0.62`) AND drop oak/pine ~30%. Rig wood tan
  0xb89878 → 0x5a4128.
- **Gun ports asymmetric:** `round(cz±hb)` with cz=21.5 (even beam) rounds both ports about
  cell 22, biasing BOTH batteries a half-cell to starboard — the right guns hung a full
  cell further over the edge. `floor(cz)+hb` / `ceil(cz)-hb` mirrors them exactly.
- **Sail warble:** the billow's `sin(uv.y·π)` pinned the belly to the yards but the flutter
  term had no envelope, so the laced head/foot floated off the spars. Multiply flutter by
  the same `sin(uv.y·π)`.
- **Ocean clipping the hull:** the dry-hull discard ellipse was only 0.62·beam × 0.88·len,
  leaving the sea drawn over the outer third of the hull and the bow/stern tips. Widen to
  0.97·len × 0.92·beam to hug the true waterline plan (still xz-only, so pitch/heave can't
  reveal sea through the deck). Add a STANDING displacement collar (rr≈1.08 ridge just
  outside the hull ellipse) so she bulges the sea even at rest. Chop: additive boost on the
  sub-14 m components (physics never feels them) + a 3rd fine normal octave.
- Ramming: dropped the onRam toast entirely — voxel carving only ("voxel based and dynamic").

**Verified numbers (round 9):** full-sail heave 0.86 m p2p / max |v_y| 0.25 m/s (was the
"bobs out of the water" resonance); rest draft submerged 0.43–0.53, deck ~1.5 m clear;
all 5 gun stations symmetric (offsets ±14.5/±15.5/±15.5/±13.5/±11.5, stbd≡-port); dark oak
holds in full sun, shadows still readable; bow throws a bulging bow wave + foam at 8 m/s,
clean waterline (no sea through hull/deck/bow); suite 105 green; tsc clean. Open (unchanged):
F-fullscreen needs a real browser; sunk ships still fall forever; "guns too far forward"
may persist (only the L/R asymmetry + overhang were fixed — user to confirm).
