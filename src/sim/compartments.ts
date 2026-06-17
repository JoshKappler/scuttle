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

/** A hole connecting two compartments (e.g. a shot-through bulkhead). */
export interface Opening {
  a: number; // compartment id
  b: number; // compartment id
  area: number; // m²
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
    const fillA = a.waterVolume / a.volume;
    const fillB = b.waterVolume / b.volume;
    const head = (fillA - fillB) * EXCHANGE_HEAD_SCALE;
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
  // water-column (factor 0.28, not 0.5) so heavy flooding acts like the keel BALLAST the user asked
  // for — a near-sunk hull (where reserve buoyancy and waterplane righting are nearly gone, so only
  // KG-below-KB holds her up) stays MORE bottom-heavy and rides upright down to the bottom instead of
  // turning turtle. The actual sinking is still driven by `waterlog`, not by losing stability, so she
  // founders upright rather than flipping. Still rises monotonically with fill; still heel-independent.
  const ly = (c.bboxMin[1] + (c.bboxMax[1] + 1 - c.bboxMin[1]) * fill * 0.28 + 0.5) * VOXEL_SIZE;
  return [c.centroid[0], ly, c.centroid[2]];
}

const SEEP_FILL_GATE = 0.55; // a compartment only sheds to a neighbour once it's this full
const SEEP_RATE = 0.06; // per-second fraction of the fill-fraction gap moved (slow overtopping)

/**
 * Slow cross-compartment seepage: real bulkheads aren't watertight under a standing head — once a
 * compartment is substantially flooded, water overtops/seeps into its fore-aft neighbours. Modelling
 * that makes a foundering hull fill EVENLY (staying balanced and bottom-heavy) instead of pooling all
 * the water in the one breached end and trimming/listing hard. Consecutive ids are physical neighbours
 * (compartments are sorted bow→stern in findCompartments). Slow, fill-driven, mass-conserving, clamped
 * so it can never push a compartment below 0 or over capacity. Deterministic — safe for the oracle.
 */
export function equalizeFlooding(compartments: Compartment[], dt: number): void {
  for (let i = 0; i + 1 < compartments.length; i++) {
    const a = compartments[i];
    const b = compartments[i + 1];
    if (a.volume <= 0 || b.volume <= 0) continue;
    const fillA = a.waterVolume / a.volume;
    const fillB = b.waterVolume / b.volume;
    if (Math.max(fillA, fillB) < SEEP_FILL_GATE) continue; // neither side full enough to overtop
    const gap = fillA - fillB; // + → a is fuller, sheds to b
    if (Math.abs(gap) < 1e-6) continue;
    // move toward equal FILL at a slow rate; size by the smaller capacity so neither side overshoots
    let flow = gap * SEEP_RATE * dt * Math.min(a.volume, b.volume); // + = a→b
    flow = Math.min(flow, a.waterVolume, b.volume - b.waterVolume);
    flow = Math.max(flow, -b.waterVolume, -(a.volume - a.waterVolume));
    a.waterVolume -= flow;
    b.waterVolume += flow;
  }
}

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
