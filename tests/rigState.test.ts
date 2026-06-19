import { describe, it, expect } from "vitest";
import { createGrid } from "../src/sim/voxelGrid";
import { CANVAS } from "../src/sim/materials";
import { survivingFraction, sailIntegrityValue } from "../src/sim/rigState";

describe("rig state (sail integrity)", () => {
  it("survivingFraction tracks how many cells still hold the material", () => {
    const g = createGrid(4, 1, 1);
    const cells = [0, 1, 2, 3].map((x) => ({ x, y: 0, z: 0 }));
    for (const c of cells) g.set(c.x, c.y, c.z, CANVAS);
    expect(survivingFraction(g, cells, CANVAS)).toBeCloseTo(1, 6);
    g.remove(0, 0, 0);
    g.remove(1, 0, 0);
    expect(survivingFraction(g, cells, CANVAS)).toBeCloseTo(0.5, 6);
    expect(survivingFraction(g, [], CANVAS)).toBe(1); // a mast with no canvas reads full
  });

  it("sailIntegrityValue is convex: a few holes barely matter, a peppered sail collapses", () => {
    expect(sailIntegrityValue(1)).toBeCloseTo(1, 6);
    expect(sailIntegrityValue(0.9)).toBeGreaterThan(0.95); // ~0.97
    expect(sailIntegrityValue(0.5)).toBeLessThan(0.3);     // ~0.25
    expect(sailIntegrityValue(0)).toBe(0);
  });
});
