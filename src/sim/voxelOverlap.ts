// Pure, engine-free hull-vs-hull contact detection. Given hull A (its boundary/surface cells)
// and hull B (an occupancy test), each with a world transform (pos + unit quat) and a shared
// voxel size, find the cells of A whose centre lands inside — or within `buffer` voxels of — a
// solid cell of B. The contacts are written into caller-owned flat scratch buffers (no per-cell
// allocation, so this can run every fixed step for every overlapping pair); the return value is
// the aggregate {count, depth, axis, centroid}. Caller passes the SMALLER hull as A (fewer
// surface cells to walk) and sizes the scratch to hold A's surface.
//
// This is the geometric heart of the deformable contact (game/voxelContact.ts): the recorded
// cells are EXACTLY the material in contact, so the carve removes the real overlap, and the
// per-contact world points let the caller compute each contact's own closing speed. The `buffer`
// makes "sufficiently close" count as touching — the voxels are a coarse approximation of a real
// hull, so a small slack (in voxels) decides destruction eligibility without needing a full
// half-voxel of interpenetration first.

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

/** Caller-owned output buffers, refilled each call. Each contact occupies 3 slots (x,y,z).
 *  Capacity = aCells.length/3; detection stops once full (so size it to A's surface length). */
export interface ContactScratch {
  /** A's contacting cells, A-local integer indices, flat [x,y,z,...]. */
  aCells: Int32Array;
  /** The matching solid cells in B, B-local integer indices, flat [x,y,z,...]. */
  bCells: Int32Array;
  /** World-space contact points (A cell centres), flat [x,y,z,...] — for per-contact velocity. */
  points: Float32Array;
}

export interface ContactResult {
  /** Number of contacts written into the scratch (≤ capacity). */
  count: number;
  /** Approximate interpenetration depth (metres) — the thinnest extent of the contact box. */
  depth: number;
  /** Unit push-out direction (world), oriented from A toward B. Reliable for the SHALLOW
   *  contacts the rest/de-penetration branch uses; the breaking branch uses the relative-velocity
   *  direction instead (which never flips when a big hull engulfs a small one). */
  axis: [number, number, number];
  /** World-space centroid of the contacts — a contact point for aggregate force/velocity. */
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

const _bMin: [number, number, number] = [0, 0, 0];
const _bMax: [number, number, number] = [0, 0, 0];
const _world: [number, number, number] = [0, 0, 0];
const _blocal: [number, number, number] = [0, 0, 0];
const _bc: [number, number, number] = [0, 0, 0];

export function detectContacts(
  a: HullView,
  b: HullView,
  voxelSize: number,
  buffer: number,
  scratch: ContactScratch,
): ContactResult | null {
  const vs = voxelSize;
  const cap = (scratch.aCells.length / 3) | 0;
  if (cap === 0) return null;

  // B's world AABB, padded by the buffer, for a cheap per-cell broad reject.
  worldAabb(b, vs, _bMin, _bMax);
  const pad = buffer * vs;
  _bMin[0] -= pad; _bMin[1] -= pad; _bMin[2] -= pad;
  _bMax[0] += pad; _bMax[1] += pad; _bMax[2] += pad;

  let count = 0;
  let oMinX = Infinity, oMinY = Infinity, oMinZ = Infinity;
  let oMaxX = -Infinity, oMaxY = -Infinity, oMaxZ = -Infinity;
  let sumWX = 0, sumWY = 0, sumWZ = 0;

  const [aqx, aqy, aqz, aqw] = a.quat;
  const surf = a.surface;

  for (let i = 0; i < surf.length; i += 3) {
    if (count >= cap) break; // scratch full — stop (caller sizes it to A's surface)
    const ax = surf[i], ay = surf[i + 1], az = surf[i + 2];
    // A cell centre -> world
    qRot(aqx, aqy, aqz, aqw, (ax + 0.5) * vs, (ay + 0.5) * vs, (az + 0.5) * vs, _world);
    const wx = _world[0] + a.pos[0], wy = _world[1] + a.pos[1], wz = _world[2] + a.pos[2];
    // broad reject against B's padded world box
    if (wx < _bMin[0] || wx > _bMax[0] || wy < _bMin[1] || wy > _bMax[1] || wz < _bMin[2] || wz > _bMax[2]) continue;
    // world -> B local (inverse rotate by B's quat = rotate by its conjugate), in CELL units
    qRot(-b.quat[0], -b.quat[1], -b.quat[2], b.quat[3], wx - b.pos[0], wy - b.pos[1], wz - b.pos[2], _blocal);
    const ux = _blocal[0] / vs, uy = _blocal[1] / vs, uz = _blocal[2] / vs;

    // The cell that contains the point; prefer it (deepest contact) if solid.
    const cx = Math.floor(ux), cy = Math.floor(uy), cz = Math.floor(uz);
    let fx = cx, fy = cy, fz = cz;
    let found = b.isSolid(cx, cy, cz);
    if (!found && buffer > 0) {
      // scan the (tiny) neighbourhood within `buffer` voxels for the nearest solid cell
      const bx0 = Math.floor(ux - buffer), bx1 = Math.floor(ux + buffer);
      const by0 = Math.floor(uy - buffer), by1 = Math.floor(uy + buffer);
      const bz0 = Math.floor(uz - buffer), bz1 = Math.floor(uz + buffer);
      for (let bx = bx0; bx <= bx1 && !found; bx++)
        for (let by = by0; by <= by1 && !found; by++)
          for (let bz = bz0; bz <= bz1 && !found; bz++)
            if (b.isSolid(bx, by, bz)) { fx = bx; fy = by; fz = bz; found = true; }
    }
    if (!found) continue;

    const o = count * 3;
    scratch.aCells[o] = ax; scratch.aCells[o + 1] = ay; scratch.aCells[o + 2] = az;
    scratch.bCells[o] = fx; scratch.bCells[o + 1] = fy; scratch.bCells[o + 2] = fz;
    scratch.points[o] = wx; scratch.points[o + 1] = wy; scratch.points[o + 2] = wz;
    count++;

    if (wx < oMinX) oMinX = wx; if (wx > oMaxX) oMaxX = wx;
    if (wy < oMinY) oMinY = wy; if (wy > oMaxY) oMaxY = wy;
    if (wz < oMinZ) oMinZ = wz; if (wz > oMaxZ) oMaxZ = wz;
    sumWX += wx; sumWY += wy; sumWZ += wz;
  }

  if (count === 0) return null;

  // penetration ≈ the THINNEST extent of the contact box (cells span (n-1)*vs between centres,
  // so add one voxel for the cell width). The thin axis is the contact normal.
  const extX = oMaxX - oMinX + vs;
  const extY = oMaxY - oMinY + vs;
  const extZ = oMaxZ - oMinZ + vs;
  let depth = extX, axisIdx = 0;
  if (extY < depth) { depth = extY; axisIdx = 1; }
  if (extZ < depth) { depth = extZ; axisIdx = 2; }

  // axis = the thin world axis, signed from the contact centroid toward B's centre.
  const cax = sumWX / count, cay = sumWY / count, caz = sumWZ / count;
  qRot(b.quat[0], b.quat[1], b.quat[2], b.quat[3], (b.dims[0] * vs) / 2, (b.dims[1] * vs) / 2, (b.dims[2] * vs) / 2, _bc);
  const bcx = _bc[0] + b.pos[0], bcy = _bc[1] + b.pos[1], bcz = _bc[2] + b.pos[2];
  const axis: [number, number, number] = [0, 0, 0];
  axis[axisIdx] = 1;
  const toB = axisIdx === 0 ? bcx - cax : axisIdx === 1 ? bcy - cay : bcz - caz;
  if (toB < 0) axis[axisIdx] = -1;

  return { count, depth, axis, centroid: [cax, cay, caz] };
}
