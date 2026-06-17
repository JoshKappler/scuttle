import * as THREE from "three";
import { decideAI } from "../sim/aiBrain";
import type { Wave } from "../sim/gerstner";
import type { Effects } from "../render/effects";
import { Cannons } from "./cannons";
import { SailingController, type Wind } from "./sailing";
import type { Ship } from "./ship";

/**
 * Adapter between the pure AI brain and the live world: builds the brain's
 * view from physics state, applies its decision through a SailingController
 * and the captain's own cannon battery.
 *
 * Rudder convention note: sailing.rudder + = port turn; the brain's
 * rudderSign + = "turn starboard" — hence the sign flip.
 */
export class AICaptain {
  readonly sailing = new SailingController();
  readonly cannons: Cannons;
  private tmpQ = new THREE.Quaternion();
  // reused per update() instead of allocating two Vector3 per enemy per fixed step
  private tmpRel = new THREE.Vector3();
  private tmpWind = new THREE.Vector3();
  private accuracyJitter: number;
  // the broadside the brain is currently committed to presenting (-1 port,
  // +1 starboard, 0 = not yet engaged). Carried across ticks so the beam
  // choice has hysteresis and doesn't thrash side to side.
  private committedBeam: -1 | 0 | 1 = 0;

  constructor(
    public readonly ship: Ship,
    scene: THREE.Scene,
    effects: Effects,
    jitterDeg = 2.5,
  ) {
    // the AI crew is deliberately WORSE than yours: slower reloads, slower
    // helm, leaner sail trim, wider shot spread — aggressive but beatable
    // (round 6: "both of the ships are so equally matched … nerf the enemy")
    this.cannons = new Cannons(scene, effects, 9.5);
    // a touch quicker than round 6's 0.82 so she can actually keep station and
    // hunt rather than fall astern and drift off (round 10)
    this.sailing.efficiency = 0.9;
    this.accuracyJitter = jitterDeg;
  }

  update(dt: number, t: number, waves: Wave[], wind: Wind, target: Ship): void {
    const tr = this.ship.body.translation();
    const rot = this.ship.body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w).invert();
    const tt = target.body.translation();
    const rel = this.tmpRel.set(tt.x - tr.x, 0, tt.z - tr.z).applyQuaternion(this.tmpQ);
    const range = Math.hypot(rel.x, rel.z);
    const bearingDeg = (Math.atan2(rel.z, rel.x) * 180) / Math.PI;

    let worstFlood = 0;
    for (const c of this.ship.build.compartments) {
      worstFlood = Math.max(worstFlood, c.waterVolume / c.volume);
    }

    // bearing of the wind's source in ship frame
    const wrel = this.tmpWind.set(-wind.dirX, 0, -wind.dirZ).applyQuaternion(this.tmpQ);
    const windBearingDeg = (Math.atan2(wrel.z, wrel.x) * 180) / Math.PI;

    const d = decideAI({
      range,
      bearingDeg,
      angleOffWindDeg: this.sailing.angleOffWind,
      windBearingDeg,
      floodFrac: worstFlood,
      // ready when the broadside that's actually pointing at the target (its
      // side in ship frame) is mostly loaded
      reloadReady: this.cannons.sideReadiness(this.ship, rel.z >= 0 ? 1 : -1, t) >= 0.99,
      committedBeam: this.committedBeam,
    });
    this.committedBeam = d.committedBeam; // carry the beam commitment forward

    this.sailing.sailSet = d.sailSet;
    const rudderTarget = -d.rudderSign; // convention flip (see header)
    if (d.rudderSign === 0) {
      this.sailing.rudder *= Math.max(1 - dt * 3, 0);
    } else {
      this.sailing.rudder = Math.min(Math.max(this.sailing.rudder + rudderTarget * dt * 1.4, -1), 1);
    }
    this.sailing.apply(this.ship, wind);

    if (d.fire) {
      const side = d.fire === "starboard" ? 1 : -1;
      const elevation =
        Math.min(Math.max((range / 90) * 6, 0.2), 8) + (Math.random() - 0.5) * 2 * this.accuracyJitter;
      this.cannons.fireBroadside(this.ship, side, t, elevation);
    }
    this.cannons.update(dt, t, waves, [target]);
  }
}
