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
  deckY: number; // voxel y of the MAIN (waist) deck plane
  envelopeVolume: number; // m³ enclosed by the hull up to and including deck
  compartments: Compartment[];
  interiorLeaks: number[]; // packed indices of interior regions that escaped (should be empty)
  cannonPorts: { x: number; y: number; z: number; side: 1 | -1 }[]; // voxel coords; side = +z / −z
  masts: { x: number; z: number; h: number }[]; // voxel coords on centerline; h = rig height (m)
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
    // floor/ceil split keeps the two ports SYMMETRIC about the true centerline:
    // cz is a half-cell on an even beam, and round(cz±hb) biased BOTH batteries
    // a half-cell to starboard — so the right guns hung a full cell further over
    // the edge than the left ("right … hanging off the edge, the left … only
    // slightly off", round 9). Now they mirror exactly.
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.floor(cz) + hb, side: 1 });
    cannonPorts.push({ x: px, y: deckY + 1, z: Math.ceil(cz) - hb, side: -1 });
  }

  // single mast slightly forward of midship
  const masts = [{ x: x0 + Math.round(L * 0.42), z: Math.round(cz), h: 15 }];

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
  const ny = 42;
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

  // transverse watertight bulkheads at 1/3 and 2/3
  const bulkheadXs = [x0 + Math.round(L / 3), x0 + Math.round((2 * L) / 3)];
  for (const bx of bulkheadXs) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(bx, y, z) && grid.get(bx, y, z) === EMPTY) grid.set(bx, y, z, OAK);
      }
    }
  }

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
  const hatchXs = [x0 + Math.round(L / 6), x0 + Math.round(L / 2), x0 + Math.round((5 * L) / 6)];
  const hatchZ = Math.floor(cz);
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) hatches.push({ x: hx, z: hatchZ, w: 2, d: 2 });

  const compartments = findCompartments(grid, deckY);
  const hatchAreaM2 = 2 * 2 * VOXEL_SIZE * VOXEL_SIZE;
  for (const c of compartments) c.hatchArea = hatchAreaM2;

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

  // brig rig: main mast forward of midship, fore mast toward the bow
  const masts = [
    { x: x0 + Math.round(L * 0.38), z: Math.round(cz), h: 21 },
    { x: x0 + Math.round(L * 0.68), z: Math.round(cz), h: 18 },
  ];

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
