import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { computeSurface, updateSurfaceAfterRemoval, packCell, isSurface } from "../src/sim/surfaceSet";
import { OAK } from "../src/sim/materials";

function solidBlock(n: number) {
  const grid = createGrid(n, n, n);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) grid.set(x, y, z, OAK);
  return grid;
}

describe("surfaceSet", () => {
  it("a 3x3x3 solid block has 26 surface cells — all but the centre", () => {
    const grid = solidBlock(3);
    const surface = computeSurface(grid);
    expect(surface.size).toBe(26);
    // the centre (1,1,1) is fully enclosed -> not surface
    expect(isSurface(grid, 1, 1, 1)).toBe(false);
    expect(surface.has(packCell(1, 1, 1, 3, 3))).toBe(false);
    // a corner is surface
    expect(surface.has(packCell(0, 0, 0, 3, 3))).toBe(true);
  });

  it("after carving one face cell, the newly-exposed neighbour joins the set", () => {
    const grid = solidBlock(3);
    const surface = computeSurface(grid);
    const centreKey = packCell(1, 1, 1, 3, 3);
    expect(surface.has(centreKey)).toBe(false);

    // carve the centre of one face, exposing the core
    const faceCell: [number, number, number] = [1, 1, 0];
    grid.remove(faceCell[0], faceCell[1], faceCell[2]);
    updateSurfaceAfterRemoval(grid, surface, [faceCell]);

    // the carved cell left the set; the core (1,1,1) is now exposed and joined it
    expect(surface.has(packCell(1, 1, 0, 3, 3))).toBe(false);
    expect(surface.has(centreKey)).toBe(true);
    // every remaining solid cell is now surface (no interior left)
    expect(surface.size).toBe(26);
  });
});
