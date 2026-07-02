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

function scratchN(capacity: number): ContactScratch {
  return {
    aCells: new Int32Array(capacity * 3),
    bCells: new Int32Array(capacity * 3),
    points: new Float32Array(capacity * 3),
    normals: new Float32Array(capacity * 3),
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

  it("tight broad-phase: a near-but-not-overlapping pair returns the SAME empty set (just faster)", () => {
    // A occupies world x [0,4); B's left face sits at x = 4.6 — a >0.5-voxel gap. The hulls do NOT
    // interpenetrate and no A-cell centre (max 3.5) lands within even a 0.5-voxel-padded B (min 4.1),
    // so the result is identically null. This is the case the new envelope gate short-circuits BEFORE
    // the surface walk; the contract is only that the produced set is unchanged (empty), now cheaper.
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [4.6, 0, 0], ID);
    expect(detectContacts(a, b, 1, 0, scratch(64))).toBeNull();   // no buffer
    expect(detectContacts(a, b, 1, 0.5, scratch(64))).toBeNull(); // even with the live 0.5-voxel buffer
  });

  it("tight broad-phase: a near-miss that is ROTATED still returns null (gate never drops a real contact)", () => {
    // B rotated 45° about Y and parked just clear of A. The corner-transformed envelope grows, but the
    // two padded grid boxes still don't meet, so the gate returns null — and that matches the full walk
    // (no A-cell centre lands inside the rotated B). Locks that the gate is a pure broad reject.
    const s2 = Math.SQRT1_2; // sin/cos 45°
    const rotY: [number, number, number, number] = [0, s2, 0, s2];
    const a = block(4, [0, 0, 0], ID);    // world x [0,4)
    const b = block(4, [7, 0, 0], rotY);  // well clear even after the √2 corner spread (~5.66 wide)
    expect(detectContacts(a, b, 1, 0.4, scratch(64))).toBeNull();
  });

  it("tight broad-phase: a JUST-touching pair is NOT skipped — the real overlap is still found", () => {
    // Guard against an over-aggressive gate: A x[0,4), B x[3,7) overlap by one voxel layer. The
    // envelopes clearly intersect, so the gate must fall through and the contact slab must be detected
    // exactly as before (16 cells, A's x=3 layer). (Mirrors the headline overlap test, post-gate.)
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [3, 0, 0], ID);
    const s = scratch(64);
    const r = detectContacts(a, b, 1, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16);
    for (let i = 0; i < r!.count; i++) expect(aCell(s, i)[0]).toBe(3);
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

  it("corner-clip scrape: ov.axis is the thin FACE normal, distinct from the diagonal COM→COM line", () => {
    // The glancing corner-clip that game/voxelContact's off-axis de-pen targets. A small hull noses into
    // the CORNER region of a big one: a 2^3 block A overlaps the +x/+z corner of a 6^3 block B by one
    // X-layer but several Z-layers. The genuine push-out (ov.axis) is the THIN axis = +X (a 1-cell-deep
    // overlap there), which is PERPENDICULAR to that face. The COM→COM line, by contrast, runs DIAGONALLY
    // (B's centre is offset from A's in BOTH x and z), so resolving only along the COM line would shove A
    // partly ALONG B's side instead of cleanly out of it — exactly the disagreement (|axis·n̂_COM| < 1)
    // that voxelContact's off-axis branch gates on (align < 0.5) and corrects by also pushing along
    // ov.axis. This locks the geometric fact the fix relies on: ov.axis = the perpendicular face normal.
    const vs = 1;
    const a = block(2, [5, 0, 1], ID);  // A: x[5,7) z[1,3), COM ≈ (6,1,2)
    const b = block(6, [0, 0, 0], ID);  // B: x[0,6) z[0,6), COM ≈ (3,3,3)
    const s = scratch(64);
    const r = detectContacts(a, b, vs, 0, s);
    expect(r).not.toBeNull();
    // overlap is 1 layer thick on X (A's x=5 vs B's x=5 face) → thin axis = X. Signed A→B points -x
    // (B's centre is to A's −x), so the push-out is −x. Either sign is fine; assert it's the X axis and
    // carries NO Z component, despite the diagonal centre offset.
    expect(Math.abs(r!.axis[0])).toBe(1);
    expect(r!.axis[1]).toBe(0);
    expect(r!.axis[2]).toBe(0);            // push-out is the perpendicular X face normal, not the diagonal
    expect(r!.depth).toBeCloseTo(1, 5);
    // and the COM→COM horizontal line genuinely DISAGREES with that axis (it has a real Z share), which is
    // what makes this the off-axis scrape case rather than a clean head-on.
    const nx = 3 - 6, nz = 3 - 2;          // B.COM − A.COM, horizontal
    const nlen = Math.hypot(nx, nz);
    const align = Math.abs((r!.axis[0] * nx + r!.axis[2] * nz) / nlen);
    expect(align).toBeLessThan(1);         // not perfectly aligned → COM-line push-out alone is imperfect
    expect(nz / nlen).toBeGreaterThan(0);  // a real perpendicular (Z) component the X push-out must add
  });
});

describe("detectContacts — per-contact local surface normals (round 12)", () => {
  it("flat-wall contact: every normal is unit, faces A; interior face cells are EXACTLY (-1,0,0)", () => {
    const a = block(4, [0, 0, 0], ID); // A's x=3 layer meets…
    const b = block(4, [3, 0, 0], ID); // …B's x=0 face
    const s = scratchN(64);
    const r = detectContacts(a, b, 1, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16);
    let interiorChecked = false;
    for (let i = 0; i < r!.count; i++) {
      const nx0 = s.normals![i * 3], ny0 = s.normals![i * 3 + 1], nz0 = s.normals![i * 3 + 2];
      expect(Math.hypot(nx0, ny0, nz0)).toBeCloseTo(1, 5); // unit
      expect(nx0).toBeLessThan(0);                          // every contacted cell exposes -x (toward A)
      const bc = bCell(s, i);
      if (bc[0] === 0 && bc[1] === 1 && bc[2] === 1) {      // an interior face cell → exact face normal
        expect(nx0).toBeCloseTo(-1, 5);
        expect(ny0).toBeCloseTo(0, 5);
        expect(nz0).toBeCloseTo(0, 5);
        interiorChecked = true;
      }
    }
    expect(interiorChecked).toBe(true);
  });

  it("deep engulf: contacts against INTERIOR B cells report zero normals (caller falls back)", () => {
    const b = block(6, [0, 0, 0], ID);
    const a = block(2, [2, 2, 2], ID); // fully inside B — every contacted B cell has 6 solid neighbours
    const s = scratchN(64);
    const r = detectContacts(a, b, 1, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(8);
    for (let i = 0; i < r!.count * 3; i++) expect(s.normals![i]).toBe(0);
  });

  it("rotated B: the local face normal is rotated into world space", () => {
    const flip: [number, number, number, number] = [0, 1, 0, 0]; // 180° yaw about the grid corner
    const a = block(4, [0, 0, 0], ID);
    const b = block(4, [7, 0, 4], flip); // local (x,z) → world (7−x, 4−z): occupies x[3,7) z[0,4)
    const s = scratchN(64);
    const r = detectContacts(a, b, 1, 0, s);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(16);
    let checked = false;
    for (let i = 0; i < r!.count; i++) {
      const bc = bCell(s, i);
      if (bc[0] === 3 && bc[1] === 1 && bc[2] === 2) {
        // B-LOCAL outward is (+1,0,0) (the local +x face is the wall A touches); yawed 180°
        // it must land at world (−1,0,0) — still pointing out of the wall toward A.
        expect(s.normals![i * 3]).toBeCloseTo(-1, 5);
        expect(s.normals![i * 3 + 1]).toBeCloseTo(0, 5);
        expect(s.normals![i * 3 + 2]).toBeCloseTo(0, 5);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });
});
