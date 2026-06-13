/**
 * Rig damage geometry (round 7): cannonballs vs the soft/standing rigging —
 * sails, mast trunks, the rudder blade. All tests run in SHIP-LOCAL meters
 * on the segment a ball swept this step. Pure functions, unit-tested.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** A sail as a vertical rectangle on a fore-aft-facing plane (x = const). */
export interface SailRect {
  planeX: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

/** A mast trunk as a vertical cylinder. */
export interface MastCyl {
  x: number;
  z: number;
  yBase: number;
  yTop: number;
  r: number;
}

/** Axis-aligned box (the rudder blade zone). */
export interface Box {
  min: V3;
  max: V3;
}

/** Where (if anywhere) the segment p0→p1 crosses the sail's plane inside
 *  its rectangle. Returns the crossing point's (y, z) or null. */
export function segmentSailHit(p0: V3, p1: V3, sail: SailRect): { y: number; z: number } | null {
  const dx = p1.x - p0.x;
  if (Math.abs(dx) < 1e-9) return null; // flying parallel to the cloth
  const t = (sail.planeX - p0.x) / dx;
  if (t < 0 || t > 1) return null;
  const y = p0.y + (p1.y - p0.y) * t;
  const z = p0.z + (p1.z - p0.z) * t;
  if (y < sail.yMin || y > sail.yMax || z < sail.zMin || z > sail.zMax) return null;
  return { y, z };
}

/** Does the segment pass through the mast trunk? */
export function segmentMastHit(p0: V3, p1: V3, m: MastCyl): boolean {
  // closest approach of the xz-projected segment to the trunk axis
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const fx = p0.x - m.x;
  const fz = p0.z - m.z;
  const a = dx * dx + dz * dz;
  let t = 0;
  if (a > 1e-12) t = Math.min(Math.max(-(fx * dx + fz * dz) / a, 0), 1);
  const cx = fx + dx * t;
  const cz = fz + dz * t;
  if (cx * cx + cz * cz > m.r * m.r) return false;
  const y = p0.y + (p1.y - p0.y) * t;
  return y >= m.yBase && y <= m.yTop;
}

/** Segment vs axis-aligned box (slab method). */
export function segmentBoxHit(p0: V3, p1: V3, box: Box): boolean {
  let tMin = 0;
  let tMax = 1;
  const axes: ("x" | "y" | "z")[] = ["x", "y", "z"];
  for (const ax of axes) {
    const d = p1[ax] - p0[ax];
    if (Math.abs(d) < 1e-9) {
      if (p0[ax] < box.min[ax] || p0[ax] > box.max[ax]) return false;
      continue;
    }
    let t1 = (box.min[ax] - p0[ax]) / d;
    let t2 = (box.max[ax] - p0[ax]) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}
