import { describe, it, expect } from "vitest";
import { segmentSailHit, segmentMastHit, segmentBoxHit } from "../src/sim/rigDamage";

const SAIL = { planeX: 10, yMin: 8, yMax: 14, zMin: 2, zMax: 9 };

describe("rig damage geometry (round 7)", () => {
  it("a ball crossing the sail plane inside the cloth reports the crossing point", () => {
    const hit = segmentSailHit({ x: 0, y: 10, z: 5 }, { x: 20, y: 12, z: 6 }, SAIL);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(11);
    expect(hit!.z).toBeCloseTo(5.5);
  });

  it("misses outside the rectangle, even when crossing the plane", () => {
    expect(segmentSailHit({ x: 0, y: 2, z: 5 }, { x: 20, y: 3, z: 5 }, SAIL)).toBeNull(); // under the foot
    expect(segmentSailHit({ x: 0, y: 10, z: 20 }, { x: 20, y: 10, z: 21 }, SAIL)).toBeNull(); // wide of the leech
  });

  it("misses when the segment stops short of the plane or flies parallel", () => {
    expect(segmentSailHit({ x: 0, y: 10, z: 5 }, { x: 9, y: 10, z: 5 }, SAIL)).toBeNull();
    expect(segmentSailHit({ x: 12, y: 10, z: 5 }, { x: 12, y: 11, z: 6 }, SAIL)).toBeNull();
  });

  it("with a slab thickness, a BEAM-WISE ball through the canvas tears it", () => {
    // a broadside ball runs along z (parallel to the cloth) at the sail's fore-aft position, INSIDE
    // its y/z rectangle → with a 1 m slab it tears; the same shot 2 m off the plane still misses.
    const hit = segmentSailHit({ x: 10.2, y: 11, z: 0 }, { x: 10.2, y: 11, z: 10 }, SAIL, 1.0);
    expect(hit).not.toBeNull();
    expect(hit!.z).toBeGreaterThanOrEqual(SAIL.zMin);
    expect(hit!.z).toBeLessThanOrEqual(SAIL.zMax);
    expect(segmentSailHit({ x: 12, y: 11, z: 0 }, { x: 12, y: 11, z: 10 }, SAIL, 1.0)).toBeNull();
  });

  const MAST = { x: 5, z: 5, yBase: 6, yTop: 26, r: 0.3 };

  it("a ball through the trunk is a mast hit; a near miss is not", () => {
    expect(segmentMastHit({ x: 0, y: 10, z: 5 }, { x: 10, y: 10, z: 5 }, MAST)).toBe(true);
    expect(segmentMastHit({ x: 0, y: 10, z: 5.5 }, { x: 10, y: 10, z: 5.5 }, MAST)).toBe(false);
  });

  it("flying over the masthead or under the deck is not a mast hit", () => {
    expect(segmentMastHit({ x: 0, y: 30, z: 5 }, { x: 10, y: 30, z: 5 }, MAST)).toBe(false);
    expect(segmentMastHit({ x: 0, y: 2, z: 5 }, { x: 10, y: 2, z: 5 }, MAST)).toBe(false);
  });

  const RUDDER = { min: { x: -2, y: 0.5, z: 4.6 }, max: { x: 0.5, y: 4.5, z: 5.4 } };

  it("a ball raking the stern passes through the rudder box", () => {
    expect(segmentBoxHit({ x: -6, y: 2, z: 5 }, { x: 4, y: 2.5, z: 5 }, RUDDER)).toBe(true);
  });

  it("shots wide or high of the blade miss it", () => {
    expect(segmentBoxHit({ x: -6, y: 2, z: 8 }, { x: 4, y: 2, z: 8 }, RUDDER)).toBe(false);
    expect(segmentBoxHit({ x: -6, y: 6, z: 5 }, { x: 4, y: 6, z: 5 }, RUDDER)).toBe(false);
  });

  it("a segment that starts and ends inside the box still hits", () => {
    expect(segmentBoxHit({ x: -1, y: 2, z: 5 }, { x: -0.5, y: 2.2, z: 5.1 }, RUDDER)).toBe(true);
  });
});
