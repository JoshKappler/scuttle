import { CHUNK_SIZE, VOXEL_SIZE } from "../core/constants";
import { IRON, MATERIALS } from "../sim/materials";
import type { VoxelGrid } from "../sim/voxelGrid";

/**
 * Greedy meshing of one 16³ chunk of a ship's voxel grid.
 * - Interior faces culled (checks neighbors across chunk borders via the grid).
 * - Coplanar same-material faces with identical per-corner AO merge into rects.
 * - Per-vertex ambient occlusion (corner occupancy) baked into vertex colors.
 * Positions are emitted in SHIP-LOCAL METERS including the chunk offset, so
 * all chunk meshes parent directly to the ship group with no per-chunk offset.
 */
export interface ChunkMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** Index COUNT belonging to the IRON/ballast material, packed at the TAIL of `indices`
   *  (wood faces fill [0, indices.length - ironIndexCount), iron faces the remainder). Lets the
   *  renderer give ballast its own OPAQUE iron material via two geometry groups, so distributed
   *  bilge iron reads as a solid block in the X cutaway instead of a translucent shell sharing
   *  the DoubleSide wood material. 0 when the chunk holds no iron. */
  ironIndexCount: number;
}

const AO_FACTOR = [0.5, 0.68, 0.84, 1.0];

/** Vertex AO level 0..3 from the two edge neighbors + corner neighbor. */
function vertexAo(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0));
}

export function meshChunk(grid: VoxelGrid, cx: number, cy: number, cz: number): ChunkMesh | null {
  const ox = cx * CHUNK_SIZE;
  const oy = cy * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  // wood (and every non-iron material) vs IRON/ballast faces, kept in separate index lists so the
  // renderer can split them into two opaque/translucent geometry groups (cutaway ballast = solid).
  const woodIdx: number[] = [];
  const ironIdx: number[] = [];

  // Sweep each axis d, both directions. u, v are the in-plane axes.
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    for (let dir = -1; dir <= 1; dir += 2) {
      // For every slice boundary along axis d
      for (let slice = 0; slice <= CHUNK_SIZE; slice++) {
        // mask over the u-v plane: 0 = no face, else a packed key
        const mask = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);
        const aoMask: number[][] = new Array(CHUNK_SIZE * CHUNK_SIZE);

        for (let i = 0; i < CHUNK_SIZE; i++) {
          for (let j = 0; j < CHUNK_SIZE; j++) {
            const cell = [0, 0, 0];
            cell[d] = dir === 1 ? slice - 1 : slice;
            cell[u] = i;
            cell[v] = j;
            const wx = ox + cell[0];
            const wy = oy + cell[1];
            const wz = oz + cell[2];
            // face exists if this cell is solid and the cell across the slice is not
            const here = inChunkRange(cell[d]) ? grid.get(wx, wy, wz) : 0;
            if (here === 0) continue;
            const across = [wx, wy, wz];
            across[d] += dir;
            if (grid.isSolid(across[0], across[1], across[2])) continue;

            // per-corner AO sampled in the face plane (one step along the normal)
            const ao = faceAo(grid, [wx, wy, wz], d, u, v, dir);
            const key = (here << 8) | (ao[0] << 6) | (ao[1] << 4) | (ao[2] << 2) | ao[3];
            mask[i + j * CHUNK_SIZE] = key;
            aoMask[i + j * CHUNK_SIZE] = ao;
          }
        }

        // greedy rectangle merge over the mask
        for (let j = 0; j < CHUNK_SIZE; j++) {
          for (let i = 0; i < CHUNK_SIZE; ) {
            const key = mask[i + j * CHUNK_SIZE];
            if (key === 0) {
              i++;
              continue;
            }
            // width
            let w = 1;
            while (i + w < CHUNK_SIZE && mask[i + w + j * CHUNK_SIZE] === key) w++;
            // height
            let h = 1;
            outer: while (j + h < CHUNK_SIZE) {
              for (let k = 0; k < w; k++) {
                if (mask[i + k + (j + h) * CHUNK_SIZE] !== key) break outer;
              }
              h++;
            }

            emitQuad(
              positions,
              normals,
              colors,
              woodIdx,
              ironIdx,
              key,
              aoMask[i + j * CHUNK_SIZE],
              d,
              u,
              v,
              dir,
              slice,
              i,
              j,
              w,
              h,
              ox,
              oy,
              oz,
            );

            for (let jj = 0; jj < h; jj++) {
              for (let ii = 0; ii < w; ii++) mask[i + ii + (j + jj) * CHUNK_SIZE] = 0;
            }
            i += w;
          }
        }
      }
    }
  }

  if (positions.length === 0) return null;
  // wood faces first, iron faces at the tail → the iron run is the last `ironIdx.length` indices.
  const indices = new Uint32Array(woodIdx.length + ironIdx.length);
  indices.set(woodIdx, 0);
  indices.set(ironIdx, woodIdx.length);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices,
    ironIndexCount: ironIdx.length,
  };
}

/**
 * Mesh an ENTIRE grid into one merged geometry by concatenating every chunk's
 * greedy mesh and re-basing its indices. Pure (no THREE) — reused by the static
 * island renderer and its trimesh collider. Element-wise concat avoids any
 * spread arg-count limit on densely-packed chunks.
 */
export function meshGrid(grid: VoxelGrid): ChunkMesh {
  const [nx, ny, nz] = grid.dims;
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  // keep wood and iron indices separate across chunks so the merged buffer also has all iron at the
  // tail (one clean group). Terrain grids carry no iron → ironOut stays empty.
  const woodOut: number[] = [];
  const ironOut: number[] = [];
  for (let cx = 0; cx <= Math.floor((nx - 1) / CHUNK_SIZE); cx++) {
    for (let cy = 0; cy <= Math.floor((ny - 1) / CHUNK_SIZE); cy++) {
      for (let cz = 0; cz <= Math.floor((nz - 1) / CHUNK_SIZE); cz++) {
        const m = meshChunk(grid, cx, cy, cz);
        if (!m) continue;
        const base = positions.length / 3;
        for (let i = 0; i < m.positions.length; i++) {
          positions.push(m.positions[i]);
          normals.push(m.normals[i]);
          colors.push(m.colors[i]);
        }
        // m.indices = [wood... , iron...]; the trailing m.ironIndexCount are the iron run.
        const woodEnd = m.indices.length - m.ironIndexCount;
        for (let i = 0; i < woodEnd; i++) woodOut.push(m.indices[i] + base);
        for (let i = woodEnd; i < m.indices.length; i++) ironOut.push(m.indices[i] + base);
      }
    }
  }
  const indices = new Uint32Array(woodOut.length + ironOut.length);
  indices.set(woodOut, 0);
  indices.set(ironOut, woodOut.length);
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Float32Array(colors),
    indices,
    ironIndexCount: ironOut.length,
  };
}

function inChunkRange(c: number): boolean {
  return c >= 0 && c < CHUNK_SIZE;
}

function faceAo(
  grid: VoxelGrid,
  cell: number[],
  d: number,
  u: number,
  v: number,
  dir: number,
): number[] {
  // sample the 8 neighbors in the plane one step out along the face normal
  const base = [...cell];
  base[d] += dir;
  const solidAt = (du: number, dv: number) => {
    const p = [...base];
    p[u] += du;
    p[v] += dv;
    return grid.isSolid(p[0], p[1], p[2]);
  };
  const nU = solidAt(-1, 0);
  const pU = solidAt(1, 0);
  const nV = solidAt(0, -1);
  const pV = solidAt(0, 1);
  // corners: (-,-), (+,-), (+,+), (-,+) matching vertex order below
  return [
    vertexAo(nU, nV, solidAt(-1, -1)),
    vertexAo(pU, nV, solidAt(1, -1)),
    vertexAo(pU, pV, solidAt(1, 1)),
    vertexAo(nU, pV, solidAt(-1, 1)),
  ];
}

function emitQuad(
  positions: number[],
  normals: number[],
  colors: number[],
  woodIdx: number[],
  ironIdx: number[],
  key: number,
  ao: number[],
  d: number,
  u: number,
  v: number,
  dir: number,
  slice: number,
  i: number,
  j: number,
  w: number,
  h: number,
  ox: number,
  oy: number,
  oz: number,
) {
  const mat = key >> 8;
  const [r, g, b] = MATERIALS[mat].color;

  // quad corners in chunk-local cell space
  const corner = (du: number, dv: number): [number, number, number] => {
    const p = [0, 0, 0];
    p[d] = slice;
    p[u] = i + du;
    p[v] = j + dv;
    return [(ox + p[0]) * VOXEL_SIZE, (oy + p[1]) * VOXEL_SIZE, (oz + p[2]) * VOXEL_SIZE];
  };
  // vertex order: (0,0) (w,0) (w,h) (0,h) — matches faceAo corner order
  const verts = [corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)];

  const n = [0, 0, 0];
  n[d] = dir;

  const vi = positions.length / 3;
  for (let k = 0; k < 4; k++) {
    positions.push(verts[k][0], verts[k][1], verts[k][2]);
    normals.push(n[0], n[1], n[2]);
    const f = AO_FACTOR[ao[k]];
    colors.push(r * f, g * f, b * f);
  }

  // winding: counter-clockwise when viewed from the +normal side
  // flip the diagonal when AO is anisotropic for better interpolation
  const flip = ao[0] + ao[2] > ao[1] + ao[3];
  let quad: number[];
  if (flip) {
    quad = dir > 0 ? [vi, vi + 1, vi + 2, vi, vi + 2, vi + 3] : [vi, vi + 2, vi + 1, vi, vi + 3, vi + 2];
  } else {
    quad = dir > 0 ? [vi + 1, vi + 2, vi + 3, vi + 1, vi + 3, vi] : [vi + 1, vi + 3, vi + 2, vi + 1, vi, vi + 3];
  }
  // route this face's indices to the IRON list (own opaque ballast material) or the wood list.
  (mat === IRON ? ironIdx : woodIdx).push(...quad);
}
