import { describe, it, expect } from "vitest";
import { dist, relax, integrate, kineticEnergy, stepRig, attachedToPin, type Rig, type RigNode, type AccelFn, NodeFlag, LinkKind } from "../src/sim/rigLattice";

describe("rigLattice vec helpers", () => {
  it("dist measures node separation", () => {
    const a: RigNode = { pos: { x: 0, y: 0, z: 0 }, prev: { x: 0, y: 0, z: 0 }, mass: 1, pinned: false, flags: NodeFlag.WOOD };
    const b: RigNode = { pos: { x: 3, y: 4, z: 0 }, prev: { x: 3, y: 4, z: 0 }, mass: 1, pinned: false, flags: NodeFlag.WOOD };
    expect(dist(a.pos, b.pos)).toBeCloseTo(5, 6);
  });
});

function node(x: number, y: number, z: number, pinned = false): RigNode {
  return { pos: { x, y, z }, prev: { x, y, z }, mass: 1, pinned, flags: NodeFlag.WOOD };
}

describe("rigLattice relax", () => {
  it("pulls a stretched intact link back toward its rest length", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0), node(3, 0, 0)],
      links: [{ a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true }],
      awake: true, sleepTimer: 0,
    };
    relax(rig, 1);
    expect(dist(rig.nodes[0].pos, rig.nodes[1].pos)).toBeLessThan(3);
    expect(rig.links[0].alive).toBe(true);
  });

  it("breaks (deletes) a link whose strain exceeds breakStrain", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0), node(3, 0, 0)],
      links: [{ a: 0, b: 1, rest: 1, breakStrain: 0.5, kind: LinkKind.WOOD, alive: true }],
      awake: true, sleepTimer: 0,
    };
    relax(rig, 1);
    expect(rig.links[0].alive).toBe(false);
  });

  it("a pinned node does not move; the free end does all the correcting", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0, true), node(3, 0, 0)],
      links: [{ a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true }],
      awake: true, sleepTimer: 0,
    };
    relax(rig, 1);
    expect(rig.nodes[0].pos.x).toBe(0);
    expect(rig.nodes[1].pos.x).toBeCloseTo(1, 6);
  });

  it("a slack CLOTH link applies no push (canvas does not strut)", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0), node(0.5, 0, 0)],
      links: [{ a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true }],
      awake: true, sleepTimer: 0,
    };
    relax(rig, 1);
    expect(rig.nodes[1].pos.x).toBeCloseTo(0.5, 6);
  });
});

describe("rigLattice integrate", () => {
  it("a free node under gravity falls by accel*dt^2 on the first step", () => {
    const rig: Rig = { nodes: [node(0, 10, 0)], links: [], awake: true, sleepTimer: 0 };
    const dt = 1 / 60;
    integrate(rig, () => ({ x: 0, y: -9.81, z: 0 }), dt, 1);
    expect(rig.nodes[0].pos.y).toBeCloseTo(10 - 9.81 * dt * dt, 6);
    expect(rig.nodes[0].prev.y).toBeCloseTo(10, 6);
  });

  it("a pinned node ignores acceleration", () => {
    const rig: Rig = { nodes: [node(0, 10, 0, true)], links: [], awake: true, sleepTimer: 0 };
    integrate(rig, () => ({ x: 0, y: -9.81, z: 0 }), 1 / 60, 1);
    expect(rig.nodes[0].pos.y).toBe(10);
  });
});

describe("rigLattice stepRig + sleep", () => {
  it("kineticEnergy is zero when no node has moved", () => {
    const rig: Rig = { nodes: [node(0, 0, 0)], links: [], awake: true, sleepTimer: 0 };
    expect(kineticEnergy(rig, 1 / 60)).toBeCloseTo(0, 9);
  });

  it("stepRig accumulates sleepTimer while KE stays below the threshold", () => {
    const dt = 1 / 60;
    const rig: Rig = { nodes: [node(0, 5, 0, true)], links: [], awake: true, sleepTimer: 0 };
    const opts = { dt, damp: 1, iterations: 1, accel: () => ({ x: 0, y: -9.81, z: 0 }), sleepKE: 1e-6 };
    stepRig(rig, opts);
    stepRig(rig, opts);
    expect(rig.sleepTimer).toBeCloseTo(2 * dt, 6);
  });

  it("stepRig resets sleepTimer when the rig is moving", () => {
    const dt = 1 / 60;
    const rig: Rig = { nodes: [node(0, 5, 0)], links: [], awake: true, sleepTimer: 99 };
    stepRig(rig, { dt, damp: 1, iterations: 1, accel: () => ({ x: 0, y: -9.81, z: 0 }), sleepKE: 1e-12 });
    expect(rig.sleepTimer).toBe(0);
  });
});
