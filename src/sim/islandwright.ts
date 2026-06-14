import { createGrid, type VoxelGrid } from "./voxelGrid";
import { Rng } from "../core/rng";
import { fbm2 } from "./noise";
import { DARKROCK, DIRT, EMPTY, FOLIAGE, GRASS, OAK, PALMWOOD, PINE, ROCK, SAND } from "./materials";

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

  scatterPalms(grid, o, hgt, waterlineY);

  return {
    grid,
    meta: { waterlineY, radiusVox: o.radiusVox, peakVox: o.peakVox, dock: null },
  };
}

/**
 * The harbor island: a flatter, lower landmass with a leveled town shelf, a
 * voxel pier reaching out over the water on pylons, and a few voxel buildings.
 * `meta.dock` carries the seaward pier-end anchor (voxel coords) for the future
 * docking interaction. Deterministic for a seed.
 */
export function buildHarborIsland(opts: { seed: number }): IslandModel {
  // flatter + lower than a wild island so the town sits on gentle ground
  const model = buildIsland({ seed: opts.seed, radiusVox: 46, peakVox: 20, cliffiness: 0.25 });
  const { grid, meta } = model;
  const [nx, ny, nz] = grid.dims;
  const cx = Math.floor(nx / 2);
  const cz = Math.floor(nz / 2);
  const shelfY = meta.waterlineY + 2; // town/dock deck level, a touch above the sea

  // flatten a circular town shelf near the centre: clear above shelfY, fill to it
  const townR = 16;
  for (let x = cx - townR; x <= cx + townR; x++)
    for (let z = cz - townR; z <= cz + townR; z++) {
      if (x < 1 || z < 1 || x >= nx - 1 || z >= nz - 1) continue;
      if ((x - cx) ** 2 + (z - cz) ** 2 > townR * townR) continue;
      for (let y = shelfY + 1; y < ny; y++) grid.remove(x, y, z);
      for (let y = SEABED_Y; y <= shelfY; y++)
        if (grid.get(x, y, z) === EMPTY) grid.set(x, y, z, y === shelfY ? DIRT : ROCK);
    }

  // pier: a 3-wide plank run marching out +x from the shelf edge across the water,
  // on OAK pylons every 3 m
  const pierZ = cz;
  const pierStartX = cx + townR - 2;
  const pierLen = 26;
  for (let i = 0; i < pierLen; i++) {
    const x = pierStartX + i;
    if (x >= nx - 1) break;
    for (let dz = -1; dz <= 1; dz++) grid.set(x, shelfY, clampZ(pierZ + dz, nz), PINE); // deck
    if (i % 3 === 0)
      for (const dz of [-1, 1])
        for (let y = SEABED_Y; y < shelfY; y++) grid.set(x, y, clampZ(pierZ + dz, nz), OAK);
  }
  meta.dock = { x: pierStartX + pierLen, y: shelfY, z: pierZ, bearing: 0 }; // +x end, faces +x

  // buildings: a tavern + huts + harbormaster's shack around the shelf
  const rng = new Rng(`town-${opts.seed}`);
  const lots = [
    { x: cx - 8, z: cz - 7, w: 7, d: 6, h: 6 }, // tavern (bigger)
    { x: cx + 4, z: cz - 8, w: 5, d: 5, h: 5 },
    { x: cx - 9, z: cz + 5, w: 5, d: 5, h: 5 },
    { x: cx + 6, z: cz + 6, w: 5, d: 4, h: 4 }, // harbormaster's shack
  ];
  for (const lot of lots) stampBuilding(grid, lot, shelfY, rng);

  return model;
}

function clampZ(z: number, nz: number): number {
  return Math.min(Math.max(z, 0), nz - 1);
}

/** A hollow voxel hut: OAK corner posts + PINE walls, a doorway, a couple of
 *  windows, and a stepped-pitch PINE roof. */
function stampBuilding(
  grid: VoxelGrid,
  lot: { x: number; z: number; w: number; d: number; h: number },
  floorY: number,
  rng: Rng,
): void {
  const { x: x0, z: z0, w, d, h } = lot;
  for (let dx = 0; dx < w; dx++)
    for (let dz = 0; dz < d; dz++)
      for (let dy = 1; dy <= h; dy++) {
        const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
        if (!edge) continue;
        const corner = (dx === 0 || dx === w - 1) && (dz === 0 || dz === d - 1);
        const isDoor = dz === 0 && dx === ((w / 2) | 0) && dy <= 2;
        const isWindow = !corner && dy === 3 && (dx + dz) % 2 === 0;
        if (isDoor || isWindow) continue;
        grid.set(x0 + dx, floorY + dy, z0 + dz, corner ? OAK : PINE);
      }
  // pitched roof: shrinking PINE rings stepping up toward the ridge
  for (let r = 0; r <= Math.ceil(Math.min(w, d) / 2); r++) {
    const ry = floorY + h + 1 + r;
    for (let dx = r; dx < w - r; dx++)
      for (let dz = r; dz < d - r; dz++)
        if (dx === r || dx === w - 1 - r || dz === r || dz === d - 1 - r)
          grid.set(x0 + dx, ry, z0 + dz, PINE);
  }
  void rng; // reserved for future per-building variation
}

/** Stamp a deterministic handful of palms (PALMWOOD trunk + FOLIAGE canopy) onto
 *  grass columns, so the whole island stays a single voxel mesh. */
function scatterPalms(grid: VoxelGrid, o: IslandOpts, hgt: number[], _waterlineY: number): void {
  const [nx, ny, nz] = grid.dims;
  const rng = new Rng(`palms-${o.seed}`);
  const count = Math.round(o.radiusVox / 6);
  for (let i = 0; i < count; i++) {
    const x = rng.int(2, nx - 2);
    const z = rng.int(2, nz - 2);
    if (hgt[x + z * nx] <= 0) continue;
    const topY = SEABED_Y + hgt[x + z * nx];
    if (grid.get(x, topY, z) !== GRASS) continue; // palms only on grass
    const trunk = rng.int(5, 9);
    for (let t = 1; t <= trunk && topY + t < ny; t++) grid.set(x, topY + t, z, PALMWOOD);
    const cy = topY + trunk;
    for (let dx = -2; dx <= 2; dx++) // a +-shaped frond canopy
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 2) continue;
        const px = x + dx;
        const pz = z + dz;
        if (px > 0 && px < nx && pz > 0 && pz < nz && cy < ny && grid.get(px, cy, pz) === EMPTY)
          grid.set(px, cy, pz, FOLIAGE);
      }
  }
}
