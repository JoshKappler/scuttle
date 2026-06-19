import { describe, it, expect } from "vitest";
import { buildSloop, buildCutter, buildFrigate, type ShipBuild } from "../src/sim/shipwright";
import { mountSolidCount } from "../src/sim/cannonMount";
import { WATER_DENSITY, VOXEL_SIZE } from "../src/core/constants";
import { OAK, RAM } from "../src/sim/materials";

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
    // the stem carries RAM, the stern carries none. Windows are measured from the HULL PLATING's
    // real x-extent (OAK/RAM cells), NOT the grid width nor any-solid — the forward bowsprit margin
    // adds empty cells, and the bowsprit/masts are SPAR (not plating) further forward.
    const { grid } = ship;
    const [nx, ny, nz] = grid.dims;
    let hullMinX = Infinity, hullMaxX = -Infinity;
    for (let x = 0; x < nx; x++) {
      let plateHere = false;
      for (let y = 0; y < ny && !plateHere; y++)
        for (let z = 0; z < nz; z++) {
          const m = grid.get(x, y, z);
          if (m === OAK || m === RAM) { plateHere = true; break; }
        }
      if (plateHere) { hullMinX = Math.min(hullMinX, x); hullMaxX = x; }
    }
    const hullLen = hullMaxX - hullMinX + 1;
    const stemX0 = hullMaxX - Math.floor(hullLen * 0.15); // forward 15% of the hull
    const sternX1 = hullMinX + Math.floor(hullLen * 0.15); // aft 15% of the hull
    let stemRam = 0, sternRam = 0;
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
    // round-8: assert the AUTHORITATIVE build set (the holds the game floods), not a re-detect of the
    // grid — bulkheads now carry a carved TOP overflow notch, so re-running findCompartments would merge
    // adjacent holds through the gap. The holds are still separate flooding reservoirs (sill overflow).
    const comps = ship.compartments;
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

  it("metadata: 12 cannon ports (8 broadside + 4 chasers), ≥1 mast, hatches over each hold", () => {
    // cannon-count pass: the sloop carries 2 bow + 2 stern chasers (was 1+1).
    expect(ship.cannonPorts.length).toBe(12);
    expect(ship.cannonPorts.filter((p) => !p.facing).length).toBe(8);
    expect(ship.cannonPorts.filter((p) => p.facing === "fore").length).toBe(2);
    expect(ship.cannonPorts.filter((p) => p.facing === "aft").length).toBe(2);
    expect(ship.masts.length).toBeGreaterThanOrEqual(1);
    expect(ship.hatches.length).toBe(3);
  });

  it("every chaser is mirrored in z about the centerline (the fleet pairs straddle it)", () => {
    const nz = ship.grid.dims[2];
    for (const key of ["fore", "aft"] as const) {
      const zs = ship.cannonPorts.filter((p) => p.facing === key).map((p) => p.z).sort((a, b) => a - b);
      // a 2-gun battery is one mirror pair: z values sum to nz − 1.
      expect(zs.length).toBe(2);
      expect(zs[0] + zs[zs.length - 1]).toBe(nz - 1);
    }
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
      // cannon-count pass: bow + stern chasers split evenly (front + back guns).
      expect(s.cannonPorts.filter((p) => p.facing === "fore").length).toBe(chasers / 2);
      expect(s.cannonPorts.filter((p) => p.facing === "aft").length).toBe(chasers / 2);
      expect(s.masts.length).toBeGreaterThanOrEqual(1);
    });

    it("every chaser is seated below deck on solid timber, mirrored in z", () => {
      const nz = s.grid.dims[2];
      for (const key of ["fore", "aft"] as const) {
        const guns = s.cannonPorts.filter((p) => p.facing === key);
        for (const p of guns) {
          expect(p.y).toBeLessThan(s.deckY); // axial guns fire below the weather deck
          expect(mountSolidCount(s.grid, p)).toBeGreaterThan(0); // a real hull mount, not air
        }
        // the battery's z-values form mirror pairs about the centerline (set sums symmetric).
        const zs = guns.map((p) => p.z).sort((a, b) => a - b);
        for (let i = 0, j = zs.length - 1; i < j; i++, j--) expect(zs[i] + zs[j]).toBe(nz - 1);
      }
    });

    it("deterministic: building twice yields identical grids", () => {
      expect(build().grid.data).toEqual(s.grid.data);
    });
  });
}

tierInvariants("cutter", buildCutter, 4, 2); // 2 guns/side + 1 bow + 1 stern chaser
tierInvariants("frigate", buildFrigate, 12, 8); // 6 guns/side + 4 bow + 4 stern chasers
