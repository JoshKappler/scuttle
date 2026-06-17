/**
 * Rig lattice (voxel rig core): masts, yards, bowsprit and sails are all the
 * SAME primitive — point-masses joined by breakable distance links. ONE rule:
 * a link whose strain exceeds its breakStrain is deleted instead of satisfied.
 * Topple, break-in-half, tear, flap and detach all emerge from that. Pure &
 * deterministic (forces + collisions are injected by the caller); unit-tested
 * like sim/buoyancy.ts. See docs/superpowers/specs/2026-06-16-voxel-rig-design.md.
 */

export interface Vec3 { x: number; y: number; z: number; }

// Plain const objects, NOT enums: the project sets `isolatedModules: true` (so
// `const enum` is unsafe across modules) and uses no enums anywhere — match that.

/** Node role bits (bitmask in RigNode.flags). */
export const NodeFlag = {
  WOOD: 1,
  CLOTH: 2,
  FOOT: 4, // a hull anchor (mast foot / bowsprit heel); pinned to the deck
  WET: 8,
} as const;

/** Link material: WOOD is rigid (resists stretch AND compression); CLOTH only
 *  resists stretch (goes slack under compression, like real canvas). */
export const LinkKind = { WOOD: 0, CLOTH: 1 } as const;
export type LinkKindV = (typeof LinkKind)[keyof typeof LinkKind];

export interface RigNode {
  pos: Vec3;
  prev: Vec3; // previous position (Verlet velocity = pos - prev)
  mass: number;
  /** A world anchor: never integrated, never moved by relax. The mast foot and
   *  bowsprit heel start pinned; clearing the pin (hull voxel gone) frees the
   *  rig to fall. Cloth/yards are NOT pinned — they attach via links. */
  pinned: boolean;
  flags: number;
}

export interface RigLink {
  a: number; // node index
  b: number; // node index
  rest: number;
  breakStrain: number; // |len - rest| / rest beyond which the link deletes
  kind: LinkKindV;
  alive: boolean;
}

export interface Rig {
  nodes: RigNode[];
  links: RigLink[];
  awake: boolean;
  sleepTimer: number; // seconds spent below the sleep KE threshold
}

export function dist(a: Vec3, b: Vec3): number {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
