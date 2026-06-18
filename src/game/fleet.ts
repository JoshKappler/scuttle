import type * as THREE from "three";
import type { Wave } from "../sim/gerstner";
import type { Wind } from "./sailing";
import type { AICaptain } from "./ai";
import type { Ship } from "./ship";
import { TUN } from "../core/tunables";
import { MAXVIS } from "../core/constants";
import { isFoundered, SINK_OUT_GRACE_STEPS } from "./foundering";

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
  /** fixed steps a declared wreck keeps descending (in-world) before its geometry is disposed.
   *  Defaults to {@link SINK_OUT_GRACE_STEPS}; exposed mainly so tests can shorten it. */
  sinkOutGrace?: number;
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

  private readonly world: FleetWorld;
  private target: Ship; // the player ship — reassigned when the player swaps hulls
  private readonly spawn: () => EnemyUnit;
  private readonly isWreck: (ship: Ship) => boolean;
  private readonly maxVis: number;
  /** Declared wrecks living out their continued-descent grace (see {@link SINK_OUT_GRACE_STEPS}): each
   *  has LEFT `units` (so a replacement already spawned + it's off the AI/LOD/despawn lists) but is
   *  STILL in the world, so world.step keeps flooding + sinking it. `ticks` counts DOWN each reconcile;
   *  at 0 the geometry is finally disposed. Kept off `units`/`enemies` so a foundering carcass is never
   *  treated as a live foe. */
  private readonly sinkingOut: { unit: EnemyUnit; ticks: number }[] = [];
  /** How many steps a freshly-declared wreck lingers + keeps descending before disposal. Injectable so
   *  the unit test can pin it; defaults to the tuned {@link SINK_OUT_GRACE_STEPS}. */
  private readonly sinkOutGrace: number;

  constructor(opts: FleetOptions) {
    this.world = opts.world;
    this.target = opts.target;
    this.spawn = opts.spawn;
    // A ship is a wreck only when it has genuinely FOUNDERED — deep under AND waterlogged, or
    // fully saturated outright. The old pure y<-12 check fired on transients: a ram's de-pen shove,
    // a heeling hull whose grid-corner origin swings low, or a deep swell trough — so a still-afloat
    // victim got replaced before it sank. `waterlog` only climbs after a compartment is ~90% full,
    // so it's a true sinking signal. (De-pen is now horizontal too, removing the shove path.)
    this.isWreck = opts.isWreck ?? isFoundered;
    this.maxVis = opts.maxVis ?? MAXVIS;
    this.sinkOutGrace = opts.sinkOutGrace ?? SINK_OUT_GRACE_STEPS;
  }

  /** Re-point the fleet at a freshly-built player ship (after a hull swap). */
  setTarget(ship: Ship): void {
    this.target = ship;
  }

  /** Living + sinking enemy ships, in spawn order. */
  get enemies(): Ship[] {
    return this.units.map((u) => u.ship);
  }

  /** Drop a unit from the LIVE roster (units list + premium-LOD slot) WITHOUT touching the world —
   *  so it stops being a foe/AI/LOD/despawn candidate, but its body + visual stay alive for now. */
  private dropFromUnits(unit: EnemyUnit): void {
    const i = this.units.indexOf(unit);
    if (i >= 0) this.units.splice(i, 1);
    if (this.premiumEnemy === unit.ship) this.premiumEnemy = null;
  }

  /** Final teardown: pull the unit from the live roster (if still there) and dispose its body +
   *  visual via the world. Used for an immediate cull (off-screen despawn) — the sinking-out grace
   *  path disposes a sunk wreck the same way once its descent timer expires. */
  private remove(unit: EnemyUnit): void {
    this.dropFromUnits(unit);
    this.world.removeShip(unit.ship);
  }

  /** One step of population control: declare foundered wrecks (handing them to the continued-descent
   *  grace instead of disposing on the spot), advance + retire those sinking-out carcasses, then move
   *  the live count ONE toward the target (so a big slider drag never hitches). */
  reconcile(): void {
    // 1. DECLARE every freshly-foundered wreck. Don't dispose it on the spot — that's the "pops out of
    //    existence" blink (the tall masts, the last thing showing, vanish the same frame). Instead drop
    //    it from the LIVE roster (so a replacement spawns this same reconcile + it leaves the AI/LOD
    //    lists) but keep its body in the world and hand it to `sinkingOut`, where world.step keeps
    //    flooding + sinking it for a few seconds so she slides fully under and the masts dip last.
    for (let i = this.units.length - 1; i >= 0; i--) {
      const unit = this.units[i];
      if (this.isWreck(unit.ship)) {
        this.dropFromUnits(unit);
        this.sinkingOut.push({ unit, ticks: this.sinkOutGrace });
      }
    }

    // 2. age the sinking-out carcasses; dispose each once it has descended out its grace window. (The
    //    ship keeps stepping/sinking in world.step the whole time — nothing freezes it here.)
    for (let i = this.sinkingOut.length - 1; i >= 0; i--) {
      if (--this.sinkingOut[i].ticks <= 0) {
        const { unit } = this.sinkingOut[i];
        this.sinkingOut.splice(i, 1);
        this.world.removeShip(unit.ship);
      }
    }

    // 3. step the live count one toward the (clamped) target. A wreck declared in step 1 has already
    //    left `units`, so its replacement is spawned here on the SAME reconcile — foes appear no later
    //    than before; only the sunk carcass lingers (out of the live count) while it founders away.
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

  /** The farthest unit from the player. */
  private farthestDespawnable(): EnemyUnit | null {
    const p = this.target.body.translation();
    let best: EnemyUnit | null = null;
    let bestD = -1;
    for (const u of this.units) {
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
