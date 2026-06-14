import { describe, it, expect } from "vitest";
import {
  MATERIALS,
  SAND,
  ROCK,
  DARKROCK,
  GRASS,
  DIRT,
  PALMWOOD,
  FOLIAGE,
  OAK,
} from "../src/sim/materials";

describe("terrain materials", () => {
  it("defines the seven tropical terrain materials with valid colors", () => {
    for (const id of [SAND, ROCK, DARKROCK, GRASS, DIRT, PALMWOOD, FOLIAGE]) {
      const m = MATERIALS[id];
      expect(m, `material ${id}`).toBeDefined();
      expect(m.color).toHaveLength(3);
      for (const c of m.color) expect(c).toBeGreaterThanOrEqual(0);
      expect(m.density).toBeGreaterThan(0);
    }
  });
  it("leaves the ship materials untouched", () => {
    expect(MATERIALS[OAK].name).toBe("oak");
    expect(MATERIALS[OAK].density).toBe(430);
  });
  it("keeps every material id within Int8 range", () => {
    for (const k of Object.keys(MATERIALS)) expect(Number(k)).toBeLessThanOrEqual(127);
  });
});
