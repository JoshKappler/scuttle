import { createGrid, type VoxelGrid } from "./voxelGrid";
import { fbm2 } from "./noise";
import { DARKROCK, DIRT, EMPTY, GRASS, ROCK, SAND } from "./materials";

/**
 * Procedural voxel islandwright — the terrain analogue of sim/shipwright.ts.
 * Builds STATIONARY landmasses from analytic heightfields rasterized into a
 * voxel grid: radial-falloff dome × value noise for the surface, slope-driven
 * cliff faces, elevation-banded materials (beach / highland / rock core), and
 * scattered palms. Deterministic: same opts → same grid.
 *
 * The grid works in voxel space; `meta.waterlineY` is the row that maps to sea
 * level (world y≈0) — columns rising above it poke out of the water.
 */
export interface IslandOpts {
  seed: number;
  radiusVox: number; // plan-view island radius in voxels
  peakVox: number; // max terrain height above the seabed in voxels
  cliffiness: number; // 0..1 — how sheer the rim falloff is
}

export interface IslandMeta {
  waterlineY: number; // grid row that maps to sea level (world y≈0)
  radiusVox: number;
  peakVox: number;
  /** Harbor islands only: the dock anchor in VOXEL coords + facing (future docking hook). */
  dock: { x: number; y: number; z: number; bearing: number } | null;
}

export interface IslandModel {
  grid: VoxelGrid;
  meta: IslandMeta;
}

const SEABED_Y = 2; // a couple of rock rows for the seafloor base
const WATERLINE_FRAC = 0.18; // waterline sits this far up the height range

/** Height (voxel rows above SEABED_Y) of the terrain column at (x,z), 0 = open sea. */
function heightAt(o: IslandOpts, cx: number, cz: number, x: number, z: number): number {
  const dx = (x - cx) / o.radiusVox;
  const dz = (z - cz) / o.radiusVox;
  const r = Math.sqrt(dx * dx + dz * dz);
  if (r >= 1) return 0;
  // radial falloff: gentle dome, steepened near the rim by cliffiness → sheer walls
  const falloff = Math.pow(1 - r, 1 + o.cliffiness * 3);
  const n = fbm2(o.seed, x * 0.06, z * 0.06); // rolling terrain
  const ridge = fbm2(o.seed + 99, x * 0.13, z * 0.13); // finer detail
  const h = o.peakVox * falloff * (0.55 + 0.45 * n) * (0.7 + 0.3 * ridge);
  return Math.max(0, Math.floor(h));
}

export function buildIsland(o: IslandOpts): IslandModel {
  const margin = 4;
  const nx = o.radiusVox * 2 + margin * 2;
  const nz = o.radiusVox * 2 + margin * 2;
  const ny = SEABED_Y + o.peakVox + 2;
  const grid = createGrid(nx, ny, nz);
  const cx = nx / 2;
  const cz = nz / 2;
  const waterlineY = SEABED_Y + Math.floor(o.peakVox * WATERLINE_FRAC);

  const hgt: number[] = new Array(nx * nz).fill(0);
  for (let x = 0; x < nx; x++)
    for (let z = 0; z < nz; z++) hgt[x + z * nx] = heightAt(o, cx, cz, x, z);

  for (let x = 1; x < nx - 1; x++) {
    for (let z = 1; z < nz - 1; z++) {
      const h = hgt[x + z * nx];
      if (h <= 0) continue;
      const topY = SEABED_Y + h;
      // slope = largest height drop to a 4-neighbour → steep means a cliff face
      const slope = Math.max(
        h - hgt[x - 1 + z * nx],
        h - hgt[x + 1 + z * nx],
        h - hgt[x + (z - 1) * nx],
        h - hgt[x + (z + 1) * nx],
        0,
      );
      for (let y = 0; y <= topY && y < ny; y++) {
        let mat: number;
        if (y < SEABED_Y) mat = ROCK; // seafloor base
        else if (slope >= 3) mat = y > topY - 2 ? ROCK : DARKROCK; // cliff face
        else if (y === topY && topY <= waterlineY + 2) mat = SAND; // beach band
        else if (y === topY) mat = GRASS; // highland surface
        else if (y >= topY - 2) mat = DIRT; // subsoil
        else mat = ROCK; // core
        if (mat !== EMPTY) grid.set(x, y, z, mat);
      }
    }
  }

  return {
    grid,
    meta: { waterlineY, radiusVox: o.radiusVox, peakVox: o.peakVox, dock: null },
  };
}
