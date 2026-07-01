# Round 12 — Overhaul design: perf, collision, handling, sails, buoyancy

**Date:** 2026-07-01 · **Status:** approved by Josh (design + decomposition + all four direction calls)

Round 12 is a five-sub-project overhaul driven by a six-way parallel investigation of the
codebase (rig/sails, collision, buoyancy/flooding, performance, handling/feel, code health).
The verdict: the architecture is sound (sim/ stays pure, one destruction rule, low duplication,
real test coverage) — the pain traces to a handful of specific causes, fixed here.

> Per CLAUDE.md THE RULE: file references below name mechanisms, not gospel line numbers.
> Implementers verify every claim against the code before changing it.

## Investigation findings (what this design answers)

1. **Turning is slow because of math, not tuning.** Steady yaw rate ≈
   `rudderGain / (yawDamp · (l² + w²))` — ship mass cancels (rudder torque scales with mass,
   damping torque scales with inertia which scales with mass). Turn rate falls off with hull
   length **squared**: Cutter ~85°/s steady-state, Frigate ~8°/s (10–12 s to 90°). That is why
   doubling `rudderGain` twice barely helped. The levers are inertia (1.6× added-mass factor in
   `game/ship.ts`), `yawDamp` (0.6, scales WITH inertia), and rudder authority that today has no
   hull-length lever arm.
2. **Collision jank is structural, not tunable.** `game/voxelContact.ts` computes ONE aggregate
   closing direction for the whole contact patch and classifies every voxel contact by its speed
   projected onto it. Angled/T-bone rams project low → misclassified as REST → mushy damage.
   The break-energy budget is likewise computed from centroid velocity, not per contact. Two
   more holes: glancing parallel scrapes can have both push-out axes (COM→COM line and
   `ov.axis`) perpendicular to the actual slide (ships grind + stick), and near-zero relative
   velocity degenerates the closing direction to [0,0] (slow-drift press never separates).
3. **Perf losses are redundant recomputation**, not algorithms: the buoyancy wave-field lattice
   rebuilds per ship per frame; breach sea-heads re-run exact Gerstner inversions at 10 Hz even
   with no new damage; the ocean `uProfileAtlas` hull profile rescans the whole voxel grid per
   ship per frame though it only changes on carve; the damage path allocates (remesh
   BufferGeometry/typed arrays, carve heap + seen-Set per contact pair, contact scratch growth,
   full deck-collider resweep).
4. **Buoyancy is correct but entangled.** Per-cell lift is textbook Archimedes ×
   `TUN.phys.buoyancy = 1.5` (a feel-tune). The problem: heave **stiffness**
   (`k = ρ·g·A_waterplane·buoyancy`) includes the multiplier, so buoyancy and heave damping
   secretly move together (`c = 2ζ√(k·m)`). Also: no fore-aft trim test exists (known blind
   spot), and CLAUDE.md LAW #3 says lateral drag applies at COM — the code intentionally
   applies it at the **center of buoyancy** (that is what rights her and banks turns); the doc
   is wrong, not the code.
5. **Sails need a render/feel layer only.** The voxel truth (per-sail cell lists in
   `build.sailVoxels`, cannon bore, 18-connectivity sever, floating debris, thrust =
   surviving-CANVAS fraction) works. CANVAS cells are just drawn by the same cubic mesher as
   oak. The old billowing sail (throttle-driven `uFill`, yard-pinned belly, flutter, backlit
   canvas) survives in git at `079e06d` (last mesh-rig shader) and is recoverable.
   Known gaps to close: felled masts get no wind, port repair cannot restore a felled mast at
   all, and (deferred round-11 issue) a continuous sail sheet BRIDGES a trunk-only cut.
6. **Code health is decent.** `main.ts` is a 2,440-line god-file (aim-arc UI, cutaway, ship
   swap are clean extractions); small dead list (`TUN.flood.render.skirtDepth`/`blendBand` +
   their dev-panel sliders, `sim/islandCollider.ts surfaceBandVoxels` zero-importer).

## Decisions (Josh, 2026-07-01)

- **Order:** parallel blitz — but as **file-disjoint waves** (four sub-projects touch
  `game/ship.ts`; naive all-at-once would commingle, see the hub-file memory).
- **Sails:** cloth mesh over voxel truth (option A).
- **Handling target:** weighty but responsive — Cutter ~2–3 s to 90°, Frigate ~5–6 s.
- **Buoyancy:** keep the current feel/draft exactly; decouple the knobs; no return to 1.0
  this round.

---

## SP1 — Sails: cloth mesh over voxel truth

**Sim truth is unchanged.** CANVAS voxels stay in the grid: bore, sever, debris islands,
`sailIntegrity` from surviving fraction, GM/topweight — all as today.

Render/behavior layer:

- **Hide the cubes:** the hull mesher skips CANVAS cells (reuse the `meshChunk` visibility
  predicate added for the cutaway cull — exclude material 14). SPAR stays cubic (reads as
  timber). The cutaway `X` cut must keep working with sails excluded.
- **`render/sailVisual.ts` (new):** one subdivided plane (~16×12 segments) per sail sheet,
  sized/positioned from that sail's voxel-rectangle bounds (derivable from
  `build.sailVoxels[mi]` + yard levels). Parented to the ship visual so it rides pose. Vertex
  shader recovered from `079e06d`: belly pinned at yards (`sin(uv.y·π)`), inflation
  `uFill = 0.35 + 0.65·sailSet`, time flutter, backlit translucency (`uSailTrans`) — adapted
  to current three.js setup and `getOceanLook`-era lighting.
- **Damage mapping:** per sail, a small occupancy texture (R8, one texel per CANVAS voxel of
  that sheet) rebuilt from the grid on damage flush (~10 Hz, only when that mast is touched).
  Fragment shader discards where occupancy says dead (noise-warped edge for jagged tears);
  vertex shader scales belly by local surviving fraction so raked canvas sags, and the whole
  sheet hides at integrity 0. Result: holes and deflation visibly match the thrust nerf.
- **Wind response (standing rig):** billow depth/direction driven by the same wind-vs-heading
  factor `game/sailing.ts` computes (share, don't duplicate). Head-to-wind = luffing: belly
  → 0, flutter amplitude up.
- **Felled rig:** debris keeps the voxel-meshed SPAR body; its CANVAS renders as a limp draped
  variant of the sail mesh (no throttle billow, waterlogged tint) parented to the debris body.
  New: a wind-drag force on rig-debris bodies proportional to surviving canvas area above
  water (`game/debris.ts`), so felled sails drift downwind. Force magnitude must stay well
  below crush-relevant speeds (drift, not a weapon).
- **Repair fix:** port repair (`ship.repairSails`) can currently only restore standing masts.
  Change: repairing also restores felled masts — despawn that ship's rig-debris islands and
  re-stamp SPAR + CANVAS from `build.mastVoxels`/`sailVoxels`; `mastAlive[mi]` resets.
  *Ownership split:* the debris-despawn API (`debris.removeRigFor(ship)`) lands in wave 1
  with agent B (owns `debris.ts`); the `ship.repairSails` change lands in wave 2 with agent D
  (owns `ship.ts` then).
- **Explicitly out of scope:** a Verlet/soft-body cloth sim; fixing the sail-bridges-trunk-cut
  connectivity quirk (still deferred; note it in CLAUDE.md).

**Acceptance:** sails read as billowing fabric at sea; W/S visibly inflates/deflates; cannon
hits punch visible jagged holes and the sheet sags as integrity drops; a felled mast drapes
its canvas and drifts downwind while afloat; port repair restores a fully dismasted ship;
cutaway unaffected; 431+ tests green (no sim change ⇒ no oracle change).

## SP2 — Collision correctness

Architecture stays: energy-bounded cheapest-first carve, rest/de-pen split, horizontal-only
positional separation, ship pairs outside Rapier. Three structural fixes in
`game/voxelContact.ts` (+ `sim/voxelOverlap.ts` where the data comes from):

1. **Local classification:** classify each contact by closing speed along a **local** contact
   normal (per-contact or per-cluster from the overlap geometry — e.g. the local surface
   gradient / face normal from `voxelOverlap`), not the single aggregate direction. T-bone and
   45° rams must read their true perpendicular closing speed.
2. **Per-contact energy budget:** break energy allocated from per-contact `½μ·v²` (summed over
   breaking contacts / clusters), replacing the centroid `vClose`. The total must stay bounded
   by the pair's actual closing KE (no energy injection).
3. **Robust separation:** (a) when the closing direction is degenerate (near-zero relative
   velocity) fall back to the geometric minimal-overlap axis for push-out; (b) for tangential/
   parallel scrapes (closing ⊥ both candidate axes) use `ov.axis` at full weight and add a
   small tangential friction impulse so grinding hulls shed relative speed and separate.

**Guard rails:** de-pen stays horizontal-only and position-based with pre-zeroed closing (the
anti-fling invariants); terrain stays infinite-mass/no-carve; determinism (sim/ purity) holds.

**Acceptance:** new deterministic tests — 45° ram carves comparably to head-on at equal speed
(no REST misclassification), side-scrape pair separates within N steps, slow-drift press
separates, head-on behavior unchanged within tolerance; existing crush/overlap tests green;
in-browser: T-bone rams bite, no side-by-side sticking.

## SP3 — Handling: weighty but responsive

- **Inertia:** yaw added-mass factor 1.6 → ~1.3 (`game/ship.ts` box inertia).
- **Damping:** `TUN.phys.yawDamp` 0.6 → ~0.4 (final value from the turn-rate tests).
- **Rudder lever arm:** add a hull-length factor to rudder torque (physical: rudder force ×
  lever ∝ L) so authority scales with ship size instead of falling off with L². Calibrate so
  targets hit: **Cutter ~2–3 s to 90° at cruise, Frigate ~5–6 s**, monotonic in between
  (Sloop/Brig). Implementers pick the exact form (e.g. `torque ∝ mass·L·flow·gain`) and
  normalize `rudderGain` so the Cutter's current feel is the anchor.
- **Turn-heel:** re-verify `turnHeel`/`turnHeelMaxG`/`turnHeelCap` at the new turn rates —
  banks stay dramatic (~30–45° hard turn), capsize impossible in a clean turn.
- **THE LAW:** all changes are mass/inertia/force-model-side — no attitude clamps, no rate
  caps.
- **Pacing audit (report + light retune):** island spacing vs cruise speed, enemy spawn
  distance, reload cadence, time-to-kill at each tier. Deliver numbers + small tunable nudges;
  anything structural becomes a follow-up, not this round.

**Acceptance:** new deterministic per-tier turn-rate test (90° time within target band at
cruise, calm sea); stability tests still green (no capsize regression); heel behavior verified
in-browser.

## SP4 — Performance: cache what didn't change

No behavior changes — determinism suite must stay green, and each item is validated against
the `DEBUG.world.timing` HUD (before/after in a 4+-ship combat scene):

1. **Wave-field lattice cache** (`game/ship.ts` applyForces): rebuild the per-ship Gerstner
   lattice only on a movement threshold or every N substeps (~15 Hz), not per frame.
2. **Breach sea-heads from the cached lattice:** bilinear-interpolate breach surface heights
   instead of exact per-cell inversions; freeze the breach list when no carve has touched the
   ship for ~0.5 s.
3. **Hull ocean-profile cache:** `buildHullProfile` result cached on Ship, rebuilt on carve
   only; `render/ocean.ts` consumes the cache (kills the per-ship-per-frame full-grid scan).
4. **Pooling:** remesh BufferGeometry/typed-array pool (`render/shipVisual.ts`); carve
   heap + seen-set reuse across contact pairs (`sim/carve.ts` — pure module, pool must not
   break determinism); contact scratch preallocated to max hull size + cleared per step
   (`game/voxelContact.ts`); deck-collider re-sweep restricted to dirty chunks
   (`game/ship.ts`).

**Acceptance:** timing HUD shows buoy + flood + visual buckets down materially in the combat
scene; all tests green; no visible behavior change (float/trim/contact oracles unchanged).

## SP5 — Buoyancy: decouple, don't retune

- **Stiffness decoupling:** heave stiffness becomes `k = ρ·g·A_waterplane` (multiplier
  factored OUT); the damping coefficient is recalibrated (≈ 0.2·√1.5 ≈ 0.245 — verify by
  matching step response, not by trusting the algebra) so the in-game heave feel is
  **identical** at `buoyancy = 1.5`. After this, moving `buoyancy` no longer silently moves ζ.
- **Trim test:** new deterministic test — shifting ballast fore/aft produces the right-signed,
  sensible-magnitude equilibrium pitch (closes the known blind spot).
- **Docs:** fix LAW #3 in CLAUDE.md (lateral drag applies at the center of buoyancy, below
  COM — that offset is what rights her and banks turns); document the buoyancy-multiplier
  finding.
- **Not this round:** returning `buoyancy` to 1.0 (Josh chose keep-feel). The decoupling makes
  that a clean single-knob experiment later.

**Acceptance:** draft/float/stability tests green with unchanged expectations; new trim test;
heave step-response before/after match (test or scripted check).

## Cleanup (rides along, wave 2)

- Delete dead knobs `TUN.flood.render.skirtDepth`/`blendBand` + their dev-panel sliders;
  remove the unwired `surfaceBandVoxels` export (or the file, with a memory-note).
- Extract from `main.ts`: aim-arc UI (`render/aimUI.ts`), cutaway controller, ship-swap flow
  (`game/shipSwap.ts`). Pure moves, no behavior change.
- CLAUDE.md round-12 note + LAW #3 fix.

## Orchestration: two file-disjoint waves

Concurrent agents own disjoint files, each builds + tests + commits **only its own paths**,
push per wave (per the standing SCUTTLE multi-agent workflow + hub-file commingling memory).

**Wave 1**
| Agent | Sub-project | Owns |
|---|---|---|
| A | SP2 collision | `game/voxelContact.ts`, `sim/voxelOverlap.ts`, `sim/crush.ts`, `sim/carve.ts` (incl. its SP4 pooling), their tests |
| B | SP1 sails | `render/sailVisual.ts` (new), `render/shipVisual.ts` (incl. its SP4 buffer pool), `render/voxelMesher.ts`, `game/debris.ts`, their tests |
| C | SP4+SP5 ship core | `game/ship.ts` (caches, breach freeze, deck-collider chunks, stiffness decoupling), `sim/buoyancy.ts` (profile cache), `render/ocean.ts` (consume cache), trim test |

Shared-file rules, wave 1: `core/tunables.ts` and `game/ship.ts` belong to C (A and B must
not edit them — if B needs a Ship hook, it defines the interface in its own file and C or
wave 2 wires it); `main.ts` is frozen except one-line wiring, applied by agent B only (sails
will likely need a per-frame wind/sail-set uniform push). B may READ exported game-layer
state (`sailing.sailSet`, the `wind` object) but not edit `sailing.ts`; a render-side billow
factor computed from wind + heading is acceptable (visual-only, need not bit-match physics).

**Wave 2** (starts only when wave 1 is green + pushed)
| Agent | Sub-project | Owns |
|---|---|---|
| D | SP3 handling + pacing | `game/ship.ts` (inertia), `game/sailing.ts`, `core/tunables.ts`, `sim/fleetSpawn.ts`/`sim/islandwright.ts` (audit), turn-rate tests |
| E | Cleanup | `main.ts` extractions, dead knobs/exports, CLAUDE.md |

**Verification per wave:** `npm run build` + `npm run test` green per agent before commit
(vitest does NOT type-check — build is mandatory); after each wave, an in-browser pass
(Playwright at :5173: timing HUD numbers, sail visuals, ram scenarios) before hand-off;
commit + push to `main` so Josh playtests on Vercel. Test-flake note: brig/frigate symmetric
tests false-fail under CPU load — rerun isolated before declaring red.

## Non-goals (round 12)

- No soft-body cloth sim; no crush architecture rewrite; no buoyancy feel change; no
  Web-Worker/SharedArrayBuffer physics (future — needs COOP/COEP for Vercel); no world-scale
  restructuring (pacing audit reports first).
