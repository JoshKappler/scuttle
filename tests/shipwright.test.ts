import { describe, it, expect } from "vitest";
import { buildSloop } from "../src/sim/shipwright";
import { findCompartments } from "../src/sim/compartments";
import { WATER_DENSITY } from "../src/core/constants";

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

  it("has exactly three watertight compartments", () => {
    expect(findCompartments(ship.grid, ship.deckY).length).toBe(3);
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
