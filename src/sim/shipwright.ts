import { VOXEL_SIZE, VOXEL_VOLUME } from "../core/constants";
import { createGrid, type VoxelGrid } from "./voxelGrid";
import { EMPTY, IRON, OAK, PINE } from "./materials";
import { findCompartments, type Compartment } from "./compartments";

/**
 * Procedural voxel shipwright. Hulls come from analytic curves — plan-view
 * half-beam, keel rocker, flared sections — rasterized into a voxel shell
 * with deck, transverse bulkheads, deck hatches, and a bulwark rail.
 * Deterministic: same inputs, same ship.
 */
export interface ShipBuild {
  grid: VoxelGrid;
  deckY: number; // voxel y of the deck plane
  envelopeVolume: number; // m³ enclosed by the hull up to and including deck
  compartments: Compartment[];
  interiorLeaks: number[]; // packed indices of interior regions that escaped (should be empty)
  cannonPorts: { x: number; y: number; z: number; side: 1 | -1 }[]; // voxel coords; side = +z / −z
  masts: { x: number; z: number }[]; // voxel coords on centerline
  hatches: { x: number; z: number; w: number; d: number }[]; // deck openings
  lengthM: number;
  beamM: number;
}

export function buildSloop(): ShipBuild {
  // grid envelope: 72 × 20 × 24 cells = 18 × 5 × 6 m
  const nx = 72;
  const ny = 20;
  const nz = 24;
  const grid = createGrid(nx, ny, nz);

  const x0 = 4; // first station
  const L = 64; // stations along x (16 m)
  const deckY = 13; // raised one layer for freeboard (playtest: rode too deep)
  const halfBeamMax = 9.5; // cells from centerline → beam ≈ 4.75 m
  const cz = (nz - 1) / 2; // 11.5, centerline between cells

  const stationT = (x: number) => (x - x0) / (L - 1);
  const keelY = (t: number) => 2 + Math.round(3 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.8));
  const halfBeam = (t: number) => halfBeamMax * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * t)), 0.72);
  const sectionHalfBeam = (t: number, y: number) => {
    const k = keelY(t);
    const f = Math.min(Math.max((y - k) / (deckY - k), 0), 1);
    return halfBeam(t) * (0.42 + 0.58 * Math.pow(f, 0.65));
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

  // iron ballast along the keel. Two jobs: (1) without it the deck makes the
  // ship top-heavy and she turtles (negative metacentric height); (2) the
  // solid mass must exceed the solid displacement, or a fully flooded wooden
  // hull just floats awash forever instead of going down. Both found empirically.
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    if (t < 0.08 || t > 0.92) continue;
    const by = keelY(t) + 1;
    // 2-wide strip everywhere, widened + double-stacked on alternating
    // stations — enough iron to sink her when flooded while keeping a
    // seaworthy freeboard
    const zs = x % 2 === 0 ? [10, 11, 12, 13] : [11, 12];
    for (const z of zs) {
      if (inside(x, by, z) && grid.get(x, by, z) === EMPTY) grid.set(x, by, z, IRON);
    }
    if (x % 2 === 0) {
      for (const z of [11, 12]) {
        if (inside(x, by + 1, z) && grid.get(x, by + 1, z) === EMPTY) grid.set(x, by + 1, z, IRON);
      }
    }
  }

  // transverse watertight bulkheads at 1/3 and 2/3 of length
  const bulkheadXs = [x0 + Math.round(L / 3), x0 + Math.round((2 * L) / 3)];
  for (const bx of bulkheadXs) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(bx, y, z) && grid.get(bx, y, z) === EMPTY) grid.set(bx, y, z, OAK);
      }
    }
  }

  // bulwark rail: one cell of PINE above the deck's outer edge
  for (let x = 0; x < nx; x++) {
    for (let z = 0; z < nz; z++) {
      if (!inside(x, deckY, z)) continue;
      const onEdge =
        !inside(x - 1, deckY, z) || !inside(x + 1, deckY, z) || !inside(x, deckY, z - 1) || !inside(x, deckY, z + 1);
      if (onEdge) grid.set(x, deckY + 1, z, PINE);
    }
  }

  // deck hatches: 2×2 openings over each hold (between/before/after bulkheads)
  const hatchXs = [
    x0 + Math.round(L / 6),
    x0 + Math.round(L / 2),
    x0 + Math.round((5 * L) / 6),
  ];
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) {
    for (let dx = 0; dx < 2; dx++) {
      for (let dz = 0; dz < 2; dz++) {
        grid.set(hx + dx, deckY, 11 + dz, EMPTY);
      }
    }
    hatches.push({ x: hx, z: 11, w: 2, d: 2 });
  }

  // compartments + leak audit
  const compartments = findCompartments(grid, deckY);
  const hatchAreaM2 = 2 * 2 * VOXEL_SIZE * VOXEL_SIZE;
  for (const c of compartments) c.hatchArea = hatchAreaM2;

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

  // cannon ports: 4 per side, midship spread, at deck level on the bulwark line
  const portXs = [0.3, 0.45, 0.6, 0.75].map((f) => x0 + Math.round(L * f));
  const cannonPorts: ShipBuild["cannonPorts"] = [];
  for (const px of portXs) {
    const t = stationT(px);
    const hb = Math.round(sectionHalfBeam(t, deckY));
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.round(cz + hb), side: 1 });
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.round(cz - hb), side: -1 });
  }

  // single mast slightly forward of midship
  const masts = [{ x: x0 + Math.round(L * 0.42), z: Math.round(cz) }];

  return {
    grid,
    deckY,
    envelopeVolume: envelopeCells * VOXEL_VOLUME,
    compartments,
    interiorLeaks,
    cannonPorts,
    masts,
    hatches,
    lengthM: L * VOXEL_SIZE,
    beamM: halfBeamMax * 2 * VOXEL_SIZE,
  };
}
