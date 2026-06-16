import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { createGrid } from "../src/sim/voxelGrid";
import { ROCK } from "../src/sim/materials";
import { IslandTarget } from "../src/game/islandTarget";

describe("IslandTarget — terrain as an immovable, indestructible hull", () => {
  function rockBlock() {
    const grid = createGrid(4, 4, 4);
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) grid.set(x, y, z, ROCK);
    return grid;
  }

  it("is indestructible: canCarve is false and carveCells is a no-op", () => {
    const grid = rockBlock();
    const t = new IslandTarget(grid, { x: 10, y: -3, z: 20 }, 1);
    expect(t.canCarve).toBe(false);
    expect(t.carveCells([[0, 0, 0], [1, 1, 1]])).toBe(0);
    expect(grid.isSolid(0, 0, 0)).toBe(true); // grid untouched
  });

  it("is immovable: zero velocity, and setTranslation / applyImpulseAtPoint do nothing", () => {
    const t = new IslandTarget(rockBlock(), { x: 10, y: -3, z: 20 }, 1);
    expect(t.linvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(t.angvel()).toEqual({ x: 0, y: 0, z: 0 });
    const before = { ...t.translation() };
    t.setTranslation({ x: 999, y: 999, z: 999 });
    t.applyImpulseAtPoint(new THREE.Vector3(1, 1, 1), { x: 0, y: 0, z: 0 });
    expect(t.translation()).toEqual(before); // never moved
  });

  it("reports its voxel size, a world centre, and an AABB from the grid envelope", () => {
    const t = new IslandTarget(rockBlock(), { x: 10, y: -3, z: 20 }, 1);
    expect(t.voxelSize).toBe(1);
    const c = t.comWorld(new THREE.Vector3());
    expect(c.x).toBeCloseTo(12, 9); // 10 + 4*1/2
    expect(c.y).toBeCloseTo(-1, 9); // -3 + 4*1/2
    const box = { min: new THREE.Vector3(), max: new THREE.Vector3() };
    t.aabbWorld(box);
    expect(box.min.toArray()).toEqual([10, -3, 20]);
    expect(box.max.toArray()).toEqual([14, 1, 24]);
  });

  it("reports an effectively-infinite mass", () => {
    const t = new IslandTarget(rockBlock(), { x: 0, y: 0, z: 0 }, 1);
    expect(t.mass()).toBeGreaterThan(1e10);
  });
});
