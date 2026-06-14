import { describe, it, expect } from "vitest";
import { planCrush } from "../src/sim/crush";
import { STRENGTH_TO_JOULES } from "../src/sim/materials";

const J = STRENGTH_TO_JOULES;
// candidate cells with toughness (strength) per cell
const cells = [
  { x: 0, y: 0, z: 0, strength: 3 }, // oak  -> 3J
  { x: 1, y: 0, z: 0, strength: 2 }, // pine -> 2J
  { x: 2, y: 0, z: 0, strength: 8 }, // iron -> 8J
];
const tough = (c: { strength: number }) => c.strength * J;

describe("planCrush", () => {
  it("removes cheapest-first until the budget can't afford the next", () => {
    // budget = 2+3 = 5 strength-units of J -> removes pine(2) then oak(3); iron(8) unaffordable
    const r = planCrush(cells, tough, 5 * J);
    expect(r.removed.map((c) => c.strength).sort()).toEqual([2, 3]);
    expect(r.leftover).toBe(0);
  });

  it("returns leftover energy when budget exceeds total cost", () => {
    const r = planCrush(cells, tough, 100 * J);
    expect(r.removed).toHaveLength(3);
    expect(r.leftover).toBe((100 - 13) * J);
  });

  it("removes nothing on a budget below the cheapest cell", () => {
    const r = planCrush(cells, tough, 1 * J);
    expect(r.removed).toHaveLength(0);
    expect(r.leftover).toBe(1 * J);
  });

  it("an iron belt stops a budget that would otherwise reach past it", () => {
    // a bore-ray candidate: two oak then an iron belt then more oak behind it.
    // a budget that can afford the two oak but not the iron must stop at the belt,
    // proving emergent penetration depth (Task 2 cannonball lodge-vs-through).
    const path = [
      { x: 0, y: 0, z: 0, strength: 3 }, // oak
      { x: 0, y: 0, z: 1, strength: 3 }, // oak
      { x: 0, y: 0, z: 2, strength: 8 }, // iron belt
      { x: 0, y: 0, z: 3, strength: 3 }, // oak behind the belt
    ];
    const r = planCrush(path, tough, 7 * J); // affords 3+3=6, not the iron(8)
    expect(r.removed).toHaveLength(2);
    expect(r.removed.every((c) => c.strength === 3)).toBe(true);
    expect(r.leftover).toBe(1 * J);
  });
});
