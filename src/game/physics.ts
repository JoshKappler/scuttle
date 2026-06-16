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
  const hooks: RAPIER.PhysicsHooks = {
    filterContactPair(_c1, _c2, body1, body2) {
      // Two distinct ships: generate NO rigid contact. voxelContact reads the real voxel overlap
      // (which needs the hulls to actually interpenetrate) and applies its own carve + hard
      // position-based de-penetration + inelastic velocity cancel. Returning null is what lets the
      // hulls overlap enough to crunch instead of Rapier rigidly shoving them apart first.
      if (body1 !== body2 && shipBodies.has(body1) && shipBodies.has(body2)) return null;
      // everything else (hull↔debris, hull↔player, deck↔character, …) solves normally.
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
