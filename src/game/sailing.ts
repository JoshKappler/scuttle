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

    // near-zero in irons (±24°), rising to 1 at ~105-150°. A small steerage
    // floor remains even in irons so you're never anchored bow-to-wind
    // (playtest: "essentially anchored" — no fun)
    const deg = this.angleOffWind;
    let wf = 0.08;
    if (deg > 24) {
      const x = Math.min((deg - 24) / 81, 1);
      const runFade = deg > 150 ? 1 - ((deg - 150) / 30) * 0.25 : 1;
      wf = Math.max(Math.pow(Math.sin((x * Math.PI) / 2), 1.2) * runFade, 0.08);
    }

    // thrust ∝ wind pressure on set canvas; tuned for ~7-8 m/s top speed
    const mass = body.mass();
    // arcade-tuned: ~12 m/s (23 kn) at full sail on a reach — playtest verdict
    // was that realistic hull speeds are no fun
    const thrust = this.sailSet * wf * wind.speed * wind.speed * mass * 0.016;

    if (thrust > 0 && ship.submergedFrac > 0.02) {
      // applied at COM height: thrust above the COM pitched the bow under at
      // speed (playtest: "front heavy… clips beneath the waves"). Heel still
      // comes from the keel's lateral resistance in turns.
      const m = ship.build.masts[0];
      const ap = ship.localToWorld(
        [(m.x + 0.5) * 0.25, ship.comLocal[1], (m.z + 0.5) * 0.25],
        this.tmpF.clone(),
      );
      body.addForceAtPoint({ x: fwd.x * thrust, y: 0, z: fwd.z * thrust }, ap, true);
    }

    // rudder: yaw torque scales with water flow over it, with a generous
    // low-speed floor so you can always work the bow off the wind
    const flow = Math.sign(this.speed || 1) * (1.5 + Math.abs(this.speed));
    const yaw = this.rudder * flow * mass * 0.5;
    body.addTorque({ x: 0, y: yaw, z: 0 }, true);
  }
}
