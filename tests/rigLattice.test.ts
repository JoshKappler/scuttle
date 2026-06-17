import { describe, it, expect } from "vitest";
import { dist, type RigNode, NodeFlag } from "../src/sim/rigLattice";

describe("rigLattice vec helpers", () => {
  it("dist measures node separation", () => {
    const a: RigNode = { pos: { x: 0, y: 0, z: 0 }, prev: { x: 0, y: 0, z: 0 }, mass: 1, pinned: false, flags: NodeFlag.WOOD };
    const b: RigNode = { pos: { x: 3, y: 4, z: 0 }, prev: { x: 3, y: 4, z: 0 }, mass: 1, pinned: false, flags: NodeFlag.WOOD };
    expect(dist(a.pos, b.pos)).toBeCloseTo(5, 6);
  });
});
