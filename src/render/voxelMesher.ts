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

/**
 * Round-12 SP4 pooling: an optional grow-ONLY output buffer a caller can pass to `meshChunk` via
 * `into` to skip allocating fresh Float32Array/Uint32Array output on every remesh. Only
 * `render/shipVisual.ts` (the hot damage-driven remesh path) passes one — debris/character/
 * islands keep the default fresh-array behavior (spawn-time only, and the returned arrays there
 * outlive a single frame, so aliasing a shared scratch would be unsafe for them). The caller must
 * consume (copy out of) the returned `ChunkMesh`'s arrays BEFORE the next `meshChunk(..., into)`
 * call — they are `subarray` VIEWS over `into`'s buffers, reused/regrown in place next call.
 */
export interface MeshScratch {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

/** A fresh grow-only scratch buffer, sized for a typical chunk (grows 1.5× on overflow). */
export function createMeshScratch(vertCap = 2048, idxCap = 4096): MeshScratch {
  return {
    positions: new Float32Array(vertCap * 3),
    normals: new Float32Array(vertCap * 3),
    colors: new Float32Array(vertCap * 3),
    indices: new Uint32Array(idxCap),
  };
}

function ensureF32(buf: Float32Array, needed: number): Float32Array {
  return buf.length >= needed ? buf : new Float32Array(Math.ceil(needed * 1.5));
}
function ensureU32(buf: Uint32Array, needed: number): Uint32Array {
  return buf.length >= needed ? buf : new Uint32Array(Math.ceil(needed * 1.5));
}

const AO_FACTOR = [0.5, 0.68, 0.84, 1.0];

/** Vertex AO level 0..3 from the two edge neighbors + corner neighbor. */
function vertexAo(side1: boolean, side2: boolean, corner: boolean): number {
  if (side1 && side2) return 0;
  return 3 - ((side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0));
}

// Module-level per-slice scratch, cleared/reset each slice instead of allocating a fresh
// `new Int32Array(256)` + `new Array(256)` every one of the ~6·17 slices per chunk (×re-mesh).
// meshChunk is single-threaded + non-reentrant (no async between fills), so sharing is safe.
const scratchMask = new Int32Array(CHUNK_SIZE * CHUNK_SIZE);
const scratchAo: (number[] | undefined)[] = new Array(CHUNK_SIZE * CHUNK_SIZE);

// Module-level per-CALL accumulators (round-12 SP4), reset (`.length = 0`) at the top of every
// meshChunk instead of `const positions: number[] = []` etc. allocating 5 fresh arrays per call —
// same non-reentrancy rationale as scratchMask/scratchAo above (one synchronous sweep at a time).
const scratchPositions: number[] = [];
const scratchNormals: number[] = [];
const scratchColors: number[] = [];
const scratchWoodIdx: number[] = [];
const scratchIronIdx: number[] = [];

/**
 * Greedy-mesh one chunk. `visible(x,y,z)` is an OPTIONAL cutaway predicate (ship-local cell coords):
 * a cell is treated as present for face-emission ONLY where it is solid AND `visible` returns true.
 * Making the cut-away half read as EMPTY makes the mesher auto-emit the newly-exposed INTERNAL faces
 * of the surviving cells → a SOLID capped cross-section of whole voxels (ballast cap = solid iron, no
 * holes), so no GPU clip plane is needed for the hull. Omitting the predicate is the unchanged build.
 * `into` (round-12 SP4, optional) — see `MeshScratch` — reuses a grow-only output buffer instead of
 * allocating fresh typed arrays for the returned `ChunkMesh` (only `shipVisual.ts` passes one).
 */
export function meshChunk(
  grid: VoxelGrid,
  cx: number,
  cy: number,
  cz: number,
  visible?: (x: number, y: number, z: number) => boolean,
  into?: MeshScratch,
): ChunkMesh | null {
  const ox = cx * CHUNK_SIZE;
  const oy = cy * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  // a solid cell counts ONLY if it's also visible (cutaway): the cut half reads as empty, so the
  // surviving half's now-exposed inner faces emit (a filled cross-section) and AO ignores the cut half.
  const solidVis = (x: number, y: number, z: number): boolean =>
    grid.isSolid(x, y, z) && (!visible || visible(x, y, z));

  const positions = scratchPositions; positions.length = 0;
  const normals = scratchNormals; normals.length = 0;
  const colors = scratchColors; colors.length = 0;
  // wood (and every non-iron material) vs IRON/ballast faces, kept in separate index lists so the
  // renderer can split them into two opaque/translucent geometry groups (cutaway ballast = solid).
  const woodIdx = scratchWoodIdx; woodIdx.length = 0;
  const ironIdx = scratchIronIdx; ironIdx.length = 0;

  // Sweep each axis d, both directions. u, v are the in-plane axes.
  for (let d = 0; d < 3; d++) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    for (let dir = -1; dir <= 1; dir += 2) {
      // For every slice boundary along axis d
      for (let slice = 0; slice <= CHUNK_SIZE; slice++) {
        // mask over the u-v plane: 0 = no face, else a packed key. Reuse the module scratch
        // (cleared per slice) instead of allocating per slice.
        const mask = scratchMask;
        mask.fill(0);
        const aoMask = scratchAo;

        for (let i = 0; i < CHUNK_SIZE; i++) {
          for (let j = 0; j < CHUNK_SIZE; j++) {
            const cell = [0, 0, 0];
            cell[d] = dir === 1 ? slice - 1 : slice;
            cell[u] = i;
            cell[v] = j;
            const wx = ox + cell[0];
            const wy = oy + cell[1];
            const wz = oz + cell[2];
            // face exists if this cell is solid+visible and the cell across the slice is not
            const here = inChunkRange(cell[d]) && solidVis(wx, wy, wz) ? grid.get(wx, wy, wz) : 0;
            if (here === 0) continue;
            const across = [wx, wy, wz];
            across[d] += dir;
            if (solidVis(across[0], across[1], across[2])) continue;

            // per-corner AO sampled in the face plane (one step along the normal)
            const ao = faceAo([wx, wy, wz], d, u, v, dir, solidVis);
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
              aoMask[i + j * CHUNK_SIZE]!, // set whenever key !== 0 (same cell wrote both)
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
  const totalIdx = woodIdx.length + ironIdx.length;
  if (into) {
    // grow-only reuse (round-12 SP4): grow `into`'s buffers in place when this chunk's data
    // outgrows them (1.5× slack so a further growth spurt doesn't thrash), else reuse as-is.
    // The RETURNED arrays are `subarray` VIEWS — the caller must consume them before the next
    // `meshChunk(..., into)` call reuses the same backing buffers.
    into.positions = ensureF32(into.positions, positions.length);
    into.normals = ensureF32(into.normals, normals.length);
    into.colors = ensureF32(into.colors, colors.length);
    into.indices = ensureU32(into.indices, totalIdx);
    into.positions.set(positions, 0);
    into.normals.set(normals, 0);
    into.colors.set(colors, 0);
    into.indices.set(woodIdx, 0);
    into.indices.set(ironIdx, woodIdx.length);
    return {
      positions: into.positions.subarray(0, positions.length),
      normals: into.normals.subarray(0, normals.length),
      colors: into.colors.subarray(0, colors.length),
      indices: into.indices.subarray(0, totalIdx),
      ironIndexCount: ironIdx.length,
    };
  }
  const indices = new Uint32Array(totalIdx);
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
  cell: number[],
  d: number,
  u: number,
  v: number,
  dir: number,
  // occupancy test = solid AND (under cutaway) visible — so a cap face exposed by the cut isn't
  // darkened by the now-hidden near voxels it abuts (they read as empty here, same as to the mesher).
  solidVis: (x: number, y: number, z: number) => boolean,
): number[] {
  // sample the 8 neighbors in the plane one step out along the face normal
  const base = [...cell];
  base[d] += dir;
  const solidAt = (du: number, dv: number) => {
    const p = [...base];
    p[u] += du;
    p[v] += dv;
    return solidVis(p[0], p[1], p[2]);
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
