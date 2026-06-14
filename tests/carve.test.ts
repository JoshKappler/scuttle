import { describe, it, expect } from "vitest";
import { planCarve, type CarveParams } from "../src/sim/carve";
import { STRENGTH_TO_JOULES as C } from "../src/sim/materials";

function uniform(dims: [number, number, number], strength: number): Omit<CarveParams, "origin" | "dir" | "energy" | "maxCells"> {
  const [nx, ny, nz] = dims;
  return { dims, isSolid: (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz, strengthAt: () => strength };
}

describe("planCarve", () => {
  it("removes energy/cost cells from a uniform soft wall", () => {
    const r = planCarve({ ...uniform([20, 1, 20], 2), origin: [10, 0, 10], dir: null, energy: 5 * 2 * C, maxCells: 999 });
    expect(r.cells.length).toBe(5);
    expect(r.spent).toBeLessThanOrEqual(5 * 2 * C);
  });
  it("tough material removes fewer cells than soft for equal energy", () => {
    const soft = planCarve({ ...uniform([20, 1, 20], 2), origin: [10, 0, 10], dir: null, energy: 40 * C, maxCells: 999 });
    const tough = planCarve({ ...uniform([20, 1, 20], 8), origin: [10, 0, 10], dir: null, energy: 40 * C, maxCells: 999 });
    expect(tough.cells.length).toBeLessThan(soft.cells.length);
  });
  it("biases penetration along dir (tunnel deeper than wide)", () => {
    const r = planCarve({ ...uniform([41, 1, 41], 2), origin: [20, 0, 20], dir: [1, 0, 0], energy: 30 * 2 * C, maxCells: 999 });
    const xs = r.cells.map((c) => c[0]); const zs = r.cells.map((c) => c[2]);
    const xSpan = Math.max(...xs) - Math.min(...xs); const zSpan = Math.max(...zs) - Math.min(...zs);
    expect(xSpan).toBeGreaterThan(zSpan);
  });
  it("respects maxCells", () => {
    const r = planCarve({ ...uniform([50, 1, 50], 1), origin: [25, 0, 25], dir: null, energy: 1e12, maxCells: 12 });
    expect(r.cells.length).toBe(12);
  });
  it("is deterministic (no RNG)", () => {
    const mk = () => planCarve({ ...uniform([30, 1, 30], 2), origin: [15, 0, 15], dir: [1, 0, 0], energy: 50 * C, maxCells: 999 });
    expect(mk().cells).toEqual(mk().cells);
  });
  it("returns nothing when the origin region is empty", () => {
    const r = planCarve({ dims: [5, 5, 5], isSolid: () => false, strengthAt: () => 1, origin: [2, 2, 2], dir: null, energy: 1e9, maxCells: 99 });
    expect(r.cells.length).toBe(0);
  });
});
