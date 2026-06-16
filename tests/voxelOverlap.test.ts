import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { computeSurface, unpackCell } from "../src/sim/surfaceSet";
import { detectContacts, type HullView, type ContactScratch } from "../src/sim/voxelOverlap";
import { OAK } from "../src/sim/materials";

const ID: [number, number, number, number] = [0, 0, 0, 1];

function block(n: number, pos: [number, number, number], quat: [number, number, number, number]): HullView {
  const grid = createGrid(n, n, n);
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) grid.set(x, y, z, OAK);
  const set = computeSurface(grid);
  const surface = new Int32Array(set.size * 3);
  let i = 0;
  for (const k of set) {
    const [x, y, z] = unpackCell(k, n, n);
    surface[i++] = x; surface[i++] = y; surface[i++] = z;
  }
  return { surface, isSolid: (x, y, z) => grid.isSolid(x, y, z), dims: [n, n, n], pos, quat };
}

function scratch(capacity: number): ContactScratch {
  return {
    aCells: new Int32Array(capacity * 3),
    bCells: new Int32Array(capacity * 3),
    points: new Float32Array(capacity * 3),
  };
}

/** Read contact i's A cell out of a filled scratch. */
function aCell(s: ContactScratch, i: number): [number, number, number] {
  return [s.aCells[i * 3], s.aCells[i * 3 + 1], s.aCells[i * 3 + 2]];
}
function bCell(s: ContactScratch, i: number): [number, number, number] {
  return [s.bCells[i * 3], s.bCells[i * 3 + 1], s.bCells[i * 3 + 2]];
}

describe("detectContacts", () => {
  it("two 4^3 blocks overlapping 1 voxel along +x: shared slab, ~1 voxel depth, +x push axis", () => {
    const vs = 1;
    const a = block(4, [0, 0, 0], ID); // world x [0,4)
    const b = block(4, [3, 0, 0], ID); // world x [3,7) -> overlap is A's x=3 layer vs B's x=0 layer
    const s = scratch(64);
    const r = detectContacts(a, b, vs, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16); // A's +x face layer, 4x4 cells
    for (let i = 0; i < r!.count; i++) {
      expect(aCell(s, i)[0]).toBe(3); // A's +x face layer
      expect(bCell(s, i)[0]).toBe(0); // B's -x face layer
    }
    expect(r!.depth).toBeCloseTo(1, 5); // ~1 voxel along the thin (x) axis
    expect(r!.axis).toEqual([1, 0, 0]); // push-out A->B = +x
    // contact points sit at A's x=3 cell centres in world (x = 3.5)
    for (let i = 0; i < r!.count; i++) expect(s.points[i * 3]).toBeCloseTo(3.5, 5);
  });

  it("returns null when the two hulls are disjoint", () => {
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [10, 0, 0], ID);
    expect(detectContacts(a, b, 1, 0, scratch(64))).toBeNull();
  });

  it("is symmetric in detection: swapping A/B still finds the same slab (mirrored axis)", () => {
    const vs = 1;
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [3, 0, 0], ID);
    const s = scratch(64);
    const r = detectContacts(b, a, vs, 0, s); // now B-at-3 is the 'A' arg
    expect(r).not.toBeNull();
    for (let i = 0; i < r!.count; i++) {
      expect(aCell(s, i)[0]).toBe(0); // the at-3 block's -x layer
      expect(bCell(s, i)[0]).toBe(3); // the at-0 block's +x layer
    }
    expect(r!.depth).toBeCloseTo(1, 5);
    expect(r!.axis).toEqual([-1, 0, 0]); // push the at-3 block back toward -x
  });

  it("buffer: surfaces that don't quite overlap still register when close enough", () => {
    const vs = 1;
    const a = block(4, [0, 0, 0], ID); // right face at world x = 4 (cell centres to 3.5)
    const b = block(4, [3.8, 0, 0], ID); // left face at world x = 3.8 — surfaces overlap only 0.2, no centre is inside the other
    // with no buffer, no A-cell centre lands inside B -> nothing touches
    expect(detectContacts(a, b, vs, 0, scratch(64))).toBeNull();
    // a 0.5-voxel buffer bridges the gap from A's x=3.5 centres to B's face at 3.8
    const s = scratch(64);
    const r = detectContacts(a, b, vs, 0.5, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16);
    for (let i = 0; i < r!.count; i++) expect(aCell(s, i)[0]).toBe(3);
  });

  it("mismatched voxel sizes: a fine hull A overlapping a coarse hull B finds the contacts", () => {
    // B: a 2^3 block at voxel size 2 -> world extent [0,4)^3
    const b = block(2, [0, 0, 0], ID);
    // A: a 4^3 block at voxel size 1, shifted so only A's x=0 layer (centre 3.5) lands inside B
    const a = block(4, [3, 0, 0], ID); // A world x [3,7)
    const s = scratch(64);
    const r = detectContacts(a, b, 1, 0, s, 2); // vsA=1, vsB=2
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16); // A's x=0 face layer, 4x4 in y,z
    for (let i = 0; i < r!.count; i++) {
      expect(aCell(s, i)[0]).toBe(0); // A's leading (-x) layer into B
      expect(bCell(s, i)[0]).toBe(1); // world 3.5 -> B-local floor(3.5/2) = 1
    }
  });

  it("respects scratch capacity (never writes past the end)", () => {
    const vs = 1;
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [3, 0, 0], ID);
    const s = scratch(5); // far fewer than the 16 real contacts
    const r = detectContacts(a, b, vs, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(5); // capped, no out-of-bounds write
  });
});
