import { G, VOXEL_SIZE, VOXEL_VOLUME, WATER_DENSITY } from "../core/constants";
import type { VoxelGrid } from "./voxelGrid";
import type { Compartment } from "./compartments";

/**
 * Probe-based Archimedes buoyancy (the spec's core trick): the hull's
 * displaced volume is partitioned into vertical columns, each represented by
 * one probe at the column's bottom. A probe's upward force scales with how
 * much of its column is below the local water surface, and is scaled toward
 * zero by the flood fraction of the compartment it passes through — so a
 * flooding ship loses lift exactly where the water is, and listing emerges.
 */
export interface Probe {
  local: [number, number, number]; // ship-local meters (column bottom center)
  volume: number; // m³ of displaced envelope this probe represents
  height: number; // m — column height (full submersion depth)
  compartmentId: number; // -1 if the column crosses no compartment
}

/**
 * Build probes from a hull grid by scanning 2×2-cell column groups.
 * A column's envelope spans from its lowest solid cell to its highest solid
 * cell; enclosed air (compartment cells) counts as displaced volume.
 */
export function makeProbes(grid: VoxelGrid, compartments: Compartment[]): Probe[] {
  const [nx, ny, nz] = grid.dims;
  const cellComp = new Map<number, number>();
  for (const c of compartments) {
    for (const cell of c.cells) cellComp.set(cell, c.id);
  }
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  const probes: Probe[] = [];
  const STEP = 2; // 2×2 cell column groups

  for (let gx = 0; gx < nx; gx += STEP) {
    for (let gz = 0; gz < nz; gz += STEP) {
      let cellCount = 0;
      let minY = ny;
      let maxY = -1;
      const compVotes = new Map<number, number>();

      for (let dx = 0; dx < STEP; dx++) {
        for (let dz = 0; dz < STEP; dz++) {
          const x = gx + dx;
          const z = gz + dz;
          if (x >= nx || z >= nz) continue;
          // column envelope: from lowest solid to highest solid; air cells in
          // between count when they belong to a compartment (enclosed)
          let lo = -1;
          let hi = -1;
          for (let y = 0; y < ny; y++) {
            if (grid.isSolid(x, y, z)) {
              if (lo === -1) lo = y;
              hi = y;
            }
          }
          if (lo === -1) continue;
          for (let y = lo; y <= hi; y++) {
            const solid = grid.isSolid(x, y, z);
            const comp = cellComp.get(idx(x, y, z));
            if (solid || comp !== undefined) {
              cellCount++;
              if (comp !== undefined) compVotes.set(comp, (compVotes.get(comp) ?? 0) + 1);
            }
          }
          if (lo < minY) minY = lo;
          if (hi > maxY) maxY = hi;
        }
      }

      if (cellCount === 0) continue;

      let compartmentId = -1;
      let best = 0;
      for (const [id, n] of compVotes) {
        if (n > best) {
          best = n;
          compartmentId = id;
        }
      }

      probes.push({
        local: [(gx + STEP / 2) * VOXEL_SIZE, minY * VOXEL_SIZE, (gz + STEP / 2) * VOXEL_SIZE],
        volume: cellCount * VOXEL_VOLUME,
        height: Math.max((maxY - minY + 1) * VOXEL_SIZE, VOXEL_SIZE),
        compartmentId,
      });
    }
  }
  return probes;
}

/**
 * TRUE PER-VOXEL buoyancy (round 16). One entry per occupied (x,z) hull column,
 * listing the displacing cells stacked in it. Each cell pushes up by
 * ρ·g·V_cell·(its own submerged fraction) at its own height — so a small bit of
 * the bow under water lifts LESS than a fat midship section under the same water,
 * and the hydrostatic stiffness is exactly ρ·g·(waterplane area) and CONSTANT with
 * draft (the playtest's "the threshold should be constant; she shouldn't sit 3 m
 * lower or higher"). The consumer samples the wave surface ONCE per column (height
 * depends only on x,z) and reuses it down the stack, so per-voxel accuracy costs
 * O(columns) wave evaluations, not O(cells).
 */
export interface VoxelColumn {
  /** ship-local center (m) of the column in the x,z plane (shared by every cell). */
  x: number;
  z: number;
  /** waterplane area this column occupies (m²) = VOXEL_SIZE² — the heave-stiffness unit. */
  area: number;
  /** ship-local center Y (m) of each displacing cell, ascending keel→deck. */
  cellY: number[];
  /** r18: on the OUTSIDE of the footprint (lacks a column neighbour on ≥1 of ±x/±z), where
   *  the hull skin meets the sea. Only edge columns throw waterline spray — interior columns
   *  sit under the deck, so their "waterline" is inside the ship. Computed once at build. */
  edge: boolean;
}

/** The set of compartment-enclosed (trapped-air) cells, packed `x + nx*(y + ny*z)`. STATIC for a
 *  hull — compartment cells never change once built (carving only adds breaches/openings) — so the
 *  caller builds it ONCE and reuses it across every column rebuild instead of re-walking ~10^5
 *  compartment cells each time. Shared by makeVoxelColumns and the incremental updateVoxelColumns. */
export function enclosedCellSet(compartments: Compartment[]): Set<number> {
  const enclosed = new Set<number>();
  for (const c of compartments) for (const cell of c.cells) enclosed.add(cell);
  return enclosed;
}

/** Build the ONE displacing column at grid (x,z), or null if it holds no displacing cell. The single
 *  source of truth for a column's shape (solid-or-enclosed cells between the lowest and highest solid
 *  cell). `edge` is left false here — it depends on neighbouring columns and is set by the edge pass. */
function buildColumnAt(grid: VoxelGrid, enclosed: Set<number>, x: number, z: number): VoxelColumn | null {
  const [nx, ny] = grid.dims;
  const idx = (xx: number, yy: number, zz: number) => xx + nx * (yy + ny * zz);
  let lo = -1;
  let hi = -1;
  for (let y = 0; y < ny; y++) {
    if (grid.isSolid(x, y, z)) {
      if (lo === -1) lo = y;
      hi = y;
    }
  }
  if (lo === -1) return null;
  const cellY: number[] = [];
  for (let y = lo; y <= hi; y++) {
    if (grid.isSolid(x, y, z) || enclosed.has(idx(x, y, z))) cellY.push((y + 0.5) * VOXEL_SIZE);
  }
  if (cellY.length === 0) return null;
  return { x: (x + 0.5) * VOXEL_SIZE, z: (z + 0.5) * VOXEL_SIZE, area: VOXEL_SIZE * VOXEL_SIZE, cellY, edge: false };
}

/** Recover the integer grid (x,z) a column sits on from its world-meter centre (exact: col.x = (x+½)·VS). */
function colGridX(col: VoxelColumn): number {
  return Math.round(col.x / VOXEL_SIZE - 0.5);
}
function colGridZ(col: VoxelColumn): number {
  return Math.round(col.z / VOXEL_SIZE - 0.5);
}

/** Build per-(x,z) columns of displacing cells. A cell displaces if it is solid OR
 *  enclosed by a compartment (a sealed hull's trapped air still pushes water) — the
 *  same envelope makeProbes uses, so the resting draft is unchanged. */
export function makeVoxelColumns(grid: VoxelGrid, compartments: Compartment[]): VoxelColumn[] {
  const [nx, , nz] = grid.dims;
  const enclosed = enclosedCellSet(compartments);

  const cols: VoxelColumn[] = [];
  const present = new Set<number>();
  for (let x = 0; x < nx; x++) {
    for (let z = 0; z < nz; z++) {
      const col = buildColumnAt(grid, enclosed, x, z);
      if (!col) continue;
      cols.push(col);
      present.add(x * nz + z);
    }
  }
  // r18: flag the footprint-boundary columns (the hull skin at the waterline). A column is an
  // edge if any 4-neighbour (x,z) has no column — including grid-edge neighbours (out of range
  // counts as absent). Keys are x*nz+z (unique within bounds, so no boundary aliasing).
  const has = (x: number, z: number) => x >= 0 && x < nx && z >= 0 && z < nz && present.has(x * nz + z);
  for (const col of cols) {
    const x = colGridX(col), z = colGridZ(col);
    col.edge = !has(x + 1, z) || !has(x - 1, z) || !has(x, z + 1) || !has(x, z - 1);
  }
  return cols;
}

/**
 * Incrementally rebuild ONLY the columns whose (x,z) changed, returning a list set-identical to a
 * full makeVoxelColumns rebuild. A carve touches a handful of (x,z) stripes, so this is O(changed·ny)
 * instead of O(nx·nz·ny) — the difference between updating ~10 columns and re-scanning all ~2,500
 * over a 470k-cell hull every flush (the dominant cost of recomputeMassProperties during a grind).
 *
 * `changedKeys` are packed `x*nz + z`. Carving only ever REMOVES cells, so a column can shrink or
 * vanish but never appear; a vanished column flips its surviving 4-neighbours to `edge`, so the edge
 * pass re-runs over the changed columns AND their neighbours. `enclosed` is the cached static set.
 * Column ORDER differs from a full rebuild (the consumers sum/maximise over columns — order-free).
 */
export function updateVoxelColumns(
  grid: VoxelGrid,
  enclosed: Set<number>,
  prev: VoxelColumn[],
  changedKeys: Iterable<number>,
  nx: number,
  nz: number,
): VoxelColumn[] {
  const byKey = new Map<number, VoxelColumn>();
  for (const col of prev) byKey.set(colGridX(col) * nz + colGridZ(col), col);

  // rebuild each changed column; collect it + its 4-neighbours as edge-dirty (a vanished column
  // changes its neighbours' edge status, a shrunk one doesn't — recomputing both is correct).
  const edgeDirty = new Set<number>();
  for (const key of changedKeys) {
    const x = Math.floor(key / nz), z = key % nz;
    const col = buildColumnAt(grid, enclosed, x, z);
    if (col) byKey.set(key, col);
    else byKey.delete(key);
    edgeDirty.add(key);
    if (x + 1 < nx) edgeDirty.add((x + 1) * nz + z);
    if (x - 1 >= 0) edgeDirty.add((x - 1) * nz + z);
    if (z + 1 < nz) edgeDirty.add(x * nz + (z + 1));
    if (z - 1 >= 0) edgeDirty.add(x * nz + (z - 1));
  }

  const has = (x: number, z: number) => x >= 0 && x < nx && z >= 0 && z < nz && byKey.has(x * nz + z);
  for (const key of edgeDirty) {
    const col = byKey.get(key);
    if (!col) continue;
    const x = Math.floor(key / nz), z = key % nz;
    col.edge = !has(x + 1, z) || !has(x - 1, z) || !has(x, z + 1) || !has(x, z - 1);
  }

  return [...byKey.values()];
}

/** A per-column keel/deck height-field baked from the voxel grid, for the ocean's
 *  VOXEL-ACCURATE, attitude-aware in-hull cut (round 14, P4). For every (x,z) grid
 *  column it stores the local-Y of the lowest solid cell (keel) and the top of the
 *  highest solid cell (deck). The ocean shader inverse-transforms each sea fragment
 *  into this same ship-local frame (the frame `Probe.local` lives in) and discards
 *  only sea genuinely between the column's keel and deck — so the cut follows the
 *  true hull plan (the pointed bow included) AND the live pose (no void when she
 *  bobs/pitches/rolls). Columns with no hull store deck < keel (a "no cut" sentinel). */
export interface HullProfile {
  nx: number;
  nz: number;
  /** nx*nz*2 floats, row-major idx = (z*nx + x)*2: [keelYLocal, deckYLocal] (m). */
  data: Float32Array;
  /** local-space span the grid occupies (uv = localXZ / [sizeX,sizeZ]). */
  sizeX: number;
  sizeZ: number;
}

export function buildHullProfile(grid: VoxelGrid): HullProfile {
  const [nx, ny, nz] = grid.dims;
  const data = new Float32Array(nx * nz * 2);
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      let lo = -1;
      let hi = -1;
      for (let y = 0; y < ny; y++) {
        if (grid.isSolid(x, y, z)) {
          if (lo === -1) lo = y;
          hi = y;
        }
      }
      const o = (z * nx + x) * 2;
      if (lo === -1) {
        data[o] = 1; // keel above deck → sentinel "no hull here, never cut"
        data[o + 1] = -1;
      } else {
        data[o] = lo * VOXEL_SIZE; // keel: bottom of lowest solid cell
        data[o + 1] = (hi + 1) * VOXEL_SIZE; // deck: top of highest solid cell
      }
    }
  }
  // local frame matches Probe.local: column (x,z) center = ((x+0.5)·VS, ·, (z+0.5)·VS),
  // grid corner at local 0 → uv = localXZ / (n·VS).
  return { nx, nz, data, sizeX: nx * VOXEL_SIZE, sizeZ: nz * VOXEL_SIZE };
}

/** 0..1 submerged fraction of the probe's column (bottom at worldY). */
export function submergedFraction(probe: Probe, worldY: number, surfaceY: number): number {
  const depth = surfaceY - worldY;
  if (depth <= 0) return 0;
  return Math.min(depth / probe.height, 1);
}

/**
 * Upward force (N) for one probe.
 * @param worldY     probe's current world height (column bottom)
 * @param surfaceY   water surface height at the probe's horizontal position
 * @param floodFrac  0..1 fill fraction of the probe's compartment
 *
 * IMPORTANT for consumers: apply this force at the centroid of the SUBMERGED
 * segment of the column — ship-local (x, y + submergedFraction·height/2, z) —
 * NOT at the column bottom. Applying at the bottom biases application points
 * deep in the ship frame; when heeled they swing toward the high side and the
 * ship becomes hydrostatically unstable (it turtles). Found empirically; the
 * regression lives in tests/stability.test.ts.
 */
export function probeForce(probe: Probe, worldY: number, surfaceY: number, floodFrac: number): number {
  const submerged = submergedFraction(probe, worldY, surfaceY);
  return WATER_DENSITY * G * probe.volume * submerged * (1 - floodFrac);
}

/** Test/diagnostic helper: total force using local positions as world positions. */
export function totalBuoyancy(
  probes: Probe[],
  surfaceAt: (p: Probe) => number,
  floodAt: (compartmentId: number) => number,
): number {
  let f = 0;
  for (const p of probes) {
    f += probeForce(p, p.local[1], surfaceAt(p), floodAt(p.compartmentId));
  }
  return f;
}
