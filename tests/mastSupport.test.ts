import { describe, it, expect } from "vitest";
import { buildBrig, buildFrigate, type ShipBuild } from "../src/sim/shipwright";
import { findSevered } from "../src/sim/connectivity";
import { mastFootingCells, MAST_FOOTING_HALF, MAST_SUPPORT_MIN_FRAC } from "../src/sim/mastSupport";

/**
 * The reported bug: blow away the FRONT of the ship (the bow hull below the deck) and the foremast
 * keeps floating in place. Root cause — the mast trunk is tied to the keel through the continuous,
 * full-length DECK PLANK, so the 18-connectivity sever (findSevered) never disconnects it even when
 * all the hull beneath it is gone. A mast must instead fall when the structure that actually carries
 * its step (the hull beneath the deck around its base) is destroyed. These tests lock that in.
 */

const keelAnchor = (b: ShipBuild): [number, number, number] => {
  const [kx, , knz] = b.grid.dims;
  const ax = Math.floor(kx / 2);
  const az = Math.floor(knz / 2);
  let ay = 0;
  while (ay < b.grid.dims[1] && !b.grid.isSolid(ax, ay, az)) ay++;
  return [ax, ay, az];
};

describe("mast footing support", () => {
  it("fells a mast when the hull beneath its footing is destroyed — even though the deck still bridges it to the keel", () => {
    const b = buildFrigate();
    const grid = b.grid;
    const [nx, , nz] = grid.dims;
    const mastX = b.masts[0].x; // foremast
    const deckY = b.deckYAt(mastX);
    const init = mastFootingCells(grid, mastX, deckY);
    expect(init).toBeGreaterThan(0);

    // Destroy the hull BELOW the deck in a band around the foremast (the "front of the ship is
    // destroyed"), but leave the deck plank (y == deckY) AND the mast's own base voxels (y > deckY)
    // intact — the exact scenario the player reported.
    const x0 = Math.max(0, mastX - MAST_FOOTING_HALF);
    const x1 = Math.min(nx - 1, mastX + MAST_FOOTING_HALF);
    for (let x = x0; x <= x1; x++)
      for (let y = 0; y < deckY; y++) // strictly below the deck plank
        for (let z = 0; z < nz; z++) grid.remove(x, y, z);

    // The bug: 18-connectivity does NOT sever the mast — the surviving full-length deck plank still
    // bridges every mast voxel back to the keel anchor, so none of them land in a severed island.
    const severed = findSevered(grid, keelAnchor(b)).flatMap((i) => i.cells);
    const mastCells = b.mastVoxels[0];
    const mastStillAttached = mastCells.every(
      (c) => !severed.some((s) => s.x === c.x && s.y === c.y && s.z === c.z),
    );
    expect(mastStillAttached).toBe(true);

    // The fix: the footing-support check catches it — the hull carrying the mast's step is gone.
    const now = mastFootingCells(grid, mastX, deckY);
    expect(now / init).toBeLessThan(MAST_SUPPORT_MIN_FRAC);
  });

  it("keeps a mast standing when the damage is far from it (stern hull blown out)", () => {
    const b = buildBrig();
    const grid = b.grid;
    const [nx, , nz] = grid.dims;
    const mastX = b.masts[0].x; // foremast (forward end)
    const deckY = b.deckYAt(mastX);
    const init = mastFootingCells(grid, mastX, deckY);

    // Blow out the aft hull below deck, well clear of the foremast's footing band.
    const sternStart = Math.max(mastX + MAST_FOOTING_HALF + 4, nx - 1 - MAST_FOOTING_HALF * 2);
    for (let x = sternStart; x < nx; x++)
      for (let y = 0; y < deckY; y++)
        for (let z = 0; z < nz; z++) grid.remove(x, y, z);

    const now = mastFootingCells(grid, mastX, deckY);
    expect(now / init).toBeGreaterThan(MAST_SUPPORT_MIN_FRAC);
  });

  it("a fresh hull's masts are all fully supported (frac == 1)", () => {
    const b = buildFrigate();
    for (const m of b.masts) {
      const deckY = b.deckYAt(m.x);
      const init = mastFootingCells(b.grid, m.x, deckY);
      expect(init).toBeGreaterThan(0);
      // recomputing on the intact grid is unchanged
      expect(mastFootingCells(b.grid, m.x, deckY)).toBe(init);
    }
  });
});
