import { describe, it, expect } from "vitest";
import { buildSloop, buildCutter, buildFrigate, type ShipBuild } from "../src/sim/shipwright";
import { findCompartments } from "../src/sim/compartments";
import { WATER_DENSITY, VOXEL_SIZE } from "../src/core/constants";
import { RAM } from "../src/sim/materials";

const ship = buildSloop();

describe("shipwright sloop", () => {
  it("is port/starboard symmetric", () => {
    const { grid } = ship;
    const [nx, ny, nz] = grid.dims;
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
          expect(grid.get(x, y, z)).toBe(grid.get(x, y, nz - 1 - z));
        }
      }
    }
  });

  it("has a reinforced RAM prow but a plain stern (directional bow armor)", () => {
    // armorBow lays the toughest material (RAM) over the forward hull so a bow-first ram wins
    // via material cost — the deformable contact never special-cases it. Lock the invariant:
    // the stem carries RAM, the stern carries none.
    const { grid } = ship;
    const [nx, ny, nz] = grid.dims;
    let stemRam = 0, sternRam = 0;
    const stemX0 = Math.floor(nx * 0.85); // forward 15%
    const sternX1 = Math.floor(nx * 0.15); // aft 15%
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ny; y++)
        for (let z = 0; z < nz; z++) {
          if (grid.get(x, y, z) !== RAM) continue;
          if (x >= stemX0) stemRam++;
          else if (x < sternX1) sternRam++;
        }
    expect(stemRam).toBeGreaterThan(0);
    expect(sternRam).toBe(0);
  });

  it("average density is below seawater (it will float)", () => {
    expect(ship.grid.totalMass()).toBeLessThan(0.68 * ship.envelopeVolume * WATER_DENSITY);
    // ...but it is not a cork either: a ship sits IN the water
    expect(ship.grid.totalMass()).toBeGreaterThan(0.12 * ship.envelopeVolume * WATER_DENSITY);
  });

  it("fully flooded + waterlogged she FOUNDERS: max waterlog overcomes residual flotation", () => {
    // when flooded, interior water weight cancels interior displacement;
    // residual lift = solid displacement − mass. The foundering rule can
    // remove up to 50% of ALL probe lift (≈ envelope displacement), which
    // must exceed that residual or a wreck floats awash forever.
    const solidDisplacement = ship.grid.solidCount() * 0.25 ** 3 * WATER_DENSITY;
    const residual = solidDisplacement - ship.grid.totalMass();
    const maxWaterlogLoss = 0.5 * ship.envelopeVolume * WATER_DENSITY;
    expect(maxWaterlogLoss).toBeGreaterThan(residual * 1.5); // healthy margin
  });

  it("has ~9 watertight compartments (more bulkheads = a single breach floods one section)", () => {
    const comps = findCompartments(ship.grid, ship.deckY);
    expect(comps.length).toBe(9);
    // bow→stern invariant: dense ids 0..N-1, centroid-x strictly ascending (each adjacent
    // pair is a real fore-aft neighbour — what equalizeFlooding seepage relies on).
    comps.forEach((c, i) => expect(c.id).toBe(i));
    for (let i = 1; i < comps.length; i++) {
      expect(comps[i].centroid[0]).toBeGreaterThan(comps[i - 1].centroid[0]);
    }
  });

  it("hull shell is watertight below deck", () => {
    expect(ship.interiorLeaks).toEqual([]);
  });

  it("metadata: 10 cannon ports (8 broadside + 2 chasers), ≥1 mast, hatches over each hold", () => {
    expect(ship.cannonPorts.length).toBe(10);
    expect(ship.cannonPorts.filter((p) => !p.facing).length).toBe(8);
    expect(ship.cannonPorts.filter((p) => p.facing).length).toBe(2);
    expect(ship.masts.length).toBeGreaterThanOrEqual(1);
    expect(ship.hatches.length).toBe(3);
  });

  it("compartments carry volume and centroid", () => {
    for (const c of ship.compartments) {
      expect(c.volume).toBeGreaterThan(1); // m³ — holds are real spaces
      expect(c.centroid[1]).toBeGreaterThan(0); // above keel plane in local meters
      expect(c.waterVolume).toBe(0);
    }
  });

  it("deterministic: building twice yields identical grids", () => {
    const again = buildSloop();
    expect(again.grid.data).toEqual(ship.grid.data);
  });
});

// ---- the new tycoon tiers: same structural invariants as the proven hulls ----
function tierInvariants(name: string, build: () => ShipBuild, broadside: number, chasers: number) {
  describe(`shipwright ${name}`, () => {
    const s = build();

    it("is port/starboard symmetric", () => {
      const { grid } = s;
      const [nx, ny, nz] = grid.dims;
      for (let x = 0; x < nx; x++)
        for (let y = 0; y < ny; y++)
          for (let z = 0; z < nz; z++) expect(grid.get(x, y, z)).toBe(grid.get(x, y, nz - 1 - z));
    });

    it("floats but sits in the water (density between 0.12 and 0.68 of seawater)", () => {
      expect(s.grid.totalMass()).toBeLessThan(0.68 * s.envelopeVolume * WATER_DENSITY);
      expect(s.grid.totalMass()).toBeGreaterThan(0.12 * s.envelopeVolume * WATER_DENSITY);
    });

    it("rides upright: COM sits below the main deck and near amidships", () => {
      const mp = s.grid.massProperties();
      // COM low → stiff (won't turtle). Below ~60% of deck height keel-up.
      expect(mp.com[1]).toBeLessThan(s.deckY * VOXEL_SIZE * 0.6);
      // COM near amidships fore-aft → won't plough bow- or stern-down.
      const lo = 0.3 * s.lengthM,
        hi = 0.65 * s.lengthM;
      const comXFromBow = mp.com[0] - 4 * VOXEL_SIZE; // x0 = 4 on every hull
      expect(comXFromBow).toBeGreaterThan(lo);
      expect(comXFromBow).toBeLessThan(hi);
    });

    it("hull shell is watertight below deck and has watertight compartments", () => {
      expect(s.interiorLeaks).toEqual([]);
      expect(s.compartments.length).toBeGreaterThan(0);
    });

    it(`carries ${broadside} broadside guns + ${chasers} chasers, ≥1 mast`, () => {
      expect(s.cannonPorts.filter((p) => !p.facing).length).toBe(broadside);
      expect(s.cannonPorts.filter((p) => p.facing).length).toBe(chasers);
      expect(s.masts.length).toBeGreaterThanOrEqual(1);
    });

    it("deterministic: building twice yields identical grids", () => {
      expect(build().grid.data).toEqual(s.grid.data);
    });
  });
}

tierInvariants("cutter", buildCutter, 4, 2); // 2 guns/side + bow & stern chasers
tierInvariants("frigate", buildFrigate, 12, 4); // 6 guns/side + 2 bow + 2 stern chasers
