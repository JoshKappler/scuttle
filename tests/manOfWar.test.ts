import { describe, it, expect } from "vitest";
import { buildManOfWar } from "../src/sim/shipwright";
import { mountSolidCount } from "../src/sim/cannonMount";
import { RAM } from "../src/sim/materials";

const ship = buildManOfWar();

describe("shipwright man-o'-war (first-rate, three gun decks)", () => {
  it("is port/starboard symmetric", () => {
    const { grid } = ship;
    const [nx, ny, nz] = grid.dims;
    // Scan every cell but assert ONCE: this first-rate's grid is ~1.27M cells (the tall voxel-mast
    // tower nearly doubled ny), and an expect() per cell blows the test timeout on pure call overhead.
    // Capture the first asymmetric coordinate for a useful failure message instead.
    let firstAsym: string | null = null;
    for (let x = 0; x < nx && firstAsym === null; x++)
      for (let y = 0; y < ny && firstAsym === null; y++)
        for (let z = 0; z < nz; z++)
          if (grid.get(x, y, z) !== grid.get(x, y, nz - 1 - z)) {
            firstAsym = `(${x},${y},${z}): ${grid.get(x, y, z)} vs mirror ${grid.get(x, y, nz - 1 - z)}`;
            break;
          }
    expect(firstAsym).toBeNull();
  });

  it("is watertight: no interior region leaks to the outside", () => {
    expect(ship.interiorLeaks).toHaveLength(0);
  });

  it("is bigger than the brig — a full-sized fighting ship", () => {
    expect(ship.lengthM).toBeGreaterThanOrEqual(45);
    expect(ship.beamM).toBeGreaterThanOrEqual(13);
  });

  it("carries three firing gun decks: 22 broadside ports a side across three heights", () => {
    const broadside = ship.cannonPorts.filter((p) => !p.facing);
    expect(broadside.filter((p) => p.side === 1)).toHaveLength(22);
    expect(broadside.filter((p) => p.side === -1)).toHaveLength(22);
    const decks = new Set(broadside.map((p) => p.y));
    expect(decks.size).toBe(3);
  });

  it("each broadside port pair is symmetric about the centerline", () => {
    const nz = ship.grid.dims[2];
    const byX = new Map<string, number[]>();
    for (const p of ship.cannonPorts.filter((p) => !p.facing)) {
      const k = `${p.x}:${p.y}`;
      const arr = byX.get(k) ?? [];
      arr.push(p.z);
      byX.set(k, arr);
    }
    for (const zs of byX.values()) {
      expect(zs).toHaveLength(2);
      expect(zs[0] + zs[1]).toBe(nz - 1);
    }
  });

  it("mounts a heavy chase battery: 6 bow + 8 stern chasers, seated below the weather deck", () => {
    // cannon-count pass: the first-rate's explicit minimum — 6 forward + 8 aft axial guns,
    // far beyond the brig's pair (the bigger the ship, the more chasers).
    const fore = ship.cannonPorts.filter((p) => p.facing === "fore");
    const aft = ship.cannonPorts.filter((p) => p.facing === "aft");
    expect(fore.length).toBe(6);
    expect(aft.length).toBe(8);
    for (const p of [...fore, ...aft]) {
      expect(p.y).toBeLessThan(ship.deckY); // axial guns fire below the weather deck
      expect(mountSolidCount(ship.grid, p)).toBeGreaterThan(0); // each bolts to real hull timber
    }
    // each battery's z-values are mirror pairs about the centerline (port/starboard symmetry).
    const nz = ship.grid.dims[2];
    for (const guns of [fore, aft]) {
      const zs = guns.map((p) => p.z).sort((a, b) => a - b);
      expect(zs.length % 2).toBe(0); // even count → all paired
      for (let i = 0, j = zs.length - 1; i < j; i++, j--) expect(zs[i] + zs[j]).toBe(nz - 1);
    }
  });

  it("bow chasers form a CLEAN 2-column × 3-row grid that pokes OUT the bow face", () => {
    // user layout: the six bow guns are an orderly 2×3 grid — exactly TWO z columns (a mirror pair
    // about the centerline), THREE evenly-spaced y rows, all seated FAR forward so each barrel tip
    // clears the stem (stem skin ≈ x202 at the centerline; the ~11.3-voxel barrel reaches x≈212).
    const [nx, , nz] = ship.grid.dims;
    const fore = ship.cannonPorts.filter((p) => p.facing === "fore");
    expect(fore.length).toBe(6);
    // distinct seats (no two guns share a voxel)
    const keys = new Set(fore.map((p) => `${p.x},${p.y},${p.z}`));
    expect(keys.size).toBe(6);
    // exactly TWO z columns, forming one mirror pair about the centerline
    const zs = [...new Set(fore.map((p) => p.z))].sort((a, b) => a - b);
    expect(zs.length).toBe(2);
    expect(zs[0] + zs[1]).toBe(nz - 1); // mirror pair → port/starboard symmetric
    // exactly THREE y rows at an even (constant) pitch
    const ys = [...new Set(fore.map((p) => p.y))].sort((a, b) => a - b);
    expect(ys.length).toBe(3);
    const yPitches = ys.slice(1).map((y, i) => y - ys[i]);
    expect(new Set(yPitches).size).toBe(1); // single, consistent row pitch
    // every (row,col) cell is filled → a full 2×3 lattice
    expect(new Set(fore.map((p) => `${p.y},${p.z}`)).size).toBe(6);
    for (const p of fore) {
      expect(p.x).toBeGreaterThanOrEqual(nx - 12); // hard up against the bow → barrel clears the stem
      expect(mountSolidCount(ship.grid, p)).toBeGreaterThan(0); // bolts to real bow timber
    }
  });

  it("stern chasers form a CLEAN 2-column × 4-row grid on the transom (not a fan)", () => {
    // user layout: the eight stern guns are an orderly 2×4 grid — ONE station (the transom face),
    // exactly TWO z columns (a mirror pair), FOUR evenly-spaced y rows. Lock that orderly shape in.
    const nz = ship.grid.dims[2];
    const aft = ship.cannonPorts.filter((p) => p.facing === "aft");
    expect(aft.length).toBe(8);
    const xs = new Set(aft.map((p) => p.x));
    expect(xs.size).toBe(1); // a single transom station — no fore/aft fan
    // exactly TWO z columns, a mirror pair about the centerline
    const zs = [...new Set(aft.map((p) => p.z))].sort((a, b) => a - b);
    expect(zs.length).toBe(2);
    expect(zs[0] + zs[1]).toBe(nz - 1); // mirror pair → port/starboard symmetric
    // exactly FOUR y rows at an even (constant) pitch
    const ys = [...new Set(aft.map((p) => p.y))].sort((a, b) => a - b);
    expect(ys.length).toBe(4);
    const yPitches = ys.slice(1).map((y, i) => y - ys[i]);
    expect(new Set(yPitches).size).toBe(1); // single, consistent row pitch
    // every (row,col) cell is filled → a full 2×4 lattice
    expect(new Set(aft.map((p) => `${p.y},${p.z}`)).size).toBe(8);
  });

  it("leaves embrasures in the weather-deck fence for the upper-tier guns", () => {
    for (const p of ship.cannonPorts.filter((p) => !p.facing && p.y > ship.deckY)) {
      expect(ship.grid.get(p.x, ship.deckY + 4, p.z)).toBe(0); // EMPTY — fence open above the gun
    }
  });

  it("raises a quarterdeck aft with the wheel on it", () => {
    const q = ship.quarterdeck!;
    expect(q).not.toBeNull();
    expect(q.deckY - ship.deckY).toBeGreaterThanOrEqual(8);
    const ws = Math.round(ship.wheelM.x / 0.25);
    expect(ship.deckYAt(ws)).toBe(q.deckY);
    expect(ship.grid.isSolid(ws, q.deckY, Math.round(ship.wheelM.z / 0.25))).toBe(true);
  });

  it("raises a forecastle forward (the deck steps up at the bow too)", () => {
    const [nx] = ship.grid.dims;
    expect(ship.deckYAt(nx - 12)).toBe(ship.quarterdeck!.deckY);
    expect(ship.deckYAt(Math.round(nx / 2))).toBe(ship.deckY); // the waist stays low
  });

  it("has a reinforced RAM prow but a plain stern (directional bow armor)", () => {
    const { grid } = ship;
    const [nx, ny, nz] = grid.dims;
    let stemRam = 0, sternRam = 0;
    const stemX0 = Math.floor(nx * 0.85);
    const sternX1 = Math.floor(nx * 0.15);
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

  it("subdivides the hold into ~12 watertight compartments, three masts, three hatches", () => {
    // round-8: the authoritative build set (the holds the game floods). Bulkheads now carry a carved TOP
    // overflow notch, so a grid re-detect would merge holds through the gap; the holds remain separate
    // flooding reservoirs (sill overflow only once a hold tops the gap).
    const comps = ship.compartments;
    // many transverse bulkheads → a single breach floods one section, not the whole ship.
    expect(comps.length).toBeGreaterThanOrEqual(10);
    // bow→stern invariant: dense ids, ascending centroid-x (real fore-aft neighbours for seepage).
    comps.forEach((c, i) => expect(c.id).toBe(i));
    for (let i = 1; i < comps.length; i++) {
      expect(comps[i].centroid[0]).toBeGreaterThan(comps[i - 1].centroid[0]);
    }
    expect(ship.hatches.length).toBe(3);
    expect(ship.masts.length).toBe(3);
  });

  it("deterministic: building twice yields identical grids", () => {
    const again = buildManOfWar();
    expect(again.grid.data).toEqual(ship.grid.data);
  });
});
