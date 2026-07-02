import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { classifyBearing, gunBears, integrateAimArc, ARC_PTS } from "../src/render/aimUI";

describe("classifyBearing", () => {
  it("keel-dominant look lays the chasers", () => {
    expect(classifyBearing(1, 0.5)).toBe("fore");
    expect(classifyBearing(-1, 0.5)).toBe("aft");
  });
  it("beam-dominant look lays that broadside", () => {
    expect(classifyBearing(0.3, 1)).toBe(1);
    expect(classifyBearing(0.3, -1)).toBe(-1);
  });
  it("an exact tie goes to the broadside (strict > on |x|)", () => {
    expect(classifyBearing(1, 1)).toBe(1);
  });
});

describe("gunBears", () => {
  it("broadside guns bear only for their numeric side, chasers never do", () => {
    expect(gunBears({ side: 1 }, 1)).toBe(true);
    expect(gunBears({ side: 1 }, -1)).toBe(false);
    expect(gunBears({ side: 1, facing: "fore" }, 1)).toBe(false);
  });
  it("chasers bear only for their facing", () => {
    expect(gunBears({ side: 1, facing: "fore" }, "fore")).toBe(true);
    expect(gunBears({ side: 1, facing: "aft" }, "fore")).toBe(false);
    expect(gunBears({ side: 1 }, "fore")).toBe(false);
  });
});

describe("integrateAimArc", () => {
  const abyss = () => -1e9; // sea far below → the full arc always fits
  it("writes the muzzle as vertex 0 and fills all ARC_PTS vertices", () => {
    const out = new Float32Array(ARC_PTS * 3);
    integrateAimArc(out, new THREE.Vector3(2, 5, 3), new THREE.Vector3(1, 0, 0), 150, 0.0025, abyss);
    expect([out[0], out[1], out[2]]).toEqual([2, 5, 3]);
    expect(out[(ARC_PTS - 1) * 3]).toBeGreaterThan(2); // downrange
  });
  it("drag shortens range vs the drag-free arc", () => {
    const noDrag = new Float32Array(ARC_PTS * 3);
    const dragged = new Float32Array(ARC_PTS * 3);
    const dir = new THREE.Vector3(1, 0.2, 0).normalize();
    integrateAimArc(noDrag, new THREE.Vector3(0, 10, 0), dir, 150, 0, abyss);
    integrateAimArc(dragged, new THREE.Vector3(0, 10, 0), dir.clone(), 150, 0.0025, abyss);
    expect(dragged[(ARC_PTS - 1) * 3]).toBeLessThan(noDrag[(ARC_PTS - 1) * 3]);
  });
  it("clamps the tail to the splash point once the arc meets the sea", () => {
    const out = new Float32Array(ARC_PTS * 3);
    integrateAimArc(out, new THREE.Vector3(0, 2, 0), new THREE.Vector3(1, 0, 0), 150, 0.0025, () => 0);
    expect(out[(ARC_PTS - 2) * 3]).toBe(out[(ARC_PTS - 1) * 3]); // repeated splash vertex
    expect(out[(ARC_PTS - 1) * 3 + 1]).toBeLessThanOrEqual(0);
  });
});
