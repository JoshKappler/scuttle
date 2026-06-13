import * as THREE from "three";
import { turnHeelTorque } from "../sim/heel";
import { TUN } from "../core/tunables";
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
  /** Crew quality 0..1 — scales thrust. The AI captain sails at a deficit so
   *  the player can out-run and out-turn to a firing position (round 6:
   *  "no amount of throttle and turning can take you broadside … nerf"). */
  efficiency = 1;

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
    const thrust = this.sailSet * wf * wind.speed * wind.speed * mass * 0.019 * upright * this.efficiency;

    if (thrust > 0 && ship.submergedFrac > 0.02) {
      // drive and heel split across every mast (the brig carries two) —
      // scaled per mast by its canvas integrity, zero once it's by the board
      // (round 7: shot-up sails slow you; a felled mast pulls nothing)
      const masts = ship.build.masts;
      const latX = -fwd.z;
      const latZ = fwd.x;
      const wLat = wind.speed * (wind.dirX * latX + wind.dirZ * latZ);
      const heelF = (this.sailSet * wLat * Math.abs(wLat) * mass * 0.012 * upright) / masts.length;
      masts.forEach((m, mi) => {
        if (!ship.mastAlive[mi]) return;
        const canvas = ship.sailIntegrity[mi];
        const mx = (m.x + 0.5) * 0.25;
        const mz = (m.z + 0.5) * 0.25;
        // drive applied at COM height (thrust high on the mast buried the
        // bow; pitch is the trim controller's job now)
        const ap = ship.localToWorld([mx, ship.comLocal[1], mz], this.tmpF.clone());
        body.addForceAtPoint(
          {
            x: (fwd.x * thrust * canvas) / masts.length,
            y: 0,
            z: (fwd.z * thrust * canvas) / masts.length,
          },
          ap,
          true,
        );
        // the wind's LATERAL push on the canvas, applied up the mast: this is
        // what actually heels a square-rigger on a reach, and the deep keel
        // resisting the resulting leeway completes the couple
        const hp = ship.localToWorld([mx, ship.comLocal[1] + m.h * 0.23, mz], this.tmpF.clone());
        body.addForceAtPoint(
          { x: latX * heelF * canvas, y: 0, z: latZ * heelF * canvas },
          hp,
          true,
        );
      });
    }

    // turn heel: lateral G (v·ω) reacts on the mass above the keel's grip
    // and rolls her OUTWARD, like a car body on springs — speed and rudder
    // together now produce the lean, not the wind alone (round 7: "the
    // leaning feels pretty random and not based in anything the ship is
    // actually doing")
    if (ship.submergedFrac > 0.02) {
      const om = body.angvel();
      const heelT = turnHeelTorque(this.speed, om.y, mass, TUN.phys.turnHeelArm);
      body.addTorque({ x: fwd.x * heelT, y: 0, z: fwd.z * heelT }, true);
    }

    // rudder: yaw torque scales with water flow over it, with a generous
    // low-speed floor so you can always work the bow off the wind — and with
    // what's LEFT of the blade (round 7: "holes in the rudder should mess
    // up their maneuverability")
    const flow = Math.sign(this.speed || 1) * (1.5 + Math.abs(this.speed));
    const yaw = this.rudder * flow * mass * 0.5 * ship.rudderEff;
    body.addTorque({ x: 0, y: yaw, z: 0 }, true);
  }
}
