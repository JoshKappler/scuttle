import { G } from "../core/constants";

/**
 * Cannonball kinematics + voxel damage footprints. Pure math — projectile
 * entities and impact detection live in game/cannons.ts.
 */
export interface ShotParams {
  speed: number; // muzzle speed m/s
  elevationDeg: number;
  drag: number; // quadratic drag coefficient (per meter)
}

export interface ShotResult {
  range: number; // horizontal distance at return to launch height
  flightTime: number; // s
  apex: number; // m above launch height
}

/** Integrate a shot over flat ground (semi-implicit Euler, 240 Hz). */
export function simulateShot(p: ShotParams): ShotResult {
  const dt = 1 / 240;
  const el = (p.elevationDeg * Math.PI) / 180;
  let vx = Math.cos(el) * p.speed;
  let vy = Math.sin(el) * p.speed;
  let x = 0;
  let y = 0;
  let apex = 0;
  let t = 0;
  for (let i = 0; i < 240 * 60; i++) {
    const v = Math.hypot(vx, vy);
    vx += -p.drag * v * vx * dt;
    vy += (-G - p.drag * v * vy) * dt;
    x += vx * dt;
    y += vy * dt;
    t += dt;
    if (y > apex) apex = y;
    if (y < 0 && vy < 0) break;
  }
  return { range: x, flightTime: t, apex };
}

/** All integer cells whose centers lie within `radius` cells of the center cell. */
export function sphereCells(center: [number, number, number], radius: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const r = Math.ceil(radius);
  const r2 = radius * radius;
  for (let dx = -r; dx <= r; dx++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dz = -r; dz <= r; dz++) {
        if (dx * dx + dy * dy + dz * dz <= r2) {
          out.push([center[0] + dx, center[1] + dy, center[2] + dz]);
        }
      }
    }
  }
  return out;
}
