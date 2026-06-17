import { VOXEL_SIZE, VOXEL_VOLUME } from "../core/constants";
import { createGrid, type VoxelGrid } from "./voxelGrid";
import { EMPTY, IRON, OAK, PINE, RAM, SPAR } from "./materials";
import { findCompartments, type Compartment } from "./compartments";
import { weldToSingleComponent } from "./weld";

/**
 * Procedural voxel shipwright. Hulls come from analytic curves — plan-view
 * half-beam, keel rocker, flared sections — rasterized into a voxel shell
 * with deck, transverse bulkheads, deck hatches, and a bulwark rail.
 * Deterministic: same inputs, same ship.
 */
export interface ShipBuild {
  grid: VoxelGrid;
  deckY: number; // voxel y of the MAIN (waist) deck plane
  envelopeVolume: number; // m³ enclosed by the hull up to and including deck
  compartments: Compartment[];
  interiorLeaks: number[]; // packed indices of interior regions that escaped (should be empty)
  // voxel coords; side = ±z broadside. `facing` (r17) marks a bow/stern CHASER that
  // bears axially (±x) instead — fired independently of the broadsides.
  cannonPorts: { x: number; y: number; z: number; side: 1 | -1; facing?: "fore" | "aft" }[];
  masts: { x: number; z: number; h: number }[]; // voxel coords on centerline; h = rig height (m)
  /** Per mast: the SPAR voxels stamped into the grid for that mast (the actual voxel trunk), in
   *  voxel coords, ascending keel→top. Masts are now REAL grid voxels (stampMasts) so they break
   *  voxel-by-voxel under the unified destruction + 18-connectivity sever — render/game read this to
   *  know which voxels carry which mast (e.g. to drop a sail once its supporting trunk is gone). */
  mastVoxels: { x: number; y: number; z: number }[][];
  hatches: { x: number; z: number; w: number; d: number }[]; // deck openings
  lengthM: number;
  beamM: number;
  /** Deck level (voxel y) at a station — the quarterdeck rises aft. */
  deckYAt(x: number): number;
  /** Raised quarterdeck aft of x1 (inclusive), or null for a flush deck. */
  quarterdeck: { x1: number; deckY: number } | null;
  /** Where the helm stands, local METERS (y derived from deckYAt). */
  wheelM: { x: number; z: number };
  /** Hull footprint in local METERS, for overboard checks. */
  footprint: { minX: number; maxX: number; zC: number; halfZ: number };
}

/** Lay reinforced ram-timber (RAM) over the forward shell of a finished hull so a
 *  bow-first ram mechanically WINS. Each RAM voxel costs ~4.6× an oak one to break, so
 *  the same impact energy on both hulls barely chips the armored bow while the victim's
 *  unarmored oak side caves in — the asymmetry falls out of the material cost, with no
 *  special-casing in the collision code. A pure OAK→RAM swap (RAM density = oak), so
 *  draft and the tuned trim are unchanged: toughness only. Bow is at high x on every hull. */
function armorBow(grid: VoxelGrid, forwardFrac = 0.7): void {
  const [nx, ny, nz] = grid.dims;
  const x0 = Math.floor(nx * forwardFrac);
  for (let x = x0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        if (grid.get(x, y, z) === OAK) grid.set(x, y, z, RAM);
      }
    }
  }
}

/**
 * Lower the ballast centroid at CONSTANT mass — the ship-feel pass's "heavier bottom,
 * same waterline" lever (Task 3). After a hull's iron bands are laid, this moves the
 * HIGHEST `frac` of iron cells DOWN into the LOWEST still-empty interior cells. Because
 * it removes exactly as many iron voxels as it re-adds (a pure relocation, IRON→IRON of
 * the same density), the TOTAL mass — and therefore the buoyancy-equilibrium draft /
 * resting waterline — is unchanged to the cell, while the centre of mass drops. A lower
 * COM stiffens the buoyant righting (less idle/straight-line roll) WITHOUT sinking her
 * any deeper. Applied uniformly across every tier so the whole fleet gets the same
 * bottom-heavy feel. Only moves a cell when a strictly-lower empty slot exists, so it can
 * never raise the centroid and self-limits once the bilges are packed.
 *
 * An "interior empty" slot is an EMPTY cell with a solid cell directly beneath it (it sits
 * on the hold floor / on the ballast already there) — this keeps the new iron inside the
 * hull, resting on structure, and the later weldToSingleComponent() ties it into the one
 * 6-connected solid. `frac` 0.25 was tuned live: ~0.2–0.3 m of COM drop on the big hulls
 * (less on the already-tight cutter), draft Δ = 0 measured.
 */
function lowerBallast(grid: VoxelGrid, deckY: number, frac = 0.5): void {
  const [nx, ny, nz] = grid.dims;
  // Work in MIRROR PAIRS (z, nz−1−z) so the relocation stays port/starboard symmetric — the
  // hull's defining invariant (a lopsided ballast move would list her AND fail the symmetry test).
  // A "unit" is one such pair (the centre column on an odd beam is its own pair).
  type Unit = { x: number; y: number; zs: number[]; comp: number };
  const ironUnits: Unit[] = [];
  const emptyUnits: Unit[] = [];

  // PRESERVE THE WATERTIGHT COMPARTMENTS: the low bilge air we'd fill IS each hold's air, and
  // filling a hold's last cells makes the compartment vanish (10 holds → 2). So pre-map every
  // below-deck air cell to its compartment and cap how much of each hold's air may be consumed,
  // guaranteeing every hold keeps a healthy air budget (count + seepage chain unchanged).
  const comps = findCompartments(grid, deckY);
  const cellComp = new Map<number, number>(); // packed idx → compartment id
  const compAir = new Map<number, number>(); // id → original air-cell count
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  for (const c of comps) {
    compAir.set(c.id, c.cells.size); // c.cells is a Set
    for (const cell of c.cells) cellComp.set(cell, c.id);
  }
  const KEEP_AIR = 0.5; // never fill a hold below this fraction of its original air → it survives
  const filledPerComp = new Map<number, number>();

  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z <= nz - 1 - z; z++) {
        const zm = nz - 1 - z;
        const m = grid.get(x, y, z);
        const mm = grid.get(x, y, zm);
        const zs = z === zm ? [z] : [z, zm];
        // A symmetric IRON pair is eligible to come DOWN only if the cell directly ABOVE each side is
        // air — i.e. it's the EXPOSED TOP of an iron ballast column. This is the crucial guard: iron
        // buried inside a transverse BULKHEAD station (solid above it, the wall continuing to the deck)
        // must NOT be pulled — removing it would punch a hole through the watertight wall and merge two
        // holds (10 compartments → a few). Top-of-column iron only opens to the air already above it.
        if (
          m === IRON && mm === IRON &&
          grid.get(x, y + 1, z) === EMPTY && grid.get(x, y + 1, zm) === EMPTY
        )
          ironUnits.push({ x, y, zs, comp: -1 });
        // a symmetric EMPTY pair, each a known compartment air cell resting on solid, is a destination
        else if (
          m === EMPTY && mm === EMPTY &&
          grid.isSolid(x, y - 1, z) && grid.isSolid(x, y - 1, zm)
        ) {
          const c = cellComp.get(idx(x, y, z));
          const cm = cellComp.get(idx(x, y, zm));
          if (c !== undefined && c === cm) emptyUnits.push({ x, y, zs, comp: c });
        }
      }
    }
  }

  // Match like-for-like by cell count (2-cell side pairs vs 1-cell centre columns) so each move is
  // exactly mass-conserving — moving a centre cell into a side pair would ADD a cell (sink her deeper).
  const moveBucket = (width: 1 | 2) => {
    const iron = ironUnits.filter((u) => u.zs.length === width).sort((a, b) => b.y - a.y); // highest first
    const empty = emptyUnits.filter((u) => u.zs.length === width).sort((a, b) => a.y - b.y); // lowest first
    const K = Math.floor(iron.length * frac);
    let dst = 0;
    for (let i = 0; i < K; i++) {
      const src = iron[i];
      // advance to the next destination that still has compartment-air headroom
      while (dst < empty.length) {
        const tgt = empty[dst];
        const used = filledPerComp.get(tgt.comp) ?? 0;
        const cap = Math.floor((compAir.get(tgt.comp) ?? 0) * (1 - KEEP_AIR));
        if (used + tgt.zs.length > cap) { dst++; continue; } // this hold is at its fill cap — skip it
        break;
      }
      if (dst >= empty.length) break;
      const tgt = empty[dst];
      if (tgt.y >= src.y) break; // no strictly-lower slot remains → done (never raise COM)
      for (const z of src.zs) grid.remove(src.x, src.y, z);
      for (const z of tgt.zs) grid.set(tgt.x, tgt.y, z, IRON);
      filledPerComp.set(tgt.comp, (filledPerComp.get(tgt.comp) ?? 0) + tgt.zs.length);
      dst++;
    }
  };
  moveBucket(2); // side pairs
  moveBucket(1); // centre columns (odd beams)
}

/**
 * Evenly-spaced transverse-bulkhead stations (voxel x) for `comps` watertight holds.
 * `comps` holds need `comps − 1` interior bulkheads, dropped at the fractional stations
 * k/comps for k = 1..comps−1. Computed from L so the layout scales with the hull and
 * stays maintainable (no magic offsets). Spanning the FULL beam and full height below
 * deck (the walls themselves), they partition the below-deck air into `comps` regions
 * ordered bow→stern — preserving the 1-D fore-aft neighbour chain that seepage rides on.
 * (The very fore/aft taper still encloses air, so the count lands at `comps` in practice.)
 */
function bulkheadStations(x0: number, L: number, comps: number): number[] {
  const xs: number[] = [];
  for (let k = 1; k < comps; k++) xs.push(x0 + Math.round((L * k) / comps));
  return xs;
}

/**
 * Deck-hatch stations (voxel x) = the CENTRES of `nHatches` evenly-spread holds. Centring a
 * hatch in its hold (between bulkheads) guarantees it lands inside a compartment's x-bbox —
 * placing one at a fixed L-fraction can fall exactly ON a bulkhead (the boundary belongs to
 * no hold) and silently give that ship zero flooding hatches. Spreading them keeps the
 * deck-wash flood/drain path on a few holds (fore/mid/aft) while the rest stay sealed.
 */
function hatchStations(x0: number, L: number, bulkheadXs: number[], nHatches: number): number[] {
  const bounds = [x0, ...bulkheadXs, x0 + L]; // hold k spans [bounds[k], bounds[k+1]]
  const comps = bounds.length - 1;
  const n = Math.min(nHatches, comps);
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    // evenly pick hold indices across the length (e.g. n=3 over 12 holds → ~fore, mid, aft)
    const k = n === 1 ? Math.floor(comps / 2) : Math.round((i * (comps - 1)) / (n - 1));
    xs.push(Math.round((bounds[k] + bounds[k + 1]) / 2));
  }
  return xs;
}

/**
 * Stamp full-section watertight bulkheads at the given stations (OAK below deck).
 * Shared so every hull builds bulkheads the same way — only the station COUNT differs.
 */
function stampBulkheads(
  grid: VoxelGrid,
  xs: number[],
  deckY: number,
  inside: (x: number, y: number, z: number) => boolean,
): void {
  const [, , nz] = grid.dims;
  for (const bx of xs) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(bx, y, z) && grid.get(bx, y, z) === EMPTY) grid.set(bx, y, z, OAK);
      }
    }
  }
}

/**
 * Stamp each mast as a real VOXEL trunk (SPAR) rising from the deck — the change that makes masts
 * break voxel-by-voxel under the ONE destruction rule (cannons bore through, rams crush) and lets the
 * 18-connectivity sever pass (sim/connectivity + game/ship flushDamage) shed whatever is left above a
 * shot-out base as debris. NO more one-piece rigid topple.
 *
 * Geometry: a thin column at the mast's (x,z). To stay PORT/STARBOARD SYMMETRIC (every hull has an
 * even beam, so `round(cz)` is an off-centre cell), the trunk is 2 voxels wide in z spanning the two
 * true centreline cells {floor(cz), ceil(cz)} (they sum to nz−1 → exact mirror), and 1 voxel in x.
 * It rises from deckTop+1 up `h` metres. The base voxel sits directly ON the deck plank (face-adjacent
 * below), and each voxel is face-adjacent to the one beneath, so the whole trunk is 6-/18-connected to
 * the keel through the deck — a shot-out base severs everything above it (NOT before). Returns the
 * stamped voxels per mast (keel→top) so the build can expose them. Deterministic (pure integer math).
 *
 * Run BEFORE weldToSingleComponent (a stray gap would get welded) and AFTER lowerBallast (which only
 * relocates IRON BELOW deck, never touches above-deck SPAR). Masts never overwrite existing solid
 * (bulwark/quarterdeck), and a mast on the centreline is interior, clear of the edge fence.
 */
function stampMasts(
  grid: VoxelGrid,
  masts: { x: number; z: number; h: number }[],
  deckYAt: (x: number) => number,
): { x: number; y: number; z: number }[][] {
  const [, ny, nz] = grid.dims;
  const cz = (nz - 1) / 2;
  const zPair = [Math.floor(cz), Math.ceil(cz)]; // {floor,ceil} → mirror pair (sum = nz−1) for symmetry
  const out: { x: number; y: number; z: number }[][] = [];
  for (const m of masts) {
    const cells: { x: number; y: number; z: number }[] = [];
    const yBase = deckYAt(m.x) + 1; // first voxel sits on the deck plank (face-adjacent below)
    const hVox = Math.max(1, Math.round(m.h / VOXEL_SIZE));
    for (let i = 0; i < hVox; i++) {
      const y = yBase + i;
      if (y >= ny) break; // never run off the top of the grid
      for (const z of zPair) {
        if (grid.get(m.x, y, z) === EMPTY) {
          grid.set(m.x, y, z, SPAR);
          cells.push({ x: m.x, y, z });
        }
      }
    }
    out.push(cells);
  }
  return out;
}

/**
 * Assign a deck-hatch flooding orifice ONLY to the compartments that actually sit under a
 * deck hatch (one of `hatchXs`), leaving every other hold SEALED (it can only flood via a
 * breach or slow inter-bulkhead seepage). With ~10 holds this is what keeps the ship
 * resilient — giving every tiny compartment its own hatch would let a normal swell wash
 * the whole hull down, defeating the point. Returns the count that received a hatch.
 *
 * A compartment "owns" a hatch when the hatch's x falls within its cell-space x-bbox.
 * (`hatchArea` is the only field flooding reads; `build.hatches` is render/metadata.)
 */
function assignHatchAreas(compartments: Compartment[], hatchXs: number[], hatchAreaM2: number): number {
  let n = 0;
  for (const c of compartments) {
    const has = hatchXs.some((hx) => hx >= c.bboxMin[0] && hx <= c.bboxMax[0]);
    if (has) {
      c.hatchArea = hatchAreaM2;
      n++;
    }
  }
  return n;
}

export function buildSloop(): ShipBuild {
  // a proper fighting brig: 24 m hull (playtest: the 16 m boat "looks like a
  // fishing vessel and somehow has eight cannons"), with a TALL hull —
  // round-5 references: cross-section is a wide oval with the top sliced
  // off for the deck, widest at the waterline belt, narrow rounded bottom,
  // tumblehome above, and a lot of ship under the water
  const nx = 104;
  // ny holds the HULL (deckY≈20) PLUS the VOXEL MAST tower above it (15 m ≈ 60 voxels) + headroom —
  // the trunk is real grid voxels now (stampMasts), so the grid must be tall enough to contain it.
  const ny = 86;
  const nz = 32;
  const grid = createGrid(nx, ny, nz);

  const x0 = 4; // first station
  const L = 96; // stations along x (24 m)
  const deckY = 20; // 5 m depth of hold keel-to-deck
  const halfBeamMax = 13; // cells from centerline → beam ≈ 6.5 m at the belt
  const cz = (nz - 1) / 2; // centerline between cells

  const stationT = (x: number) => (x - x0) / (L - 1);
  const keelY = (t: number) => 2 + Math.round(4 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.8));
  const halfBeam = (t: number) => halfBeamMax * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * t)), 0.72);
  const sectionHalfBeam = (t: number, y: number) => {
    const k = keelY(t);
    const f = Math.min(Math.max((y - k) / (deckY - k), 0), 1);
    // egg section: widest at 62% of depth, ~32% beam at the rounded bottom,
    // deck edge pulled back in to ~76% (tumblehome)
    const d = f - 0.62;
    const a = d < 0 ? 0.64 : 0.56;
    const oval = Math.sqrt(Math.max(1 - (d / a) * (d / a), 0));
    return halfBeam(t) * (0.1 + 0.9 * oval);
  };

  const inside = (x: number, y: number, z: number): boolean => {
    const t = stationT(x);
    if (t < 0 || t > 1) return false;
    if (y < keelY(t) || y > deckY) return false;
    return Math.abs(z - cz) <= sectionHalfBeam(t, y);
  };

  // rasterize: shell (OAK) where an inside cell touches outside; deck (PINE) caps the top
  let envelopeCells = 0;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        if (!inside(x, y, z)) continue;
        envelopeCells++;
        if (y === deckY) {
          grid.set(x, y, z, PINE); // deck planking
          continue;
        }
        const onShell =
          !inside(x - 1, y, z) ||
          !inside(x + 1, y, z) ||
          !inside(x, y - 1, z) ||
          !inside(x, y, z - 1) ||
          !inside(x, y, z + 1);
        if (onShell) grid.set(x, y, z, OAK);
      }
    }
  }

  // iron ballast along the keel: without it the deck makes the ship
  // top-heavy and she turtles (negative metacentric height).
  //
  // The ballast centroid must sit under the hull's CENTER OF BUOYANCY, not at
  // mid-length: the egg section is fuller AFT, so the COB lands at t≈0.45 (cell
  // ~47, x≈11.8 m). The old bands were centered ~t=0.55 — the upper, narrower
  // tiers especially concentrated their mass a metre and a half FORWARD of the
  // COB, so the sloop floated bow-down (~−1.7 m·mg static pitch moment; a
  // steady ~0.8° bow-down under way). This is the exact lean the BRIG was
  // already cured of (see buildBrig); the sloop never got the same treatment.
  //
  // Fix: walk every t-band 0.10 AFT so the iron's centroid lands under the COB.
  // Verified to drive the COM-to-COB fore-aft gap to ≈0 (−0.014 m) while
  // leaving the COM height (≈1.65 m) and draft ratio (≈0.37) essentially
  // unchanged — she stays just as stiff and rides the same, just level.
  // Full sinking of a flooded hull is handled by waterlogging (foundering)
  // in game/ship.ts, not by overloading her with iron.
  const AFT = 0.1; // station shift toward the stern (under the fuller-aft COB)
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    if (t < 0.15 - AFT || t > 0.95 - AFT) continue;
    const by = keelY(t) + 1;
    for (const z of [13, 14, 15, 16, 17, 18]) {
      if (inside(x, by, z) && grid.get(x, by, z) === EMPTY) grid.set(x, by, z, IRON);
    }
    // upper tiers: enough mass low that she floats at the widest belt of
    // the egg section — round-5 references: "much more of the ship should
    // be underwater" — with the COM deep for honest banking
    if (t < 0.2 - AFT || t > 0.9 - AFT) continue;
    for (const z of [13, 14, 15, 16, 17, 18]) {
      if (inside(x, by + 1, z) && grid.get(x, by + 1, z) === EMPTY) grid.set(x, by + 1, z, IRON);
    }
    if (t < 0.3 - AFT || t > 0.8 - AFT) continue;
    for (const z of [14, 15, 16, 17]) {
      if (inside(x, by + 2, z) && grid.get(x, by + 2, z) === EMPTY) grid.set(x, by + 2, z, IRON);
    }
    if (t < 0.4 - AFT || t > 0.7 - AFT) continue;
    for (const z of [15, 16]) {
      if (inside(x, by + 3, z) && grid.get(x, by + 3, z) === EMPTY) grid.set(x, by + 3, z, IRON);
    }
  }

  // transverse watertight bulkheads: ~9 holds so a single breach floods one
  // section, not the whole ship (part B of the flooding rework). Evenly spaced
  // from L; the fore/stern taper still encloses air → COMPARTMENTS lands at ~9.
  const bulkheadXs = bulkheadStations(x0, L, 9);
  stampBulkheads(grid, bulkheadXs, deckY, inside);

  // cannon ports are decided BEFORE the rail so the fence can leave
  // embrasures for the barrels (playtest: "cannon barrels clipping directly
  // through the railing … should be slotted in between gaps in the fence").
  // Battery sits aft of the old spread: the forward stations were on the bow
  // taper, where the carriage wheels overhung the narrowing deck (round 8)
  const portXs = [0.3, 0.43, 0.56, 0.69].map((f) => x0 + Math.round(L * f));

  // bulwark as a FENCE, not a solid wall: continuous toe course at the deck,
  // posts every third cell, continuous cap rail at chest height. The 0.5 m
  // gaps read as railing but are too narrow to fall through (capsule ⌀0.56).
  for (let x = 0; x < nx; x++) {
    for (let z = 0; z < nz; z++) {
      if (!inside(x, deckY, z)) continue;
      const onEdge =
        !inside(x - 1, deckY, z) || !inside(x + 1, deckY, z) || !inside(x, deckY, z - 1) || !inside(x, deckY, z + 1);
      if (!onEdge) continue;
      // embrasure: leave the rail fully open around each cannon port so the
      // barrel pokes through a real gap in the fence
      const nearPort = portXs.some((px) => Math.abs(x - px) <= 1);
      if (nearPort) continue;
      grid.set(x, deckY + 1, z, PINE); // toe course (waterway)
      grid.set(x, deckY + 4, z, PINE); // cap rail, chest-high
      // posts: every third cell on straight runs, and at every staircase
      // corner of the curved bow/stern taper — there the rail ring steps
      // diagonally, and a cap cell without a post under it would float
      // (6-connectivity: it would sever as debris on the first hit anywhere)
      const corner =
        (!inside(x - 1, deckY, z) || !inside(x + 1, deckY, z)) &&
        (!inside(x, deckY, z - 1) || !inside(x, deckY, z + 1));
      if (corner || (x + Math.round(Math.abs(z - cz))) % 3 === 0) {
        grid.set(x, deckY + 2, z, PINE);
        grid.set(x, deckY + 3, z, PINE);
      }
    }
  }

  // deck hatches: 2×2 openings centred in three spread holds (fore/mid/aft). With ~9
  // bulkheaded holds only these few flood/drain from the deck — the rest stay sealed,
  // which is what makes a single-section breach survivable (part B of the flooding rework).
  // hatches are GRATED: the deck cells stay solid (walkable — an open hole by the helm
  // swallowed the captain in playtest), but each is a flooding path (water pours through
  // the gratings once the deck goes under the coaming).
  const hatchXs = hatchStations(x0, L, bulkheadXs, 3);
  const hatchZ = Math.floor(cz);
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) {
    hatches.push({ x: hx, z: hatchZ, w: 2, d: 2 });
  }

  // weld floating internals (diagonal-only ballast tiers etc.) to the main mass so the
  // hull is ONE 6-connected solid — otherwise findSevered sheds them all on the first hit.
  lowerBallast(grid, deckY); // ship-feel pass: drop the COM at constant mass (heavier bottom, same waterline)
  weldToSingleComponent(grid);

  // compartments + leak audit
  const compartments = findCompartments(grid, deckY);
  const hatchAreaM2 = 2 * 2 * VOXEL_SIZE * VOXEL_SIZE;
  // only the holds actually UNDER a deck hatch get a flooding orifice; the rest are sealed
  // (resilience: with ~9 holds a normal swell mustn't wash the whole ship via every hatch).
  assignHatchAreas(compartments, hatchXs, hatchAreaM2);

  // leak audit: every interior empty region below deck must be a compartment;
  // count interior-ish air cells not claimed by any compartment near the hull interior
  const claimed = new Set<number>();
  for (const c of compartments) for (const cell of c.cells) claimed.add(cell);
  const interiorLeaks: number[] = [];
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        // a cell strictly inside the analytic envelope that is empty and unclaimed
        // means the region it belongs to escaped through a hull gap
        if (inside(x, y, z) && y < deckY && grid.get(x, y, z) === EMPTY && !claimed.has(idx(x, y, z))) {
          interiorLeaks.push(idx(x, y, z));
        }
      }
    }
  }

  // cannon ports: 4 per side, midship spread, at deck level on the bulwark
  // line (portXs declared above, where the fence leaves embrasures for them)
  const cannonPorts: ShipBuild["cannonPorts"] = [];
  for (const px of portXs) {
    const t = stationT(px);
    const hb = Math.round(sectionHalfBeam(t, deckY));
    // floor/ceil split keeps the two ports SYMMETRIC about the true centerline:
    // cz is a half-cell on an even beam, and round(cz±hb) biased BOTH batteries
    // a half-cell to starboard — so the right guns hung a full cell further over
    // the edge than the left ("right … hanging off the edge, the left … only
    // slightly off", round 9). Now they mirror exactly.
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.floor(cz) + hb, side: 1 });
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.ceil(cz) - hb, side: -1 });
  }

  // r17: the sloop's bow + stern chasers (axial guns; see the brig for the rationale).
  // Cannon-count pass: 2 bow + 2 stern (was 1+1) — bigger ship, more chasers. The pair
  // straddles the centerline (cz0/cz1 sum to nz−1 → exact mirror), both seated in solid
  // bow/stern timber below the deck so each has a real mount (sim/cannonMount.ts).
  const cz0 = Math.floor(cz),
    cz1 = Math.ceil(cz); // true mirror pair: cz0 + cz1 === nz − 1
  cannonPorts.push({ x: x0 + L - 5, y: deckY - 4, z: cz0, side: -1, facing: "fore" });
  cannonPorts.push({ x: x0 + L - 5, y: deckY - 4, z: cz1, side: 1, facing: "fore" });
  cannonPorts.push({ x: x0 + 4, y: deckY - 1, z: cz0, side: -1, facing: "aft" });
  cannonPorts.push({ x: x0 + 4, y: deckY - 1, z: cz1, side: 1, facing: "aft" });

  // single mast slightly forward of midship
  const masts = [{ x: x0 + Math.round(L * 0.42), z: Math.round(cz), h: 15 }];
  // masts are REAL voxels now — break voxel-by-voxel + sever above a shot-out base (no rigid topple).
  const mastVoxels = stampMasts(grid, masts, () => deckY);

  armorBow(grid); // reinforced forward shell — a bow-first ram wins (material cost asymmetry)

  return {
    grid,
    deckY,
    envelopeVolume: envelopeCells * VOXEL_VOLUME,
    compartments,
    interiorLeaks,
    cannonPorts,
    masts,
    mastVoxels,
    hatches,
    lengthM: L * VOXEL_SIZE,
    beamM: halfBeamMax * 2 * VOXEL_SIZE,
    deckYAt: () => deckY,
    quarterdeck: null,
    wheelM: { x: 3.4, z: (nz / 2) * VOXEL_SIZE },
    footprint: {
      minX: (x0 - 6) * VOXEL_SIZE,
      maxX: (x0 + L + 6) * VOXEL_SIZE,
      zC: (nz / 2) * VOXEL_SIZE,
      halfZ: (halfBeamMax + 5.4) * VOXEL_SIZE,
    },
  };
}

/**
 * The player's ship from playtest round 6: "a realistically sized
 * sixteen-hundreds-era fighting vessel … big enough to have a crew and store
 * cannonballs and food and a few hammocks" — a 34 m brig with a raised
 * quarterdeck aft ("the back of the ship comes up one story higher than the
 * rest and the wheel on that deck"), a wider waist than the old canoe-deck,
 * five guns a side, two masts, and side companion stairs up the break.
 * The old sloop above stays verbatim as the enemy's easier hull.
 */
export function buildBrig(): ShipBuild {
  const nx = 152;
  // ny holds the HULL (main deck ≈24, quarterdeck ≈33) PLUS a VOXEL MAST tower. A full 21 m mast in
  // voxels (+84) would push this wide hull's grid past ~1 M cells (a heavier findSevered scan). The
  // voxel trunk is CAPPED to the grid top (~16 m of breakable voxel mast — the bulk a fight shoots /
  // rams); shipVisual keeps the thin cosmetic topmast above it. The small cutter/sloop fit fully.
  const ny = 90;
  const nz = 44;
  const grid = createGrid(nx, ny, nz);

  const x0 = 4; // stern transom station (low x = aft, bow at high x)
  const L = 136; // 34 m
  const deckY = 24; // 6 m hold, keel to main deck
  const qDeckY = deckY + 9; // quarterdeck: one story (2.25 m) above the waist
  const qT = 0.22; // stations with t < qT carry the quarterdeck
  const halfBeamMax = 19; // 9.5 m beam at the belt
  const cz = (nz - 1) / 2;
  // last (most forward) quarterdeck station: the largest x with t < qT
  const qX1 = Math.floor(x0 + qT * (L - 1) - 1e-9);

  const stationT = (x: number) => (x - x0) / (L - 1);
  const keelY = (t: number) => 2 + Math.round(5 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.8));
  const halfBeam = (t: number) => halfBeamMax * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * t)), 0.72);
  const sectionHalfBeam = (t: number, y: number) => {
    const k = keelY(t);
    const f = Math.min(Math.max((y - k) / (deckY - k), 0), 1);
    // the round-5 egg, but with the deck edge held out to ~84% of the belt:
    // round 6 — "the shape of the deck is just too narrow and canoe-like"
    const d = f - 0.62;
    const a = d < 0 ? 0.64 : 0.67;
    const oval = Math.sqrt(Math.max(1 - (d / a) * (d / a), 0));
    return halfBeam(t) * (0.1 + 0.9 * oval);
  };

  const deckYAt = (x: number) => (x <= qX1 ? qDeckY : deckY);

  const inside = (x: number, y: number, z: number): boolean => {
    const t = stationT(x);
    if (t < 0 || t > 1) return false;
    if (y < keelY(t) || y > deckYAt(x)) return false;
    return Math.abs(z - cz) <= sectionHalfBeam(t, y);
  };

  // rasterize: OAK shell, PINE deck planking. The waist deck plane continues
  // aft UNDER the quarterdeck as the cabin sole, and the quarterdeck caps the
  // cabin; the shell rule raises the stern sides and the break wall itself.
  let envelopeCells = 0;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        if (!inside(x, y, z)) continue;
        envelopeCells++;
        if (y === deckY || y === deckYAt(x)) {
          grid.set(x, y, z, PINE);
          continue;
        }
        const onShell =
          !inside(x - 1, y, z) ||
          !inside(x + 1, y, z) ||
          !inside(x, y - 1, z) ||
          !inside(x, y, z - 1) ||
          !inside(x, y, z + 1);
        if (onShell) grid.set(x, y, z, OAK);
      }
    }
  }

  // the great-cabin door: a full-height opening in the break wall at the
  // centerline, so the space under the quarterdeck is walkable from the waist
  for (let z = Math.round(cz - 1.5); z <= Math.round(cz + 1.5); z++) {
    for (let y = deckY + 1; y <= deckY + 7; y++) {
      if (grid.get(qX1, y, z) !== EMPTY) grid.remove(qX1, y, z);
    }
  }

  // companion stairs port + starboard: nine 1-voxel steps (0.25 rise/run —
  // the character controller autosteps 0.35) climbing AFT up the break,
  // each step a solid wedge to the waist deck so nothing floats
  // mirror-exact lanes: cz is .5 (even nz), so floor/ceil keep symmetry
  const stairZs = [Math.floor(cz - 10), Math.ceil(cz + 10)];
  for (const sz of stairZs) {
    for (let s = 0; s < 8; s++) {
      const sx = qX1 + 8 - s;
      for (let z = sz - 1; z <= sz + 1; z++) {
        for (let y = deckY + 1; y <= deckY + 1 + s; y++) {
          if (grid.get(sx, y, z) === EMPTY) grid.set(sx, y, z, PINE);
        }
      }
    }
  }

  // iron ballast: z-bands around the centerline, t-bands matching the
  // fuller-aft hull, four tiers deep — the brig floats at the belt of the
  // egg section with the COM low (tuned live: draft ≈ 45-50% of hull height)
  const ballastZ = (k: number) => {
    const zs: number[] = [];
    for (let z = Math.ceil(cz - k); z <= Math.floor(cz + k); z++) zs.push(z);
    return zs;
  };
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    // every band sits ~0.07·L (≈1.7 m) AFT of the round-7 layout: she floated
    // a steady ~2° bow-down ("the ship has a tendency to lean forwards",
    // round 8) because the iron's centroid was forward of the fuller-aft
    // hull's center of buoyancy. Tuned live to ≈level.
    if (t < 0.05 || t > 0.88) continue;
    const by = keelY(t) + 1;
    for (const z of ballastZ(4)) {
      if (inside(x, by, z) && grid.get(x, by, z) === EMPTY) grid.set(x, by, z, IRON);
    }
    if (t < 0.09 || t > 0.85) continue;
    for (const z of ballastZ(4)) {
      if (inside(x, by + 1, z) && grid.get(x, by + 1, z) === EMPTY) grid.set(x, by + 1, z, IRON);
    }
    if (t < 0.17 || t > 0.79) continue;
    for (const z of ballastZ(3)) {
      if (inside(x, by + 2, z) && grid.get(x, by + 2, z) === EMPTY) grid.set(x, by + 2, z, IRON);
    }
    if (t < 0.27 || t > 0.69) continue;
    for (const z of ballastZ(2)) {
      if (inside(x, by + 3, z) && grid.get(x, by + 3, z) === EMPTY) grid.set(x, by + 3, z, IRON);
    }
    // tiers 5-6 read as stores/shot lockers: the brig needs ~530 t to float
    // at the belt like the round-5 reference cutaways
    if (t < 0.23 || t > 0.73) continue;
    for (const z of ballastZ(3)) {
      if (inside(x, by + 4, z) && grid.get(x, by + 4, z) === EMPTY) grid.set(x, by + 4, z, IRON);
    }
    if (t < 0.33 || t > 0.63) continue;
    for (const z of ballastZ(2)) {
      if (inside(x, by + 5, z) && grid.get(x, by + 5, z) === EMPTY) grid.set(x, by + 5, z, IRON);
    }
  }
  // shot lockers + water casks amidships (tiers 7-8): the last ~150 t that
  // put the waterline at the belt — all still well below it, so the COM
  // stays deep and she stiffens rather than tips
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    const by = keelY(t) + 1;
    if (t >= 0.15 && t <= 0.79) {
      for (const z of ballastZ(4)) {
        if (inside(x, by + 6, z) && grid.get(x, by + 6, z) === EMPTY) grid.set(x, by + 6, z, IRON);
      }
    }
    if (t >= 0.25 && t <= 0.71) {
      for (const z of ballastZ(3)) {
        if (inside(x, by + 7, z) && grid.get(x, by + 7, z) === EMPTY) grid.set(x, by + 7, z, IRON);
      }
    }
  }
  // round 13 (overnight): the by+8 ballast course is DROPPED. It was added to
  // deepen the draft to 0.5–0.6, but in motion that sat the waterline right at
  // the gunwale ("water basically all the way up to the deck … not realistic" —
  // playtest, vs the tall dry topsides of real ships). Per the buoyancy research,
  // average hull density = draft/depth; cutting this top course lightens her so
  // she rides at ~0.45 (a tall, reference-like freeboard) AND lowers the COM (the
  // dropped mass was the closest to it), so she stiffens rather than tips.

  // transverse watertight bulkheads: ~10 holds (part B of the flooding rework) so a
  // single breach floods one section. Evenly spaced from L; quarterdeck stations carry
  // the same below-deck partition. fore/aft taper still encloses air → ~10 compartments.
  const bulkheadXs = bulkheadStations(x0, L, 10);
  stampBulkheads(grid, bulkheadXs, deckY, inside);

  // five gun ports a side along the waist, clear of the quarterdeck break.
  // Spread pulled aft (round 8: the 0.78 station rode the bow taper — "the
  // cannons are still too far forward … front wheels over the edge")
  const portXs = [0.3, 0.41, 0.52, 0.63, 0.74].map((f) => x0 + Math.round(L * f));

  // bulwark fence at each deck's own edge (waist AND quarterdeck), with
  // embrasures for the guns and gaps where the companion stairs land
  for (let x = 0; x < nx; x++) {
    const dY = deckYAt(x);
    for (let z = 0; z < nz; z++) {
      if (!inside(x, dY, z)) continue;
      // a neighbor missing AT THIS DECK'S LEVEL is an edge — which also puts
      // a breast rail along the quarterdeck break (the waist tops out lower)
      const onEdge =
        !inside(x - 1, dY, z) || !inside(x + 1, dY, z) || !inside(x, dY, z - 1) || !inside(x, dY, z + 1);
      if (!onEdge) continue;
      const nearPort = dY === deckY && portXs.some((px) => Math.abs(x - px) <= 1);
      if (nearPort) continue;
      // companion-stair landings: no toe course where you top out
      if (x === qX1 && stairZs.some((sz) => Math.abs(z - sz) <= 1)) continue;
      grid.set(x, dY + 1, z, PINE);
      grid.set(x, dY + 4, z, PINE);
      const corner =
        (!inside(x - 1, dY, z) || !inside(x + 1, dY, z)) &&
        (!inside(x, dY, z - 1) || !inside(x, dY, z + 1));
      if (corner || (x + Math.round(Math.abs(z - cz))) % 3 === 0) {
        grid.set(x, dY + 2, z, PINE);
        grid.set(x, dY + 3, z, PINE);
      }
    }
  }

  // grated deck hatches over each hold (flooding paths, walkable)
  // hatches centred in three spread holds (fore/mid/aft) so only those flood/drain from the
  // deck; the rest of the ~10 holds stay sealed (part B of the flooding rework — resilience).
  const hatchXs = hatchStations(x0, L, bulkheadXs, 3);
  const hatchZ = Math.floor(cz);
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) hatches.push({ x: hx, z: hatchZ, w: 2, d: 2 });

  // weld floating internals to the main mass — ONE 6-connected solid (see weld.ts / buildSloop).
  lowerBallast(grid, deckY); // ship-feel pass: drop the COM at constant mass (heavier bottom, same waterline)
  weldToSingleComponent(grid);

  const compartments = findCompartments(grid, deckY);
  const hatchAreaM2 = 2 * 2 * VOXEL_SIZE * VOXEL_SIZE;
  // only holds under a deck hatch flood from the deck; the rest stay sealed (resilience).
  assignHatchAreas(compartments, hatchXs, hatchAreaM2);

  const claimed = new Set<number>();
  for (const c of compartments) for (const cell of c.cells) claimed.add(cell);
  const interiorLeaks: number[] = [];
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(x, y, z) && grid.get(x, y, z) === EMPTY && !claimed.has(idx(x, y, z))) {
          interiorLeaks.push(idx(x, y, z));
        }
      }
    }
  }

  const cannonPorts: ShipBuild["cannonPorts"] = [];
  for (const px of portXs) {
    const t = stationT(px);
    const hb = Math.round(sectionHalfBeam(t, deckY));
    // floor/ceil split keeps the two ports SYMMETRIC about the true centerline:
    // cz is a half-cell on an even beam, and round(cz±hb) biased BOTH batteries
    // a half-cell to starboard — so the right guns hung a full cell further over
    // the edge than the left ("right … hanging off the edge, the left … only
    // slightly off", round 9). Now they mirror exactly.
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.floor(cz) + hb, side: 1 });
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.ceil(cz) - hb, side: -1 });
  }

  // r17: bow chasers one gun deck BELOW the main deck (fire forward) and stern chasers
  // from the great cabin (fire aft) — axial guns so you can line a shot on a ship you're
  // chasing or running from, not only abeam ("so hard to line up shots with the enemy").
  // The hull voxels stay intact (shipVisual frames the gunport); all sit above the water.
  // Cannon-count pass: 3 bow + 3 stern (was 2+2) — a mirror pair straddling the centerline
  // plus a CENTRED gun seated one station further inboard so no two share a voxel. cz0/cz1 are
  // the two centre cells (cz0 + cz1 === nz − 1 → an exact mirror pair); the centred gun sits on
  // cz1. Each seats in solid bow/stern timber (sim/cannonMount.ts samples a box around the port).
  const cz0 = Math.floor(cz),
    cz1 = Math.ceil(cz); // true mirror pair about the centerline
  cannonPorts.push({ x: x0 + L - 6, y: deckY - 5, z: cz0, side: -1, facing: "fore" });
  cannonPorts.push({ x: x0 + L - 6, y: deckY - 5, z: cz1, side: 1, facing: "fore" });
  cannonPorts.push({ x: x0 + L - 9, y: deckY - 3, z: cz1, side: 1, facing: "fore" });
  cannonPorts.push({ x: x0 + 5, y: deckY - 1, z: cz0, side: -1, facing: "aft" });
  cannonPorts.push({ x: x0 + 5, y: deckY - 1, z: cz1, side: 1, facing: "aft" });
  cannonPorts.push({ x: x0 + 8, y: deckY - 3, z: cz1, side: 1, facing: "aft" });

  // brig rig: main mast forward of midship, fore mast toward the bow
  const masts = [
    { x: x0 + Math.round(L * 0.38), z: Math.round(cz), h: 21 },
    { x: x0 + Math.round(L * 0.68), z: Math.round(cz), h: 18 },
  ];
  // masts are REAL voxels now — break voxel-by-voxel + sever above a shot-out base (no rigid topple).
  const mastVoxels = stampMasts(grid, masts, deckYAt);

  armorBow(grid); // reinforced forward shell — a bow-first ram wins (material cost asymmetry)

  return {
    grid,
    deckY,
    envelopeVolume: envelopeCells * VOXEL_VOLUME,
    compartments,
    interiorLeaks,
    cannonPorts,
    masts,
    mastVoxels,
    hatches,
    lengthM: L * VOXEL_SIZE,
    beamM: halfBeamMax * 2 * VOXEL_SIZE,
    deckYAt,
    quarterdeck: { x1: qX1, deckY: qDeckY },
    wheelM: { x: (x0 + Math.round(L * 0.1) + 0.5) * VOXEL_SIZE, z: (nz / 2) * VOXEL_SIZE },
    footprint: {
      minX: (x0 - 6) * VOXEL_SIZE,
      maxX: (x0 + L + 6) * VOXEL_SIZE,
      zC: (nz / 2) * VOXEL_SIZE,
      halfZ: (halfBeamMax + 5.4) * VOXEL_SIZE,
    },
  };
}

/**
 * The CUTTER — the tycoon starter hull and the commonest early prey: a small,
 * cheap, single-masted ~19 m boat with two guns a side plus chasers, a flush
 * deck and a shallow hold. Modelled on {@link buildSloop} (same egg section and
 * fence/hatch/ballast recipe) but scaled down; ballast is centreline-relative so
 * the smaller beam still self-trims at the belt.
 */
export function buildCutter(): ShipBuild {
  const nx = 84;
  // ny holds the HULL (deckY≈16) PLUS the VOXEL MAST tower (12 m ≈ 48 voxels) + headroom — the mast
  // is real grid voxels now (stampMasts), so the grid must be tall enough to contain the trunk.
  const ny = 70;
  const nz = 26;
  const grid = createGrid(nx, ny, nz);

  const x0 = 4;
  const L = 76; // 19 m
  const deckY = 16; // 4 m hold
  const halfBeamMax = 10; // beam ≈ 5 m at the belt
  const cz = (nz - 1) / 2;

  const stationT = (x: number) => (x - x0) / (L - 1);
  const keelY = (t: number) => 2 + Math.round(3 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.8));
  const halfBeam = (t: number) => halfBeamMax * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * t)), 0.72);
  const sectionHalfBeam = (t: number, y: number) => {
    const k = keelY(t);
    const f = Math.min(Math.max((y - k) / (deckY - k), 0), 1);
    const d = f - 0.62;
    const a = d < 0 ? 0.64 : 0.56;
    const oval = Math.sqrt(Math.max(1 - (d / a) * (d / a), 0));
    return halfBeam(t) * (0.1 + 0.9 * oval);
  };
  const inside = (x: number, y: number, z: number): boolean => {
    const t = stationT(x);
    if (t < 0 || t > 1) return false;
    if (y < keelY(t) || y > deckY) return false;
    return Math.abs(z - cz) <= sectionHalfBeam(t, y);
  };

  let envelopeCells = 0;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        if (!inside(x, y, z)) continue;
        envelopeCells++;
        if (y === deckY) {
          grid.set(x, y, z, PINE);
          continue;
        }
        const onShell =
          !inside(x - 1, y, z) ||
          !inside(x + 1, y, z) ||
          !inside(x, y - 1, z) ||
          !inside(x, y, z - 1) ||
          !inside(x, y, z + 1);
        if (onShell) grid.set(x, y, z, OAK);
      }
    }
  }

  // iron ballast: centreline-relative z-bands, shifted aft under the fuller-aft COB.
  const ballastZ = (k: number) => {
    const zs: number[] = [];
    for (let z = Math.ceil(cz - k); z <= Math.floor(cz + k); z++) zs.push(z);
    return zs;
  };
  const AFT = 0.1;
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    if (t < 0.15 - AFT || t > 0.95 - AFT) continue;
    const by = keelY(t) + 1;
    for (const z of ballastZ(4)) {
      if (inside(x, by, z) && grid.get(x, by, z) === EMPTY) grid.set(x, by, z, IRON);
    }
    if (t < 0.2 - AFT || t > 0.9 - AFT) continue;
    for (const z of ballastZ(3)) {
      if (inside(x, by + 1, z) && grid.get(x, by + 1, z) === EMPTY) grid.set(x, by + 1, z, IRON);
    }
    if (t < 0.32 - AFT || t > 0.78 - AFT) continue;
    for (const z of ballastZ(2)) {
      if (inside(x, by + 2, z) && grid.get(x, by + 2, z) === EMPTY) grid.set(x, by + 2, z, IRON);
    }
  }

  // transverse watertight bulkheads: ~8 holds — fewer than the bigger hulls since the
  // little cutter (L=76) shouldn't be absurdly chopped, but enough that a single breach
  // floods one section, not the whole boat (part B of the flooding rework).
  const bulkheadXs = bulkheadStations(x0, L, 8);
  stampBulkheads(grid, bulkheadXs, deckY, inside);

  // two guns a side
  const portXs = [0.4, 0.62].map((f) => x0 + Math.round(L * f));

  for (let x = 0; x < nx; x++) {
    for (let z = 0; z < nz; z++) {
      if (!inside(x, deckY, z)) continue;
      const onEdge =
        !inside(x - 1, deckY, z) || !inside(x + 1, deckY, z) || !inside(x, deckY, z - 1) || !inside(x, deckY, z + 1);
      if (!onEdge) continue;
      if (portXs.some((px) => Math.abs(x - px) <= 1)) continue;
      grid.set(x, deckY + 1, z, PINE);
      grid.set(x, deckY + 4, z, PINE);
      const corner =
        (!inside(x - 1, deckY, z) || !inside(x + 1, deckY, z)) &&
        (!inside(x, deckY, z - 1) || !inside(x, deckY, z + 1));
      if (corner || (x + Math.round(Math.abs(z - cz))) % 3 === 0) {
        grid.set(x, deckY + 2, z, PINE);
        grid.set(x, deckY + 3, z, PINE);
      }
    }
  }

  // two hatches centred in a fore and an aft hold so a couple of holds flood/drain from the
  // deck; the rest of the ~8 stay sealed (part B of the flooding rework — resilience).
  const hatchXs = hatchStations(x0, L, bulkheadXs, 2);
  const hatchZ = Math.floor(cz);
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) hatches.push({ x: hx, z: hatchZ, w: 2, d: 2 });

  lowerBallast(grid, deckY); // ship-feel pass: drop the COM at constant mass (heavier bottom, same waterline)
  weldToSingleComponent(grid);

  const compartments = findCompartments(grid, deckY);
  const hatchAreaM2 = 2 * 2 * VOXEL_SIZE * VOXEL_SIZE;
  // only holds under a deck hatch flood from the deck; the rest stay sealed (resilience).
  assignHatchAreas(compartments, hatchXs, hatchAreaM2);

  const claimed = new Set<number>();
  for (const c of compartments) for (const cell of c.cells) claimed.add(cell);
  const interiorLeaks: number[] = [];
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(x, y, z) && grid.get(x, y, z) === EMPTY && !claimed.has(idx(x, y, z))) {
          interiorLeaks.push(idx(x, y, z));
        }
      }
    }
  }

  const cannonPorts: ShipBuild["cannonPorts"] = [];
  for (const px of portXs) {
    const t = stationT(px);
    const hb = Math.round(sectionHalfBeam(t, deckY));
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.floor(cz) + hb, side: 1 });
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.ceil(cz) - hb, side: -1 });
  }
  const czi = Math.round(cz);
  cannonPorts.push({ x: x0 + L - 5, y: deckY - 3, z: czi, side: 1, facing: "fore" });
  cannonPorts.push({ x: x0 + 4, y: deckY - 1, z: czi, side: 1, facing: "aft" });

  const masts = [{ x: x0 + Math.round(L * 0.44), z: Math.round(cz), h: 12 }];
  // masts are REAL voxels now — break voxel-by-voxel + sever above a shot-out base (no rigid topple).
  const mastVoxels = stampMasts(grid, masts, () => deckY);

  armorBow(grid);

  return {
    grid,
    deckY,
    envelopeVolume: envelopeCells * VOXEL_VOLUME,
    compartments,
    interiorLeaks,
    cannonPorts,
    masts,
    mastVoxels,
    hatches,
    lengthM: L * VOXEL_SIZE,
    beamM: halfBeamMax * 2 * VOXEL_SIZE,
    deckYAt: () => deckY,
    quarterdeck: null,
    wheelM: { x: 3.4, z: (nz / 2) * VOXEL_SIZE },
    footprint: {
      minX: (x0 - 6) * VOXEL_SIZE,
      maxX: (x0 + L + 6) * VOXEL_SIZE,
      zC: (nz / 2) * VOXEL_SIZE,
      halfZ: (halfBeamMax + 5.4) * VOXEL_SIZE,
    },
  };
}

/**
 * The FRIGATE — the late-game flagship: a big ~43 m three-master with a raised
 * quarterdeck, six guns a side plus bow/stern chasers, and a deep, many-tiered
 * hold. Modelled on {@link buildBrig} (quarterdeck + companion stairs + the same
 * deep-ballast recipe) scaled up; ballast is centreline-relative and tuned to
 * float at the belt with a deep COM.
 */
export function buildFrigate(): ShipBuild {
  const nx = 188;
  // ny holds the HULL (main deck ≈28, quarterdeck ≈37) PLUS a VOXEL MAST tower. A full 26 m mast in
  // voxels (+104) would push this big hull's grid past ~1.3 M cells (a heavier findSevered scan). The
  // voxel trunk is CAPPED to the grid top (~16 m of breakable voxel mast — the bulk a fight shoots /
  // rams); shipVisual keeps the thin cosmetic topmast above it. The small cutter/sloop fit fully.
  const ny = 96;
  const nz = 50;
  const grid = createGrid(nx, ny, nz);

  const x0 = 4;
  const L = 172; // 43 m
  const deckY = 28; // 7 m hold
  const qDeckY = deckY + 9;
  const qT = 0.22;
  const halfBeamMax = 22; // 11 m beam
  const cz = (nz - 1) / 2;
  const qX1 = Math.floor(x0 + qT * (L - 1) - 1e-9);

  const stationT = (x: number) => (x - x0) / (L - 1);
  const keelY = (t: number) => 2 + Math.round(6 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.8));
  const halfBeam = (t: number) => halfBeamMax * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * t)), 0.72);
  const sectionHalfBeam = (t: number, y: number) => {
    const k = keelY(t);
    const f = Math.min(Math.max((y - k) / (deckY - k), 0), 1);
    const d = f - 0.62;
    const a = d < 0 ? 0.64 : 0.67;
    const oval = Math.sqrt(Math.max(1 - (d / a) * (d / a), 0));
    return halfBeam(t) * (0.1 + 0.9 * oval);
  };
  const deckYAt = (x: number) => (x <= qX1 ? qDeckY : deckY);
  const inside = (x: number, y: number, z: number): boolean => {
    const t = stationT(x);
    if (t < 0 || t > 1) return false;
    if (y < keelY(t) || y > deckYAt(x)) return false;
    return Math.abs(z - cz) <= sectionHalfBeam(t, y);
  };

  let envelopeCells = 0;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        if (!inside(x, y, z)) continue;
        envelopeCells++;
        if (y === deckY || y === deckYAt(x)) {
          grid.set(x, y, z, PINE);
          continue;
        }
        const onShell =
          !inside(x - 1, y, z) ||
          !inside(x + 1, y, z) ||
          !inside(x, y - 1, z) ||
          !inside(x, y, z - 1) ||
          !inside(x, y, z + 1);
        if (onShell) grid.set(x, y, z, OAK);
      }
    }
  }

  // great-cabin door through the break wall
  for (let z = Math.round(cz - 1.5); z <= Math.round(cz + 1.5); z++) {
    for (let y = deckY + 1; y <= deckY + 7; y++) {
      if (grid.get(qX1, y, z) !== EMPTY) grid.remove(qX1, y, z);
    }
  }

  // companion stairs port + starboard up the break
  const stairZs = [Math.floor(cz - 12), Math.ceil(cz + 12)];
  for (const sz of stairZs) {
    for (let s = 0; s < 8; s++) {
      const sx = qX1 + 8 - s;
      for (let z = sz - 1; z <= sz + 1; z++) {
        for (let y = deckY + 1; y <= deckY + 1 + s; y++) {
          if (grid.get(sx, y, z) === EMPTY) grid.set(sx, y, z, PINE);
        }
      }
    }
  }

  // deep iron ballast — centreline-relative bands, fuller aft, many tiers.
  const ballastZ = (k: number) => {
    const zs: number[] = [];
    for (let z = Math.ceil(cz - k); z <= Math.floor(cz + k); z++) zs.push(z);
    return zs;
  };
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    if (t < 0.05 || t > 0.88) continue;
    const by = keelY(t) + 1;
    for (const z of ballastZ(5)) {
      if (inside(x, by, z) && grid.get(x, by, z) === EMPTY) grid.set(x, by, z, IRON);
    }
    if (t < 0.09 || t > 0.85) continue;
    for (const z of ballastZ(5)) {
      if (inside(x, by + 1, z) && grid.get(x, by + 1, z) === EMPTY) grid.set(x, by + 1, z, IRON);
    }
    if (t < 0.17 || t > 0.79) continue;
    for (const z of ballastZ(4)) {
      if (inside(x, by + 2, z) && grid.get(x, by + 2, z) === EMPTY) grid.set(x, by + 2, z, IRON);
    }
    if (t < 0.27 || t > 0.69) continue;
    for (const z of ballastZ(3)) {
      if (inside(x, by + 3, z) && grid.get(x, by + 3, z) === EMPTY) grid.set(x, by + 3, z, IRON);
    }
    if (t < 0.23 || t > 0.73) continue;
    for (const z of ballastZ(3)) {
      if (inside(x, by + 4, z) && grid.get(x, by + 4, z) === EMPTY) grid.set(x, by + 4, z, IRON);
    }
    if (t < 0.33 || t > 0.63) continue;
    for (const z of ballastZ(2)) {
      if (inside(x, by + 5, z) && grid.get(x, by + 5, z) === EMPTY) grid.set(x, by + 5, z, IRON);
    }
  }
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    const by = keelY(t) + 1;
    if (t >= 0.15 && t <= 0.79) {
      for (const z of ballastZ(4)) {
        if (inside(x, by + 6, z) && grid.get(x, by + 6, z) === EMPTY) grid.set(x, by + 6, z, IRON);
      }
    }
    if (t >= 0.25 && t <= 0.71) {
      for (const z of ballastZ(3)) {
        if (inside(x, by + 7, z) && grid.get(x, by + 7, z) === EMPTY) grid.set(x, by + 7, z, IRON);
      }
    }
  }

  // transverse watertight bulkheads: ~11 holds on this long hull (part B of the flooding
  // rework) so a single breach floods one section. Evenly spaced from L; the deep fore/aft
  // taper still encloses air → ~11 compartments.
  const bulkheadXs = bulkheadStations(x0, L, 11);
  stampBulkheads(grid, bulkheadXs, deckY, inside);

  // six guns a side along the waist
  const portXs = [0.3, 0.39, 0.48, 0.57, 0.66, 0.75].map((f) => x0 + Math.round(L * f));

  for (let x = 0; x < nx; x++) {
    const dY = deckYAt(x);
    for (let z = 0; z < nz; z++) {
      if (!inside(x, dY, z)) continue;
      const onEdge =
        !inside(x - 1, dY, z) || !inside(x + 1, dY, z) || !inside(x, dY, z - 1) || !inside(x, dY, z + 1);
      if (!onEdge) continue;
      const nearPort = dY === deckY && portXs.some((px) => Math.abs(x - px) <= 1);
      if (nearPort) continue;
      if (x === qX1 && stairZs.some((sz) => Math.abs(z - sz) <= 1)) continue;
      grid.set(x, dY + 1, z, PINE);
      grid.set(x, dY + 4, z, PINE);
      const corner =
        (!inside(x - 1, dY, z) || !inside(x + 1, dY, z)) &&
        (!inside(x, dY, z - 1) || !inside(x, dY, z + 1));
      if (corner || (x + Math.round(Math.abs(z - cz))) % 3 === 0) {
        grid.set(x, dY + 2, z, PINE);
        grid.set(x, dY + 3, z, PINE);
      }
    }
  }

  // hatches centred in three spread holds (fore/mid/aft) so only those flood/drain from the
  // deck; the rest of the ~10 holds stay sealed (part B of the flooding rework — resilience).
  const hatchXs = hatchStations(x0, L, bulkheadXs, 3);
  const hatchZ = Math.floor(cz);
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) hatches.push({ x: hx, z: hatchZ, w: 2, d: 2 });

  lowerBallast(grid, deckY); // ship-feel pass: drop the COM at constant mass (heavier bottom, same waterline)
  weldToSingleComponent(grid);

  const compartments = findCompartments(grid, deckY);
  const hatchAreaM2 = 2 * 2 * VOXEL_SIZE * VOXEL_SIZE;
  // only holds under a deck hatch flood from the deck; the rest stay sealed (resilience).
  assignHatchAreas(compartments, hatchXs, hatchAreaM2);

  const claimed = new Set<number>();
  for (const c of compartments) for (const cell of c.cells) claimed.add(cell);
  const interiorLeaks: number[] = [];
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(x, y, z) && grid.get(x, y, z) === EMPTY && !claimed.has(idx(x, y, z))) {
          interiorLeaks.push(idx(x, y, z));
        }
      }
    }
  }

  const cannonPorts: ShipBuild["cannonPorts"] = [];
  for (const px of portXs) {
    const t = stationT(px);
    const hb = Math.round(sectionHalfBeam(t, deckY));
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.floor(cz) + hb, side: 1 });
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.ceil(cz) - hb, side: -1 });
  }
  // Cannon-count pass: 4 bow + 4 stern chasers (was 2+2) on this big late-game frigate —
  // two mirror pairs per end on two gun-deck heights, the inner pair tucked near the
  // centerline and the outer pair spread in z and seated a deck lower. cz0/cz1 are the centre
  // cells (cz0 + cz1 === nz − 1); spreading both outward by k keeps each pair an exact mirror.
  // All sit in solid bow/stern timber below the weather deck (sim/cannonMount.ts).
  const cz0 = Math.floor(cz),
    cz1 = Math.ceil(cz);
  cannonPorts.push({ x: x0 + L - 6, y: deckY - 5, z: cz0, side: -1, facing: "fore" });
  cannonPorts.push({ x: x0 + L - 6, y: deckY - 5, z: cz1, side: 1, facing: "fore" });
  cannonPorts.push({ x: x0 + L - 8, y: deckY - 9, z: cz0 - 2, side: -1, facing: "fore" });
  cannonPorts.push({ x: x0 + L - 8, y: deckY - 9, z: cz1 + 2, side: 1, facing: "fore" });
  cannonPorts.push({ x: x0 + 5, y: deckY - 1, z: cz0, side: -1, facing: "aft" });
  cannonPorts.push({ x: x0 + 5, y: deckY - 1, z: cz1, side: 1, facing: "aft" });
  cannonPorts.push({ x: x0 + 7, y: deckY - 6, z: cz0 - 2, side: -1, facing: "aft" });
  cannonPorts.push({ x: x0 + 7, y: deckY - 6, z: cz1 + 2, side: 1, facing: "aft" });

  // three masts
  const masts = [
    { x: x0 + Math.round(L * 0.3), z: Math.round(cz), h: 24 },
    { x: x0 + Math.round(L * 0.52), z: Math.round(cz), h: 26 },
    { x: x0 + Math.round(L * 0.74), z: Math.round(cz), h: 22 },
  ];
  // masts are REAL voxels now — break voxel-by-voxel + sever above a shot-out base (no rigid topple).
  const mastVoxels = stampMasts(grid, masts, deckYAt);

  armorBow(grid);

  return {
    grid,
    deckY,
    envelopeVolume: envelopeCells * VOXEL_VOLUME,
    compartments,
    interiorLeaks,
    cannonPorts,
    masts,
    mastVoxels,
    hatches,
    lengthM: L * VOXEL_SIZE,
    beamM: halfBeamMax * 2 * VOXEL_SIZE,
    deckYAt,
    quarterdeck: { x1: qX1, deckY: qDeckY },
    wheelM: { x: (x0 + Math.round(L * 0.1) + 0.5) * VOXEL_SIZE, z: (nz / 2) * VOXEL_SIZE },
    footprint: {
      minX: (x0 - 6) * VOXEL_SIZE,
      maxX: (x0 + L + 6) * VOXEL_SIZE,
      zC: (nz / 2) * VOXEL_SIZE,
      halfZ: (halfBeamMax + 5.4) * VOXEL_SIZE,
    },
  };
}

export function buildManOfWar(): ShipBuild {
  const nx = 208;
  // ny holds the HULL (weather deck ≈36) PLUS a tall VOXEL MAST tower. This first-rate's grid is
  // ALREADY huge in plan (208×60), so a full 32 m voxel mast (+128 voxels) would blow it past 2 M
  // cells (heavy findSevered + a per-cell test that stalls). The voxel trunk is CAPPED to the grid
  // top here (~16 m of breakable voxel mast — the part a fight actually shoots/rams); stampMasts
  // truncates cleanly at ny, and shipVisual keeps the thin cosmetic topmast cylinder for the slender
  // upper third. Every other (smaller) hull fits its WHOLE mast in voxels.
  const ny = 102;
  const nz = 60;
  const grid = createGrid(nx, ny, nz);

  const x0 = 4;             // stern transom station (low x = AFT, bow at HIGH x)
  const L = 200;           // 50 m gun-deck length
  const deckY = 36;        // weather (main) deck, ~9 m above the keel plane
  const lowerGunY = 21;    // lower gun-deck port height (at the waterline belt)
  const midGunY = 29;      // middle gun-deck port height
  const qDeckY = deckY + 8; // raised quarterdeck AND forecastle: one ~2 m story up
  const qTaft = 0.20;      // stations with t < qTaft carry the aft quarterdeck
  const fcTfwd = 0.82;     // stations with t > fcTfwd carry the forward forecastle
  const halfBeamMax = 28;  // 14 m beam at the belt
  const cz = (nz - 1) / 2;
  const qX1 = Math.floor(x0 + qTaft * (L - 1) - 1e-9); // forward edge of the aft quarterdeck
  const fcX0 = Math.ceil(x0 + fcTfwd * (L - 1));       // aft edge of the forecastle
  const stairZs = [Math.floor(cz - 10), Math.ceil(cz + 10)]; // companion-stair lanes (both breaks)

  const stationT = (x: number) => (x - x0) / (L - 1);
  const keelY = (t: number) => 2 + Math.round(6 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.8));
  const halfBeam = (t: number) => halfBeamMax * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * t)), 0.72);
  const sectionHalfBeam = (t: number, y: number) => {
    const k = keelY(t);
    const f = Math.min(Math.max((y - k) / (deckY - k), 0), 1);
    const d = f - 0.62;
    const a = d < 0 ? 0.64 : 0.67;
    const oval = Math.sqrt(Math.max(1 - (d / a) * (d / a), 0));
    return halfBeam(t) * (0.1 + 0.9 * oval);
  };

  const deckYAt = (x: number) => (x <= qX1 || x >= fcX0 ? qDeckY : deckY);

  const inside = (x: number, y: number, z: number): boolean => {
    const t = stationT(x);
    if (t < 0 || t > 1) return false;
    if (y < keelY(t) || y > deckYAt(x)) return false;
    return Math.abs(z - cz) <= sectionHalfBeam(t, y);
  };

  // rasterize: OAK shell, PINE planking at the weather deck AND the raised ends.
  // The weather-deck plane continues under the quarterdeck/forecastle as the
  // deck below; the shell rule raises the break walls and the topsides.
  let envelopeCells = 0;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        if (!inside(x, y, z)) continue;
        envelopeCells++;
        if (y === deckY || y === deckYAt(x)) {
          grid.set(x, y, z, PINE);
          continue;
        }
        const onShell =
          !inside(x - 1, y, z) ||
          !inside(x + 1, y, z) ||
          !inside(x, y - 1, z) ||
          !inside(x, y, z - 1) ||
          !inside(x, y, z + 1);
        if (onShell) grid.set(x, y, z, OAK);
      }
    }
  }

  // a walk-in door + companion stairs at EACH break (aft great cabin, forward
  // forecastle) so both raised decks are reachable from the waist. Steps are
  // single-voxel wedges (the character controller autosteps 0.35).
  const cutDoorAndStairs = (breakX: number, climbDir: 1 | -1) => {
    for (let z = Math.round(cz - 1.5); z <= Math.round(cz + 1.5); z++) {
      for (let y = deckY + 1; y <= deckY + 7; y++) {
        if (grid.get(breakX, y, z) !== EMPTY) grid.remove(breakX, y, z);
      }
    }
    for (const sz of stairZs) {
      for (let s = 0; s < 8; s++) {
        const sx = breakX + climbDir * (8 - s); // steps on the waist side, climbing to the break
        for (let z = sz - 1; z <= sz + 1; z++) {
          for (let y = deckY + 1; y <= deckY + 1 + s; y++) {
            if (grid.get(sx, y, z) === EMPTY) grid.set(sx, y, z, PINE);
          }
        }
      }
    }
  };
  cutDoorAndStairs(qX1, 1);    // aft quarterdeck: stairs forward of the break, climbing aft
  cutDoorAndStairs(fcX0, -1);  // forward forecastle: stairs aft of the break, climbing forward

  // iron ballast — deep z/t-bands following the fuller-aft centre of buoyancy,
  // like the brig but more iron in the lower hold (three gun decks = more
  // top-weight to counter). Tuned live against tests/manOfWarFloat.test.ts: nine
  // tiers, WIDEST at the keel (zHalf 8) and tapering up to a narrow tier-8
  // spine, all packed into the lower hold well below the lower gun deck (y21).
  // Lands draft ≈ 0.455 of the envelope with COM ≈ 2.25 (very low), so GM ≈ 4.1
  // and she stays restoring out past 15° — a stiff first-rate, not a Vasa.
  //
  // Every band sits ~0.016·L AFT of the symmetric layout (e.g. tier-0 0.05→0.90
  // became 0.034→0.884): in-browser she rode a steady bow-down trim because the
  // iron's centroid was forward of the fuller-aft hull's center of buoyancy —
  // the exact lever the brig cured (see buildBrig's ballast comment). Walking
  // the rows aft drops the COM onto the COB, so the fore-aft moment vanishes and
  // she floats on an even keel (tests/manOfWarFloat.test.ts trim test, |trim| < 0.2).
  const ballastZ = (k: number) => {
    const zs: number[] = [];
    for (let z = Math.ceil(cz - k); z <= Math.floor(cz + k); z++) zs.push(z);
    return zs;
  };
  // each row: [tier above keel, tMin, tMax, zHalf]
  const ballastRows: [number, number, number, number][] = [
    [0, 0.034, 0.884, 8],
    [1, 0.044, 0.874, 8],
    [2, 0.064, 0.854, 7],
    [3, 0.084, 0.834, 7],
    [4, 0.114, 0.804, 6],
    [5, 0.144, 0.774, 5],
    [6, 0.184, 0.734, 4],
    [7, 0.234, 0.684, 3],
    [8, 0.294, 0.624, 2],
  ];
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    const by = keelY(t) + 1;
    for (const [tier, tMin, tMax, zHalf] of ballastRows) {
      if (t < tMin || t > tMax) continue;
      for (const z of ballastZ(zHalf)) {
        if (inside(x, by + tier, z) && grid.get(x, by + tier, z) === EMPTY) grid.set(x, by + tier, z, IRON);
      }
    }
  }

  // transverse watertight bulkheads: ~12 holds on this first-rate (part B of the flooding
  // rework) so a single breach floods one section, not the whole ship. Evenly spaced from L.
  const bulkheadXs = bulkheadStations(x0, L, 12);
  stampBulkheads(grid, bulkheadXs, deckY, inside);

  // ---- gun decks: three broadside tiers + axial chasers ----
  // lower & middle decks fire through framed ports in the side shell (the shell
  // voxel stays solid — the render frames it, shipVisual.ts:674); the weather
  // deck fires over the rail through fence embrasures like the brig's waist.
  const lowerXs = [0.26, 0.33, 0.40, 0.47, 0.54, 0.61, 0.68, 0.74].map((f) => x0 + Math.round(L * f));
  const midXs = lowerXs;
  const upperXs = [0.30, 0.38, 0.46, 0.54, 0.62, 0.70].map((f) => x0 + Math.round(L * f));

  // bulwark fence at each deck's own edge (waist + quarterdeck + forecastle),
  // with embrasures for the weather-deck guns and gaps where the stairs land.
  for (let x = 0; x < nx; x++) {
    const dY = deckYAt(x);
    for (let z = 0; z < nz; z++) {
      if (!inside(x, dY, z)) continue;
      const onEdge =
        !inside(x - 1, dY, z) || !inside(x + 1, dY, z) || !inside(x, dY, z - 1) || !inside(x, dY, z + 1);
      if (!onEdge) continue;
      const nearPort = dY === deckY && upperXs.some((px) => Math.abs(x - px) <= 1);
      if (nearPort) continue;
      if ((x === qX1 || x === fcX0) && stairZs.some((sz) => Math.abs(z - sz) <= 1)) continue;
      grid.set(x, dY + 1, z, PINE);
      grid.set(x, dY + 4, z, PINE);
      const corner =
        (!inside(x - 1, dY, z) || !inside(x + 1, dY, z)) &&
        (!inside(x, dY, z - 1) || !inside(x, dY, z + 1));
      if (corner || (x + Math.round(Math.abs(z - cz))) % 3 === 0) {
        grid.set(x, dY + 2, z, PINE);
        grid.set(x, dY + 3, z, PINE);
      }
    }
  }

  // grated deck hatches over the holds (flooding paths, walkable)
  // hatches centred in three spread holds (fore/mid/aft) so only those flood/drain from the
  // deck; the rest of the ~10 holds stay sealed (part B of the flooding rework — resilience).
  const hatchXs = hatchStations(x0, L, bulkheadXs, 3);
  const hatchZ = Math.floor(cz);
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) hatches.push({ x: hx, z: hatchZ, w: 2, d: 2 });

  // weld floating internals (diagonal ballast tiers) to the main mass — ONE 6-connected solid.
  lowerBallast(grid, deckY); // ship-feel pass: drop the COM at constant mass (heavier bottom, same waterline)
  weldToSingleComponent(grid);

  const compartments = findCompartments(grid, deckY);
  const hatchAreaM2 = 2 * 2 * VOXEL_SIZE * VOXEL_SIZE;
  // only holds under a deck hatch flood from the deck; the rest stay sealed (resilience).
  assignHatchAreas(compartments, hatchXs, hatchAreaM2);

  const claimed = new Set<number>();
  for (const c of compartments) for (const cell of c.cells) claimed.add(cell);
  const interiorLeaks: number[] = [];
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(x, y, z) && grid.get(x, y, z) === EMPTY && !claimed.has(idx(x, y, z))) {
          interiorLeaks.push(idx(x, y, z));
        }
      }
    }
  }

  // broadside ports: 8 lower + 8 middle + 6 weather, each side, symmetric about cz.
  // floor/ceil split keeps the two batteries exactly mirrored on the even beam.
  const cannonPorts: ShipBuild["cannonPorts"] = [];
  const addBroadside = (xs: number[], gunY: number) => {
    for (const px of xs) {
      const t = stationT(px);
      const hb = Math.round(sectionHalfBeam(t, gunY));
      cannonPorts.push({ x: px, y: gunY, z: Math.floor(cz) + hb, side: 1 });
      cannonPorts.push({ x: px, y: gunY, z: Math.ceil(cz) - hb, side: -1 });
    }
  };
  addBroadside(lowerXs, lowerGunY);
  addBroadside(midXs, midGunY);
  addBroadside(upperXs, deckY + 1);

  // axial chasers (cannon-count pass): 6 bow (fore, under the forecastle) + 8 stern (aft,
  // through the great cabin / transom) — the first-rate's explicit minimum, a heavy chase
  // battery far beyond the brig's pair. Both are now laid out as CLEAN, REGULAR GRIDS: the bow
  // as 2 columns × 3 rows, the stern as 2 columns × 4 rows. In each grid the two z-columns are a
  // single mirror PAIR (their z values sum to nz − 1 → exact port/starboard symmetry), the rows
  // are evenly pitched in y, and every gun is below the weather deck (y < deckY). All seat in
  // solid bow/stern timber (sim/cannonMount.ts samples a box around each port) and every barrel
  // tip clears the hull skin so the whole grid is visible from outside.
  const cz0 = Math.floor(cz),
    cz1 = Math.ceil(cz); // centre cells; cz0 + cz1 === nz − 1, so a {cz0, cz1} column pair mirrors
  // ---- 6 bow chasers: a 2 × 3 grid poking OUT through the stem ----
  // The cannon barrel reaches ~11.3 voxels forward of its port cell (pivot→tip =
  // (TRUNNION_OUT_B + TIP_FROM_TRUNNION_B)·GUN_SCALE / VOXEL_SIZE), and the bow stem skin at the
  // centerline (z = cz0/cz1) sits at x = 202 across every chosen row (a fine, vertical wedge there).
  // Seat all six at ONE forward station x = x0 + L − 3 = 201 → every tip lands at x ≈ 212.3, a clear
  // ~10 voxels (2.5 m) proud of the stem (verified). Two columns = the centerline mirror pair
  // {cz0, cz1} (29 + 30 === nz − 1); three rows evenly pitched 4 voxels in y (deckY−4/−8/−12 = 32/28/24),
  // all below the weather deck and seated in solid bow timber (mountSolidCount ≈ 49–64). A neat
  // upright 2-wide × 3-tall battery on the bow face, all bearing dead ahead.
  const bowX = x0 + L - 3;                       // 201 — one forward station for the whole grid
  const bowZcols = [cz0, cz1];                    // 29, 30 — the centerline mirror pair
  const bowYrows = [deckY - 4, deckY - 8, deckY - 12]; // 32, 28, 24 — even 4-voxel pitch
  for (const gy of bowYrows) {
    for (const gz of bowZcols) {
      cannonPorts.push({ x: bowX, y: gy, z: gz, side: gz < cz ? -1 : 1, facing: "fore" });
    }
  }
  // ---- 8 stern chasers: a 2 × 4 grid across the broad transom ----
  // The hull is a HOLLOW shell, so a chaser must seat ON the solid transom plating: the cabin behind
  // it is open air, and the mount sampler reaches INBOARD (+x) from the port cell — only at the
  // transom skin (sternX = x0 = 4) does it bite real timber (mountSolidCount ≈ 49–70; one voxel
  // forward it falls to 0). Two columns = a single mirror pair {cz0−2, cz1+2} (27 + 32 === nz − 1);
  // four rows evenly pitched 3 voxels in y (deckY−1/−4/−7/−10 = 35/32/29/26), all below the weather
  // deck. Each barrel runs out aft through the transom. A neat upright 2-wide × 4-tall battery,
  // all bearing dead astern.
  const sternX = x0;                              // 4 — the transom face: the only solid stern station
  const sternZcols = [cz0 - 2, cz1 + 2];          // 27, 32 — mirror pair (27 + 32 === nz − 1)
  const sternYrows = [deckY - 1, deckY - 4, deckY - 7, deckY - 10]; // 35, 32, 29, 26 — even 3-voxel pitch
  for (const gy of sternYrows) {
    for (const gz of sternZcols) {
      cannonPorts.push({ x: sternX, y: gy, z: gz, side: gz < cz ? -1 : 1, facing: "aft" });
    }
  }

  // three masts: mizzen (aft), main (tallest, amidships), fore (forward)
  const masts = [
    { x: x0 + Math.round(L * 0.22), z: Math.round(cz), h: 22 },
    { x: x0 + Math.round(L * 0.48), z: Math.round(cz), h: 32 },
    { x: x0 + Math.round(L * 0.74), z: Math.round(cz), h: 26 },
  ];
  // masts are REAL voxels now — break voxel-by-voxel + sever above a shot-out base (no rigid topple).
  const mastVoxels = stampMasts(grid, masts, deckYAt);

  armorBow(grid); // reinforced forward shell — a bow-first ram wins (material cost asymmetry)

  return {
    grid,
    deckY,
    envelopeVolume: envelopeCells * VOXEL_VOLUME,
    compartments,
    interiorLeaks,
    cannonPorts,
    masts,
    mastVoxels,
    hatches,
    lengthM: L * VOXEL_SIZE,
    beamM: halfBeamMax * 2 * VOXEL_SIZE,
    deckYAt,
    quarterdeck: { x1: qX1, deckY: qDeckY },
    wheelM: { x: (x0 + Math.round(L * 0.08) + 0.5) * VOXEL_SIZE, z: (nz / 2) * VOXEL_SIZE },
    footprint: {
      minX: (x0 - 6) * VOXEL_SIZE,
      maxX: (x0 + L + 6) * VOXEL_SIZE,
      zC: (nz / 2) * VOXEL_SIZE,
      halfZ: (halfBeamMax + 5.4) * VOXEL_SIZE,
    },
  };
}
