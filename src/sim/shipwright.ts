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
  // a proper fighting brig: 24 m hull (playtest: the 16 m boat "looks like a
  // fishing vessel and somehow has eight cannons"), with a TALL hull —
  // round-5 references: cross-section is a wide oval with the top sliced
  // off for the deck, widest at the waterline belt, narrow rounded bottom,
  // tumblehome above, and a lot of ship under the water
  const nx = 104;
  const ny = 30;
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
  // top-heavy and she turtles (negative metacentric height). Shifted AFT
  // (t ≥ 0.15) so the center of mass matches the fuller-aft hull's center
  // of buoyancy — the old symmetric strip trimmed her down by the bow.
  // Full sinking of a flooded hull is handled by waterlogging (foundering)
  // in game/ship.ts, not by overloading her with iron.
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    if (t < 0.15 || t > 0.95) continue;
    const by = keelY(t) + 1;
    for (const z of [13, 14, 15, 16, 17, 18]) {
      if (inside(x, by, z) && grid.get(x, by, z) === EMPTY) grid.set(x, by, z, IRON);
    }
    // upper tiers: enough mass low that she floats at the widest belt of
    // the egg section — round-5 references: "much more of the ship should
    // be underwater" — with the COM deep for honest banking
    if (t < 0.2 || t > 0.9) continue;
    for (const z of [13, 14, 15, 16, 17, 18]) {
      if (inside(x, by + 1, z) && grid.get(x, by + 1, z) === EMPTY) grid.set(x, by + 1, z, IRON);
    }
    if (t < 0.3 || t > 0.8) continue;
    for (const z of [14, 15, 16, 17]) {
      if (inside(x, by + 2, z) && grid.get(x, by + 2, z) === EMPTY) grid.set(x, by + 2, z, IRON);
    }
    if (t < 0.4 || t > 0.7) continue;
    for (const z of [15, 16]) {
      if (inside(x, by + 3, z) && grid.get(x, by + 3, z) === EMPTY) grid.set(x, by + 3, z, IRON);
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

  // cannon ports are decided BEFORE the rail so the fence can leave
  // embrasures for the barrels (playtest: "cannon barrels clipping directly
  // through the railing … should be slotted in between gaps in the fence")
  const portXs = [0.3, 0.45, 0.6, 0.75].map((f) => x0 + Math.round(L * f));

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

  // deck hatches: 2×2 openings over each hold (between/before/after bulkheads)
  // hatches are GRATED: the deck cells stay solid (walkable — an open hole
  // by the helm swallowed the captain in playtest), but each hatch is
  // registered as a flooding path (water pours through gratings once the
  // deck goes under the coaming)
  const hatchXs = [
    x0 + Math.round(L / 6),
    x0 + Math.round(L / 2),
    x0 + Math.round((5 * L) / 6),
  ];
  const hatchZ = Math.floor(cz);
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) {
    hatches.push({ x: hx, z: hatchZ, w: 2, d: 2 });
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

  // cannon ports: 4 per side, midship spread, at deck level on the bulwark
  // line (portXs declared above, where the fence leaves embrasures for them)
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
