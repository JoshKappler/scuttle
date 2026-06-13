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
// Whole-gun scale: round 7 sized the battery up ("a bit smaller than I think
// they would be in real life") — the visual scales its gun group by this and
// the firing solution scales the same offsets, so they can never drift apart.
// Round 8: "still smaller than realistic" — 1.6 puts the barrel near 2.3 m,
// honest for a 6-pounder.
export const GUN_SCALE = 1.6;

export const BARREL_INBOARD = 2.6; // voxels the carriage sits inboard of the port cell
/** Extra meters inboard of that: round 7 had the carriage so far outboard
 *  "their front wheels are actually off of the ship"; round 8 still saw
 *  wheels over the edge with the bigger guns — pulled well inboard. */
export const GUN_INBOARD_M = 0.55;

// The gun's true geometry IN ITS OWN MODEL SPACE — gunnery owns these
// numbers and the procedural gun model in shipVisual is BUILT from them
// (then scaled by GUN_SCALE as one group), so the visible bore is the
// firing solution by construction (playtest round 6: the CC0 prop was one
// merged mesh with ~37° of elevation baked in; its preview line "isn't
// facing with where the cannon itself appears to be pointing").
export const BORE_UP_B = -0.1; // bore height above the pivot origin
export const TRUNNION_OUT_B = 0.45; // pivot origin → trunnion, along the level bore
export const TIP_FROM_TRUNNION_B = 1.32; // trunnion → muzzle face
export const BARREL_PIVOT_UP_B = 0.62; // pivot origin above the deck surface

// …and the same offsets in SHIP space (scaled) — the muzzle math uses these
export const BORE_UP = BORE_UP_B * GUN_SCALE;
export const TRUNNION_OUT = TRUNNION_OUT_B * GUN_SCALE;
export const TIP_FROM_TRUNNION = TIP_FROM_TRUNNION_B * GUN_SCALE;
export const BARREL_PIVOT_UP = BARREL_PIVOT_UP_B * GUN_SCALE;

/** Shared by the projectile spawn AND the aim-arc preview — one constant so
 *  the line and the ball can never disagree. Round 8 raised it from 55
 *  ("the cannonballs should be faster and more powerful, have a further
 *  range") — 72 m/s nearly doubles flat-trajectory reach. */
export const MUZZLE_SPEED = 72; // m/s
export const BALL_DRAG = 0.006;

export interface MuzzleOut {
  pos: THREE.Vector3;
  dir: THREE.Vector3;
}

const tmpQ = new THREE.Quaternion();

/** Which way a gun bears at rest: out a broadside (undefined → use `side`, ±z) or
 *  axially as a bow/stern CHASER (r17: fires straight forward/back so you can line a
 *  shot on a ship you're chasing or running from, not just abeam). */
export type GunFacing = "fore" | "aft";

/**
 * Barrel direction in SHIP-LOCAL space. Elevation lifts the muzzle;
 * traverse (±, degrees) swings it. Broadside guns bear out ±z; a fore/aft
 * chaser bears out ±x (and traverse then swings it across the beam).
 */
export function barrelDirLocal(
  side: 1 | -1,
  elevationDeg: number,
  traverseDeg: number,
  out: THREE.Vector3,
  facing?: GunFacing,
): THREE.Vector3 {
  const el = (elevationDeg * Math.PI) / 180;
  const tv = (traverseDeg * Math.PI) / 180;
  if (facing === "fore") out.set(Math.cos(tv), Math.tan(el), Math.sin(tv));
  else if (facing === "aft") out.set(-Math.cos(tv), Math.tan(el), Math.sin(tv));
  else out.set(Math.sin(tv), Math.tan(el), side * Math.cos(tv));
  return out.normalize();
}

/** Trunnion pivot in SHIP-LOCAL meters for a cannon port. */
export function pivotLocal(ship: Ship, portIndex: number, out: THREE.Vector3): THREE.Vector3 {
  const port = ship.build.cannonPorts[portIndex];
  // r17: use the port's own height so a below-deck/cabin gun sits lower (deck guns store
  // y = deckY+1, unchanged). Mirrored in shipVisual. A chaser seats its carriage inboard
  // along ±x (behind the bow / forward of the stern) instead of ±z.
  const cy = port.y * VOXEL_SIZE + BARREL_PIVOT_UP;
  const cz = (port.z + 0.5) * VOXEL_SIZE;
  if (port.facing === "fore")
    return out.set((port.x + 0.5 - BARREL_INBOARD) * VOXEL_SIZE - GUN_INBOARD_M, cy, cz);
  if (port.facing === "aft")
    return out.set((port.x + 0.5 + BARREL_INBOARD) * VOXEL_SIZE + GUN_INBOARD_M, cy, cz);
  return out.set(
    (port.x + 0.5) * VOXEL_SIZE,
    cy,
    (port.z + 0.5 - port.side * BARREL_INBOARD) * VOXEL_SIZE - port.side * GUN_INBOARD_M,
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
  barrelDirLocal(port.side, 0, traverseDeg, out.dir, port.facing);
  out.pos.y += BORE_UP;
  out.pos.addScaledVector(out.dir, TRUNNION_OUT);
  barrelDirLocal(port.side, elevationDeg, traverseDeg, out.dir, port.facing);
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
