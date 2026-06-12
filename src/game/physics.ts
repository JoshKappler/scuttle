import RAPIER from "@dimforge/rapier3d-compat";
import { FIXED_DT, G } from "../core/constants";

/** Rapier bootstrap (compat build: WASM embedded, no asset wiring needed). */
export interface Physics {
  world: RAPIER.World;
  RAPIER: typeof RAPIER;
}

export async function initPhysics(): Promise<Physics> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.timestep = FIXED_DT;
  return { world, RAPIER };
}
