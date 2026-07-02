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
  it("pooled scratch carries NOTHING across calls (same call → same result after unrelated calls)", () => {
    const mk = () => planCarve({ ...uniform([30, 1, 30], 2), origin: [15, 0, 15], dir: [1, 0, 0], energy: 50 * C, maxCells: 999 });
    const first = mk();
    // dirty the pooled heap + seen set with unrelated, differently-shaped work…
    planCarve({ ...uniform([9, 9, 9], 8), origin: [4, 4, 4], dir: [0, 1, 0], energy: 200 * C, maxCells: 7 });
    planCarve({ dims: [5, 5, 5], isSolid: () => false, strengthAt: () => 1, origin: [2, 2, 2], dir: null, energy: 1e9, maxCells: 99 });
    // …then the identical call must be bit-identical (determinism survives pooling).
    const again = mk();
    expect(again.cells).toEqual(first.cells);
    expect(again.spent).toBe(first.spent);
  });
});
