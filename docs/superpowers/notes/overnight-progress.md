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

## M4+ (next plan docs, not started)

Boarding + melee (weapons/armor, ragdolls, blood), gold chests (physical,
carryable), swimming/diving + wreck salvage, sharks, ship-stealing, ports +
upgrades + parrot, roguelite run + leaderboard + daily seed. Spec:
`docs/superpowers/specs/2026-06-12-scuttle-design.md` (user-approved).
Start M4 from the char-spike findings (`notes/char-spike.md`): per-chunk
trimesh colliders rebuilt on damage, swim state, lateral-drift fix.

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
