import { VOXEL_SIZE, VOXEL_VOLUME } from "../core/constants";
import type { VoxelGrid } from "./voxelGrid";

/**
 * Compartment detection: partition the enclosed interior air of a hull into
 * watertight spaces via flood-fill. Runtime flooding dynamics (Bernoulli
 * inflow, inter-compartment flow) live here too once Task 11 lands.
 */
export interface Compartment {
  id: number;
  /** Packed cell indices (x + nx*(y + ny*z)) of interior air cells. */
  cells: Set<number>;
  volume: number; // m³ capacity
  waterVolume: number; // m³ currently flooded
  centroid: [number, number, number]; // local meters
  /** Open deck-hatch area connecting this compartment upward, m². */
  hatchArea: number;
  /** Lowest cell y (voxels) — used for water-level rendering and breach depth. */
  floorY: number;
  /** Cell-space bounding box (inclusive), for water-plane rendering. */
  bboxMin: [number, number, number];
  bboxMax: [number, number, number];
}

/** A connection between two compartments. Two kinds, ONE mechanism (sill overflow):
 *  - a battle-damage HOLE in a bulkhead → `sillY: 0` (conducts at any water level, a bottom hole);
 *  - the designed bulkhead-TOP GAP → `sillY` = the fill-FRACTION of the gap, so water only crosses
 *    once a hold rises ABOVE the gap (the user's "fills up, THEN spills" — no threshold logic, just
 *    water over a wall). Dimensionless (a fill fraction, not meters) so the rule stays pose-free + pure. */
export interface Opening {
  a: number; // compartment id
  b: number; // compartment id
  area: number; // m²
  /** Fill-fraction sill: only the water ABOVE this fraction on each side conducts. 0 = bottom hole. */
  sillY: number;
}

/** One hull breach (a hole cell) this step, resolved as a two-reservoir orifice. */
export interface BreachInput {
  compartmentId: number;
  area: number; // m² (already scaled by flood.inflowScale by the caller)
  extHead: number; // m the SEA surface sits above the hole (≤0 = hole is above the sea)
  intHead: number; // m the INTERNAL pool sits above the hole (≤0 = hole is above the pool)
}

const DISCHARGE = 0.6; // sharp-edged orifice coefficient (Cd)
const EXCHANGE_HEAD_SCALE = 2.0; // m of head per unit fill-fraction difference
/** How far up the wet column the floodwater weight bears (0 = keel, 0.5 = mid-water = the physically
 *  correct centroid of settled water). At 0.5 an unevenly-flooded hull develops a VISIBLE fore/aft
 *  trim (the user's ask) because the flood mass shifts the longitudinal CG by its true moment, not a
 *  damped-low fraction of it. Turtle-safety does NOT come from biasing this low — it comes from the
 *  per-voxel buoyancy righting + the heel-INDEPENDENCE of this point (it never slides to the low side
 *  as she heels), so 0.5 is safe. See floodBallastLocal. */
const BALLAST_BIAS = 0.5;

/**
 * Signed two-reservoir orifice flow (m³/s) through a submerged hull hole. The hole connects the
 * sea and the compartment's own rising pool; `extHead`/`intHead` are how far each free surface
 * sits ABOVE the hole. Flow is driven by their difference and REVERSES when the interior is the
 * higher of the two (water drains back out); a hole above BOTH surfaces conducts nothing.
 *
 *   Q = sign(Δh)·Cd·A·√(2·g·|Δh|),   Δh = max(0,extHead) − max(0,intHead)
 *
 * This single signed rule is the whole of flooding: + fills, − drains, 0 at equilibrium (the
 * interior level reaching the sea level at the hole). Deterministic — the oracle rides on it.
 */
export function orificeFlow(area: number, extHead: number, intHead: number): number {
  const e = Math.max(0, extHead);
  const i = Math.max(0, intHead);
  const dh = e - i;
  if (dh === 0) return 0;
  return Math.sign(dh) * DISCHARGE * area * Math.sqrt(2 * 9.81 * Math.abs(dh));
}

/**
 * Advance flooding one step: signed breach flow (in OR out, by the sea↔pool head difference),
 * then inter-compartment exchange through openings (fill-level difference). Water is clamped to
 * [0, capacity] — the LOWER clamp at 0 is the drain path that lets a heeled/capsized hull empty.
 */
export function floodStep(
  compartments: Compartment[],
  openings: Opening[],
  breaches: BreachInput[],
  dt: number,
): void {
  // compartment ids are dense 0..N-1 indices === array position (assigned in findCompartments),
  // so a direct index resolves them — no need to rebuild an id→compartment Map every step.
  for (const br of breaches) {
    const c = compartments[br.compartmentId];
    if (!c) continue;
    const next = c.waterVolume + orificeFlow(br.area, br.extHead, br.intHead) * dt;
    c.waterVolume = Math.max(0, Math.min(next, c.volume));
  }

  for (const o of openings) {
    const a = compartments[o.a];
    const b = compartments[o.b];
    if (!a || !b) continue;
    // SILL OVERFLOW: only the water standing ABOVE the gap conducts. For a bottom hole (sillY 0) this
    // is the full fill on each side (the old always-on exchange). For a bulkhead-TOP gap (sillY > 0)
    // nothing moves until a hold rises over the gap — then the over-sill water spills toward the lower
    // side, exactly like water topping a wall. No threshold/seep constants — it's just the head.
    const overA = Math.max(0, a.waterVolume / a.volume - o.sillY);
    const overB = Math.max(0, b.waterVolume / b.volume - o.sillY);
    if (overA === 0 && overB === 0) continue; // neither hold tops the sill → no flow
    const head = (overA - overB) * EXCHANGE_HEAD_SCALE;
    if (Math.abs(head) < 1e-9) continue;
    const rate = DISCHARGE * o.area * Math.sqrt(2 * 9.81 * Math.abs(head)) * Math.sign(head);
    let flow = rate * dt; // + = a→b
    // clamp by available water and remaining capacity
    flow = Math.min(flow, a.waterVolume, b.volume - b.waterVolume);
    flow = Math.max(flow, -b.waterVolume, -(a.volume - a.waterVolume));
    a.waterVolume -= flow;
    b.waterVolume += flow;
  }
}

/**
 * Local-meter point where a flooded compartment's water weight bears, modelled as the water SETTLES:
 * the horizontal geometric centre, and a vertical height that rises with fill from the floor toward
 * mid-compartment (water pools bottom-up). Crucially HEEL-INDEPENDENT — unlike the wet-cell centroid
 * it replaced (which ranked cells by world-Y and so slid to the LOW side as she heeled, a free-surface
 * moment that deepened the list until she turned turtle), this point never moves with attitude. So
 * floodwater acts like shifting BALLAST: it lowers the CG and makes a flooding hull MORE bottom-heavy,
 * and the per-voxel buoyancy keeps her upright while she settles instead of capsizing.
 */
export function floodBallastLocal(c: Compartment): [number, number, number] {
  const fill = c.volume > 0 ? c.waterVolume / c.volume : 0;
  // Bottom-up pool: the surface rises with fill. We bias the bearing point BELOW the physical mid-
  // water-column (factor BALLAST_BIAS, not 0.5) so heavy flooding acts like the keel BALLAST the user
  // asked for — a near-sunk hull (where reserve buoyancy and waterplane righting are nearly gone, so
  // only KG-below-KB holds her up) stays bottom-heavy and rides upright down to the bottom instead of
  // turning turtle. The actual sinking is still driven by `waterlog`, not by losing stability, so she
  // founders upright rather than flipping. Still rises monotonically with fill; still heel-independent.
  // 0.42 (was 0.28): low enough to stay safe against turtling but high enough that the floodwater
  // weight produces a VISIBLE fore/aft trim moment (the bow noses down when the forward holds flood)
  // instead of bearing so deep it's almost on the keel line and barely shifts the longitudinal CG.
  const ly = (c.bboxMin[1] + (c.bboxMax[1] + 1 - c.bboxMin[1]) * fill * BALLAST_BIAS + 0.5) * VOXEL_SIZE;
  return [c.centroid[0], ly, c.centroid[2]];
}

/**
 * Static cumulative volume↔height curve for a compartment, built ONCE (cells never change after
 * build). Replaces the old per-tick "rotate every cell into world-Y and Float32Array.sort() them"
 * pass that dominated the flood phase on a badly-holed big hull (~60k cells/compartment).
 *
 * Water settles bottom-up in LOCAL space: it fills the lowest cell-LAYER first, then the next up.
 * `layerY[k]` is the local-Y voxel index of the k-th occupied layer (ascending); `cumCells[k]` is
 * the number of cells AT OR BELOW that layer. So as the pool rises through the compartment the wet
 * cell count steps through `cumCells`. Inverting that step function (cheap binary search) turns the
 * current `waterVolume` into a LOCAL fill height in O(log layers) — no per-cell work at runtime.
 *
 * HEEL TRADEOFF: this is a ship-LOCAL-horizontal fill, so the derived level is exact upright and an
 * approximation under heel (the old code used world-Y, heel-aware). That's safe because the list /
 * capsize physics is entirely independent (`floodBallastLocal`, heel-independent) — the level here
 * only feeds the two-reservoir breach head and the rendered surface, both of which just need a
 * believable world height that equilibrates toward the outside waterline. The render side still
 * counter-rotates its tiles so the surface DRAWS world-horizontal at this height.
 */
export interface FillCurve {
  /** Ascending local-Y voxel indices of the occupied layers. */
  layerY: Int32Array;
  /** Cumulative cell count at or below layerY[k]. cumCells[last] === total cells. */
  cumCells: Int32Array;
  /** Total interior cells (=== compartment cell count). */
  total: number;
}

/** Build the static fill curve for a compartment from its cell set + grid dims. Runs once. */
export function buildFillCurve(c: Compartment, nx: number, ny: number): FillCurve {
  // count cells per local-Y layer (packed index = x + nx*(y + ny*z), so y = floor(p/nx) % ny)
  const perLayer = new Map<number, number>();
  for (const p of c.cells) {
    const y = Math.floor(p / nx) % ny;
    perLayer.set(y, (perLayer.get(y) ?? 0) + 1);
  }
  const ys = Array.from(perLayer.keys()).sort((a, b) => a - b);
  const layerY = new Int32Array(ys.length);
  const cumCells = new Int32Array(ys.length);
  let cum = 0;
  for (let k = 0; k < ys.length; k++) {
    layerY[k] = ys[k];
    cum += perLayer.get(ys[k])!;
    cumCells[k] = cum;
  }
  return { layerY, cumCells, total: c.cells.size };
}

/**
 * Local-space fill height (meters, in ship-local Y) of a compartment's pool given its current
 * `waterVolume`, via the static curve — the cheap replacement for ranking + sorting every cell.
 * Returns the TOP of the wet column: the local Y at which the free surface sits. Empty → the floor.
 *
 *   wetCells = waterVolume / VOXEL_VOLUME ; binary-search cumCells for the layer that count reaches,
 *   then linearly interpolate WITHIN that layer by how far the count fills it (partial top layer).
 */
export function fillHeightLocal(curve: FillCurve, waterVolume: number): number {
  const m = curve.layerY.length;
  if (m === 0) return 0;
  const wetCells = waterVolume / VOXEL_VOLUME;
  if (wetCells <= 0) return curve.layerY[0] * VOXEL_SIZE; // dry → the floor (bottom of lowest layer)
  if (wetCells >= curve.total) return (curve.layerY[m - 1] + 1) * VOXEL_SIZE; // full → top of top layer
  // binary search for the first layer whose cumulative count >= wetCells
  let lo = 0,
    hi = m - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (curve.cumCells[mid] >= wetCells) hi = mid;
    else lo = mid + 1;
  }
  const below = lo > 0 ? curve.cumCells[lo - 1] : 0; // cells filled by all layers strictly below
  const inLayer = curve.cumCells[lo] - below; // cells this layer holds
  const frac = inLayer > 0 ? Math.min(1, Math.max(0, (wetCells - below) / inLayer)) : 0;
  // surface sits `frac` of the way up the current layer; layer spans [layerY, layerY+1) in voxels
  return (curve.layerY[lo] + frac) * VOXEL_SIZE;
}

// (REMOVED 2026-06-18) `equalizeFlooding` + SEEP_FILL_GATE/SEEP_RATE — the "once a hold is half full,
// seep a fixed fraction toward its neighbour" hack. Replaced by real SILL OVERFLOW through the
// bulkhead-top gaps, modelled in floodStep's opening loop above (Opening.sillY). Water now crosses a
// bulkhead only when a hold rises over the gap, driven by the over-sill head — one mechanism, no
// threshold constants. See the round-8 flooding rewrite spec.

/**
 * Find watertight compartments: connected regions of empty cells strictly
 * below deckY that never escape to the grid boundary. Regions that DO escape
 * are exterior water/air, not compartments.
 *
 * Returns compartments ordered bow-ward (ascending centroid x) with stable ids.
 */
export function findCompartments(grid: VoxelGrid, deckY: number): Compartment[] {
  const [nx, ny, nz] = grid.dims;
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const visited = new Uint8Array(nx * ny * nz);
  const compartments: Compartment[] = [];

  for (let z0 = 0; z0 < nz; z0++) {
    for (let y0 = 0; y0 < deckY; y0++) {
      for (let x0 = 0; x0 < nx; x0++) {
        const start = idx(x0, y0, z0);
        if (visited[start] || grid.isSolid(x0, y0, z0)) continue;

        // BFS this empty region (bounded above by deckY)
        const cells: number[] = [];
        let escaped = false;
        const queue: number[] = [start];
        visited[start] = 1;
        while (queue.length > 0) {
          const cur = queue.pop()!;
          const cx = cur % nx;
          const cy = Math.floor(cur / nx) % ny;
          const cz = Math.floor(cur / (nx * ny));
          cells.push(cur);
          const neighbors: [number, number, number][] = [
            [cx - 1, cy, cz],
            [cx + 1, cy, cz],
            [cx, cy - 1, cz],
            [cx, cy + 1, cz],
            [cx, cy, cz - 1],
            [cx, cy, cz + 1],
          ];
          for (const [px, py, pz] of neighbors) {
            if (px < 0 || pz < 0 || py < 0 || px >= nx || pz >= nz) {
              escaped = true; // reached the grid boundary → exterior region
              continue;
            }
            if (py >= deckY) continue; // hatches connect upward; not an escape below deck
            const ni = idx(px, py, pz);
            if (visited[ni] || grid.isSolid(px, py, pz)) continue;
            visited[ni] = 1;
            queue.push(ni);
          }
        }

        if (escaped) continue;

        let sx = 0;
        let sy = 0;
        let sz = 0;
        let floorY = ny;
        const bboxMin: [number, number, number] = [nx, ny, nz];
        const bboxMax: [number, number, number] = [0, 0, 0];
        for (const c of cells) {
          const cx = c % nx;
          const cy = Math.floor(c / nx) % ny;
          const cz = Math.floor(c / (nx * ny));
          sx += cx + 0.5;
          sy += cy + 0.5;
          sz += cz + 0.5;
          if (cy < floorY) floorY = cy;
          bboxMin[0] = Math.min(bboxMin[0], cx);
          bboxMin[1] = Math.min(bboxMin[1], cy);
          bboxMin[2] = Math.min(bboxMin[2], cz);
          bboxMax[0] = Math.max(bboxMax[0], cx);
          bboxMax[1] = Math.max(bboxMax[1], cy);
          bboxMax[2] = Math.max(bboxMax[2], cz);
        }
        const n = cells.length;
        compartments.push({
          id: 0, // assigned after sorting
          cells: new Set(cells),
          volume: n * VOXEL_VOLUME,
          waterVolume: 0,
          centroid: [(sx / n) * VOXEL_SIZE, (sy / n) * VOXEL_SIZE, (sz / n) * VOXEL_SIZE],
          hatchArea: 0, // measured by the caller (shipwright) which knows hatch placement
          floorY,
          bboxMin,
          bboxMax,
        });
      }
    }
  }

  compartments.sort((a, b) => a.centroid[0] - b.centroid[0]);
  compartments.forEach((c, i) => (c.id = i));
  return compartments;
}
