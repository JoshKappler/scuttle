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

/**
 * Satisfy all alive links over `iterations` passes (position-based dynamics).
 * THE ONE RULE: a link whose tension strain exceeds breakStrain is deleted
 * (alive=false) instead of satisfied. WOOD resists both stretch and
 * compression; CLOTH only resists stretch (slack under compression).
 */
export function relax(rig: Rig, iterations: number): void {
  const { nodes, links } = rig;
  for (let it = 0; it < iterations; it++) {
    for (const lk of links) {
      if (!lk.alive) continue;
      const a = nodes[lk.a], b = nodes[lk.b];
      const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1e-9) continue;
      const delta = d - lk.rest;
      if (delta > 0 && delta / lk.rest > lk.breakStrain) { lk.alive = false; continue; }
      if (lk.kind === LinkKind.CLOTH && delta < 0) continue;
      const wa = a.pinned ? 0 : 1 / a.mass;
      const wb = b.pinned ? 0 : 1 / b.mass;
      const wsum = wa + wb;
      if (wsum === 0) continue;
      const f = (delta / d) / wsum;
      a.pos.x += dx * f * wa; a.pos.y += dy * f * wa; a.pos.z += dz * f * wa;
      b.pos.x -= dx * f * wb; b.pos.y -= dy * f * wb; b.pos.z -= dz * f * wb;
    }
  }
}

/** Acceleration supplier (gravity + wind + buoyancy), injected so the core
 *  stays pure and deterministic. Returns m/s^2 in ship-local axes. */
export type AccelFn = (n: RigNode, i: number) => Vec3;

/**
 * Position-Verlet integrate. `damp` is velocity retention (1 = none, <1 bleeds
 * energy). Pinned nodes are skipped. prev is set to the pre-step position so
 * the implicit velocity carries to the next step.
 */
export function integrate(rig: Rig, accel: AccelFn, dt: number, damp: number): void {
  const dt2 = dt * dt;
  const nodes = rig.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.pinned) continue;
    const a = accel(n, i);
    const px = n.pos.x, py = n.pos.y, pz = n.pos.z;
    n.pos.x = px + (px - n.prev.x) * damp + a.x * dt2;
    n.pos.y = py + (py - n.prev.y) * damp + a.y * dt2;
    n.pos.z = pz + (pz - n.prev.z) * damp + a.z * dt2;
    n.prev.x = px; n.prev.y = py; n.prev.z = pz;
  }
}
