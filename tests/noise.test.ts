import { describe, it, expect } from "vitest";
import { fbm2 } from "../src/sim/noise";

describe("fbm2 value noise", () => {
  it("is deterministic for a given seed", () => {
    expect(fbm2(123, 4.2, -1.7)).toBe(fbm2(123, 4.2, -1.7));
  });
  it("differs across seeds and across space", () => {
    expect(fbm2(1, 0.5, 0.5)).not.toBe(fbm2(2, 0.5, 0.5));
    expect(fbm2(1, 0.5, 0.5)).not.toBe(fbm2(1, 9.5, 3.5));
  });
  it("stays within [0,1]", () => {
    for (let i = 0; i < 200; i++) {
      const v = fbm2(7, i * 0.37, i * -0.21);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
