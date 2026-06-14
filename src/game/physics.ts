import RAPIER from "@dimforge/rapier3d-compat";
import { FIXED_DT, G } from "../core/constants";

/** Rapier bootstrap (compat build: WASM embedded, no asset wiring needed). */
export interface Physics {
  world: RAPIER.World;
  RAPIER: typeof RAPIER;
  /** Rigid-body handles of every live ship. A contact pair where BOTH bodies are ships is
   *  pulled OUT of Rapier's rigid solver (the hook below returns null), so the deformable
   *  voxelContact owns the ship-vs-ship response — mutual crunch, not rigid plow-and-shove.
   *  Ships must remove their handle here on despawn (handles are recycled by Rapier). */
  shipBodies: Set<number>;
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
  const hooks: RAPIER.PhysicsHooks = {
    filterContactPair(_c1, _c2, body1, body2) {
      // Two distinct ship hulls: generate NO rigid contact. voxelContact reads the real voxel
      // overlap itself and applies a soft, capped, carve-bled response — returning null here
      // is what stops Rapier from rigidly shoving them apart before they can crunch.
      if (body1 !== body2 && shipBodies.has(body1) && shipBodies.has(body2)) return null;
      // everything else (hull↔debris, hull↔player, …) solves normally.
      return RAPIER.SolverFlags.COMPUTE_IMPULSE;
    },
    filterIntersectionPair() {
      return true;
    },
  };

  // see Physics.events: required for `hooks` to actually fire in this Rapier build.
  const events = new RAPIER.EventQueue(true);

  return { world, RAPIER, shipBodies, hooks, events };
}
