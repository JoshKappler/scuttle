/**
 * Rig damage geometry: a cannonball's swept segment vs the rudder blade (an axis-aligned box).
 * Masts and sails are real grid voxels now (bored by the unified crush), so the old sail-rectangle
 * and mast-cylinder tests are gone — only the rudder is still a mesh tested here. Ship-local meters,
 * pure + unit-tested.
 */

export interface V3 {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned box (the rudder blade zone). */
export interface Box {
  min: V3;
  max: V3;
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
