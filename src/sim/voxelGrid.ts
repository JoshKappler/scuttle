import { CHUNK_SIZE, VOXEL_SIZE, VOXEL_VOLUME } from "../core/constants";
import { MATERIALS } from "./materials";

/**
 * Dense voxel grid for one ship. Stores a material id per cell (0 = empty).
 * Pure data structure — no rendering or physics imports. Mutations track
 * dirty 16³ chunks for incremental remeshing; mutations on a chunk border
 * also dirty the neighbor (its border faces may appear/disappear).
 */
export interface VoxelGrid {
  dims: [number, number, number];
  data: Int8Array;
  dirtyChunks: Set<string>;
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, mat: number): void;
  remove(x: number, y: number, z: number): boolean;
  isSolid(x: number, y: number, z: number): boolean;
  solidCount(): number;
  totalMass(): number;
  /** Local-space center of mass in meters (cell centers). */
  centerOfMass(): [number, number, number];
  /** One pass: mass (kg), local-space COM (m), and the principal-DIAGONAL inertia (kg·m²)
   *  about that COM — the EXACT tensor for the current voxels, not a box approximation. Used
   *  after carving so an asymmetrically-holed hull gets honest roll/pitch/yaw inertia (a
   *  mass-only rescale leaves it stable-looking but actually unstable → it turtles). */
  massProperties(): { mass: number; com: [number, number, number]; inertia: [number, number, number] };
  forEachSolid(fn: (x: number, y: number, z: number, mat: number) => void): void;
}

export function createGrid(nx: number, ny: number, nz: number): VoxelGrid {
  const data = new Int8Array(nx * ny * nz);
  const dirtyChunks = new Set<string>();
  let solids = 0;

  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const inBounds = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz;

  function markDirty(x: number, y: number, z: number): void {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    dirtyChunks.add(`${cx},${cy},${cz}`);
    // border cells affect the neighboring chunk's culled faces
    const lx = x % CHUNK_SIZE;
    const ly = y % CHUNK_SIZE;
    const lz = z % CHUNK_SIZE;
    if (lx === 0 && cx > 0) dirtyChunks.add(`${cx - 1},${cy},${cz}`);
    if (ly === 0 && cy > 0) dirtyChunks.add(`${cx},${cy - 1},${cz}`);
    if (lz === 0 && cz > 0) dirtyChunks.add(`${cx},${cy},${cz - 1}`);
    if (lx === CHUNK_SIZE - 1) dirtyChunks.add(`${cx + 1},${cy},${cz}`);
    if (ly === CHUNK_SIZE - 1) dirtyChunks.add(`${cx},${cy + 1},${cz}`);
    if (lz === CHUNK_SIZE - 1) dirtyChunks.add(`${cx},${cy},${cz + 1}`);
  }

  return {
    dims: [nx, ny, nz],
    data,
    dirtyChunks,

    get(x, y, z) {
      return inBounds(x, y, z) ? data[idx(x, y, z)] : 0;
    },

    set(x, y, z, mat) {
      if (!inBounds(x, y, z)) return;
      const i = idx(x, y, z);
      if (data[i] === 0 && mat !== 0) solids++;
      else if (data[i] !== 0 && mat === 0) solids--;
      data[i] = mat;
      markDirty(x, y, z);
    },

    remove(x, y, z) {
      if (!inBounds(x, y, z) || data[idx(x, y, z)] === 0) return false;
      data[idx(x, y, z)] = 0;
      solids--;
      markDirty(x, y, z);
      return true;
    },

    isSolid(x, y, z) {
      return inBounds(x, y, z) && data[idx(x, y, z)] !== 0;
    },

    solidCount() {
      return solids;
    },

    totalMass() {
      let m = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0) m += MATERIALS[data[i]].density * VOXEL_VOLUME;
      }
      return m;
    },

    centerOfMass() {
      let m = 0;
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            const mat = data[idx(x, y, z)];
            if (mat === 0) continue;
            const w = MATERIALS[mat].density * VOXEL_VOLUME;
            m += w;
            cx += (x + 0.5) * w;
            cy += (y + 0.5) * w;
            cz += (z + 0.5) * w;
          }
        }
      }
      if (m === 0) return [0, 0, 0];
      return [(cx / m) * VOXEL_SIZE, (cy / m) * VOXEL_SIZE, (cz / m) * VOXEL_SIZE];
    },

    massProperties() {
      let m = 0, mx = 0, my = 0, mz = 0; // mass + first moments (about origin)
      let sxx = 0, syy = 0, szz = 0;     // second moments about origin
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            const mat = data[idx(x, y, z)];
            if (mat === 0) continue;
            const wgt = MATERIALS[mat].density * VOXEL_VOLUME;
            const px = (x + 0.5) * VOXEL_SIZE, py = (y + 0.5) * VOXEL_SIZE, pz = (z + 0.5) * VOXEL_SIZE;
            m += wgt; mx += wgt * px; my += wgt * py; mz += wgt * pz;
            sxx += wgt * (py * py + pz * pz);
            syy += wgt * (px * px + pz * pz);
            szz += wgt * (px * px + py * py);
          }
        }
      }
      if (m === 0) return { mass: 0, com: [0, 0, 0] as [number, number, number], inertia: [1, 1, 1] as [number, number, number] };
      const cx = mx / m, cy = my / m, cz = mz / m;
      // parallel-axis shift to the COM: I_com = I_origin − m·d²  (clamped ≥1 to stay positive-definite)
      const ixx = Math.max(sxx - m * (cy * cy + cz * cz), 1);
      const iyy = Math.max(syy - m * (cx * cx + cz * cz), 1);
      const izz = Math.max(szz - m * (cx * cx + cy * cy), 1);
      return { mass: m, com: [cx, cy, cz], inertia: [ixx, iyy, izz] };
    },

    forEachSolid(fn) {
      for (let z = 0; z < nz; z++) {
        for (let y = 0; y < ny; y++) {
          for (let x = 0; x < nx; x++) {
            const mat = data[idx(x, y, z)];
            if (mat !== 0) fn(x, y, z, mat);
          }
        }
      }
    },
  };
}
