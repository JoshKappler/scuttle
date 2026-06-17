import { describe, it, expect } from "vitest";
import {
  dist, relax, integrate, kineticEnergy, stepRig, attachedToPin,
  components, freezeChunk, integrateChunk, applyChunk,
  type Rig, type RigNode, type Vec3, NodeFlag, LinkKind,
} from "../src/sim/rigLattice";

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
    // equal-mass free pair: one pass closes a distance constraint EXACTLY to rest
    expect(dist(rig.nodes[0].pos, rig.nodes[1].pos)).toBeCloseTo(1, 6);
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

describe("rigLattice attachedToPin", () => {
  it("all nodes reachable from a pinned anchor over alive links are attached", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0, true), node(1, 0, 0), node(2, 0, 0), node(3, 0, 0)],
      links: [
        { a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
        { a: 1, b: 2, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
        { a: 2, b: 3, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
      ],
      awake: true, sleepTimer: 0,
    };
    expect(attachedToPin(rig)).toEqual([true, true, true, true]);
  });

  it("a severed link cuts the far nodes loose (detached strip)", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0, true), node(1, 0, 0), node(2, 0, 0), node(3, 0, 0)],
      links: [
        { a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
        { a: 1, b: 2, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: false },
        { a: 2, b: 3, rest: 1, breakStrain: 10, kind: LinkKind.CLOTH, alive: true },
      ],
      awake: true, sleepTimer: 0,
    };
    expect(attachedToPin(rig)).toEqual([true, true, false, false]);
  });
});

describe("rigLattice components (mid-mast break split)", () => {
  it("a single intact chain is one component", () => {
    const rig: Rig = {
      nodes: [node(0, 0, 0), node(0, 1, 0), node(0, 2, 0), node(0, 3, 0)],
      links: [
        { a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true },
        { a: 1, b: 2, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true },
        { a: 2, b: 3, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true },
      ],
      awake: true, sleepTimer: 0,
    };
    const { comp, count } = components(rig);
    expect(count).toBe(1);
    expect(comp).toEqual([0, 0, 0, 0]);
  });

  it("breaking the trunk MID-way splits into a foot stub + a detached top", () => {
    // a 4-node vertical trunk; break the middle link (between node 1 and node 2)
    const rig: Rig = {
      nodes: [node(0, 0, 0, true), node(0, 1, 0), node(0, 2, 0), node(0, 3, 0)],
      links: [
        { a: 0, b: 1, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true },
        { a: 1, b: 2, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: false }, // broken at the hit
        { a: 2, b: 3, rest: 1, breakStrain: 10, kind: LinkKind.WOOD, alive: true },
      ],
      awake: true, sleepTimer: 0,
    };
    const { comp, count } = components(rig);
    expect(count).toBe(2);
    // foot stub (0,1) is one component; detached top (2,3) is the other
    expect(comp[0]).toBe(comp[1]);
    expect(comp[2]).toBe(comp[3]);
    expect(comp[0]).not.toBe(comp[2]);
  });
});

describe("rigLattice rigid chunk (felled mast holds its shape — no noodle)", () => {
  // a 6-node trunk chunk: integrate it as a rigid body and check the pairwise
  // inter-node distances NEVER drift — that is what "stiff, not floppy" means.
  function trunkRig(): { rig: Rig; idx: number[] } {
    const nodes: RigNode[] = [];
    for (let i = 0; i < 6; i++) nodes.push(node(0, i * 2, 0));
    const links = [];
    for (let i = 0; i + 1 < 6; i++) links.push({ a: i, b: i + 1, rest: 2, breakStrain: 10, kind: LinkKind.WOOD, alive: true });
    return { rig: { nodes, links, awake: true, sleepTimer: 0 }, idx: [0, 1, 2, 3, 4, 5] };
  }

  it("inter-node distances stay constant across 600 steps under gravity + topple (rigid, no NaN)", () => {
    const { rig, idx } = trunkRig();
    // rest distances BEFORE motion (the shape we must preserve)
    const rest: number[][] = [];
    for (let i = 0; i < idx.length; i++) {
      rest[i] = [];
      for (let j = 0; j < idx.length; j++) rest[i][j] = dist(rig.nodes[idx[i]].pos, rig.nodes[idx[j]].pos);
    }
    const vel: Vec3 = { x: 0, y: 0, z: 1.5 };
    const omega: Vec3 = { x: 0.6, y: 0, z: 0 }; // a topple roll
    const c = freezeChunk(rig, idx, vel, omega);
    const dt = 1 / 60;
    const gravity = () => ({ x: 0, y: -9.81, z: 0 });
    let maxDrift = 0;
    for (let step = 0; step < 600; step++) {
      integrateChunk(rig, c, gravity, dt, 1, 1);
      applyChunk(rig, c, dt);
      for (let i = 0; i < idx.length; i++) {
        for (let j = i + 1; j < idx.length; j++) {
          const d = dist(rig.nodes[idx[i]].pos, rig.nodes[idx[j]].pos);
          expect(Number.isFinite(d)).toBe(true);
          maxDrift = Math.max(maxDrift, Math.abs(d - rest[i][j]));
        }
      }
    }
    // rigid: distances are preserved to floating-point tolerance — the antithesis of a noodle.
    expect(maxDrift).toBeLessThan(1e-6);
  });

  it("a freely-falling chunk's centroid follows projectile motion (½gt²)", () => {
    const { rig, idx } = trunkRig();
    const c = freezeChunk(rig, idx, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const y0 = c.pos.y;
    const dt = 1 / 60;
    const N = 120;
    for (let s = 0; s < N; s++) { integrateChunk(rig, c, () => ({ x: 0, y: -9.81, z: 0 }), dt, 1, 1); applyChunk(rig, c, dt); }
    const t = N * dt;
    // semi-implicit Euler drops slightly faster than the closed form; within a few % is plenty.
    const expected = y0 - 0.5 * 9.81 * t * t;
    expect(c.pos.y).toBeLessThan(y0);
    expect(Math.abs(c.pos.y - expected) / Math.abs(y0 - expected)).toBeLessThan(0.05);
  });

  it("a spinning chunk conserves its node fan-out (rotation does not stretch it)", () => {
    const { rig, idx } = trunkRig();
    const span0 = dist(rig.nodes[idx[0]].pos, rig.nodes[idx[5]].pos);
    const c = freezeChunk(rig, idx, { x: 0, y: 0, z: 0 }, { x: 2.0, y: 1.0, z: 0.5 });
    const dt = 1 / 60;
    for (let s = 0; s < 300; s++) { integrateChunk(rig, c, () => ({ x: 0, y: 0, z: 0 }), dt, 1, 1); applyChunk(rig, c, dt); }
    expect(dist(rig.nodes[idx[0]].pos, rig.nodes[idx[5]].pos)).toBeCloseTo(span0, 6);
  });
});
