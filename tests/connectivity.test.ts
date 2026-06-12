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
});
