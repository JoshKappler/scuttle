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
  SPAR,
  CANVAS,
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

describe("CANVAS material (voxel sail cloth)", () => {
  it("exists, is near-massless and tears far more easily than wood", () => {
    const canvas = MATERIALS[CANVAS];
    expect(canvas).toBeDefined();
    // a ~1 mm cloth sheet inside a 0.25 m voxel is nearly weightless vs spar (120) / oak (430)
    expect(canvas.density).toBeLessThan(20);
    expect(canvas.density).toBeGreaterThan(0);
    // far softer than oak (3) and spar (1.5): a ball punches straight through
    expect(breakEnergy(CANVAS)).toBeLessThan(breakEnergy(SPAR));
    expect(MATERIALS[CANVAS].strength).toBeLessThan(MATERIALS[OAK].strength);
    // a light, distinct off-white colour (lighter than spar brown)
    const [r, g, b] = canvas.color;
    expect(r + g + b).toBeGreaterThan(MATERIALS[SPAR].color.reduce((a, c) => a + c, 0));
  });
});
