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
  PINE,
  IRON,
  RAM,
  breakEnergy,
  STRENGTH_TO_JOULES,
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

describe("material break energy", () => {
  it("scales with strength", () => {
    expect(breakEnergy(PINE)).toBe(MATERIALS[PINE].strength * STRENGTH_TO_JOULES);
    expect(breakEnergy(IRON)).toBeGreaterThan(breakEnergy(OAK));
  });
  it("ram bow is reinforced oak — only modestly tougher than the hull it strikes (~50%), NOT armor plate", () => {
    // a bow-first ram is modestly favoured (RAM > OAK) but the prow still chips; it is NOT the
    // toughest material on the ship (iron ballast is) — that made it punch through victims without
    // taking damage (playtest: "front of boat strength enhancements are too much").
    expect(MATERIALS[RAM].strength).toBeGreaterThan(MATERIALS[OAK].strength);
    expect(MATERIALS[RAM].strength).toBeLessThan(MATERIALS[IRON].strength);
    expect(MATERIALS[RAM].strength / MATERIALS[OAK].strength).toBeCloseTo(1.5, 1); // ~50% tougher
  });
  it("empty / unknown material costs nothing to break", () => {
    expect(breakEnergy(0)).toBe(0);
  });
});
