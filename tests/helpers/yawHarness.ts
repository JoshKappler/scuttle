import { SailingController, type Wind } from "../../src/game/sailing";
import { yawInertia, BODY_ANGULAR_DAMPING, type Ship } from "../../src/game/ship";
import type { ShipBuild } from "../../src/sim/shipwright";
import { TUN } from "../../src/core/tunables";
import { FIXED_DT } from "../../src/core/constants";

/** Reference calm-water full-sail cruise speeds (m/s), per tier — the equilibrium of the real
 *  constants: 0.019·wind² = 0.04·(1+0.08v)·v·sub + 0.02·v with wind = 7 m/s (main.ts) and
 *  sub = mass/(1.5·1025·V_displacing). Derivation in the round-12 agent-D plan. */
export const CRUISE = { cutter: 17.7, sloop: 20.3, brig: 18.5, frigate: 19.6 } as const;

/** The shipped physics wind (main.ts:433) — unused at sailSet 0 but apply() requires it. */
const WIND: Wind = { dirX: 1, dirZ: 0, speed: 7 };

/** Minimal fake hull for SailingController.apply(): identity heading (+x), speed held at
 *  `cruise`, torque captured. Same pattern as tests/sailing.test.ts fakeShip(). */
function makeStub(build: ShipBuild, cruise: number) {
  const cap = { tau: 0 };
  const body = {
    rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
    linvel: () => ({ x: cruise, y: 0, z: 0 }),
    mass: () => build.grid.totalMass(),
    addForceAtPoint: () => {},
    addTorque: (t: { x: number; y: number; z: number }) => { cap.tau += t.y; },
  };
  const ship = {
    body,
    submergedFrac: 1,
    build,
    mastAlive: build.masts.map(() => true),
    sailIntegrity: build.masts.map(() => 1),
    comLocal: [0, 0, 0],
    rudderEff: 1,
    rudderPower: 1,
    localToWorld: (l: [number, number, number], out: { set: (x: number, y: number, z: number) => unknown }) => {
      out.set(l[0], l[1], l[2]);
      return out;
    },
  } as unknown as Ship;
  return { ship, cap };
}

/** The REAL rudder torque (N·m) sailing.ts produces at full rudder + cruise flow. */
export function rudderTorque(build: ShipBuild, cruise: number): number {
  const { ship, cap } = makeStub(build, cruise);
  const sail = new SailingController();
  sail.sailSet = 0; // no thrust — pure rudder
  sail.rudder = 1;  // full helm
  cap.tau = 0;
  sail.apply(ship, WIND);
  return cap.tau;
}

/**
 * Deterministic 1-DOF time-to-90° (s): full rudder at held cruise speed, calm sea (no waves in
 * this model at all — swell never enters), mirroring the live per-substep order (game/world.ts):
 * ship.applyForces yaw damping (τ = −ω·wet·TUN.phys.yawDamp·I_yaw, wet = 1 afloat — every tier's
 * rest submergence ×5 saturates min(sub·5,1)) + sailing.apply rudder torque, integrated at
 * FIXED_DT with Rapier's body angular damping factor. Reads the LIVE shipped TUN — a tunables
 * drift moves the result out of band and fails the assertions loudly.
 */
export function timeTo90(build: ShipBuild, cruise: number): number {
  const iyaw = yawInertia(build);
  const { ship, cap } = makeStub(build, cruise);
  const sail = new SailingController();
  sail.sailSet = 0;
  sail.rudder = 1;
  let omega = 0;
  let heading = 0;
  const maxSteps = 60 * 40;
  for (let i = 0; i < maxSteps; i++) {
    cap.tau = 0;
    sail.apply(ship, WIND); // real torque incl. TUN.phys.rudderGain (+ lever once Task 4 lands)
    const tauDamp = -omega * 1 * TUN.phys.yawDamp * iyaw; // ship.applyForces yaw-damping line
    omega += ((cap.tau + tauDamp) / iyaw) * FIXED_DT;
    omega /= 1 + BODY_ANGULAR_DAMPING * FIXED_DT; // Rapier setAngularDamping
    heading += omega * FIXED_DT;
    if (heading >= Math.PI / 2) return (i + 1) * FIXED_DT;
  }
  return Infinity;
}

/** Steady-state yaw rate (rad/s) of the same model (closed form). */
export function steadyYawRate(build: ShipBuild, cruise: number): number {
  return rudderTorque(build, cruise) / ((TUN.phys.yawDamp + BODY_ANGULAR_DAMPING) * yawInertia(build));
}
