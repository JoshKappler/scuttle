import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import { createGrid, type VoxelGrid } from "./voxelGrid";
import { Rng } from "../core/rng";
import { DARKROCK, DIRT, EMPTY, FOLIAGE, GRASS, OAK, PALMWOOD, PINE, ROCK, SAND } from "./materials";

/**
 * Procedural voxel islandwright — the terrain analogue of sim/shipwright.ts.
 * Builds STATIONARY landmasses from a real noise field (simplex-noise) rather
 * than a smooth radial dome: domain-warped fBm + ridged multifractal relief +
 * a NOISY coastline (land = where the field crosses a threshold, not a circle)
 * give jagged, irregular islands with sheer rock cliffs. Deterministic: same
 * opts → same grid (the noise is seeded from a deterministic Rng).
 *
 * The grid works in voxel space; `meta.waterlineY` is the row that maps to sea
 * level (world y≈0) — columns rising above it poke out of the water.
 */
export interface IslandOpts {
  seed: number;
  radiusVox: number; // plan-view island radius in voxels (the coastline wobbles inside this)
  peakVox: number; // rough max terrain height above the seabed in voxels
  ruggedness: number; // 0..1 — smooth rolling (0) → jagged ridges + sheer cliffs (1)
  marginVox?: number; // open-water voxels ringing the land (default 6); harbor uses more for its pier
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

const SEABED_Y = 2; // rock rows for the seafloor base, below the waterline
const WATERLINE_Y = SEABED_Y + 1; // coastal land sits right at the waterline

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** Standard fBm in [-1,1]: octaves of simplex, halving amplitude / doubling frequency. */
function fbm(noise: NoiseFunction2D, x: number, z: number, octaves: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Ridged multifractal in [0,1]: 1-|noise| squared → sharp ridge lines and valleys. */
function ridged(noise: NoiseFunction2D, x: number, z: number, octaves: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise(x * freq, z * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Build the per-column height field (voxel rows above SEABED_Y; 0 = open sea). */
function makeHeightField(o: IslandOpts, nx: number, nz: number): Int16Array {
  const rng = new Rng(`isle-${o.seed}`);
  const rand = () => rng.next();
  const elev = createNoise2D(rand);
  const warp = createNoise2D(rand);
  const ridge = createNoise2D(rand);

  const cx = nx / 2;
  const cz = nz / 2;
  const F = 2.6 / o.radiusVox; // a few big lobes across the island
  const warpAmp = o.radiusVox * 0.4; // domain-warp distance → breaks radial symmetry
  const rug = o.ruggedness;

  const hgt = new Int16Array(nx * nz);
  for (let x = 0; x < nx; x++) {
    for (let z = 0; z < nz; z++) {
      const dx = (x - cx) / o.radiusVox;
      const dz = (z - cz) / o.radiusVox;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d >= 0.99) continue; // hard sea ring at the rim (keeps the grid edge open water)

      // domain warp the sample point so nothing reads as a clean circle/dome
      const wx = x + warpAmp * warp(x * F * 0.7, z * F * 0.7);
      const wz = z + warpAmp * warp(x * F * 0.7 + 41, z * F * 0.7 + 17);

      const base = 0.5 + 0.5 * fbm(elev, wx * F, wz * F, 4); // [0,1] rolling landform
      const rg = ridged(ridge, wx * F * 1.1, wz * F * 1.1, 3); // [0,1] broad ridge lines
      // base shape dominates so islands read as terrain; ridges add cliffs + relief
      // (not a pure spike field) — the steeper the result, the more rock cliff shows
      let land = base * (1 - rug * 0.35) + rg * (rug * 0.5);

      // soft radial falloff — but the COASTLINE is where `land` crosses sea level,
      // so it follows the noise (bays, spits, inlets) instead of a circle
      land -= smoothstep(0.32, 1.0, d) * 1.15;
      if (land <= 0.16) continue; // sea

      const e = Math.min(land - 0.16, 1.1);
      hgt[x + z * nx] = 1 + Math.floor(e * o.peakVox * 0.85);
    }
  }
  return hgt;
}

export function buildIsland(o: IslandOpts): IslandModel {
  const margin = o.marginVox ?? 6;
  const nx = o.radiusVox * 2 + margin * 2;
  const nz = o.radiusVox * 2 + margin * 2;
  const ny = SEABED_Y + Math.ceil(o.peakVox * 1.05) + 4;
  const grid = createGrid(nx, ny, nz);

  const hgt = makeHeightField(o, nx, nz);

  for (let x = 1; x < nx - 1; x++) {
    for (let z = 1; z < nz - 1; z++) {
      const h = hgt[x + z * nx];
      if (h <= 0) continue;
      const topY = Math.min(SEABED_Y + h, ny - 1);
      // slope = largest height drop to a 4-neighbour → steep means a cliff face
      const slope = Math.max(
        h - hgt[x - 1 + z * nx],
        h - hgt[x + 1 + z * nx],
        h - hgt[x + (z - 1) * nx],
        h - hgt[x + (z + 1) * nx],
        0,
      );
      for (let y = 0; y <= topY; y++) {
        let mat: number;
        if (y < SEABED_Y) mat = ROCK; // seafloor base
        else if (slope >= 3) mat = y > topY - 3 ? ROCK : DARKROCK; // sheer cliff face
        else if (y === topY) mat = topY <= WATERLINE_Y + 2 ? SAND : GRASS; // beach vs highland
        else if (y >= topY - 2) mat = DIRT; // subsoil
        else mat = ROCK; // core
        if (mat !== EMPTY) grid.set(x, y, z, mat);
      }
    }
  }

  scatterPalms(grid, o, hgt);

  return {
    grid,
    meta: { waterlineY: WATERLINE_Y, radiusVox: o.radiusVox, peakVox: o.peakVox, dock: null },
  };
}

/** Highest solid voxel y in a column, or -1 if the column is open water. */
function topSolid(grid: VoxelGrid, x: number, z: number): number {
  for (let y = grid.dims[1] - 1; y >= 0; y--) if (grid.isSolid(x, y, z)) return y;
  return -1;
}

/**
 * The harbor island: a smaller, gentler landmass sitting in a grid with extra
 * open-water margin, so its town clearing has real sea around it for the dock.
 * A leveled town shelf carries voxel buildings; a 5-wide pier marches +x from the
 * shelf, across the beach and out over the water on OAK pylons (placed only where
 * they actually stand in water). `meta.dock` is the seaward pier-end anchor for
 * the future docking interaction.
 */
export function buildHarborIsland(opts: { seed: number }): IslandModel {
  // small island + a wide water ring so the pier has somewhere to go
  const model = buildIsland({ seed: opts.seed, radiusVox: 50, peakVox: 18, ruggedness: 0.3, marginVox: 40 });
  const { grid, meta } = model;
  const [nx, ny, nz] = grid.dims;
  const cx = Math.floor(nx / 2);
  const cz = Math.floor(nz / 2);
  const shelfY = meta.waterlineY + 3; // town/dock deck level, above the sea

  // flatten a circular town shelf at the centre: clear above shelfY, fill up to it
  const townR = 30;
  for (let x = cx - townR; x <= cx + townR; x++)
    for (let z = cz - townR; z <= cz + townR; z++) {
      if (x < 1 || z < 1 || x >= nx - 1 || z >= nz - 1) continue;
      if ((x - cx) ** 2 + (z - cz) ** 2 > townR * townR) continue;
      for (let y = shelfY + 1; y < ny; y++) grid.remove(x, y, z);
      for (let y = SEABED_Y; y <= shelfY; y++)
        if (grid.get(x, y, z) === EMPTY) grid.set(x, y, z, y === shelfY ? DIRT : ROCK);
    }

  // pier: a 5-wide PINE boardwalk from the shelf edge out +x across the beach and
  // over the water. The deck cuts cleanly through any low rim; OAK pylons drop to
  // the seabed only on the columns that actually overhang water.
  const pierZ = cz;
  const pierStartX = cx + townR - 2;
  const pierEnd = Math.min(pierStartX + 46, nx - 2);
  for (let x = pierStartX; x <= pierEnd; x++) {
    for (let dz = -2; dz <= 2; dz++) {
      const z = clampZ(pierZ + dz, nz);
      for (let y = shelfY + 1; y < ny; y++) grid.remove(x, y, z); // clear the boardwalk channel
      grid.set(x, shelfY, z, PINE); // deck
      if ((dz === -2 || dz === 2) && x % 4 === 0 && topSolid(grid, x, z) < shelfY - 1)
        for (let y = SEABED_Y; y < shelfY; y++) grid.set(x, y, z, OAK); // pylon, over water only
    }
  }
  meta.dock = { x: pierEnd, y: shelfY, z: pierZ, bearing: 0 }; // +x end, faces seaward (+x)

  // buildings: a tavern + warehouses + huts + harbormaster's shack around the shelf
  const rng = new Rng(`town-${opts.seed}`);
  const lots = [
    { x: cx - 22, z: cz - 14, w: 18, d: 14, h: 14 }, // tavern (big)
    { x: cx - 2, z: cz - 22, w: 13, d: 12, h: 11 }, // warehouse
    { x: cx - 24, z: cz + 8, w: 12, d: 12, h: 10 },
    { x: cx + 8, z: cz + 14, w: 11, d: 10, h: 9 }, // harbormaster's shack
    { x: cx - 6, z: cz + 22, w: 10, d: 9, h: 9 },
  ];
  for (const lot of lots) stampBuilding(grid, lot, shelfY, rng);

  return model;
}

function clampZ(z: number, nz: number): number {
  return Math.min(Math.max(z, 0), nz - 1);
}

/** A hollow voxel building: OAK corner posts + PINE walls, a doorway, windows,
 *  and a stepped-pitch PINE roof. */
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
        const isDoor = dz === 0 && Math.abs(dx - ((w / 2) | 0)) <= 1 && dy <= 3;
        const isWindow = !corner && (dy === 3 || dy === 6) && dx % 3 === 1 && dz % 3 === 1;
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
 *  grass columns, so the whole island stays a single voxel mesh. Collects the grass
 *  surface first, then plants on it — so palms reliably appear wherever grass does. */
function scatterPalms(grid: VoxelGrid, o: IslandOpts, hgt: Int16Array): void {
  const [nx, ny, nz] = grid.dims;
  const grass: { x: number; z: number; topY: number }[] = [];
  for (let x = 1; x < nx - 1; x++)
    for (let z = 1; z < nz - 1; z++) {
      const h = hgt[x + z * nx];
      if (h <= 0) continue;
      const topY = SEABED_Y + h;
      if (topY < ny && grid.get(x, topY, z) === GRASS) grass.push({ x, z, topY });
    }
  if (grass.length === 0) return;

  const rng = new Rng(`palms-${o.seed}`);
  const want = Math.min(grass.length, Math.round(o.radiusVox / 2.5));
  for (let i = 0; i < want; i++) {
    const { x, z, topY } = grass[rng.int(0, grass.length)];
    const trunk = rng.int(6, 12);
    for (let t = 1; t <= trunk && topY + t < ny; t++) grid.set(x, topY + t, z, PALMWOOD);
    const cy = topY + trunk;
    for (let dx = -3; dx <= 3; dx++) // a drooping frond canopy
      for (let dz = -3; dz <= 3; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 3) continue;
        const px = x + dx;
        const pz = z + dz;
        if (px > 0 && px < nx && pz > 0 && pz < nz && cy < ny && grid.get(px, cy, pz) === EMPTY)
          grid.set(px, cy, pz, FOLIAGE);
      }
  }
}
