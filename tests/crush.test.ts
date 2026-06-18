import { describe, it, expect } from "vitest";
import { planCrush, breakImpulse, distributeClosingDrag, splitClosingImpulse } from "../src/sim/crush";
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

describe("breakImpulse", () => {
  const CAP = 1e9; // effectively uncapped for the physics checks

  it("is zero with no energy, no closing, or no mass", () => {
    expect(breakImpulse(1000, 5, 0, CAP)).toBe(0);
    expect(breakImpulse(1000, 0, 1e5, CAP)).toBe(0);
    expect(breakImpulse(1000, -3, 1e5, CAP)).toBe(0);
    expect(breakImpulse(0, 5, 1e5, CAP)).toBe(0);
  });

  it("removes EXACTLY the broken energy from the closing KE (uncapped)", () => {
    const mu = 2000, vc = 6, energy = 9000; // < 0.5*mu*vc^2 = 36000, so not fully absorbed
    const Jimp = breakImpulse(mu, vc, energy, CAP);
    const vcAfter = vc - Jimp / mu; // caller applies J as μ·Δv
    const keLost = 0.5 * mu * (vc * vc - vcAfter * vcAfter);
    expect(keLost).toBeCloseTo(energy, 3);
    expect(vcAfter).toBeGreaterThan(0); // didn't over-shoot to a stop
  });

  it("self-limits: energy beyond the closing KE only brings them to rest, never reverses", () => {
    const mu = 2000, vc = 6;
    const Jimp = breakImpulse(mu, vc, 1e9, CAP); // way more than 0.5*mu*vc^2
    expect(Jimp).toBeCloseTo(mu * vc, 6); // exactly brings closing to zero
    expect(vc - Jimp / mu).toBeCloseTo(0, 9);
  });

  it("is monotonic in energy and respects the per-step Δv cap", () => {
    const mu = 2000, vc = 6;
    expect(breakImpulse(mu, vc, 2000, CAP)).toBeLessThan(breakImpulse(mu, vc, 8000, CAP));
    const capped = breakImpulse(mu, vc, 1e9, 1.5); // cap Δv at 1.5 m/s
    expect(capped).toBeCloseTo(mu * 1.5, 6);
  });

  it("heavier reduced mass sheds less speed for the same broken energy", () => {
    const vc = 6, energy = 9000;
    const dvLight = breakImpulse(1000, vc, energy, CAP) / 1000;
    const dvHeavy = breakImpulse(8000, vc, energy, CAP) / 8000;
    expect(dvHeavy).toBeLessThan(dvLight); // a heavy hull barely slows -> plows through
  });

  it("clamps a pathologically huge closing speed (defensive net, determinism preserved)", () => {
    // A teleport-deep degenerate overlap could feed an enormous vc; the constant 50 m/s clamp caps
    // the impulse so a corrupt step can't launch a hull. With the closing-KE fully absorbed the
    // result equals μ·min(vc,50) — a HUGE vc therefore yields the SAME bounded impulse as vc=50.
    const mu = 2000;
    const huge = breakImpulse(mu, 1e6, 1e30, CAP);
    expect(Number.isFinite(huge)).toBe(true);
    expect(huge).toBeCloseTo(mu * 50, 6);          // clamped to 50 m/s, not 1e6
    expect(huge).toBe(breakImpulse(mu, 50, 1e30, CAP)); // deterministic: vc≥50 collapses to the clamp
  });
});

describe("distributeClosingDrag", () => {
  it("a stationary victim is NOT shoved — the whole drag slows the rammer", () => {
    // A drives in at +4 m/s; B (the victim) is dead in the water. All of the closing reduction
    // comes off A; B sheds nothing. This is the core fix: B never picks up the rammer's velocity.
    const { dvA, dvB } = distributeClosingDrag(4, 0, 3);
    expect(dvA).toBeCloseTo(3, 9);
    expect(dvB).toBe(0);
  });

  it("a head-on (equal & opposite) closing splits the drag evenly", () => {
    const { dvA, dvB } = distributeClosingDrag(5, -5, 4);
    expect(dvA).toBeCloseTo(2, 9);
    expect(dvB).toBeCloseTo(2, 9);
  });

  it("slows the one CATCHING UP from behind, not the one fleeing ahead", () => {
    // both move in +d̂; B (sB more negative along d̂... here both negative) chases A. Concretely both
    // drift in −d̂ but B faster, so B is the aggressor closing the gap → B sheds the drag, A (fleeing) none.
    const { dvA, dvB } = distributeClosingDrag(-1, -3, 2);
    expect(dvA).toBe(0);
    expect(dvB).toBeCloseTo(2, 9);
  });

  it("the shed speeds always sum to the closing reduction when something is approaching", () => {
    const { dvA, dvB } = distributeClosingDrag(3, -1, 5);
    expect(dvA + dvB).toBeCloseTo(5, 9);
    expect(dvA).toBeGreaterThan(dvB); // A drives in faster (3) than B (1) → A sheds more
  });

  it("does nothing when there is no closing reduction or nothing is driving in", () => {
    expect(distributeClosingDrag(4, 0, 0)).toEqual({ dvA: 0, dvB: 0 });   // no energy removed
    expect(distributeClosingDrag(4, 0, -2)).toEqual({ dvA: 0, dvB: 0 });  // negative guard
    expect(distributeClosingDrag(-2, 2, 5)).toEqual({ dvA: 0, dvB: 0 });  // both separating
  });
});

describe("splitClosingImpulse", () => {
  // heavy A (mA) rams a stationary light B (mB); d̂ points A->B, so sA>0, sB=0.
  const mA = 6, mB = 2, mu = (mA * mB) / (mA + mB), dvClose = 4;

  it("transferFrac 0 = pure aggressor drag: the victim gets ZERO impulse", () => {
    const { jA, jB } = splitClosingImpulse(mA, mB, mu, 3, 0, dvClose, 0);
    expect(jB).toBe(0);                 // stationary victim not shoved at all (round-3 behaviour)
    expect(jA).toBeCloseTo(mA * dvClose, 9); // all of the closing reduction comes off A
  });

  it("transferFrac 1 = pure equal-and-opposite: both get μ·dvClose (the old steal)", () => {
    const { jA, jB } = splitClosingImpulse(mA, mB, mu, 3, 0, dvClose, 1);
    expect(jA).toBeCloseTo(mu * dvClose, 9);
    expect(jB).toBeCloseTo(mu * dvClose, 9);
    // and that drives B to the common-velocity gain mA/(mA+mB)·dvClose
    expect(jB / mB).toBeCloseTo((mA / (mA + mB)) * dvClose, 9);
  });

  it("a higher transferFrac always hands the struck hull more speed", () => {
    const lo = splitClosingImpulse(mA, mB, mu, 3, 0, dvClose, 0.2);
    const hi = splitClosingImpulse(mA, mB, mu, 3, 0, dvClose, 0.6);
    expect(hi.jB).toBeGreaterThan(lo.jB);
  });

  it("is zero with no closing reduction", () => {
    expect(splitClosingImpulse(mA, mB, mu, 3, 0, 0, 0.5)).toEqual({ jA: 0, jB: 0 });
  });
});
