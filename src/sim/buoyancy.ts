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
