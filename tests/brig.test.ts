import { describe, it, expect } from "vitest";
import { buildBrig } from "../src/sim/shipwright";
import { EMPTY } from "../src/sim/materials";
import { WATER_DENSITY } from "../src/core/constants";

const ship = buildBrig();

describe("shipwright brig (round 6: the real fighting vessel)", () => {
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

  it("is watertight: no interior region leaks to the outside", () => {
    expect(ship.interiorLeaks).toHaveLength(0);
  });

  it("floats, but sits IN the water", () => {
    expect(ship.grid.totalMass()).toBeLessThan(0.68 * ship.envelopeVolume * WATER_DENSITY);
    expect(ship.grid.totalMass()).toBeGreaterThan(0.15 * ship.envelopeVolume * WATER_DENSITY);
  });

  it("is the size of a real small fighting ship, and bigger than the sloop", () => {
    expect(ship.lengthM).toBeGreaterThanOrEqual(30);
    expect(ship.beamM).toBeGreaterThanOrEqual(9);
  });

  it("carries five gun ports a side, all on the open waist", () => {
    const stb = ship.cannonPorts.filter((p) => p.side === 1);
    const prt = ship.cannonPorts.filter((p) => p.side === -1);
    expect(stb).toHaveLength(5);
    expect(prt).toHaveLength(5);
    for (const p of ship.cannonPorts) {
      expect(ship.deckYAt(p.x)).toBe(ship.deckY); // not under the quarterdeck
    }
  });

  it("raises a quarterdeck one story above the waist, with the wheel on it", () => {
    const q = ship.quarterdeck!;
    expect(q).not.toBeNull();
    expect(q.deckY - ship.deckY).toBeGreaterThanOrEqual(8); // ≥ 2 m
    const wheelStation = Math.round(ship.wheelM.x / 0.25);
    expect(ship.deckYAt(wheelStation)).toBe(q.deckY);
    // quarterdeck planking actually exists at the wheel
    const wz = Math.round(ship.wheelM.z / 0.25);
    expect(ship.grid.isSolid(wheelStation, q.deckY, wz)).toBe(true);
  });

  it("companion stairs climb the break in single-voxel steps (autostep-able)", () => {
    const q = ship.quarterdeck!;
    const grid = ship.grid;
    // walk a lane from the waist deck aft onto the quarterdeck and record the
    // standing surface at each station: it must never rise more than 1 voxel
    const lanes = [Math.floor((grid.dims[2] - 1) / 2 - 10), Math.ceil((grid.dims[2] - 1) / 2 + 10)];
    for (const z of lanes) {
      let prevTop = ship.deckY; // waist plank
      let climbed = false;
      for (let x = q.x1 + 10; x >= q.x1; x--) {
        let top = -1;
        for (let y = q.deckY + 2; y >= 0; y--) {
          if (grid.isSolid(x, y, z)) {
            top = y;
            break;
          }
        }
        expect(top).toBeGreaterThanOrEqual(0);
        expect(top - prevTop).toBeLessThanOrEqual(1); // one 0.25 m step max
        prevTop = top;
        if (top === q.deckY) climbed = true;
      }
      expect(climbed).toBe(true);
    }
  });

  it("has a walk-in cabin door at the centerline of the break", () => {
    const q = ship.quarterdeck!;
    const cz = Math.round((ship.grid.dims[2] - 1) / 2);
    // the doorway is clear for a standing pirate (≥ 6 cells of air)
    for (let y = ship.deckY + 1; y <= ship.deckY + 6; y++) {
      expect(ship.grid.get(q.x1, y, cz)).toBe(EMPTY);
    }
  });

  it("leaves embrasures in the fence for every gun", () => {
    for (const p of ship.cannonPorts) {
      // the rail cell directly above the port's deck edge must be open
      expect(ship.grid.get(p.x, ship.deckY + 4, p.z)).toBe(EMPTY);
    }
  });

  it("keeps a wider deck than the old canoe waist", () => {
    // walkable plank span at midship, inside the bulwarks
    const grid = ship.grid;
    const x = Math.round(grid.dims[0] / 2);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let z = 0; z < grid.dims[2]; z++) {
      if (grid.isSolid(x, ship.deckY, z)) {
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
    }
    expect((maxZ - minZ + 1) * 0.25).toBeGreaterThanOrEqual(7); // ≥ 7 m of deck
  });
});
