import { describe, it, expect } from "vitest";
import { Rng } from "../src/core/rng";

describe("Rng", () => {
  it("same seed → same sequence", () => {
    const a = new Rng("voyage-1");
    const b = new Rng("voyage-1");
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it("different seeds diverge", () => {
    expect(new Rng("a").next()).not.toBe(new Rng("b").next());
  });

  it("range respects bounds", () => {
    const r = new Rng("x");
    for (let i = 0; i < 1000; i++) {
      const v = r.range(2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThan(5);
    }
  });

  it("int respects bounds and returns integers", () => {
    const r = new Rng("y");
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 7);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(7);
    }
  });

  it("pick returns elements of the array", () => {
    const r = new Rng("z");
    const arr = ["a", "b", "c"];
    for (let i = 0; i < 50; i++) expect(arr).toContain(r.pick(arr));
  });
});
