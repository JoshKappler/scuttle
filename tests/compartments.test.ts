import { describe, it, expect } from "vitest";
import {
  orificeFlow,
  floodStep,
  floodBallastLocal,
  equalizeFlooding,
  buildFillCurve,
  fillHeightLocal,
  type Compartment,
  type BreachInput,
  type Opening,
} from "../src/sim/compartments";
import { VOXEL_SIZE, VOXEL_VOLUME } from "../src/core/constants";

function comp(volume: number, waterVolume: number, id = 0): Compartment {
  return {
    id,
    cells: new Set(),
    volume,
    waterVolume,
    centroid: [0, 0, 0],
    hatchArea: 0,
    floorY: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [4, 4, 4],
  };
}

function breach(compartmentId: number, area: number, extHead: number, intHead: number): BreachInput {
  return { compartmentId, area, extHead, intHead };
}

// The breach is a SUBMERGED ORIFICE between two reservoirs: the sea (extHead = how far the
// sea surface is above the hole) and the compartment's own pool (intHead = how far the
// internal pool is above the hole). The signed flow seeks equilibrium and reverses to drain.
describe("orifice flow (two-reservoir breach)", () => {
  it("inflow grows with the external head", () => {
    expect(orificeFlow(0.1, 3, 0)).toBeGreaterThan(orificeFlow(0.1, 1, 0));
  });

  it("equal heads on both sides → zero net flow (equilibrium at the waterline)", () => {
    expect(orificeFlow(0.1, 2, 2)).toBe(0);
  });

  it("internal pool above the sea → flow reverses (drains out)", () => {
    expect(orificeFlow(0.1, 1, 3)).toBeLessThan(0);
  });

  it("a hole above both surfaces admits nothing", () => {
    expect(orificeFlow(0.1, -0.5, -0.2)).toBe(0);
  });

  it("inflow scales with breach area", () => {
    expect(orificeFlow(0.2, 2, 0)).toBeCloseTo(2 * orificeFlow(0.1, 2, 0), 9);
  });
});

describe("floodStep", () => {
  it("a submerged breach with a dry interior takes on water", () => {
    const c = comp(10, 0);
    floodStep([c], [], [breach(0, 1, 3, 0)], 0.1);
    expect(c.waterVolume).toBeGreaterThan(0);
  });

  it("compartment never exceeds capacity", () => {
    const c = comp(10, 9.99);
    floodStep([c], [], [breach(0, 1, 5, 0)], 1.0);
    expect(c.waterVolume).toBeLessThanOrEqual(10);
  });

  it("drains out when the pool tops the sea, never below zero", () => {
    const c = comp(10, 2);
    // strong outward head over a long step would overshoot past 0 if unclamped
    floodStep([c], [], [breach(0, 5, 0, 5)], 5.0);
    expect(c.waterVolume).toBe(0);
  });

  it("holds its level at equilibrium (equal heads)", () => {
    const c = comp(10, 4);
    floodStep([c], [], [breach(0, 1, 2, 2)], 1.0);
    expect(c.waterVolume).toBeCloseTo(4, 9);
  });

  it("a sealed compartment with no breach stays dry", () => {
    const c = comp(10, 0);
    floodStep([c], [], [], 1.0);
    expect(c.waterVolume).toBe(0);
  });

  // TASK 4 severity model: ship.ts pushes ONE orifice per breach cell, so a big hole = many orifices.
  // More punctured cells (and deeper ones) flood dramatically faster than a single nick.
  it("many breach cells flood far faster than one (the gash-vs-nick severity model)", () => {
    const nick = comp(100, 0);
    const gash = comp(100, 0);
    const A = 0.0625 * 0.2; // VOXEL_SIZE² × inflowScale, one cell's orifice
    floodStep([nick], [], [breach(0, A, 0.3, 0)], 0.1); // 1 shallow waterline cell
    const many: BreachInput[] = [];
    for (let i = 0; i < 30; i++) many.push(breach(0, A, 2.0, 0)); // 30 deep cells
    floodStep([gash], [], many, 0.1);
    expect(gash.waterVolume).toBeGreaterThan(nick.waterVolume * 50);
  });

  it("water equalizes through an opening between connected compartments", () => {
    const a = comp(10, 8, 0);
    const b = comp(10, 0, 1);
    const openings: Opening[] = [{ a: 0, b: 1, area: 0.5 }];
    for (let i = 0; i < 1200; i++) floodStep([a, b], openings, [], 1 / 60);
    expect(a.waterVolume).toBeCloseTo(b.waterVolume, 0);
    // mass conserved
    expect(a.waterVolume + b.waterVolume).toBeCloseTo(8, 6);
  });

  it("flow through an opening follows the fuller compartment", () => {
    const a = comp(10, 1, 0);
    const b = comp(10, 6, 1);
    const openings: Opening[] = [{ a: 0, b: 1, area: 0.5 }];
    floodStep([a, b], openings, [], 0.5);
    expect(a.waterVolume).toBeGreaterThan(1); // gained from b
    expect(b.waterVolume).toBeLessThan(6);
  });
});

// Floodwater is modelled as it SETTLES — pooled low and centred, like shifting ballast — NOT at the
// heel-dependent wet-cell centroid that used to slide to the low side and capsize a sinking hull.
describe("floodBallastLocal (flood weight settles low & centred)", () => {
  it("bears at the horizontal geometric centre — no list from heel", () => {
    const c = comp(10, 5);
    c.centroid = [1.25, 0.6, -0.5];
    const [lx, , lz] = floodBallastLocal(c);
    expect(lx).toBe(1.25);
    expect(lz).toBe(-0.5);
  });

  it("sits low and rises monotonically with fill, never above mid-compartment (bottom-heavy)", () => {
    const c = comp(10, 0);
    c.bboxMin = [0, 0, 0];
    c.bboxMax = [4, 4, 4];
    c.waterVolume = 1;
    const lowFill = floodBallastLocal(c)[1];
    c.waterVolume = 9;
    const highFill = floodBallastLocal(c)[1];
    expect(highFill).toBeGreaterThan(lowFill); // pool surface rises as it fills
    // even half-full, the weight bears at or below the compartment's vertical middle
    const midY = ((c.bboxMin[1] + c.bboxMax[1] + 1) / 2) * VOXEL_SIZE;
    c.waterVolume = 5;
    expect(floodBallastLocal(c)[1]).toBeLessThanOrEqual(midY);
  });
});

// Bulkheads aren't perfectly watertight under a head: a substantially-flooded compartment slowly
// overtops/seeps into its fore-aft neighbours, so a foundering hull fills EVENLY (balanced, bottom-
// heavy) instead of pooling all in one end. Slow, fill-driven, mass-conserving, clamped.
describe("equalizeFlooding (slow cross-compartment seepage)", () => {
  it("a nearly-full compartment slowly sheds into its drier neighbour", () => {
    const a = comp(10, 9, 0);
    const b = comp(10, 0, 1);
    equalizeFlooding([a, b], 1 / 60);
    expect(b.waterVolume).toBeGreaterThan(0);
    expect(a.waterVolume).toBeLessThan(9);
    expect(a.waterVolume + b.waterVolume).toBeCloseTo(9, 9); // mass conserved
  });

  it("does NOT spread while both compartments are only lightly flooded", () => {
    const a = comp(10, 2, 0); // 20% — below the overtopping gate
    const b = comp(10, 0, 1);
    equalizeFlooding([a, b], 1 / 60);
    expect(b.waterVolume).toBe(0);
  });

  it("is SLOW — a single step moves only a sliver, not a gush", () => {
    const a = comp(10, 10, 0);
    const b = comp(10, 0, 1);
    equalizeFlooding([a, b], 1 / 60);
    expect(b.waterVolume).toBeGreaterThan(0);
    expect(b.waterVolume).toBeLessThan(0.2);
  });

  it("narrows the fill gap over time (PARTIAL leveller) but never overshoots; mass conserved", () => {
    const a = comp(10, 10, 0);
    const b = comp(8, 0, 1); // different capacity — seepage equalizes by FRACTION, not volume
    const gap0 = a.waterVolume / a.volume - b.waterVolume / b.volume; // = 1.0 initially
    for (let i = 0; i < 6000; i++) equalizeFlooding([a, b], 1 / 60);
    const gap1 = a.waterVolume / a.volume - b.waterVolume / b.volume;
    // seepage SHEDS from the fuller side toward the drier one — the gap shrinks…
    expect(gap1).toBeLessThan(gap0);
    expect(gap1).toBeGreaterThan(0); // …but only PARTIALLY: it stalls once the fuller side drops below
    // the overtopping gate, so a flooded end stays heavier and the hull keeps its trim (TASK 5).
    expect(a.waterVolume).toBeGreaterThanOrEqual(0);
    expect(b.waterVolume).toBeLessThanOrEqual(b.volume);
    expect(a.waterVolume + b.waterVolume).toBeCloseTo(10, 6); // mass conserved
  });
});

// The static cumulative volume↔height curve replaces the per-tick rotate-and-sort: it maps the
// compartment's waterVolume to a ship-local fill height in O(log layers). Built once (cells static).
describe("buildFillCurve / fillHeightLocal (cheap volume↔height)", () => {
  const NX = 8, NY = 8;
  // a box compartment occupying local cells x∈[x0..x1], y∈[y0..y1], z∈[z0..z1] (inclusive).
  function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Compartment {
    const cells = new Set<number>();
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) cells.add(x + NX * (y + NY * z));
    const c = comp(cells.size * VOXEL_VOLUME, 0);
    c.cells = cells;
    c.bboxMin = [x0, y0, z0];
    c.bboxMax = [x1, y1, z1];
    return c;
  }

  it("endpoints: empty → floor, full → top of the column", () => {
    const c = box(0, 3, 2, 5, 0, 3); // y spans voxel layers 2..5 (4 layers)
    const curve = buildFillCurve(c, NX, NY);
    expect(curve.total).toBe(c.cells.size);
    // empty pool → the bottom of the lowest layer (y=2)
    expect(fillHeightLocal(curve, 0)).toBeCloseTo(2 * VOXEL_SIZE, 9);
    // full pool → the TOP of the highest layer (y=5 → top is 6)
    expect(fillHeightLocal(curve, c.volume)).toBeCloseTo(6 * VOXEL_SIZE, 9);
    // over-full clamps to the top
    expect(fillHeightLocal(curve, c.volume * 2)).toBeCloseTo(6 * VOXEL_SIZE, 9);
  });

  it("monotonic: height never decreases as the pool fills", () => {
    const c = box(0, 3, 0, 5, 0, 3);
    const curve = buildFillCurve(c, NX, NY);
    let prev = -Infinity;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const h = fillHeightLocal(curve, c.volume * f);
      expect(h).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = h;
    }
  });

  it("uniform box: half the volume → half the height (linear within equal layers)", () => {
    const c = box(0, 3, 0, 7, 0, 3); // 4×8×4, layers 0..7
    const curve = buildFillCurve(c, NX, NY);
    const h = fillHeightLocal(curve, c.volume * 0.5);
    // each layer has equal cells, so 50% fill ⇒ surface at the top of layer 3 = 4 voxels up
    expect(h).toBeCloseTo(4 * VOXEL_SIZE, 6);
  });

  it("inverse round-trips: filling to a height back through volume reproduces the height", () => {
    // a NON-uniform footprint (a step) so cells-per-layer varies and the curve isn't trivially linear
    const cells = new Set<number>();
    for (let z = 0; z <= 3; z++)
      for (let x = 0; x <= 3; x++) {
        for (let y = 0; y <= 2; y++) cells.add(x + NX * (y + NY * z)); // wide base, layers 0..2
        if (x <= 1 && z <= 1) for (let y = 3; y <= 5; y++) cells.add(x + NX * (y + NY * z)); // narrow tower
      }
    const c = comp(cells.size * VOXEL_VOLUME, 0);
    c.cells = cells;
    c.bboxMin = [0, 0, 0];
    c.bboxMax = [3, 5, 3];
    const curve = buildFillCurve(c, NX, NY);
    // pick a target height at a layer boundary, count the cells at or below it → volume, invert.
    // top of layer 2 (h = 3 voxels) holds the wide base = 4×3×4 = 48 cells.
    const targetH = 3 * VOXEL_SIZE;
    const vol = 48 * VOXEL_VOLUME;
    expect(fillHeightLocal(curve, vol)).toBeCloseTo(targetH, 6);
  });
});
