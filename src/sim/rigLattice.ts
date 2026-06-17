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
  SPRIT: 16, // a bowsprit node — the forward ram spar (game/rig.ts bores with these)
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
 *
 * Break is TENSION-ONLY by design (a spar fails when over-stretched/bent, and
 * the design spec defines strain as tension): compression is never a break
 * condition, only a restoring push — so `delta < 0` is normal, not an error.
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
      // tension-only break: `delta > 0` guards it so compression never snaps
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

/** Sum of ½·m·v² over free nodes, where v = (pos - prev) / dt. */
export function kineticEnergy(rig: Rig, dt: number): number {
  let ke = 0;
  const inv = 1 / dt;
  for (const n of rig.nodes) {
    if (n.pinned) continue;
    const vx = (n.pos.x - n.prev.x) * inv;
    const vy = (n.pos.y - n.prev.y) * inv;
    const vz = (n.pos.z - n.prev.z) * inv;
    ke += 0.5 * n.mass * (vx * vx + vy * vy + vz * vz);
  }
  return ke;
}

export interface StepOpts {
  dt: number;
  damp: number;
  iterations: number;
  accel: AccelFn;
  sleepKE: number; // KE below this counts as "settling"
}

/**
 * One full rig step: integrate, satisfy/break links, then advance the sleep
 * timer. Collision (node-vs-hull crush) is injected by the runtime BETWEEN
 * integrate and relax in later phases; the pure core only does motion + the
 * break rule + sleep accounting. The runtime decides when to actually sleep.
 */
export function stepRig(rig: Rig, opts: StepOpts): void {
  integrate(rig, opts.accel, opts.dt, opts.damp);
  relax(rig, opts.iterations);
  if (kineticEnergy(rig, opts.dt) < opts.sleepKE) rig.sleepTimer += opts.dt;
  else rig.sleepTimer = 0;
}

/**
 * Flood from every pinned (anchored) node over ALIVE links. A node that cannot
 * reach any anchor is detached — a torn-off cloth strip or a felled spar that
 * has left the ship. The runtime uses this to drop / float-away loose pieces.
 */
export function attachedToPin(rig: Rig): boolean[] {
  const nodeCount = rig.nodes.length;
  const attached = new Array<boolean>(nodeCount).fill(false);
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const lk of rig.links) {
    if (!lk.alive) continue;
    adj[lk.a].push(lk.b);
    adj[lk.b].push(lk.a);
  }
  const stack: number[] = [];
  for (let i = 0; i < nodeCount; i++) {
    if (rig.nodes[i].pinned) { attached[i] = true; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop()!;
    for (const j of adj[i]) {
      if (!attached[j]) { attached[j] = true; stack.push(j); }
    }
  }
  return attached;
}
