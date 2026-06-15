import type * as THREE from "three";
import type { Wave } from "../sim/gerstner";
import type { Wind } from "./sailing";
import type { AICaptain } from "./ai";
import type { Ship } from "./ship";
import { TUN } from "../core/tunables";
import { MAXVIS } from "../core/constants";

/** One hostile unit: a ship and the AI captain that sails + fires her. */
export interface EnemyUnit {
  ship: Ship;
  captain: AICaptain;
}

/** The slice of GameWorld the fleet needs — kept narrow so the manager is
 *  unit-testable against a stub. */
export interface FleetWorld {
  addShip(ship: Ship): void;
  removeShip(ship: Ship): void;
}

export interface FleetOptions {
  world: FleetWorld;
  /** the player ship — distance reference for despawn + AI target. */
  target: Ship;
  /** builds one ship + captain, positioned in the world but NOT yet added. */
  spawn: () => EnemyUnit;
  /** true once a ship has foundered below the sea and should be culled. */
  isWreck?: (ship: Ship) => boolean;
  maxVis?: number;
}

/**
 * Owns the hostile fleet: keeps the live count reconciled to TUN.fleet.enemyCount
 * (spawning one ship per step, despawning the farthest, culling + auto-replacing
 * sunk wrecks), drives every captain at the player, and ranks ships by camera
 * distance to expose the nearest as the premium-LOD ship.
 */
export class FleetManager {
  readonly units: EnemyUnit[] = [];
  /** nearest living enemy (with hysteresis) — gets the premium ocean slot 1. */
  premiumEnemy: Ship | null = null;
  /** set by the caller to the grappled ship so reconcile won't despawn it. */
  boardingTarget: Ship | null = null;

  private readonly world: FleetWorld;
  private target: Ship; // the player ship — reassigned when the player swaps hulls
  private readonly spawn: () => EnemyUnit;
  private readonly isWreck: (ship: Ship) => boolean;
  private readonly maxVis: number;

  constructor(opts: FleetOptions) {
    this.world = opts.world;
    this.target = opts.target;
    this.spawn = opts.spawn;
    // A ship is a wreck only when it has genuinely FOUNDERED — deep under AND waterlogged, or
    // fully saturated outright. The old pure y<-12 check fired on transients: a ram's de-pen shove,
    // a heeling hull whose grid-corner origin swings low, or a deep swell trough — so a still-afloat
    // victim got replaced before it sank. `waterlog` only climbs after a compartment is ~90% full,
    // so it's a true sinking signal. (De-pen is now horizontal too, removing the shove path.)
    this.isWreck = opts.isWreck ?? ((s) => (s.body.translation().y < -12 && s.waterlog > 0.05) || s.waterlog >= 0.45);
    this.maxVis = opts.maxVis ?? MAXVIS;
  }

  /** Re-point the fleet at a freshly-built player ship (after a hull swap). */
  setTarget(ship: Ship): void {
    this.target = ship;
  }

  /** Living + sinking enemy ships, in spawn order. */
  get enemies(): Ship[] {
    return this.units.map((u) => u.ship);
  }

  private remove(unit: EnemyUnit): void {
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
    if (this.premiumEnemy === unit.ship) this.premiumEnemy = null;
    this.world.removeShip(unit.ship);
  }

  /** One step of population control: cull foundered wrecks, then move the live
   *  count ONE toward the target (so a big slider drag never hitches). */
  reconcile(): void {
    // 1. cull every foundered wreck (the auto-replace foundation).
    for (let i = this.units.length - 1; i >= 0; i--) {
      if (this.isWreck(this.units[i].ship)) this.remove(this.units[i]);
    }

    // 2. step the live count one toward the (clamped) target.
    const want = Math.max(0, Math.min(this.maxVis, Math.round(TUN.fleet.enemyCount)));
    if (this.units.length < want) {
      const unit = this.spawn();
      this.world.addShip(unit.ship);
      this.units.push(unit);
    } else if (this.units.length > want) {
      const victim = this.farthestDespawnable();
      if (victim) this.remove(victim);
    }
  }

  /** The farthest unit from the player that isn't the boarding target. */
  private farthestDespawnable(): EnemyUnit | null {
    const p = this.target.body.translation();
    let best: EnemyUnit | null = null;
    let bestD = -1;
    for (const u of this.units) {
      if (u.ship === this.boardingTarget) continue;
      const t = u.ship.body.translation();
      const d = (t.x - p.x) ** 2 + (t.z - p.z) ** 2;
      if (d > bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** Drive every captain to sail + fire at the player. */
  updateAI(dt: number, t: number, waves: Wave[], wind: Wind): void {
    for (const u of this.units) u.captain.update(dt, t, waves, wind, this.target);
  }

  /** Recompute the nearest living enemy (the premium-LOD ship) relative to the
   *  camera, with a 15% hysteresis band so it doesn't thrash between two ships
   *  at similar range (which would pop the wake ribbon). */
  rankLOD(cameraPos: THREE.Vector3): void {
    let best: Ship | null = null;
    let bestD = Infinity;
    for (const u of this.units) {
      const t = u.ship.body.translation();
      const d = (t.x - cameraPos.x) ** 2 + (t.z - cameraPos.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = u.ship;
      }
    }
    const cur = this.premiumEnemy;
    if (cur && this.enemies.includes(cur) && best) {
      const t = cur.body.translation();
      const dCur = (t.x - cameraPos.x) ** 2 + (t.z - cameraPos.z) ** 2;
      // keep the incumbent unless the new best is >15% closer. 1.32 in squared
      // distance ≈ 1.15× linear (sqrt(1.32) ≈ 1.149).
      if (dCur <= bestD * 1.32) return;
    }
    this.premiumEnemy = best;
  }
}
