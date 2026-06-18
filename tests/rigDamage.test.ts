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

  it("BUG-5 regression: a ball passing ENTIRELY fore/aft of the slab is NOT a hit", () => {
    // With a slab, the entry parameter must be a real interval-overlap test, not a clamped endpoint.
    // These two segments fly in the sail's y/z window but never reach the fore-aft slab [9.5,10.5]:
    // the OLD code clamped the entry t into [0,1] and evaluated at the clamped endpoint, reporting a
    // phantom hit (one MISS then stamped dozens of sail holes). They must return null.
    // entirely FORE of the slab (segment ends at x=8, slab starts at 9.5):
    expect(segmentSailHit({ x: 0, y: 11, z: 5 }, { x: 8, y: 11, z: 5 }, SAIL, 1.0)).toBeNull();
    // entirely AFT of the slab (segment starts at x=12, slab ends at 10.5):
    expect(segmentSailHit({ x: 12, y: 11, z: 5 }, { x: 20, y: 11, z: 5 }, SAIL, 1.0)).toBeNull();
  });

  it("grazing edge-case: a beam-wise segment in the slab but never inside the rectangle is NOT a hit", () => {
    // A long oblique per-frame ball segment runs PARALLEL to the cloth plane (x≈const, inside the
    // 1 m slab) but its y/z sweep skims ALONG the rectangle's edge and never actually enters it.
    // The old t∈{0,0.5,1} sampling could false-positive ("holes with no hit"); the exact y/z
    // interval test must return null.
    // travels the full z-span at y=7.4 — below the foot (yMin 8) the whole way → no rectangle entry.
    expect(segmentSailHit({ x: 10.1, y: 7.4, z: 0 }, { x: 10.1, y: 7.4, z: 12 }, SAIL, 1.0)).toBeNull();
    // a diagonal sweep that crosses the y band and the z band but in DISJOINT parameter windows:
    // z falls out the bottom of [zMin,zMax] (band t∈[0,0.167]) well before y rises into [yMin,yMax]
    // (band t∈[0.5,1]) → the segment is never inside BOTH at once, so no rectangle entry.
    expect(segmentSailHit({ x: 10.1, y: 7, z: 4 }, { x: 10.1, y: 9, z: -8 }, SAIL, 1.0)).toBeNull();
  });

  it("grazing edge-case: a beam-wise segment that DOES cross the rectangle still tears it", () => {
    // a diagonal beam-wise sweep whose y AND z ranges overlap inside the rectangle at the same t.
    const hit = segmentSailHit({ x: 10.1, y: 7, z: 1 }, { x: 10.1, y: 13, z: 8 }, SAIL, 1.0);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeGreaterThanOrEqual(SAIL.yMin);
    expect(hit!.y).toBeLessThanOrEqual(SAIL.yMax);
    expect(hit!.z).toBeGreaterThanOrEqual(SAIL.zMin);
    expect(hit!.z).toBeLessThanOrEqual(SAIL.zMax);
  });

  it("a clean fore-aft ball still punches a hole through the cloth", () => {
    // regression guard: the grazing fix must NOT weaken the legitimate perpendicular pierce.
    const hit = segmentSailHit({ x: 0, y: 11, z: 5.5 }, { x: 20, y: 11, z: 5.5 }, SAIL, 0.25);
    expect(hit).not.toBeNull();
    expect(hit!.y).toBeCloseTo(11);
    expect(hit!.z).toBeCloseTo(5.5);
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
