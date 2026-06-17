import { describe, it, expect } from "vitest";
import {
  makeVoxelColumns,
  updateVoxelColumns,
  enclosedCellSet,
  type VoxelColumn,
} from "../src/sim/buoyancy";
import { VOXEL_SIZE } from "../src/core/constants";
import { buildSloop, buildBrig } from "../src/sim/shipwright";

// Recover the integer grid (x,z) a column sits on from its world-meter centre.
function gxz(col: VoxelColumn): [number, number] {
  return [Math.round(col.x / VOXEL_SIZE - 0.5), Math.round(col.z / VOXEL_SIZE - 0.5)];
}

// Index columns by (x,z) with their content normalised for order-independent comparison.
function normalize(cols: VoxelColumn[]) {
  const m = new Map<string, { cellY: number[]; edge: boolean; area: number }>();
  for (const c of cols) {
    const [x, z] = gxz(c);
    m.set(`${x},${z}`, { cellY: c.cellY.slice().sort((a, b) => a - b), edge: c.edge, area: c.area });
  }
  return m;
}

// Incremental result must equal a full rebuild as a SET (column order is irrelevant — the
// only consumers sum over columns / take maxima, both order-independent).
function expectSameColumns(incremental: VoxelColumn[], full: VoxelColumn[]) {
  const a = normalize(incremental);
  const b = normalize(full);
  expect(a.size).toBe(b.size);
  for (const [k, vb] of b) {
    const va = a.get(k);
    expect(va, `column ${k} missing from incremental`).toBeDefined();
    expect(va!.cellY).toEqual(vb.cellY);
    expect(va!.edge, `edge flag wrong at ${k}`).toBe(vb.edge);
    expect(va!.area).toBe(vb.area);
  }
}

describe("incremental voxel columns", () => {
  it("matches a full rebuild after carving an interior slab", () => {
    const build = buildSloop();
    const grid = build.grid;
    const enclosed = enclosedCellSet(build.compartments);
    const before = makeVoxelColumns(grid, build.compartments);

    const [nx, ny, nz] = grid.dims;
    const changed = new Set<number>();
    const cx = Math.floor(nx / 2), cz = Math.floor(nz / 2);
    for (let x = cx - 2; x <= cx + 2; x++)
      for (let z = cz - 2; z <= cz + 2; z++)
        for (let y = 0; y < ny; y++)
          if (grid.isSolid(x, y, z)) { grid.remove(x, y, z); changed.add(x * nz + z); }

    const inc = updateVoxelColumns(grid, enclosed, before, changed, nx, nz);
    const full = makeVoxelColumns(grid, build.compartments);
    expectSameColumns(inc, full);
  });

  it("updates neighbour edge flags when whole columns are removed", () => {
    // Carve a full hole right through the deck/keel at a patch so several columns VANISH —
    // their surviving neighbours must flip to edge. This is the case naive incremental misses.
    const build = buildBrig();
    const grid = build.grid;
    const enclosed = enclosedCellSet(build.compartments);
    const before = makeVoxelColumns(grid, build.compartments);

    const [nx, ny, nz] = grid.dims;
    const changed = new Set<number>();
    const cx = Math.floor(nx / 2), cz = Math.floor(nz / 2);
    for (let x = cx - 1; x <= cx + 1; x++)
      for (let z = cz - 1; z <= cz + 1; z++)
        for (let y = 0; y < ny; y++)
          if (grid.isSolid(x, y, z)) { grid.remove(x, y, z); changed.add(x * nz + z); }

    const inc = updateVoxelColumns(grid, enclosed, before, changed, nx, nz);
    const full = makeVoxelColumns(grid, build.compartments);
    expectSameColumns(inc, full);
  });

  it("is a no-op (still correct) when nothing changed", () => {
    const build = buildSloop();
    const grid = build.grid;
    const enclosed = enclosedCellSet(build.compartments);
    const before = makeVoxelColumns(grid, build.compartments);
    const inc = updateVoxelColumns(grid, enclosed, before, new Set<number>(), grid.dims[0], grid.dims[2]);
    expectSameColumns(inc, before);
  });

  it("enclosedCellSet collects every compartment cell once", () => {
    const build = buildSloop();
    const enclosed = enclosedCellSet(build.compartments);
    let total = 0;
    for (const c of build.compartments) total += c.cells.size;
    // compartments are disjoint, so the set size equals the sum of cell counts
    expect(enclosed.size).toBe(total);
  });
});
