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

/**
 * Label every node by its connected component over ALIVE links (a flood fill).
 * Returns `comp[i]` = component id (0..count-1) and the component `count`. Two
 * nodes share an id iff a path of alive links joins them. Used to split a felled
 * mast into rigid chunks: break the trunk link(s) at the hit height, then every
 * component that no longer reaches the foot falls as ONE stiff body.
 */
export function components(rig: Rig): { comp: number[]; count: number } {
  const n = rig.nodes.length;
  const comp = new Array<number>(n).fill(-1);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const lk of rig.links) {
    if (!lk.alive) continue;
    adj[lk.a].push(lk.b);
    adj[lk.b].push(lk.a);
  }
  let count = 0;
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] !== -1) continue;
    comp[s] = count;
    stack.length = 0; stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      for (const j of adj[i]) if (comp[j] === -1) { comp[j] = count; stack.push(j); }
    }
    count++;
  }
  return { comp, count };
}

/**
 * A detached rig section that moves as ONE rigid body (it holds its shape — the
 * fix for "noodle" falling masts). A felled mast section is frozen into a chunk:
 * each member node's offset from the centroid is recorded in the chunk's BODY
 * frame, and thereafter we integrate a single position + orientation and re-derive
 * the node world positions from that transform. No distance constraints run, so
 * the section cannot bend, shear or stretch — it falls stiff. Pure & deterministic.
 */
export interface RigidChunk {
  nodeIdx: number[];          // rig.nodes indices that make up this chunk
  offsets: Vec3[];            // each node's body-frame offset from the centroid (parallel to nodeIdx)
  mass: number;               // summed node mass
  inertia: number;            // scalar moment of inertia about the centroid (kg·m²), single-axis approx
  pos: Vec3;                  // centroid world position
  vel: Vec3;                  // linear velocity (m/s)
  /** orientation as a unit quaternion (x,y,z,w). */
  q: [number, number, number, number];
  omega: Vec3;                // angular velocity (world axis, rad/s)
}

/**
 * Freeze a set of nodes into a RigidChunk: centroid = mass-weighted node mean,
 * each offset is the node's CURRENT position minus the centroid (so the identity
 * orientation reproduces the spawn shape), and a scalar inertia from Σ m·r².
 * Initial linear/angular velocity is supplied by the caller (inherited ship
 * velocity + topple kick).
 */
export function freezeChunk(
  rig: Rig, nodeIdx: number[],
  vel: Vec3, omega: Vec3,
): RigidChunk {
  let mass = 0, cx = 0, cy = 0, cz = 0;
  for (const i of nodeIdx) {
    const n = rig.nodes[i];
    mass += n.mass; cx += n.pos.x * n.mass; cy += n.pos.y * n.mass; cz += n.pos.z * n.mass;
  }
  if (mass <= 0) mass = 1e-6;
  cx /= mass; cy /= mass; cz /= mass;
  const offsets: Vec3[] = [];
  let inertia = 0;
  for (const i of nodeIdx) {
    const n = rig.nodes[i];
    const ox = n.pos.x - cx, oy = n.pos.y - cy, oz = n.pos.z - cz;
    offsets.push({ x: ox, y: oy, z: oz });
    inertia += n.mass * (ox * ox + oy * oy + oz * oz);
  }
  if (inertia < 1e-6) inertia = 1e-6;
  return {
    nodeIdx, offsets, mass, inertia,
    pos: { x: cx, y: cy, z: cz },
    vel: { x: vel.x, y: vel.y, z: vel.z },
    q: [0, 0, 0, 1],
    omega: { x: omega.x, y: omega.y, z: omega.z },
  };
}

/** Rotate body-frame vector v by the chunk's quaternion into world axes (out may alias). */
export function chunkRotate(c: RigidChunk, v: Vec3, out: Vec3): Vec3 {
  const [qx, qy, qz, qw] = c.q;
  // t = 2 * (q.xyz × v); out = v + qw*t + q.xyz × t   (standard quat-vector rotation)
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  out.x = v.x + qw * tx + (qy * tz - qz * ty);
  out.y = v.y + qw * ty + (qz * tx - qx * tz);
  out.z = v.z + qw * tz + (qx * ty - qy * tx);
  return out;
}

const _wp: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Write every member node's world position from the rigid transform: world =
 * pos + R(q)·offset. prev is set so the implicit (Verlet) velocity each node
 * carries equals the chunk's rigid velocity at that node — keeps `crushFalling`
 * (which reads node prev→pos) seeing the true rigid impact speed.
 */
export function applyChunk(rig: Rig, c: RigidChunk, dt: number): void {
  for (let k = 0; k < c.nodeIdx.length; k++) {
    const n = rig.nodes[c.nodeIdx[k]];
    chunkRotate(c, c.offsets[k], _wp);
    const wx = c.pos.x + _wp.x, wy = c.pos.y + _wp.y, wz = c.pos.z + _wp.z;
    // rigid velocity at this node = vel + omega × r  (r = rotated offset)
    const vx = c.vel.x + (c.omega.y * _wp.z - c.omega.z * _wp.y);
    const vy = c.vel.y + (c.omega.z * _wp.x - c.omega.x * _wp.z);
    const vz = c.vel.z + (c.omega.x * _wp.y - c.omega.y * _wp.x);
    n.pos.x = wx; n.pos.y = wy; n.pos.z = wz;
    n.prev.x = wx - vx * dt; n.prev.y = wy - vy * dt; n.prev.z = wz - vz * dt;
  }
}

/**
 * Advance a rigid chunk one step under per-node accelerations (gravity +
 * buoyancy, supplied by the caller). The accel of each node produces a force at
 * its world offset, summed into a net force (→ linear) and net torque (→ angular)
 * about the centroid. Semi-implicit Euler; `linDamp`/`angDamp` are per-step
 * velocity retention (1 = none). The chunk stays RIGID — node offsets never change.
 */
export function integrateChunk(
  rig: Rig, c: RigidChunk, accel: AccelFn, dt: number,
  linDamp: number, angDamp: number,
): void {
  let fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0;
  for (let k = 0; k < c.nodeIdx.length; k++) {
    const n = rig.nodes[c.nodeIdx[k]];
    const a = accel(n, c.nodeIdx[k]);
    const m = n.mass;
    const wfx = a.x * m, wfy = a.y * m, wfz = a.z * m; // force at this node (a already net of gravity+buoy)
    fx += wfx; fy += wfy; fz += wfz;
    // torque = r × F, r = rotated offset (world)
    chunkRotate(c, c.offsets[k], _wp);
    tx += _wp.y * wfz - _wp.z * wfy;
    ty += _wp.z * wfx - _wp.x * wfz;
    tz += _wp.x * wfy - _wp.y * wfx;
  }
  // linear
  c.vel.x = (c.vel.x + (fx / c.mass) * dt) * linDamp;
  c.vel.y = (c.vel.y + (fy / c.mass) * dt) * linDamp;
  c.vel.z = (c.vel.z + (fz / c.mass) * dt) * linDamp;
  c.pos.x += c.vel.x * dt; c.pos.y += c.vel.y * dt; c.pos.z += c.vel.z * dt;
  // angular (scalar inertia approximation — a spar is near-1D, so one moment is plenty)
  c.omega.x = (c.omega.x + (tx / c.inertia) * dt) * angDamp;
  c.omega.y = (c.omega.y + (ty / c.inertia) * dt) * angDamp;
  c.omega.z = (c.omega.z + (tz / c.inertia) * dt) * angDamp;
  // integrate orientation: q += 0.5 * (omega ⊗ q) * dt, then renormalize
  const [qx, qy, qz, qw] = c.q;
  const ox = c.omega.x, oy = c.omega.y, oz = c.omega.z;
  const dqx = 0.5 * (ox * qw + oy * qz - oz * qy) * dt;
  const dqy = 0.5 * (oy * qw + oz * qx - ox * qz) * dt;
  const dqz = 0.5 * (oz * qw + ox * qy - oy * qx) * dt;
  const dqw = 0.5 * (-ox * qx - oy * qy - oz * qz) * dt;
  let nx = qx + dqx, ny = qy + dqy, nz = qz + dqz, nw = qw + dqw;
  const inv = 1 / (Math.hypot(nx, ny, nz, nw) || 1);
  c.q[0] = nx * inv; c.q[1] = ny * inv; c.q[2] = nz * inv; c.q[3] = nw * inv;
}
