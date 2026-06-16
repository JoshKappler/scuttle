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

  const shipBodies = new Set<number>();
  const terrainBodies = new Set<number>();
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

  return { world, RAPIER, shipBodies, terrainBodies, hooks, events };
}
