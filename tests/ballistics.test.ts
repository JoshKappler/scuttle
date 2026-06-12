import { describe, it, expect } from "vitest";
import { simulateShot, sphereCells } from "../src/sim/ballistics";
import { G } from "../src/core/constants";

describe("ballistics", () => {
  it("45° launch on flat earth lands at ~v²/g (no drag)", () => {
    const v = 40;
    const { range } = simulateShot({ speed: v, elevationDeg: 45, drag: 0 });
    expect(range).toBeCloseTo((v * v) / G, 0);
  });

  it("drag shortens range", () => {
    const a = simulateShot({ speed: 40, elevationDeg: 45, drag: 0 });
    const b = simulateShot({ speed: 40, elevationDeg: 45, drag: 0.02 });
    expect(b.range).toBeLessThan(a.range);
  });

  it("higher elevation (past 45°) flies longer but not farther", () => {
    const a = simulateShot({ speed: 40, elevationDeg: 45, drag: 0 });
    const b = simulateShot({ speed: 40, elevationDeg: 70, drag: 0 });
    expect(b.flightTime).toBeGreaterThan(a.flightTime);
    expect(b.range).toBeLessThan(a.range);
  });

  it("sphereCells returns exactly the cells within radius", () => {
    const cells = sphereCells([10, 10, 10], 1.9);
    const has = (x: number, y: number, z: number) =>
      cells.some((c) => c[0] === x && c[1] === y && c[2] === z);
    expect(has(10, 10, 10)).toBe(true);
    expect(has(11, 10, 10)).toBe(true); // d = 1
    expect(has(10, 9, 10)).toBe(true); // d = 1
    expect(has(11, 11, 10)).toBe(true); // d = √2 ≈ 1.41
    expect(has(11, 11, 11)).toBe(true); // d = √3 ≈ 1.73
    expect(has(12, 10, 10)).toBe(false); // d = 2 > 1.9
    expect(has(12, 11, 10)).toBe(false); // d = √5 ≈ 2.24
  });
});
