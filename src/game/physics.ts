import RAPIER from "@dimforge/rapier3d-compat";
import { FIXED_DT, G } from "../core/constants";

/** Rapier bootstrap (compat build: WASM embedded, no asset wiring needed). */
export interface Physics {
  world: RAPIER.World;
  RAPIER: typeof RAPIER;
  /** Rigid-body handles of every live ship. A contact pair where BOTH bodies are ships is pulled
   *  OUT of Rapier's rigid solver (the hook below returns null), so the deformable voxelContact
   *  owns the ship-vs-ship response — it lets the hulls interpenetrate (so the real voxel overlap
   *  is visible to carve), then carves + resolves non-penetration itself. Ships must remove their
   *  handle here on despawn (handles are recycled by Rapier). */
  shipBodies: Set<number>;
  /** Rigid-body handles of every static terrain piece (islands, cliffs, sea stacks). A contact
   *  pair where one body is a ship and the other is terrain is ALSO pulled out of Rapier's rigid
   *  solver (the hook returns null), so the hull interpenetrates and game/voxelContact.ts erodes
   *  the ship against the terrain (an immovable, indestructible hull). Character/debris vs terrain
   *  still solve rigidly — neither is a ship — so the captain still walks the dock. */
  terrainBodies: Set<number>;
  /** Rigid-body handles of felled-mast debris. A ship↔mast-debris pair is pulled OUT of Rapier's
   *  rigid solver (the hook returns null): a felled mast spawns DEEP inside the hull it tore off
   *  (a tall thin column overlapping the standing trunk), and the solver's penetration recovery on
   *  that overlap flung the unclamped debris body hundreds of metres into the sky. Its landing damage
   *  is applied by a manual voxel-crush probe (game/debris.mastLandingDamage), not the solver, so
   *  skipping the rigid contact loses nothing — it just stops the launch. The captain still walks it
   *  (the KCC query is separate from the solver). Cleared on despawn (handles are recycled). */
  debrisBodies: Set<number>;
  /** Passed to world.step each fixed step. Only fires for pairs involving a collider that has
   *  ActiveHooks.FILTER_CONTACT_PAIRS set (we set it on hull colliders), so the common case
   *  (no ships touching) costs nothing. */
  hooks: RAPIER.PhysicsHooks;
  /** GOTCHA (rapier3d-compat 0.19): the pipeline only wires `hooks` when an EventQueue is ALSO
   *  passed to world.step — `world.step(undefined, hooks)` silently runs WITHOUT the hooks.
   *  So we keep a persistent queue and always pass it. We don't read events; it auto-clears. */
  events: RAPIER.EventQueue;
}

export async function initPhysics(): Promise<Physics> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.timestep = FIXED_DT;
  // The constraint solver is ~60% of the per-frame CPU budget at a full fleet, and its cost is
  // ~linear in the iteration count (Rapier default 4). Ship-vs-ship is pulled OUT of the rigid
  // solver entirely (filterContactPair above), so the only contacts this solver still resolves are
  // forgiving ones — hull↔static-island, hull↔debris, deck↔character — none of which is a tall
  // dynamic stack that needs 4 iterations to stay rigid. Halving to 2 is the single biggest CPU
  // lever and does NOT touch the deterministic sim/ oracle (that's a separate pure layer). Bump to
  // 3 if a resting contact (the captain on a heeled deck) ever reads mushy.
  world.numSolverIterations = 2;

  const shipBodies = new Set<number>();
  const terrainBodies = new Set<number>();
  const debrisBodies = new Set<number>();
  const hooks: RAPIER.PhysicsHooks = {
    filterContactPair(_c1, _c2, body1, body2) {
      // Generate NO rigid contact for ship↔ship AND ship↔terrain: voxelContact reads the real voxel
      // overlap (which needs the bodies to actually interpenetrate) and applies its own carve + hard
      // position de-penetration + inelastic cancel. Returning null is what lets them overlap enough
      // to crunch instead of Rapier rigidly shoving them apart first.
      if (body1 !== body2) {
        const s1 = shipBodies.has(body1), s2 = shipBodies.has(body2);
        if (s1 && s2) return null; // ship ↔ ship
        if ((s1 && terrainBodies.has(body2)) || (s2 && terrainBodies.has(body1))) return null; // ship ↔ terrain
        if ((s1 && debrisBodies.has(body2)) || (s2 && debrisBodies.has(body1))) return null; // ship ↔ felled-mast debris
      }
      // everything else (terrain↔character, terrain↔debris, hull↔debris, hull↔player, …) solves normally.
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair() {
      return true;
    },
  };

  // see Physics.events: required for `hooks` to actually fire in this Rapier build.
  const events = new RAPIER.EventQueue(true);

  return { world, RAPIER, shipBodies, terrainBodies, debrisBodies, hooks, events };
}
