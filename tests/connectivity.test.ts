import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { findSevered } from "../src/sim/connectivity";
import { OAK } from "../src/sim/materials";

describe("connectivity", () => {
  it("intact bar has no severed islands", () => {
    const g = createGrid(10, 3, 3);
    for (let x = 0; x < 10; x++) g.set(x, 0, 0, OAK);
    expect(findSevered(g, [0, 0, 0])).toEqual([]);
  });

  it("cutting a bar yields one island with the far cells", () => {
    const g = createGrid(10, 3, 3);
    for (let x = 0; x < 10; x++) g.set(x, 0, 0, OAK);
    g.remove(5, 0, 0);
    const islands = findSevered(g, [0, 0, 0]);
    expect(islands.length).toBe(1);
    expect(islands[0].cells.length).toBe(4); // x = 6..9
  });

  it("two separate cuts yield two islands", () => {
    const g = createGrid(12, 3, 3);
    for (let x = 0; x < 12; x++) g.set(x, 0, 0, OAK);
    // two L-shaped stubs both detached from the anchored end
    g.remove(4, 0, 0);
    g.remove(8, 0, 0);
    const islands = findSevered(g, [0, 0, 0]);
    // x=5..7 and x=9..11 are separate islands (gap at 8)
    expect(islands.length).toBe(2);
    const sizes = islands.map((i) => i.cells.length).sort();
    expect(sizes).toEqual([3, 3]);
  });

  it("islands preserve cell materials", () => {
    const g = createGrid(6, 3, 3);
    for (let x = 0; x < 6; x++) g.set(x, 0, 0, OAK);
    g.remove(3, 0, 0);
    const [island] = findSevered(g, [0, 0, 0]);
    for (const c of island.cells) expect(c.mat).toBe(OAK);
  });

  it("anchor cell missing (keel blown out) anchors to largest remaining component", () => {
    const g = createGrid(10, 3, 3);
    for (let x = 0; x < 10; x++) g.set(x, 0, 0, OAK);
    g.remove(0, 0, 0); // the anchor itself
    g.remove(6, 0, 0);
    const islands = findSevered(g, [0, 0, 0]);
    // components: x=1..5 (5 cells) and x=7..9 (3 cells) → larger is the ship
    expect(islands.length).toBe(1);
    expect(islands[0].cells.length).toBe(3);
  });

  // ---- 18-connectivity (FACE + EDGE adjacency; corner-only is severed) ----
  // The user's rule: "voxels only survive if connected directly to another voxel ... by their faces
  // OR a single (or more) flat edge ... voxels connected by only a corner must be automatically
  // destroyed." So a face neighbour (±1 on one axis) OR an edge neighbour (±1 on two axes, sharing a
  // flat edge in a plane) keeps a cell; a pure corner neighbour (±1 on all three axes, touching only
  // at a vertex) does NOT.

  it("a face-attached voxel survives (no island)", () => {
    const g = createGrid(4, 4, 4);
    g.set(1, 1, 1, OAK); // anchor body
    g.set(2, 1, 1, OAK); // shares the +x FACE with the anchor → connected
    expect(findSevered(g, [1, 1, 1])).toEqual([]);
  });

  it("an edge-attached voxel SURVIVES (shares a flat edge, ±1 on two axes)", () => {
    const g = createGrid(4, 4, 4);
    g.set(1, 1, 1, OAK); // anchor body
    g.set(2, 2, 1, OAK); // diagonal in the xy-plane: shares the edge along z → connected, kept
    expect(findSevered(g, [1, 1, 1])).toEqual([]);
  });

  it("a corner-only-attached voxel is SEVERED (±1 on all three axes, touches only at a vertex)", () => {
    const g = createGrid(4, 4, 4);
    g.set(1, 1, 1, OAK); // anchor body
    g.set(2, 2, 2, OAK); // pure body-diagonal: shares only a corner → must break off
    const islands = findSevered(g, [1, 1, 1]);
    expect(islands.length).toBe(1);
    expect(islands[0].cells.length).toBe(1);
    expect(islands[0].cells[0]).toMatchObject({ x: 2, y: 2, z: 2 });
  });

  it("a fully-disconnected voxel is severed", () => {
    const g = createGrid(6, 4, 4);
    g.set(1, 1, 1, OAK); // anchor body
    g.set(4, 1, 1, OAK); // far away, no neighbour of any kind → floats free → severed
    const islands = findSevered(g, [1, 1, 1]);
    expect(islands.length).toBe(1);
    expect(islands[0].cells.length).toBe(1);
    expect(islands[0].cells[0]).toMatchObject({ x: 4, y: 1, z: 1 });
  });

  it("a checkerboard slab stays ONE body (edge-connected) — the prune must not shed it", () => {
    // A planar 3×3 checkerboard in the xy-plane (z fixed). Cells touch their kept neighbours only
    // diagonally-in-plane = EDGE adjacency, so 18-connectivity keeps them all as one component.
    const g = createGrid(5, 5, 3);
    let count = 0;
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      if ((x + y) % 2 === 0) { g.set(x, y, 1, OAK); count++; }
    }
    // anchor = the (0,0,1) corner of the checkerboard
    expect(findSevered(g, [0, 0, 1])).toEqual([]);
    expect(count).toBe(5); // sanity: the (x+y) even cells of a 3×3 = 5 cells, all edge-linked
  });
});
