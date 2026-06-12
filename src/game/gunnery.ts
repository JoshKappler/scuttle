import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import type { Ship } from "./ship";

/**
 * One source of truth for where a cannon's muzzle is and where it points —
 * shared by the projectile spawn, the trajectory preview, and the barrel
 * meshes. The preview arc genuinely starts at the barrel tip, and the ball
 * genuinely leaves it (playtest round 4: "the trajectory line is originating
 * from the base of the cannon instead of from the end of the barrel").
 */
export const BARREL_PIVOT_UP = 0.62; // pivot origin above the deck surface
export const BARREL_INBOARD = 2.6; // voxels the carriage sits inboard of the port cell

// The gun's true geometry — gunnery owns these numbers and the procedural
// gun model in shipVisual is BUILT from them, so the visible bore is the
// firing solution by construction (playtest round 6: the CC0 prop was one
// merged mesh with ~37° of elevation baked in; its preview line "isn't
// facing with where the cannon itself appears to be pointing").
export const BORE_UP = -0.1; // bore height above the pivot origin (0.52 above deck)
export const TRUNNION_OUT = 0.45; // pivot origin → trunnion, along the level bore
export const TIP_FROM_TRUNNION = 1.32; // trunnion → muzzle face

export interface MuzzleOut {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
}

const tmpQ = new THREE.Quaternion();

/**
 * Barrel direction in SHIP-LOCAL space. Elevation lifts the muzzle;
 * traverse (±, degrees) swings it toward the bow for positive values —
 * coarse aim is the helm's job, this is the gun captain's handspike.
 */
export function barrelDirLocal(
  side: 1 | -1,
  elevationDeg: number,
  traverseDeg: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const el = (elevationDeg * Math.PI) / 180;
  const tv = (traverseDeg * Math.PI) / 180;
  out.set(Math.sin(tv), Math.tan(el), side * Math.cos(tv));
  return out.normalize();
}

/** Trunnion pivot in SHIP-LOCAL meters for a cannon port. */
export function pivotLocal(ship: Ship, portIndex: number, out: THREE.Vector3): THREE.Vector3 {
  const port = ship.build.cannonPorts[portIndex];
  return out.set(
    (port.x + 0.5) * VOXEL_SIZE,
    (ship.build.deckY + 1) * VOXEL_SIZE + BARREL_PIVOT_UP,
    (port.z + 0.5 - port.side * BARREL_INBOARD) * VOXEL_SIZE + port.side * 0.2,
  );
}

/** Velocity of the ship's hull AT a world point (linear + ω×r). A fired
 *  ball starts with this plus muzzle velocity — shooting "from stationary"
 *  made moving gunnery unaimable (playtest round 5). */
export function velocityAtPoint(ship: Ship, worldPt: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const v = ship.body.linvel();
  const om = ship.body.angvel();
  const c = ship.body.worldCom();
  const rx = worldPt.x - c.x;
  const ry = worldPt.y - c.y;
  const rz = worldPt.z - c.z;
  return out.set(
    v.x + om.y * rz - om.z * ry,
    v.y + om.z * rx - om.x * rz,
    v.z + om.x * ry - om.y * rx,
  );
}

/** World-space muzzle position + firing direction for one cannon. */
export function muzzleWorld(
  ship: Ship,
  portIndex: number,
  elevationDeg: number,
  traverseDeg: number,
  out: MuzzleOut,
): MuzzleOut {
  const port = ship.build.cannonPorts[portIndex];
  pivotLocal(ship, portIndex, out.pos);
  // exactly the visual model's articulation: traverse slews the carriage
  // (trunnion rides the level bore line), elevation pitches about the trunnion
  barrelDirLocal(port.side, 0, traverseDeg, out.dir);
  out.pos.y += BORE_UP;
  out.pos.addScaledVector(out.dir, TRUNNION_OUT);
  barrelDirLocal(port.side, elevationDeg, traverseDeg, out.dir);
  out.pos.addScaledVector(out.dir, TIP_FROM_TRUNNION);
  const rot = ship.body.rotation();
  tmpQ.set(rot.x, rot.y, rot.z, rot.w);
  out.pos.applyQuaternion(tmpQ);
  const tr = ship.body.translation();
  out.pos.x += tr.x;
  out.pos.y += tr.y;
  out.pos.z += tr.z;
  out.dir.applyQuaternion(tmpQ);
  return out;
}
