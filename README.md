# SCUTTLE ⚓

*A browser pirate roguelite where the ships are real.*

Every hull is a voxel structure simulated for real: cannonballs knock out
actual voxels, breaches below the waterline flood watertight compartments by
Bernoulli's law, flooded water bears as weight where it pools — so ships
list, trim by the bow, downflood through deck hatches, and sink **emergently.
Nothing is animated; everything is physics.**

Built with TypeScript, Three.js, and Rapier. No engine, no login, no
download — it runs in the browser tab.

## Status

**Milestones M1 ("It floats") + M2 ("It sinks") complete:**

- Gerstner-wave ocean — one set of wave equations drives both the GPU water
  shader and CPU physics sampling (exact agreement, tested)
- Procedural voxel sloop with watertight compartments, hatches, keel ballast
- Probe-based Archimedes buoyancy on a single rigid body per ship — floating,
  heeling, and capsizing all emerge from the solver
- Wind sailing (no-go zone, broad-reach power band, heel under beam wind)
- Broadside cannons → voxel destruction → severed sections break off as
  floating debris
- Progressive compartment flooding with accelerating inflow, bulkhead-hole
  spread, deck-hatch downflooding past coamings, and cutaway X-ray view (X)
- Character-on-deck spike: a kinematic capsule that stays planted on a
  rolling, turning, sinking deck (boarding combat groundwork)

62 unit tests on the pure simulation core, including a hydrostatic-stability
regression that computes metacentric righting torque directly from the
buoyancy model.

## Run it

```bash
npm install
npm run dev
```

W/S sails · A/D rudder · F broadside · X cutaway · drag to orbit · wheel zoom
· `?spike=char` for the deck-walking spike (IJKL/U)

## Where it's going

Cannon duels against AI captains, then boarding: arcade sword fights on
listing decks, physical gold chests, ship-stealing, swimming and diving to
sunken wrecks, ports with upgrade trees — a seeded roguelite voyage with a
daily-run leaderboard. Design docs live in `docs/superpowers/specs/`.
