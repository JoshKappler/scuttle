import { CHUNK_SIZE } from "../core/constants";
import { CANVAS } from "../sim/materials";
import type { VoxelGrid } from "../sim/voxelGrid";

/**
 * Pure sheet-derivation math for the round-12 cloth sails (SP1). The voxel TRUTH is
 * unchanged — sim/shipwright stampRig lays 1-thin CANVAS sheets in the mast x-plane
 * between yard levels, cannonballs bore them, the sever sheds them — these helpers
 * derive the RENDER layer (one billowing plane per sheet + an R8 damage-occupancy
 * mask) from `build.sailVoxels[mi]` + the LIVE grid. No THREE imports: everything
 * here is deterministic and unit-tested in node (tests/sailMath.test.ts).
 */

export interface RigCell {
  x: number;
  y: number;
  z: number;
}

/** Voxel-space AABB of one sail sheet. All cells share the same x (the mast plane);
 *  w/h are the mask dimensions in texels (z- and y-extent respectively). */
export interface SheetBounds {
  x: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
  w: number;
  h: number;
}

/** Occupancy mask states (one byte per texel of the sheet's bounding rect).
 *  ALIVE = the cell still reads CANVAS in the live grid; DEAD = it was stamped as
 *  canvas but has been shot/severed away (the shader tears a jagged hole there);
 *  NEVER = inside the bounding rect but never cloth (the taper margin — hard cut). */
export const OCC_ALIVE = 255;
export const OCC_DEAD = 128;
export const OCC_NEVER = 0;

/**
 * Group one mast's sail cells (`build.sailVoxels[mi]`, all bays concatenated) into
 * y-contiguous runs — one run per BAY between consecutive yards (the yard rows are
 * SPAR, never canvas, so they are the natural separators). Order: ascending y.
 */
export function splitSheets(cells: RigCell[]): RigCell[][] {
  if (cells.length === 0) return [];
  // bucket by row, then walk rows ascending and cut at every y gap.
  const rows = new Map<number, RigCell[]>();
  for (const c of cells) {
    let row = rows.get(c.y);
    if (!row) rows.set(c.y, (row = []));
    row.push(c);
  }
  const ys = [...rows.keys()].sort((a, b) => a - b);
  const sheets: RigCell[][] = [];
  let current: RigCell[] | null = null;
  let prevY = Number.NEGATIVE_INFINITY;
  for (const y of ys) {
    if (y !== prevY + 1) {
      current = [];
      sheets.push(current);
    }
    current!.push(...rows.get(y)!);
    prevY = y;
  }
  return sheets;
}

/** Voxel AABB of one sheet's cells (null for an empty list). */
export function sheetBounds(cells: RigCell[]): SheetBounds | null {
  if (cells.length === 0) return null;
  let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const x = cells[0].x;
  for (const c of cells) {
    if (c.y < y0) y0 = c.y;
    if (c.y > y1) y1 = c.y;
    if (c.z < z0) z0 = c.z;
    if (c.z > z1) z1 = c.z;
  }
  return { x, y0, y1, z0, z1, w: z1 - z0 + 1, h: y1 - y0 + 1 };
}

/**
 * Build the 3-state occupancy mask for one sheet against the LIVE grid, row-major
 * with ix = z − z0 (u axis) and iy = y − y0 (v axis) — matching the plane's UV
 * layout in render/sailVisual.ts. `out` (length ≥ w·h) is reused when supplied so a
 * damage refresh never allocates. Returns the surviving/total canvas cell counts —
 * the render's own integrity readout (matches ship.sailIntegrity's surviving
 * fraction; the sheet hides when alive hits 0).
 */
export function buildOccupancy(
  grid: VoxelGrid,
  cells: RigCell[],
  b: SheetBounds,
  out?: Uint8Array,
): { mask: Uint8Array; alive: number; total: number } {
  const mask = out && out.length >= b.w * b.h ? out : new Uint8Array(b.w * b.h);
  mask.fill(OCC_NEVER, 0, b.w * b.h);
  let alive = 0;
  for (const c of cells) {
    const idx = (c.z - b.z0) + (c.y - b.y0) * b.w;
    if (grid.get(c.x, c.y, c.z) === CANVAS) {
      mask[idx] = OCC_ALIVE;
      alive++;
    } else {
      mask[idx] = OCC_DEAD;
    }
  }
  return { mask, alive, total: cells.length };
}

/**
 * Visual billow response from wind vs heading — render-side ONLY (per the round-12
 * orchestration it need not bit-match game/sailing.ts, which stays frozen).
 * Inputs are horizontal-plane vectors: wind dir = the direction the wind blows
 * TOWARD (sailing.Wind convention), fwd = the ship's bow (+x local, world-rotated).
 * Returns `fill` (0..1, canvas draws and bellies) and `luff` (0..1, head-to-wind
 * flogging — flutter amplitude up while the belly collapses).
 */
export function billowFactor(
  windDirX: number,
  windDirZ: number,
  fwdX: number,
  fwdZ: number,
): { fill: number; luff: number } {
  const wl = Math.hypot(windDirX, windDirZ);
  const fl = Math.hypot(fwdX, fwdZ);
  if (wl < 1e-6 || fl < 1e-6) return { fill: 0.5, luff: 0 }; // becalmed/degenerate: neutral drape
  // downwind "run" component: +1 dead run (wind from astern), −1 in irons.
  const run = (windDirX * fwdX + windDirZ * fwdZ) / (wl * fl);
  const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
  // full belly from a broad reach aft (run ≥ 0.4), collapsing toward the bow;
  // luff ramps in once she points closer than ~run −0.05 and flogs fully in irons.
  return {
    fill: clamp01((run + 0.25) / 0.65),
    luff: clamp01((0.05 - run) / 0.5),
  };
}

/** Does this sheet's voxel AABB intersect chunk (cx,cy,cz)? Drives the damage-mask
 *  refresh: only sheets whose bounds overlap a dirty chunk rebuild their texture. */
export function sheetTouchesChunk(b: SheetBounds, cx: number, cy: number, cz: number): boolean {
  const x0 = cx * CHUNK_SIZE, x1 = x0 + CHUNK_SIZE - 1;
  const y0 = cy * CHUNK_SIZE, y1 = y0 + CHUNK_SIZE - 1;
  const z0 = cz * CHUNK_SIZE, z1 = z0 + CHUNK_SIZE - 1;
  return b.x >= x0 && b.x <= x1 && b.y1 >= y0 && b.y0 <= y1 && b.z1 >= z0 && b.z0 <= z1;
}
