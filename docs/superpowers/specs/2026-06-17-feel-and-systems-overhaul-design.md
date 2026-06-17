# SCUTTLE — Feel & Systems Overhaul (2026-06-17)

Lead-engineer coordination doc for a 9-item batch the user dumped in one go. Source of truth
for the parallel subagent run. Each item below has: **root cause** (from file:line recon),
**decision** (locked), **files**, **acceptance**. THE RULE: code wins over docs.

Baseline: `main` @ `314d5a0`. Dev server :5173 live (primary tree). NO worktrees — direct to main,
push after each wave.

## Constraint that drives the plan
We work on the ONE shared primary tree (user: no worktrees, push to main, version control is the
safety net). Two agents writing the SAME file concurrently corrupts it (Edit = whole-file RMW). So:
**each concurrently-running agent owns a DISJOINT set of whole files.** Hub files shared across
concerns (`ship.ts`, `tunables.ts`, `shipVisual.ts`, `shipwright.ts`, `cannons.ts`) get exactly ONE
owner per wave. Hence 3 waves. Lead (me) commits+pushes after each wave (no concurrent git).

## The 9 items

### #1 Turn radius 2× tighter  → PHYSICS-FEEL agent (wave 3)
- Root: `game/sailing.ts:138` `yaw = rudder*flow*mass*0.5*rudderEff*rudderPower`; base coeff `0.5`.
  Also `TUN.phys.yawDamp 0.7`, `TUN.phys.lateralDrag 1.7`.
- Decision: roughly double effective rudder authority (base coeff ~0.5→~1.0, tune live). Couple with #7.
- Accept: a ship's turning circle is ~half its current diameter; still controllable, no spin-out.

### #2 Fore/aft cannons scale with ship size  → CANNON-COUNT agent (wave 2)
- Root: chasers defined per-class in `sim/shipwright.ts` (Cutter/Sloop 1+1, Brig/Frigate 2+2,
  Man-o'-War 2+2). Routing already handles `facing:"fore"|"aft"` via `cannons.ts bears()`.
- Decision target counts (bow + stern): Cutter 1+1, Sloop 2+2, Brig 3+3, Frigate 4+4, **Man-o'-War 6+8**.
  Place without voxel overlap (z offsets / use the MoW's multiple gun decks for stern stack). Keep
  port/starboard symmetric so `tests/manOfWar.test.ts` stays green.
- Accept: MoW has ≥6 bow + ≥8 stern chasers, all fire on fore/aft keys; guns render; symmetry test green.

### #3 Music only in main menu  → AUDIO agent (wave 1)
- Root: `render/audioMath.ts:22` `musicTrackForState` — `"paused"` falls through to `menu_theme`.
- Decision: `paused` → `""` (silence). `menu` → menu theme. `playing` → `""`. `port` → harbor.
- Accept: music plays at start menu only; pausing mid-voyage = no music; gameplay = no music; harbor = harbor bed.

### #4 Ocean ≥2× louder  → AUDIO agent (wave 1)
- Root: `render/audio.ts:63` `OCEAN_GAIN = 0.28`.
- Decision: ~`0.6` (≥2×). Bump wind base too if it now feels thin (`WIND_BASE 0.4`).
- Accept: ocean ambient clearly ≥2× present.

### #5 UI overhaul  → UI agent (wave 1)
- Flood meter: `index.html:93-97` hard-codes 3 bars (fl0/1/2); `main.ts:1166-1168` fills them. Ships
  have 8-12 compartments. Decision: render ONE labeled segment per actual compartment
  (`sloop.build.compartments`), each showing its flood fraction + a status tint (dry/flooding/full),
  rebuilt on hull swap. Keep it compact (it's a HUD strip).
- Bottom help text: `main.ts:1197-1201` shows removed/dev features. Decision: drop "CLICK to capture
  mouse", drop the SANDBOX hint entirely (dev-only), verify every listed control still exists
  (R plug-breach + P pump DO exist — keep; confirm against CLAUDE.md Controls). Clean, current list.
- Fullscreen button: `index.html:109` `#fs-btn` + CSS `81-82` + handler `main.ts:923` + fn `891-922`.
  Decision: REMOVE button + CSS + listener (game launches fullscreen; button is dead).
- Compass letters upright: `main.ts:1126` rotates `.rose`; N/E/S/W children inherit. Decision:
  counter-rotate each letter by +heading so glyphs stay upright while the rose spins.
- Accept: meter shows real compartment count + statuses; help text current & dev-free; no FS button;
  compass letters always upright.

### #6 Mast breaking broken (+ #9 bowsprit)  → RIG agent (wave 1)
Four user-reported bugs + bowsprit. Root-cause map (recon):
- "Original mast stays up while a SECOND mast spawns & falls": `ship.fellMast` (ship.ts:299) calls
  `visual.fellMast` (shipVisual.ts:262 → hides `mastRigs[mi].group`) AND `RigManager.spawnFallingMast`
  (rig.ts:157) builds a FRESH lattice via `buildRig`. Suspect: hide not matching the felled mast, or
  the rebuilt lattice spawns at wrong geometry → reads as a duplicate.
- "Falling mast has NO sail, just ~8×8 sideways squares too small to tile": `render/rigVisual.ts:40,77`
  renders CLOTH nodes as 0.55 m identity-rotated tiles (look like floor tiles, not a sail) + voxel
  beams. This voxel-cloth look is the "weird squares."
- "Phases through the ship": `rig.ts:304 crushFalling` not engaging (speed/gate/bounds).
- "Generally not functioning": full chain cannons.ts:192 → ship.hitMast → fellMast → onMastFelled →
  rig.spawnFallingMast → stepFalling/crushFalling. Verify each hop live.
- Bowsprit (#9): `rig.ts:342 bore` carves enemy hulls when `TUN.rig.bowsprit && TUN.crush.enabled`
  and `vClose>vBreak`; but the spar is pinned forever — **no detach/fall-off path exists.**
- Decision (user intent): felled mast must (a) cleanly hide the original — NO phantom/duplicate,
  (b) fall as a RIGID chunk (mid-hit → top falls stiff + stub stands; foot-hit → whole mast falls),
  (c) carry a real SAIL and look like an actual mast (NOT voxel cloth tiles), (d) COLLIDE with /
  crush the hull as it lands (not phase through). Recommended: drive the falling piece's RENDER from
  the REAL mast meshes (clone/reparent `mastRigs[mi]` group: pole + yards + solid sail) posed by the
  rigid-chunk transform, instead of `RigPieceVisual` voxel beams+cloth tiles. Keep the rigid-chunk
  PHYSICS (freezeChunk/integrateChunk) for collision. Bowsprit: bore must reliably engage on a ram
  AND the bowsprit should break off (detach + fall) once it has bored / taken enough load.
- Accept (verify live): cannon through a mast → exactly ONE mast disappears and ONE rigid piece (with
  a sail, looking like a mast) falls and crushes the deck; mid-hit leaves a standing stub; bow-ram an
  enemy → bowsprit bores a tunnel first and then snaps off. No noodling, no phantom, no floor-tiles.

### #7 Sway / ballast / rudder-visual  → PHYSICS-FEEL agent (wave 3)
- Idle & straight-line roll too high; turn heel too low. Per THE LAW it's emergent: wave-driven roll
  vs leeway-at-CB turn heel. Levers: `TUN.phys.heaveDamp 0.2` (roll damping), `TUN.phys.lateralDrag
  1.7` (turn heel via CB force), ballast COM (`sim/shipwright.ts` IRON bands), `TUN.phys.buoyancy 1.5`.
- Decision: (a) reduce idle/straight roll — stiffen roll (more damping and/or lower COM via heavier
  bottom ballast). (b) INCREASE turn heel to ~45° at peak turn (stronger leeway force / heel couple),
  consistent with the #1 tighter turn. (c) heavier bottom ballast but **waterline must NOT change** —
  lower the COM by redistributing mass downward at ~constant total mass (or add low-cell density while
  trimming elsewhere); verify draft unchanged via DEBUG. (d) rudder visual extends a bit below the
  keel: `render/shipVisual.ts:565-602` lower the blade/heel.
- Accept (live): idle/forward roll visibly calmer; hard turn leans ~45° without capsize; waterline
  unchanged after ballast change (measure draft before/after); rudder pokes below hull.

### #8 Flooding visuals + tuning + pump + severity  → FLOOD agent (wave 2)
- Visual: `render/compartmentFluid.ts:175` draws ONE tilted plane per wet column at fill height → a
  thin TOP SHEET. User wants SOLID water down to the floor. Decision: extrude each wet column down to
  its floor (a box/quad wall), unlit navy, top at fill height.
- Level: `ship.ts` flood uses Gerstner `surfaceHeight` for breach heads (good); inside surface from
  `fillHeightLocal`. User says it reads slightly above outside sea — verify inside surface Y == outside
  Gerstner surface at the column x,z; fix any bias.
- Tipping: front compartments flood but she barely tips. `floodBallastLocal` biases weight low (0.28).
  Decision: make flood weight produce visible trim (raise the bias / apply more of the moment) so a
  bow-flooded ship noses down — and as she noses down those holes stay underwater (less drainage),
  forcing pump or port. Don't capsize.
- Pump: `PUMP_RATE 0.12` static. Decision: expose `TUN.flood.pumpRate`; set so the pump keeps all but
  the worst-damaged afloat.
- Severity: breach inflow currently fixed area per hole + √(depth). Decision: inflow per compartment
  should scale with **how badly punctured** it is = (number/size of breach cells) × depth head. So:
  1 small waterline hole (bobbing) → pump wins; mid always-underwater hole → ~pump capacity; big
  bottom chunk (many breach cells) → floods faster than pump.
- Accept (live): flooded compartment looks like solid water filling the room to the correct sea level;
  bow-flood noses the ship down; pump rescues a light breach but not a gaping one.

### Tracks with no hub-file conflict (run earliest):
- AUDIO (#3+#4): `render/audio.ts`, `render/audioMath.ts` — disjoint from all.
- UI (#5): `index.html`, `src/main.ts` — disjoint from all (no other task touches main.ts/index.html).

## File ownership & wave schedule

| Wave | Agents (parallel) | Owns (exclusive this wave) |
|---|---|---|
| 1 | **AUDIO** | audio.ts, audioMath.ts |
|   | **UI** | index.html, main.ts |
|   | **RIG** | rig.ts, rigLattice.ts, rigBuild.ts, rigVisual.ts, shipVisual.ts, ship.ts, cannons.ts, tunables.ts |
| 2 | **FLOOD** | compartmentFluid.ts, compartments.ts, ship.ts, tunables.ts |
|   | **CANNON-COUNT** | shipwright.ts, cannons.ts |
| 3 | **PHYSICS-FEEL** | sailing.ts, heel.ts, ship.ts, tunables.ts, shipVisual.ts, shipwright.ts |

Why the order: RIG, FLOOD, PHYSICS-FEEL each need `ship.ts`+`tunables.ts` → mutually exclusive → 3
waves. CANNON-COUNT (shipwright.ts+cannons.ts) is disjoint from FLOOD → pairs in wave 2. AUDIO+UI are
disjoint from everything → wave 1. PHYSICS-FEEL runs LAST so it tunes feel against the final hull
(after rig/flood/cannon/ballast structural changes land).

## Verification protocol (lead, after each wave)
1. `npx tsc --noEmit -p .` (vitest does NOT typecheck).
2. `npm run test` (~359 tests; `manOfWar > symmetric` is a known parallel-load flake — re-run in
   isolation if it's the only red).
3. Live Playwright at :5173 for that wave's visible features (one browser, lead-driven).
4. Commit each feature with its own files; `git push origin main`.

## Subagent rules (all)
- Opus, full context (this doc's relevant section embedded). Implement ONLY your owned files.
- Do NOT run git (lead commits). Do NOT run full-project tsc (cross-agent noise) — reason carefully +
  run your module's vitest file if one exists. Report: files changed, new TUN keys, how to verify, concerns.
- At most ONE agent per wave uses the browser (RIG in w1, FLOOD in w2, PHYSICS-FEEL in w3).
