import { createNoise2D, type NoiseFunction2D } from "simplex-noise";
import { createGrid, type VoxelGrid } from "./voxelGrid";
import { Rng } from "../core/rng";
import { DARKROCK, DIRT, EMPTY, FOLIAGE, GRASS, OAK, PALMWOOD, PINE, ROCK, ROOFTILE, SAND } from "./materials";

/**
 * Procedural voxel islandwright — the terrain analogue of sim/shipwright.ts.
 *
 * Generation follows two established procedural-terrain METHODS sampled into our
 * voxel grid (see docs/superpowers/specs/2026-06-14-voxel-islands-generation-rebuild-design.md):
 *
 *   1. Red Blob Games "coast-distance" elevation — land height is a function of
 *      distance from the coastline (a chamfer distance transform), so the shore
 *      rises GENTLY into a beach and mountains sit deep inland. The medial axis of
 *      a messy (non-convex) coast is a branching ridge, so irregular islands get
 *      mountain spines for free rather than a single central dome.
 *   2. Drop-based hydraulic erosion (Lague / Job Talle) — thousands of seeded
 *      droplets carve gullies and deposit sand at the coast, giving natural relief
 *      and VARIED cliffs (the user's priority) instead of uniform noise.
 *
 * Deterministic: same opts → byte-identical grid (all noise + every erosion
 * droplet pull from a seeded Rng). The grid works in voxel space; `meta.waterlineY`
 * is the row that maps to sea level (world y≈0).
 */
export interface IslandOpts {
  seed: number;
  radiusVox: number; // grid half-extent in voxels; the actual coastline is noise-defined inside it
  peakVox: number; // rough max terrain height above the seabed in voxels
  ruggedness: number; // 0..1 — smooth rolling (0) → jagged ridges + sheer cliffs (1)
  landBias?: number; // -0.2..0.5 — how much of the area is land (low = small messy islet, high = full)
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
const SQRT2 = Math.SQRT2;

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

/**
 * Chamfer distance transform: for every LAND cell, the (approx Euclidean) distance
 * in voxels to the nearest water cell. Water cells are 0. Two passes (forward +
 * backward) with ortho cost 1 and diagonal cost √2 — cheap and smooth, the gradient
 * we need so elevation can rise from the coast inland.
 */
function coastDistance(land: Uint8Array, nx: number, nz: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(nx * nz);
  for (let i = 0; i < d.length; i++) d[i] = land[i] ? INF : 0;
  const at = (x: number, z: number): number =>
    x < 0 || z < 0 || x >= nx || z >= nz ? 0 : d[x + z * nx]; // out-of-grid = water
  // forward pass: neighbours already finalized are up / left / both diagonals above
  for (let z = 0; z < nz; z++)
    for (let x = 0; x < nx; x++) {
      const i = x + z * nx;
      if (!land[i]) continue;
      let m = d[i];
      m = Math.min(m, at(x - 1, z) + 1, at(x, z - 1) + 1, at(x - 1, z - 1) + SQRT2, at(x + 1, z - 1) + SQRT2);
      d[i] = m;
    }
  // backward pass: down / right / both diagonals below
  for (let z = nz - 1; z >= 0; z--)
    for (let x = nx - 1; x >= 0; x--) {
      const i = x + z * nx;
      if (!land[i]) continue;
      let m = d[i];
      m = Math.min(m, at(x + 1, z) + 1, at(x, z + 1) + 1, at(x + 1, z + 1) + SQRT2, at(x - 1, z + 1) + SQRT2);
      d[i] = m;
    }
  return d;
}

interface ErodeParams {
  count: number; // number of droplets
  maxLife: number; // steps per droplet
  inertia: number; // 0..1 — how much a droplet keeps its old direction
  capacity: number; // sediment capacity factor
  minSlope: number; // floor so flat ground still carries a little
  erode: number; // erosion rate
  deposit: number; // deposition rate
  evaporate: number; // water loss per step
  gravity: number;
}

/**
 * Drop-based hydraulic erosion over a float heightfield (heights in voxel units;
 * 0 = sea). Each droplet flows downhill (bilinear height + gradient), eroding when
 * it has spare capacity and depositing when it slows or runs uphill, then dies at
 * the coast — depositing its sediment there, which builds the beaches. Only land
 * cells are ever modified, so the sea stays sea. Deterministic via `rng`.
 */
function erode(hf: Float32Array, nx: number, nz: number, land: Uint8Array, rng: Rng, p: ErodeParams): void {
  const idx = (x: number, z: number): number => x + z * nx;
  // bilinear height + gradient at a float position (cell + fractional offset)
  const sample = (px: number, pz: number): { h: number; gx: number; gz: number } => {
    const x = Math.floor(px);
    const z = Math.floor(pz);
    const u = px - x;
    const v = pz - z;
    const i = idx(x, z);
    const hNW = hf[i];
    const hNE = hf[i + 1];
    const hSW = hf[i + nx];
    const hSE = hf[i + nx + 1];
    const gx = (hNE - hNW) * (1 - v) + (hSE - hSW) * v;
    const gz = (hSW - hNW) * (1 - u) + (hSE - hNE) * u;
    const h = hNW * (1 - u) * (1 - v) + hNE * u * (1 - v) + hSW * (1 - u) * v + hSE * u * v;
    return { h, gx, gz };
  };
  // add `amt` to the four cells around (x,z) by bilinear weight — land only.
  // Inlined (no per-step array/object allocation — this runs millions of times).
  const place = (x: number, z: number, u: number, v: number, amt: number): void => {
    const i = idx(x, z);
    const i1 = i + 1;
    const i2 = i + nx;
    const i3 = i + nx + 1;
    if (land[i]) hf[i] = Math.max(0, hf[i] + amt * (1 - u) * (1 - v));
    if (land[i1]) hf[i1] = Math.max(0, hf[i1] + amt * u * (1 - v));
    if (land[i2]) hf[i2] = Math.max(0, hf[i2] + amt * (1 - u) * v);
    if (land[i3]) hf[i3] = Math.max(0, hf[i3] + amt * u * v);
  };

  for (let n = 0; n < p.count; n++) {
    let px = rng.range(1, nx - 2);
    let pz = rng.range(1, nz - 2);
    let dx = 0;
    let dz = 0;
    let speed = 1;
    let water = 1;
    let sediment = 0;
    for (let life = 0; life < p.maxLife; life++) {
      const cx = Math.floor(px);
      const cz = Math.floor(pz);
      if (cx < 1 || cz < 1 || cx >= nx - 2 || cz >= nz - 2) break;
      const u = px - cx;
      const v = pz - cz;
      const { h, gx, gz } = sample(px, pz);
      // steer: blend old direction with the downhill gradient
      dx = dx * p.inertia - gx * (1 - p.inertia);
      dz = dz * p.inertia - gz * (1 - p.inertia);
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) {
        const a = rng.range(0, Math.PI * 2);
        dx = Math.cos(a);
        dz = Math.sin(a);
      } else {
        dx /= len;
        dz /= len;
      }
      const npx = px + dx;
      const npz = pz + dz;
      const ncx = Math.floor(npx);
      const ncz = Math.floor(npz);
      // ran off land / off grid → drop the load here (builds the coast) and die
      if (ncx < 1 || ncz < 1 || ncx >= nx - 2 || ncz >= nz - 2 || !land[idx(ncx, ncz)]) {
        place(cx, cz, u, v, sediment);
        break;
      }
      const nh = sample(npx, npz).h;
      const dh = nh - h;
      const cap = Math.max(-dh, p.minSlope) * speed * water * p.capacity;
      if (sediment > cap || dh > 0) {
        // deposit: fill the pit / shed load when over capacity
        const amt = dh > 0 ? Math.min(dh, sediment) : (sediment - cap) * p.deposit;
        sediment -= amt;
        place(cx, cz, u, v, amt);
      } else {
        // erode, but never dig deeper than the local step
        const amt = Math.min((cap - sediment) * p.erode, -dh);
        sediment += amt;
        place(cx, cz, u, v, -amt);
      }
      speed = Math.sqrt(Math.max(0, speed * speed - dh * p.gravity));
      water *= 1 - p.evaporate;
      px = npx;
      pz = npz;
    }
  }
}

/**
 * Build the per-column float height field (voxel rows above SEABED_Y; 0 = open sea).
 * See the module header: organic land mask → coast-distance elevation → cliff/crag
 * variation → hydraulic erosion.
 */
function makeHeightField(o: IslandOpts, nx: number, nz: number): Float32Array {
  const rng = new Rng(`isle-${o.seed}`);
  const rand = (): number => rng.next();
  const cont = createNoise2D(rand); // continental shape
  const warpA = createNoise2D(rand);
  const warpB = createNoise2D(rand);
  const cliffN = createNoise2D(rand); // which stretches of coast are sea-cliffs
  const ridgeN = createNoise2D(rand); // inland crags

  const cx = nx / 2;
  const cz = nz / 2;
  const R = o.radiusVox;
  const Rmax = Math.min(cx, cz);
  const Fc = 2.2 / R; // continent feature frequency
  const Fw = 1.1 / R; // warp frequency — low, big sweeps not fuzz
  const warpAmp = R * 0.55;
  const rug = o.ruggedness;
  const landBias = o.landBias ?? 0.18;
  const peak = o.peakVox;

  // --- 1. organic land mask (edge-moat only — NOT a radial disc) ---
  const land = new Uint8Array(nx * nz);
  for (let x = 0; x < nx; x++)
    for (let z = 0; z < nz; z++) {
      const r = Math.hypot(x - cx, z - cz) / Rmax; // 0 centre … 1 rim
      const moat = smoothstep(0.72, 1.0, r); // only suppresses land near the grid edge
      const wx = x + warpAmp * warpA(x * Fw, z * Fw);
      const wz = z + warpAmp * warpB(x * Fw + 31, z * Fw + 19);
      const L = fbm(cont, wx * Fc, wz * Fc, 4); // [-1,1] continent
      const mask = L + landBias - moat * 2.0;
      if (mask > 0) land[x + z * nx] = 1;
    }

  // --- 2. coast distance ---
  const dist = coastDistance(land, nx, nz);

  // --- 3. elevation = coast-distance base + shore-cliff variation + inland crags ---
  const hf = new Float32Array(nx * nz);
  const mountainScale = R * 0.85;
  const cliffAmp = Math.max(4, peak * 0.4); // sea-cliff height where the cliff field is high
  const ridgeAmp = peak * 0.5;
  for (let x = 0; x < nx; x++)
    for (let z = 0; z < nz; z++) {
      const i = x + z * nx;
      if (!land[i]) continue;
      const cd = dist[i];
      const d = Math.min(cd / mountainScale, 1);
      const hBase = peak * Math.pow(smoothstep(0, 1, d), 1.25); // gentle at the shore, steeper inland

      // shore cliffs: only the top ~third of the cliff-noise becomes sheer rock —
      // the rest of the coast stays sand beach (cliffs VARY around the island)
      const cn = 0.5 + 0.5 * fbm(cliffN, x * Fc * 1.3, z * Fc * 1.3, 2);
      const cliffSel = smoothstep(0.5, 0.9, cn);
      const shoreBump = 1 - smoothstep(3, 13, cd); // strong at the coast, gone by ~13 vox inland
      const cliff = cliffSel * cliffAmp * shoreBump;

      // inland crags (kept off the beaches), scaled by ruggedness
      const rg = ridged(ridgeN, x * Fc * 1.1, z * Fc * 1.1, 3);
      const crag = rg * rug * ridgeAmp * smoothstep(3, 16, cd);

      hf[i] = Math.min(hBase + cliff + crag, peak * 1.2);
    }

  // --- 4. hydraulic erosion (visible, not dominant) ---
  let landArea = 0;
  for (let i = 0; i < land.length; i++) landArea += land[i];
  const count = Math.min(Math.round(landArea * 0.12), 14000);
  erode(hf, nx, nz, land, rng, {
    count,
    maxLife: 32,
    inertia: 0.06,
    capacity: 3,
    minSlope: 0.05,
    erode: 0.3,
    deposit: 0.2,
    evaporate: 0.02,
    gravity: 10,
  });

  return hf;
}

export function buildIsland(o: IslandOpts): IslandModel {
  const margin = o.marginVox ?? 6;
  const nx = o.radiusVox * 2 + margin * 2;
  const nz = o.radiusVox * 2 + margin * 2;
  const ny = SEABED_Y + Math.ceil(o.peakVox * 1.25) + 8;
  const grid = createGrid(nx, ny, nz);

  // Islands are filled in one bulk pass then meshed once (meshGrid scans every
  // chunk regardless of dirty state), so we write grid.data DIRECTLY and skip the
  // per-voxel markDirty bookkeeping — that string-keyed Set was the build hot spot.
  const data = grid.data;
  const nxny = nx * ny;

  const hf = makeHeightField(o, nx, nz);
  const maxH = ny - 1 - SEABED_Y;
  const H = new Int16Array(nx * nz);
  for (let i = 0; i < hf.length; i++) H[i] = hf[i] > 0.5 ? Math.min(Math.round(hf[i]), maxH) : 0;

  // a low-frequency tint field varies cliff readiness + rock shade so cliffs aren't uniform
  const tintRng = new Rng(`isle-tint-${o.seed}`);
  const tint = createNoise2D(() => tintRng.next());
  const Ft = 0.06;
  const beachBand = 2;
  const alpineY = SEABED_Y + Math.round(o.peakVox * 0.62);

  for (let x = 1; x < nx - 1; x++) {
    for (let z = 1; z < nz - 1; z++) {
      const h = H[x + z * nx];
      if (h <= 0) continue;
      const topY = SEABED_Y + h;
      const slope = Math.max(
        h - H[x - 1 + z * nx],
        h - H[x + 1 + z * nx],
        h - H[x + (z - 1) * nx],
        h - H[x + (z + 1) * nx],
        0,
      );
      const t = tint(x * Ft, z * Ft); // [-1,1]
      const cliffThresh = t > 0.2 ? 3 : 2; // cliffs form unevenly across the island
      const isCliff = slope >= cliffThresh + 1;
      const colBase = x + nxny * z; // data idx = colBase + nx*y
      // a low, gently-sloped coastal column: its beach AND its submerged rim are sand, so the
      // shelf reads as sand through the translucent shallows (not the ROCK seafloor base).
      const lowGentle = topY <= WATERLINE_Y + beachBand && slope <= 1;
      for (let y = 0; y <= topY; y++) {
        let mat: number;
        if (y < SEABED_Y) mat = ROCK; // seafloor base
        else if (lowGentle && y <= WATERLINE_Y) mat = SAND; // submerged shelf + waterline rim = sand
        else if (isCliff)
          mat = y < topY - 2 || t < -0.1 ? DARKROCK : ROCK; // varied exposed cliff face
        else if (y === topY) {
          if (topY <= WATERLINE_Y + beachBand && slope <= 1) mat = SAND; // low + gentle → beach
          else if (topY >= alpineY && t > 0.15) mat = ROCK; // bare rocky peaks
          else if (slope >= cliffThresh) mat = t < 0 ? DARKROCK : ROCK; // steep top → rock
          else mat = GRASS; // gentle inland
        } else if (y >= topY - 2) mat = DIRT; // subsoil
        else mat = ROCK; // core
        data[colBase + nx * y] = mat;
      }
    }
  }

  scatterPalms(grid, o, H);

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

function clampZ(z: number, nz: number): number {
  return Math.min(Math.max(z, 0), nz - 1);
}

/**
 * The harbor island: the BIGGEST island, built by the same pipeline at a large
 * radius. The town does NOT sit on a stamped circle — it occupies an irregular,
 * noise-warped COASTAL BENCH on one shoulder of the island (land low enough to
 * level; higher ground is excluded, so the footprint follows the natural coast).
 * A 5-wide pier marches out over the water on visible OAK pylons + tie-beams.
 * `meta.dock` is the seaward pier-end anchor for the future docking interaction.
 */
export function buildHarborIsland(opts: { seed: number; radiusVox?: number; peakVox?: number }): IslandModel {
  const radiusVox = opts.radiusVox ?? 150;
  const peakVox = opts.peakVox ?? 40;
  const model = buildIsland({
    seed: opts.seed,
    radiusVox,
    peakVox,
    ruggedness: 0.5,
    landBias: 0.5, // solid landmass for the town
    marginVox: 36, // wide water ring so the pier reaches the sea
  });
  const { grid, meta } = model;
  const [nx, ny, nz] = grid.dims;
  const data = grid.data;
  const nxny = nx * ny;
  const cz0 = Math.floor(nz / 2);
  const W = meta.waterlineY;
  const shelfY = W + 3; // town/dock deck level
  const top = (x: number, z: number): number => topSolid(grid, x, z);

  // 1. find a low coastal anchor on the +x shore near the centre row, then pull inland
  let anchorX = -1;
  let anchorZ = cz0;
  for (let x = nx - 2; x > 2 && anchorX < 0; x--)
    for (let dz = -10; dz <= 10; dz++) {
      const z = cz0 + dz;
      const t = top(x, z);
      if (t >= W && t <= W + 5) {
        anchorX = x;
        anchorZ = z;
        break;
      }
    }
  if (anchorX < 0) {
    anchorX = Math.floor(nx * 0.62);
    anchorZ = cz0;
  }
  anchorX = Math.max(4, anchorX - 14); // sit the bench on land, not half in the sea

  // 2. level an IRREGULAR coastal bench: noise-warped radius + height cap (excludes
  //    higher ground so the edge follows the coast — not a clean disc)
  const benchRng = new Rng(`bench-${opts.seed}`);
  const benchN = createNoise2D(() => benchRng.next());
  const townR = 26;
  const maxRise = 7;
  for (let x = anchorX - townR; x <= anchorX + townR; x++)
    for (let z = anchorZ - townR; z <= anchorZ + townR; z++) {
      if (x < 2 || z < 2 || x >= nx - 2 || z >= nz - 2) continue;
      const ddx = x - anchorX;
      const ddz = z - anchorZ;
      const dist = Math.hypot(ddx, ddz);
      const ang = Math.atan2(ddz, ddx);
      const rEff = townR * (0.62 + 0.38 * (0.5 + 0.5 * benchN(Math.cos(ang), Math.sin(ang))));
      if (dist > rEff) continue;
      const t = top(x, z);
      if (t < 0 || t > W + maxRise) continue; // skip open water and higher ground
      const colBase = x + nxny * z;
      for (let y = shelfY + 1; y < ny; y++) data[colBase + nx * y] = 0; // clear above the shelf
      for (let y = SEABED_Y; y <= shelfY; y++) {
        const i = colBase + nx * y;
        if (data[i] === EMPTY) data[i] = y === shelfY ? DIRT : ROCK; // build the shelf up
      }
    }

  // 3. pier from the bench's seaward edge, out over the water, on visible pylons
  const pierZ = anchorZ;
  let pierStart = anchorX;
  for (let x = anchorX; x <= anchorX + townR + 2; x++)
    if (top(x, pierZ) === shelfY) pierStart = x;
  const pierEnd = Math.min(pierStart + 44, nx - 3);
  for (let x = pierStart; x <= pierEnd; x++) {
    for (let dz = -2; dz <= 2; dz++) {
      const z = clampZ(pierZ + dz, nz);
      for (let y = shelfY + 1; y < ny; y++) grid.remove(x, y, z);
      grid.set(x, shelfY, z, PINE); // deck
    }
    // support bents every 3 cells: posts (rails + centre) to the seabed + a tie-beam
    if (x % 3 === 0) {
      let overWater = false;
      for (const dz of [-2, 0, 2]) {
        const z = clampZ(pierZ + dz, nz);
        if (grid.get(x, shelfY - 1, z) === EMPTY) {
          overWater = true;
          for (let y = SEABED_Y; y < shelfY; y++) grid.set(x, y, z, OAK); // pylon
        }
      }
      if (overWater) for (let dz = -2; dz <= 2; dz++) grid.set(x, shelfY - 1, clampZ(pierZ + dz, nz), OAK); // tie-beam
    }
  }
  meta.dock = { x: pierEnd, y: shelfY, z: pierZ, bearing: 0 };

  // 4. buildings around the bench (inland of the pier), then the lighthouse landmark
  const rng = new Rng(`town-${opts.seed}`);
  const lots: BuildingLot[] = [
    { x: anchorX - 24, z: anchorZ - 13, w: 18, d: 14, h: 13, kind: "tavern" },
    { x: anchorX - 11, z: anchorZ - 21, w: 13, d: 12, h: 10, kind: "house" },
    { x: anchorX - 26, z: anchorZ + 7, w: 12, d: 12, h: 10, kind: "house" },
    { x: anchorX - 8, z: anchorZ + 18, w: 11, d: 10, h: 9, kind: "house" },
    { x: anchorX - 20, z: anchorZ + 2, w: 10, d: 9, h: 9, kind: "house" },
  ];
  for (const lot of lots) {
    if (grid.get(lot.x + (lot.w >> 1), shelfY, lot.z + (lot.d >> 1)) === EMPTY) continue; // off the bench
    stampBuilding(grid, lot, shelfY, rng);
  }
  stampLighthouse(grid, pierStart - 4, anchorZ + 11, shelfY, 26);

  return model;
}

interface BuildingLot {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  kind: "tavern" | "house";
}

/**
 * A timber pirate-town building: PINE walls with OAK corner posts and an OAK
 * sill/top-plate, a framed doorway and shuttered windows, and a pitched terracotta
 * roof that OVERHANGS the walls by a cell. Per-building Rng variation (roof gable
 * direction, chimney, tavern porch) keeps the town from reading as a row of cubes.
 */
function stampBuilding(grid: VoxelGrid, lot: BuildingLot, floorY: number, rng: Rng): void {
  const { x: x0, z: z0, w, d, h } = lot;
  const set = (x: number, y: number, z: number, m: number): void => grid.set(x0 + x, floorY + y, z0 + z, m);

  // floor + walls
  for (let dx = 0; dx < w; dx++)
    for (let dz = 0; dz < d; dz++) {
      set(dx, 0, dz, OAK); // floor plate
      for (let dy = 1; dy <= h; dy++) {
        const edge = dx === 0 || dx === w - 1 || dz === 0 || dz === d - 1;
        if (!edge) continue;
        const corner = (dx === 0 || dx === w - 1) && (dz === 0 || dz === d - 1);
        const sillOrPlate = dy === 1 || dy === h; // OAK timber frame top & bottom
        const isDoor = dz === 0 && Math.abs(dx - (w >> 1)) <= 1 && dy <= 3;
        const isWindow =
          !corner && !sillOrPlate && dy >= 3 && dy <= h - 2 && dy % 3 === 0 && (dx % 3 === 1 || dz % 3 === 1);
        if (isDoor || isWindow) continue;
        set(dx, dy, dz, corner || sillOrPlate ? OAK : PINE);
      }
    }

  // pitched, OVERHANGING terracotta roof — gable along the longer axis
  const gableAlongX = w >= d;
  const span = gableAlongX ? d : w; // the axis the slopes climb across
  const peakRows = Math.ceil(span / 2);
  for (let r = 0; r <= peakRows; r++) {
    const ry = h + 1 + r;
    const lo = r - 1; // -1 → one-cell eave overhang past the wall
    if (gableAlongX) {
      for (let dx = -1; dx <= w; dx++) {
        if (r === peakRows && span % 2 === 0) continue;
        set(dx, ry, lo, ROOFTILE);
        set(dx, ry, d - 1 - lo, ROOFTILE);
      }
    } else {
      for (let dz = -1; dz <= d; dz++) {
        if (r === peakRows && span % 2 === 0) continue;
        set(lo, ry, dz, ROOFTILE);
        set(w - 1 - lo, ry, dz, ROOFTILE);
      }
    }
  }

  // optional chimney on one corner
  if (rng.next() < 0.6) {
    const cxp = rng.next() < 0.5 ? 1 : w - 2;
    const czp = rng.next() < 0.5 ? 1 : d - 2;
    for (let dy = h - 1; dy <= h + peakRows + 2; dy++) set(cxp, dy, czp, DARKROCK);
  }

  // a porch for the tavern: a few posts + a small lean-to roof over the doorway
  if (lot.kind === "tavern") {
    const px = w >> 1;
    for (const ox of [-1, 1]) {
      grid.set(x0 + px + ox, floorY + 1, z0 - 2, OAK);
      grid.set(x0 + px + ox, floorY + 2, z0 - 2, OAK);
    }
    for (let dx = -1; dx <= 1; dx++) {
      grid.set(x0 + px + dx, floorY + 3, z0 - 2, ROOFTILE);
      grid.set(x0 + px + dx, floorY + 3, z0 - 1, ROOFTILE);
    }
  }
}

/** A square watch-tower / lighthouse: a tall ROCK+OAK+PINE shaft with a railed
 *  lantern room and a terracotta cap — the harbor's landmark (refs: dock tower). */
function stampLighthouse(grid: VoxelGrid, x0: number, z0: number, baseY: number, h: number): void {
  const s = 5; // footprint side
  for (let dy = 1; dy <= h; dy++) {
    for (let dx = 0; dx < s; dx++)
      for (let dz = 0; dz < s; dz++) {
        const edge = dx === 0 || dx === s - 1 || dz === 0 || dz === s - 1;
        if (!edge) continue;
        const corner = (dx === 0 || dx === s - 1) && (dz === 0 || dz === s - 1);
        const lantern = dy > h - 3 && !corner && dy !== h - 2; // open railing near the top
        if (lantern) continue;
        grid.set(x0 + dx, baseY + dy, z0 + dz, dy <= 3 ? ROCK : corner ? OAK : PINE);
      }
  }
  for (let r = 0; r <= 2; r++) {
    const ry = baseY + h + 1 + r;
    for (let dx = r; dx < s - r; dx++)
      for (let dz = r; dz < s - r; dz++) grid.set(x0 + dx, ry, z0 + dz, ROOFTILE);
  }
}

/** Vegetate the island: dense leafy palms + low FOLIAGE bushes on the grass, so it
 *  reads as a lush jungle isle and stays a single voxel mesh. Collects the grass
 *  surface first, then plants on it — so greenery reliably appears wherever grass does. */
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
  const rng = new Rng(`flora-${o.seed}`);

  const leaf = (px: number, pz: number, py: number): void => {
    if (px > 0 && px < nx && pz > 0 && pz < nz && py > 0 && py < ny && grid.get(px, py, pz) === EMPTY)
      grid.set(px, py, pz, FOLIAGE);
  };

  // leafy palms — a two-tier canopy on a tall trunk
  const palms = Math.min(grass.length, Math.round(o.radiusVox / 1.4));
  for (let i = 0; i < palms; i++) {
    const { x, z, topY } = grass[rng.int(0, grass.length)];
    const trunk = rng.int(7, 14);
    for (let t = 1; t <= trunk && topY + t < ny; t++) grid.set(x, topY + t, z, PALMWOOD);
    const cy = topY + trunk;
    for (let dx = -3; dx <= 3; dx++) // wide lower frond ring
      for (let dz = -3; dz <= 3; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 3) continue;
        leaf(x + dx, z + dz, cy);
      }
    for (let dx = -2; dx <= 2; dx++) // crown
      for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 2) continue;
        leaf(x + dx, z + dz, cy + 1);
      }
    leaf(x, z, cy + 2);
  }

  // low bushes carpeting the grass between the palms
  const bushes = Math.round(grass.length / 6);
  for (let i = 0; i < bushes; i++) {
    const { x, z, topY } = grass[rng.int(0, grass.length)];
    leaf(x, z + 0, topY + 1);
    if (rng.next() < 0.6) leaf(x + (rng.next() < 0.5 ? 1 : -1), z, topY + 1);
    if (rng.next() < 0.4) leaf(x, z + (rng.next() < 0.5 ? 1 : -1), topY + 1);
  }
}
