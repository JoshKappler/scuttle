import { describe, it, expect } from "vitest";
import { buildCutter, buildSloop, buildBrig, buildFrigate, type ShipBuild } from "../src/sim/shipwright";
import { findSevered } from "../src/sim/connectivity";
import { SPAR } from "../src/sim/materials";
import { VOXEL_SIZE } from "../src/core/constants";

/**
 * Masts are now REAL grid voxels (sim/shipwright stampMasts) that break voxel-by-voxel under the
 * unified destruction rule + the 18-connectivity sever — no more one-piece rigid topple. These tests
 * lock that in: the trunk is SPAR voxels, it's structurally attached to the keel (so a fresh hull
 * sheds nothing), a shot-out base severs the WHOLE trunk above, and a mid cut severs only the upper
 * section (a stub stands).
 */

const keelAnchor = (b: ShipBuild): [number, number, number] => {
  const [kx, , knz] = b.grid.dims;
  const ax = Math.floor(kx / 2);
  const az = Math.floor(knz / 2);
  let ay = 0;
  while (ay < b.grid.dims[1] && !b.grid.isSolid(ax, ay, az)) ay++;
  return [ax, ay, az];
};

const builders: [string, () => ShipBuild][] = [
  ["cutter", buildCutter],
  ["sloop", buildSloop],
  ["brig", buildBrig],
  ["frigate", buildFrigate],
];

for (const [name, build] of builders) {
  describe(`voxel masts: ${name}`, () => {
    const b = build();

    it("stamps a real 2x2 SPAR voxel trunk per mast, rising off the deck", () => {
      expect(b.mastVoxels.length).toBe(b.masts.length);
      for (let mi = 0; mi < b.masts.length; mi++) {
        const cells = b.mastVoxels[mi];
        expect(cells.length).toBeGreaterThan(8); // a meaningful 2x2 trunk
        for (const c of cells) expect(b.grid.get(c.x, c.y, c.z)).toBe(SPAR);
        // 2 distinct x columns overall (trunk uses xPair = [m.x, m.x+1]; yards only stamp m.x)
        const xs = new Set(cells.map((c) => c.x));
        expect(xs.size).toBe(2);
        // trunk cross-section: filter to the SECOND x column (m.x+1) — yards never stamp there,
        // so these are pure trunk cells and must span exactly the 2 z-centreline cells
        const xArr = [...xs].sort((a, b) => a - b);
        const trunkCells = cells.filter((c) => c.x === xArr[1]);
        const trunkZs = new Set(trunkCells.map((c) => c.z));
        expect(trunkZs.size).toBe(2);
        // still a substantial breakable tower (whole mast, or capped at the grid top on big hulls)
        const ys = cells.map((c) => c.y);
        const span = (Math.max(...ys) - Math.min(...ys) + 1) * VOXEL_SIZE;
        const top = Math.max(...ys);
        const cappedAtGridTop = top >= b.grid.dims[1] - 2;
        expect(span >= b.masts[mi].h * 0.8 || (cappedAtGridTop && span >= 12)).toBe(true);
      }
    });

    it("the trunk is attached to the keel — a fresh hull sheds NOTHING", () => {
      // build-time weld + the mast sitting on the deck means the only solid is one component.
      expect(findSevered(b.grid, keelAnchor(b))).toEqual([]);
    });

    it("shooting out the base severs the WHOLE trunk above it", () => {
      const fresh = build();
      const cells = fresh.mastVoxels[0];
      const baseY = Math.min(...cells.map((c) => c.y));
      // remove the base layer (both z cells) of mast 0 — the trunk above loses its only path down
      for (const c of cells) if (c.y === baseY) fresh.grid.remove(c.x, c.y, c.z);
      const islands = findSevered(fresh.grid, keelAnchor(fresh));
      const severed = islands.flatMap((i) => i.cells);
      // every remaining mast-0 voxel must now be in a severed island (it broke off as debris)
      const remaining = cells.filter((c) => c.y > baseY);
      for (const c of remaining) {
        expect(severed.some((s) => s.x === c.x && s.y === c.y && s.z === c.z)).toBe(true);
      }
      // and they're SPAR (the felled mast), not random hull
      expect(severed.every((s) => fresh.grid.get(s.x, s.y, s.z) !== 0)).toBe(true);
    });

    it("a MID cut severs only the upper section — a stub keeps standing", () => {
      const fresh = build();
      const cells = fresh.mastVoxels[0].slice().sort((a, c) => a.y - c.y);
      const ys = [...new Set(cells.map((c) => c.y))];
      const midY = ys[Math.floor(ys.length / 2)];
      // remove the mid layer (both z cells at midY)
      for (const c of cells) if (c.y === midY) fresh.grid.remove(c.x, c.y, c.z);
      const severed = findSevered(fresh.grid, keelAnchor(fresh)).flatMap((i) => i.cells);
      const above = cells.filter((c) => c.y > midY);
      const below = cells.filter((c) => c.y < midY);
      // everything above the cut sheds; the stub below stays attached (not severed)
      for (const c of above) {
        expect(severed.some((s) => s.x === c.x && s.y === c.y && s.z === c.z)).toBe(true);
      }
      for (const c of below) {
        expect(severed.some((s) => s.x === c.x && s.y === c.y && s.z === c.z)).toBe(false);
      }
    });

    it("stamps 1-thick SPAR yards spanning the centerline at each level", () => {
      // a yard is a horizontal bar of SPAR in the mast x-plane, wider than the 2-cell trunk.
      const cells = b.mastVoxels[0];
      // group spar cells by y; at least 3 y-levels must be WIDER in z than the 2-cell trunk (the yards)
      const byY = new Map<number, Set<number>>();
      for (const c of cells) { (byY.get(c.y) ?? byY.set(c.y, new Set()).get(c.y)!).add(c.z); }
      const wideLevels = [...byY.values()].filter((zs) => zs.size > 2).length;
      expect(wideLevels).toBeGreaterThanOrEqual(3);
      // yards stay mirror-symmetric about the centerline (port == starboard)
      for (const [, zs] of byY) {
        if (zs.size <= 2) continue;
        for (const z of zs) expect(zs.has(b.grid.dims[2] - 1 - z)).toBe(true);
      }
    });
  });
}
