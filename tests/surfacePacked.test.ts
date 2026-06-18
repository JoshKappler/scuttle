import { describe, it, expect } from "vitest";
import { createGrid, type VoxelGrid } from "../src/sim/voxelGrid";
import { computeSurface, updateSurfaceAfterRemoval, packCell, unpackCell } from "../src/sim/surfaceSet";
import { OAK } from "../src/sim/materials";

// Standalone, faithful mirror of game/ship.ts's INCREMENTAL packed-boundary view
// (seedSurfacePacked + applySurfaceDelta + surfacePushCell + surfaceSwapRemove). ship.ts can't be
// unit-constructed (it needs a live Rapier world + a THREE ShipVisual), so this exercises the exact
// algorithm against the same surfaceSet primitives the production code uses and asserts SET parity
// with a from-scratch computeSurface after each carve — the correctness bar for the perf change
// (the deformable contact only reads the boundary as an unordered set, so order is irrelevant).
class PackedSurface {
  grid: VoxelGrid;
  surface: Set<number>;
  packed: Int32Array;
  len = 0; // live cell count
  index = new Map<number, number>(); // packed key -> cell slot

  constructor(grid: VoxelGrid) {
    this.grid = grid;
    this.surface = computeSurface(grid);
    const [nx, ny] = grid.dims;
    const n = this.surface.size;
    this.packed = new Int32Array(Math.max(n * 3, 3));
    let slot = 0;
    for (const key of this.surface) {
      const [x, y, z] = unpackCell(key, nx, ny);
      const o = slot * 3;
      this.packed[o] = x; this.packed[o + 1] = y; this.packed[o + 2] = z;
      this.index.set(key, slot);
      slot++;
    }
    this.len = slot;
  }

  /** Carve a cell list out of the grid + Set, then mirror the change into the packed view. */
  carve(cells: [number, number, number][]): void {
    const [nx, ny, nz] = this.grid.dims;
    const gone: [number, number, number][] = [];
    for (const [x, y, z] of cells) {
      if (!this.grid.isSolid(x, y, z)) continue;
      this.grid.remove(x, y, z);
      gone.push([x, y, z]);
    }
    if (gone.length === 0) return;
    updateSurfaceAfterRemoval(this.grid, this.surface, gone);
    // reconcile JUST the removed cells + their face-neighbours against the Set
    const cand = new Set<number>();
    for (const [x, y, z] of gone) {
      cand.add(packCell(x, y, z, nx, ny));
      if (x > 0) cand.add(packCell(x - 1, y, z, nx, ny));
      if (x + 1 < nx) cand.add(packCell(x + 1, y, z, nx, ny));
      if (y > 0) cand.add(packCell(x, y - 1, z, nx, ny));
      if (y + 1 < ny) cand.add(packCell(x, y + 1, z, nx, ny));
      if (z > 0) cand.add(packCell(x, y, z - 1, nx, ny));
      if (z + 1 < nz) cand.add(packCell(x, y, z + 1, nx, ny));
    }
    for (const key of cand) {
      const inSet = this.surface.has(key);
      const slot = this.index.get(key);
      if (inSet && slot === undefined) this.push(key);
      else if (!inSet && slot !== undefined) this.swapRemove(key, slot);
    }
  }

  private push(key: number): void {
    const [nx, ny] = this.grid.dims;
    const [x, y, z] = unpackCell(key, nx, ny);
    const slot = this.len;
    if ((slot + 1) * 3 > this.packed.length) {
      const grown = new Int32Array(Math.max(this.packed.length * 1.5 | 0, (slot + 1) * 3));
      grown.set(this.packed);
      this.packed = grown;
    }
    const o = slot * 3;
    this.packed[o] = x; this.packed[o + 1] = y; this.packed[o + 2] = z;
    this.index.set(key, slot);
    this.len = slot + 1;
  }

  private swapRemove(key: number, slot: number): void {
    const last = this.len - 1;
    const buf = this.packed;
    if (slot !== last) {
      const so = slot * 3, lo = last * 3;
      const lx = buf[lo], ly = buf[lo + 1], lz = buf[lo + 2];
      buf[so] = lx; buf[so + 1] = ly; buf[so + 2] = lz;
      const movedKey = packCell(lx, ly, lz, this.grid.dims[0], this.grid.dims[1]);
      this.index.set(movedKey, slot);
    }
    this.index.delete(key);
    this.len = last;
  }

  /** The live packed prefix as a key Set, for parity comparison. */
  liveKeys(): Set<number> {
    const [nx, ny] = this.grid.dims;
    const s = new Set<number>();
    for (let i = 0; i < this.len; i++) {
      const o = i * 3;
      s.add(packCell(this.packed[o], this.packed[o + 1], this.packed[o + 2], nx, ny));
    }
    return s;
  }
}

function solidBlock(n: number): VoxelGrid {
  const g = createGrid(n, n, n);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g.set(x, y, z, OAK);
  return g;
}

function expectParity(ps: PackedSurface): void {
  // packed view must hold EXACTLY the from-scratch boundary set, and its index must be consistent.
  const fresh = computeSurface(ps.grid);
  const live = ps.liveKeys();
  expect(live.size).toBe(fresh.size);
  for (const k of fresh) expect(live.has(k)).toBe(true);
  // index ↔ packed slot consistency (no stale / duplicate slots)
  expect(ps.index.size).toBe(ps.len);
  const [nx, ny] = ps.grid.dims;
  for (const [key, slot] of ps.index) {
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(ps.len);
    const o = slot * 3;
    expect(packCell(ps.packed[o], ps.packed[o + 1], ps.packed[o + 2], nx, ny)).toBe(key);
  }
}

describe("incremental packed surface view (ship.ts mirror)", () => {
  it("seeds identical to computeSurface", () => {
    const ps = new PackedSurface(solidBlock(5));
    expectParity(ps);
  });

  it("matches after carving a single face cell (exposes the core, swap-remove + push)", () => {
    const ps = new PackedSurface(solidBlock(3));
    ps.carve([[1, 1, 0]]); // carve one face center → core (1,1,1) becomes surface
    expectParity(ps);
    // the carved cell left, the core joined — same 26-cell boundary as the from-scratch set
    expect(ps.len).toBe(26);
  });

  it("matches after carving an interior slab (many adds + removes)", () => {
    const ps = new PackedSurface(solidBlock(8));
    const cells: [number, number, number][] = [];
    for (let x = 2; x <= 5; x++) for (let z = 2; z <= 5; z++) cells.push([x, 4, z]);
    ps.carve(cells);
    expectParity(ps);
  });

  it("matches after carving a full hole right through (whole columns vanish)", () => {
    const ps = new PackedSurface(solidBlock(7));
    const cells: [number, number, number][] = [];
    for (let y = 0; y < 7; y++) cells.push([3, y, 3]); // a clean bore through the centre column
    ps.carve(cells);
    expectParity(ps);
  });

  it("matches across MANY sequential carves (heavy swap-remove churn)", () => {
    const ps = new PackedSurface(solidBlock(9));
    // peel the block cell-by-cell in a deterministic sweep; every carve relocates the last packed
    // cell into the freed slot (the swap-remove index-maintenance path) and exposes fresh neighbours.
    for (let x = 0; x < 9; x += 2) {
      for (let z = 0; z < 9; z += 2) {
        ps.carve([[x, 8, z]]);
        expectParity(ps);
      }
    }
  });

  it("stays correct when carving down to (almost) nothing", () => {
    const ps = new PackedSurface(solidBlock(4));
    const cells: [number, number, number][] = [];
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if (!(x === 0 && y === 0 && z === 0)) cells.push([x, y, z]);
    ps.carve(cells); // leave a single voxel
    expectParity(ps);
    expect(ps.len).toBe(1); // the lone survivor is surface
  });
});
