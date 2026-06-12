import * as THREE from "three";
import type { Ship } from "./ship";

/**
 * Wind + sail thrust + rudder. Arcade model (playtest round 4): the wind is
 * a BOOST, never a wall — at least half power on every heading, peaking on a
 * broad reach. Thrust applies at COM height; heel comes from the keel.
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
  // separate temp for the up vector — reusing tmpF here once ALIASED fwd
  // (thrust silently pointed straight up; both ships drifted at 2 kn)
  private tmpU = new THREE.Vector3();

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

    // half power floor on every heading (playtest round 4: "you should still
    // be able to go at least half speed facing into the wind" — being
    // realistic here just strands people), rising to full at ~105-150°
    const deg = this.angleOffWind;
    let wf = 0.5;
    if (deg > 24) {
      const x = Math.min((deg - 24) / 81, 1);
      const runFade = deg > 150 ? 1 - ((deg - 150) / 30) * 0.25 : 1;
      wf = Math.max(Math.pow(Math.sin((x * Math.PI) / 2), 1.2) * runFade, 0.5);
    }

    // thrust ∝ wind pressure on set canvas; tuned for ~12 m/s (23 kn) at
    // full sail on a reach — realistic hull speeds were no fun (playtest)
    const mass = body.mass();
    // canvas only draws while she's upright: a heeled rig spills wind, a
    // capsized one is in the water (playtest round 5: "even upside down,
    // the ship is still thrusting forwards")
    const rotUp = this.tmpU.set(0, 1, 0).applyQuaternion(this.tmpQ);
    const upright = Math.min(Math.max(rotUp.y, 0), 1);
    // 0.019: the deep round-5 hull drags more wetted surface than the old
    // canoe — this keeps full sail in the low-20s of knots
    const thrust = this.sailSet * wf * wind.speed * wind.speed * mass * 0.019 * upright;

    if (thrust > 0 && ship.submergedFrac > 0.02) {
      const m = ship.build.masts[0];
      const mx = (m.x + 0.5) * 0.25;
      const mz = (m.z + 0.5) * 0.25;
      // drive applied at COM height (thrust high on the mast buried the bow;
      // pitch is the trim controller's job now)
      const ap = ship.localToWorld([mx, ship.comLocal[1], mz], this.tmpF.clone());
      body.addForceAtPoint({ x: fwd.x * thrust, y: 0, z: fwd.z * thrust }, ap, true);

      // the wind's LATERAL push on the canvas, applied up the mast: this is
      // what actually heels a square-rigger on a reach, and the deep keel
      // resisting the resulting leeway completes the couple
      const latX = -fwd.z;
      const latZ = fwd.x;
      const wLat = wind.speed * (wind.dirX * latX + wind.dirZ * latZ);
      const heelF = this.sailSet * wLat * Math.abs(wLat) * mass * 0.012 * upright;
      const hp = ship.localToWorld([mx, ship.comLocal[1] + 3.5, mz], this.tmpF.clone());
      body.addForceAtPoint({ x: latX * heelF, y: 0, z: latZ * heelF }, hp, true);
    }

    // rudder: yaw torque scales with water flow over it, with a generous
    // low-speed floor so you can always work the bow off the wind
    const flow = Math.sign(this.speed || 1) * (1.5 + Math.abs(this.speed));
    const yaw = this.rudder * flow * mass * 0.5;
    body.addTorque({ x: 0, y: yaw, z: 0 }, true);
  }
}
