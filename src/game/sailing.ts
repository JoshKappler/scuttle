import * as THREE from "three";
import type { Ship } from "./ship";

/**
 * Wind + sail thrust + rudder. Arcade-tuned but honest in shape: no thrust
 * in irons (bow into the wind), peak power on a broad reach, thrust applied
 * at the mast base so beam winds heel the ship.
 */
export interface Wind {
  dirX: number; // direction the wind blows TOWARD (unit)
  dirZ: number;
  speed: number; // m/s
}

export class SailingController {
  sailSet = 0.7; // 0..1
  rudder = 0; // -1..1 (+ = turn to port)

  private tmpQ = new THREE.Quaternion();
  private tmpF = new THREE.Vector3();

  /** Current forward speed (m/s, signed) for the HUD. */
  speed = 0;
  /** Angle off the wind in degrees (0 = in irons) for the HUD. */
  angleOffWind = 0;

  apply(ship: Ship, wind: Wind): void {
    const body = ship.body;
    const rot = body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    const fwd = this.tmpF.set(1, 0, 0).applyQuaternion(this.tmpQ);
    fwd.y = 0;
    fwd.normalize();

    const v = body.linvel();
    this.speed = v.x * fwd.x + v.z * fwd.z;

    // angle between bow and the direction the wind comes FROM
    const fromX = -wind.dirX;
    const fromZ = -wind.dirZ;
    const cosA = fwd.x * fromX + fwd.z * fromZ;
    const a = Math.acos(Math.min(Math.max(cosA, -1), 1));
    this.angleOffWind = (a * 180) / Math.PI;

    // 0 in irons (±30°), rising to 1 at ~110-150°, slightly less dead downwind
    const deg = this.angleOffWind;
    let wf = 0;
    if (deg > 28) {
      const x = Math.min((deg - 28) / 82, 1); // 28°..110° ramp
      const runFade = deg > 150 ? 1 - ((deg - 150) / 30) * 0.25 : 1;
      wf = Math.pow(Math.sin((x * Math.PI) / 2), 1.2) * runFade;
    }

    // thrust ∝ wind pressure on set canvas; tuned for ~7-8 m/s top speed
    const mass = body.mass();
    // arcade-tuned: ~12 m/s (23 kn) at full sail on a reach — playtest verdict
    // was that realistic hull speeds are no fun
    const thrust = this.sailSet * wf * wind.speed * wind.speed * mass * 0.016;

    if (thrust > 0 && ship.submergedFrac > 0.02) {
      // applied at the mast base: beam reaches heel the ship
      const m = ship.build.masts[0];
      const ap = ship.localToWorld(
        [(m.x + 0.5) * 0.25, (ship.build.deckY + 1) * 0.25, (m.z + 0.5) * 0.25],
        this.tmpF.clone(),
      );
      body.addForceAtPoint({ x: fwd.x * thrust, y: 0, z: fwd.z * thrust }, ap, true);
    }

    // rudder: yaw torque scales with water flow over it, with a small
    // low-speed floor so you can work the bow out of irons (arcade concession)
    const flow = Math.sign(this.speed || 1) * (0.8 + Math.abs(this.speed));
    const yaw = this.rudder * flow * mass * 0.5;
    body.addTorque({ x: 0, y: yaw, z: 0 }, true);
  }
}
