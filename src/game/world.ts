import * as THREE from "three";
import { FIXED_DT } from "../core/constants";
import { physicsWaves, type Wave } from "../sim/gerstner";
import type { Physics } from "./physics";
import { Ship } from "./ship";
import { VoxelContact } from "./voxelContact";

/**
 * Game orchestration: owns ships, runs the fixed-step physics loop with an
 * accumulator, and keeps a deterministic simulation clock (simTime) that the
 * ocean shader and wave sampling share so render and physics never disagree.
 *
 * Hull forces and flooding sample the LONG-WAVELENGTH subset of the sea
 * (physicsWaves): the ship rides the swell while the visual chop slides
 * under her — that's the round-8 "substantial" feel. Anything answering
 * "where is the VISIBLE surface" (swimmers, splashes, the camera) keeps
 * using the full set.
 */
export class GameWorld {
  readonly ships: Ship[] = [];
  /** The deformable ship-vs-ship contact (replaces the rigid-reaction path). main.ts may
   *  attach `.effects` for pulverization dust + read `.debug` for the tuning harness. */
  readonly contact = new VoxelContact();
  simTime = 0;
  /** Called every fixed step after buoyancy, before the physics step —
   *  sailing forces, AI, projectiles hook in here. */
  onFixedStep?: (simTime: number, dt: number) => void;
  private accumulator = 0;
  private readonly physWaves: Wave[];

  constructor(
    private physics: Physics,
    readonly waves: Wave[],
    readonly scene: THREE.Scene,
  ) {
    this.physWaves = physicsWaves(waves);
  }

  addShip(ship: Ship): void {
    this.ships.push(ship);
    this.scene.add(ship.visual.group);
  }

  /** Remove a ship: drop it from the sim list, the scene (disposing its visual
   *  geometry/materials), and the Rapier world (which also frees its colliders).
   *  Used by the FleetManager for despawn + sunk-wreck cleanup. No-op if absent. */
  removeShip(ship: Ship): void {
    const i = this.ships.indexOf(ship);
    if (i === -1) return;
    this.ships.splice(i, 1);
    this.scene.remove(ship.visual.group);
    ship.visual.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
    this.physics.shipBodies.delete(ship.body.handle); // handles are recycled — drop the stale one
    this.physics.world.removeRigidBody(ship.body);
  }

  /** Advance simulation by real dt (seconds), in fixed steps (max 5/frame). */
  step(dt: number): void {
    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * 5);
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this.simTime += FIXED_DT;
      for (const ship of this.ships) {
        ship.updateFlooding(FIXED_DT, this.physWaves, this.simTime);
        ship.applyForces(this.physWaves, this.simTime);
      }
      this.onFixedStep?.(this.simTime, FIXED_DT);
      // deformable ship-vs-ship crunch: reads the real voxel overlap, applies the capped
      // penalty push, and carves both hulls at the contact (sets damageDirty for flushDamage).
      this.contact.stepAll(this.ships, FIXED_DT);
      for (const ship of this.ships) ship.flushDamage(); // throttled heavy damage recompute
      // hooks: filterContactPair pulls ship-vs-ship pairs out of the rigid solver (physics.ts).
      // The EventQueue is REQUIRED for the hooks to fire in this Rapier build (see Physics.events).
      this.physics.world.step(this.physics.events, this.physics.hooks);
    }
    for (const ship of this.ships) {
      ship.visual.refresh();
      // syncVisual FIRST: the flood fluid reads the ship group's world
      // transform to hold its surfaces world-level and clip them to the heeled
      // hull, so the group must carry the fresh body transform before
      // updateWater runs. (No camera is available at this seam — the fluid
      // shades from straight above when none is passed.)
      ship.syncVisual();
      ship.visual.updateWater(ship.build.compartments, undefined, dt);
    }
  }
}
