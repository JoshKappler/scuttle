import * as THREE from "three";
import { FIXED_DT } from "../core/constants";
import { physicsWaves, type Wave } from "../sim/gerstner";
import type { Physics } from "./physics";
import { Ship } from "./ship";

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
      this.physics.world.step();
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
