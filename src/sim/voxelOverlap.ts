// Pure, engine-free hull-vs-hull overlap detection. Given hull A (its boundary/surface
// cells) and hull B (an occupancy test), each with a world transform (pos + unit quat) and a
// shared voxel size, return the cells of A whose centre falls inside a solid cell of B, the
// matching B cells, an approximate interpenetration depth (metres), and a unit push-out axis
// (world, oriented A->B). Caller passes the SMALLER hull as A (fewer surface cells to walk).
//
// This is the geometric heart of the deformable contact: the returned cells are EXACTLY the
// material in contact, so crush() carves the real overlap — never a guessed seed mapped
// through a moved transform (the old "hole on the far side" bug).

export interface HullView {
  /** Packed [x,y,z, x,y,z, ...] of this hull's surface cells (read for A only). */
  surface: Int32Array;
  /** Is this LOCAL integer cell solid? Bounds-checked by the impl (read for B only). */
  isSolid: (x: number, y: number, z: number) => boolean;
  dims: [number, number, number];
  /** World position of the local (0,0,0) grid corner. */
  pos: [number, number, number];
  /** World orientation, unit quaternion [x,y,z,w]. */
  quat: [number, number, number, number];
}

export interface Overlap {
  /** A's overlapping cells, in A's local integer indices. */
  aCells: [number, number, number][];
  /** The matching solid cells in B's local integer indices. */
  bCells: [number, number, number][];
  /** Approximate interpenetration depth (metres). */
  depth: number;
  /** Unit push-out direction (world), oriented from A toward B. */
  axis: [number, number, number];
  /** World-space centroid of A's overlapping cells — the contact point for force/velocity. */
  centroid: [number, number, number];
}

/** Rotate (vx,vy,vz) by unit quaternion (qx,qy,qz,qw); write to out[0..2]. */
function qRot(
  qx: number, qy: number, qz: number, qw: number,
  vx: number, vy: number, vz: number,
  out: [number, number, number],
): void {
  // t = 2 * cross(q.xyz, v); v' = v + qw*t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
}

/** World-space AABB of a hull's grid envelope (8 transformed corners). */
function worldAabb(h: HullView, vs: number, min: [number, number, number], max: [number, number, number]): void {
  const ex = h.dims[0] * vs, ey = h.dims[1] * vs, ez = h.dims[2] * vs;
  const [qx, qy, qz, qw] = h.quat;
  min[0] = min[1] = min[2] = Infinity;
  max[0] = max[1] = max[2] = -Infinity;
  const c: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 8; i++) {
    qRot(qx, qy, qz, qw, i & 1 ? ex : 0, i & 2 ? ey : 0, i & 4 ? ez : 0, c);
    const wx = c[0] + h.pos[0], wy = c[1] + h.pos[1], wz = c[2] + h.pos[2];
    if (wx < min[0]) min[0] = wx; if (wx > max[0]) max[0] = wx;
    if (wy < min[1]) min[1] = wy; if (wy > max[1]) max[1] = wy;
    if (wz < min[2]) min[2] = wz; if (wz > max[2]) max[2] = wz;
  }
}

export function voxelOverlap(a: HullView, b: HullView, voxelSize: number): Overlap | null {
  const vs = voxelSize;
  // B's world AABB for a cheap per-cell broad reject before the full inverse transform.
  const bMin: [number, number, number] = [0, 0, 0];
  const bMax: [number, number, number] = [0, 0, 0];
  worldAabb(b, vs, bMin, bMax);

  const aCells: [number, number, number][] = [];
  const bCells: [number, number, number][] = [];
  // overlap AABB in world space (from the A-cell centres confirmed inside B) → depth/axis.
  let oMinX = Infinity, oMinY = Infinity, oMinZ = Infinity;
  let oMaxX = -Infinity, oMaxY = -Infinity, oMaxZ = -Infinity;
  let sumWX = 0, sumWY = 0, sumWZ = 0;

  const [aqx, aqy, aqz, aqw] = a.quat;
  const world: [number, number, number] = [0, 0, 0];
  const blocal: [number, number, number] = [0, 0, 0];
  const surf = a.surface;

  for (let i = 0; i < surf.length; i += 3) {
    const ax = surf[i], ay = surf[i + 1], az = surf[i + 2];
    // A cell centre -> world
    qRot(aqx, aqy, aqz, aqw, (ax + 0.5) * vs, (ay + 0.5) * vs, (az + 0.5) * vs, world);
    const wx = world[0] + a.pos[0], wy = world[1] + a.pos[1], wz = world[2] + a.pos[2];
    // broad reject against B's world box
    if (wx < bMin[0] || wx > bMax[0] || wy < bMin[1] || wy > bMax[1] || wz < bMin[2] || wz > bMax[2]) continue;
    // world -> B local (inverse rotate by B's quat = rotate by its conjugate)
    qRot(-b.quat[0], -b.quat[1], -b.quat[2], b.quat[3], wx - b.pos[0], wy - b.pos[1], wz - b.pos[2], blocal);
    const bix = Math.floor(blocal[0] / vs);
    const biy = Math.floor(blocal[1] / vs);
    const biz = Math.floor(blocal[2] / vs);
    if (!b.isSolid(bix, biy, biz)) continue;
    aCells.push([ax, ay, az]);
    bCells.push([bix, biy, biz]);
    if (wx < oMinX) oMinX = wx; if (wx > oMaxX) oMaxX = wx;
    if (wy < oMinY) oMinY = wy; if (wy > oMaxY) oMaxY = wy;
    if (wz < oMinZ) oMinZ = wz; if (wz > oMaxZ) oMaxZ = wz;
    sumWX += wx; sumWY += wy; sumWZ += wz;
  }

  if (aCells.length === 0) return null;

  // penetration ≈ the THINNEST extent of the overlap box (the cells span (n-1)*vs between
  // centres, so add one voxel for the cell width). The thin axis is the contact normal.
  const extX = oMaxX - oMinX + vs;
  const extY = oMaxY - oMinY + vs;
  const extZ = oMaxZ - oMinZ + vs;
  let depth = extX, axisIdx = 0;
  if (extY < depth) { depth = extY; axisIdx = 1; }
  if (extZ < depth) { depth = extZ; axisIdx = 2; }

  // axis = the thin world axis, signed from A's overlap centroid toward B's centre.
  const n = aCells.length;
  const cax = sumWX / n, cay = sumWY / n, caz = sumWZ / n;
  // B centre in world
  const bc: [number, number, number] = [0, 0, 0];
  qRot(b.quat[0], b.quat[1], b.quat[2], b.quat[3], (b.dims[0] * vs) / 2, (b.dims[1] * vs) / 2, (b.dims[2] * vs) / 2, bc);
  const bcx = bc[0] + b.pos[0], bcy = bc[1] + b.pos[1], bcz = bc[2] + b.pos[2];
  const axis: [number, number, number] = [0, 0, 0];
  axis[axisIdx] = 1;
  const toB = axisIdx === 0 ? bcx - cax : axisIdx === 1 ? bcy - cay : bcz - caz;
  if (toB < 0) axis[axisIdx] = -1;

  return { aCells, bCells, depth, axis, centroid: [cax, cay, caz] };
}
