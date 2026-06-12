import * as THREE from "three";
import { FIXED_DT } from "../core/constants";
import type { Wave } from "../sim/gerstner";
import type { Physics } from "./physics";
import { Ship } from "./ship";

/**
 * Game orchestration: owns ships, runs the fixed-step physics loop with an
 * accumulator, and keeps a deterministic simulation clock (simTime) that the
 * ocean shader and wave sampling share so render and physics never disagree.
 */
export class GameWorld {
  readonly ships: Ship[] = [];
  simTime = 0;
  /** Called every fixed step after buoyancy, before the physics step —
   *  sailing forces, AI, projectiles hook in here. */
  onFixedStep?: (simTime: number, dt: number) => void;
  private accumulator = 0;

  constructor(
    private physics: Physics,
    readonly waves: Wave[],
    readonly scene: THREE.Scene,
  ) {}

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
        ship.applyForces(this.waves, this.simTime, () => 0); // flooding lands in plan Task 11
      }
      this.onFixedStep?.(this.simTime, FIXED_DT);
      this.physics.world.step();
    }
    for (const ship of this.ships) {
      ship.visual.refresh();
      ship.syncVisual();
    }
  }
}
