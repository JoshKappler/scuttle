import { describe, it, expect } from "vitest";
import { buildRig, type RigSpec } from "../src/sim/rigBuild";
import { NodeFlag, LinkKind, attachedToPin } from "../src/sim/rigLattice";

const oneMast: RigSpec = {
  voxelSize: 0.25,
  deckTopY: () => 2.0,
  masts: [{ x: 10, z: 4, h: 15 }],
};

describe("buildRig yards", () => {
  it("adds three yards (5 nodes each) per mast, spanning the beam", () => {
    const rig = buildRig(oneMast);
    const trunkCount = Math.round(15 / 2) + 1;
    const woodNodes = rig.nodes.filter((n) => n.flags & NodeFlag.WOOD).length;
    expect(woodNodes).toBe(trunkCount + 15);
  });

  it("each yard center is laced to the trunk by a wood link", () => {
    const rig = buildRig(oneMast);
    const trunkCount = Math.round(15 / 2) + 1;
    const woodLinks = rig.links.filter((l) => l.kind === LinkKind.WOOD).length;
    // trunk: count-1; each yard: 4 span + 1 sling = 5; *3 yards = 15
    expect(woodLinks).toBe(trunkCount - 1 + 15);
  });
});

describe("buildRig cloth + bowsprit", () => {
  it("adds 8x6 cloth nodes per sail (2 sails per mast)", () => {
    const rig = buildRig(oneMast);
    const cloth = rig.nodes.filter((n) => n.flags & NodeFlag.CLOTH).length;
    expect(cloth).toBe(2 * 8 * 6);
  });

  it("every cloth node is initially attached to the ship via the yards", () => {
    const rig = buildRig(oneMast);
    const att = attachedToPin(rig);
    rig.nodes.forEach((n, i) => {
      if (n.flags & NodeFlag.CLOTH) expect(att[i]).toBe(true);
    });
  });

  it("a bowsprit becomes a wood chain whose heel is pinned (FOOT)", () => {
    const rig = buildRig({
      ...oneMast,
      bowsprit: { heel: { x: 8, y: 3, z: 1 }, tip: { x: 12, y: 4, z: 1 } },
    });
    const feet = rig.nodes.filter((n) => n.pinned && n.flags & NodeFlag.FOOT);
    expect(feet.length).toBe(2); // mast foot + bowsprit heel
    expect(feet.some((n) => Math.abs(n.pos.x - 8) < 1e-6 && Math.abs(n.pos.y - 3) < 1e-6)).toBe(true);
  });
});

describe("buildRig trunk", () => {
  it("builds a trunk whose foot is the single pinned, FOOT-flagged node", () => {
    const rig = buildRig(oneMast);
    const pinned = rig.nodes.filter((n) => n.pinned);
    expect(pinned.length).toBe(1);
    expect(pinned[0].flags & NodeFlag.FOOT).toBeTruthy();
    expect(pinned[0].flags & NodeFlag.WOOD).toBeTruthy();
  });

  it("foot sits on the deck top at the mast's world x/z", () => {
    const rig = buildRig(oneMast);
    const foot = rig.nodes.find((n) => n.pinned)!;
    expect(foot.pos.x).toBeCloseTo((10 + 0.5) * 0.25, 6);
    expect(foot.pos.z).toBeCloseTo((4 + 0.5) * 0.25, 6);
    expect(foot.pos.y).toBeCloseTo(2.0, 6);
  });

  it("trunk reaches the masthead height (deckTop + h)", () => {
    const rig = buildRig(oneMast);
    const topY = Math.max(...rig.nodes.map((n) => n.pos.y));
    expect(topY).toBeCloseTo(2.0 + 15, 4);
  });
});

describe("buildRig detach (the tear/topple pipeline)", () => {
  it("severing the foot's links cuts the whole rig loose from its only anchor", () => {
    const rig = buildRig(oneMast); // single pin = the mast foot
    const footIdx = rig.nodes.findIndex((n) => n.pinned);
    for (const lk of rig.links) {
      if (lk.a === footIdx || lk.b === footIdx) lk.alive = false;
    }
    const att = attachedToPin(rig);
    // only the foot itself stays attached; the whole rig above it is now loose
    expect(att.filter(Boolean).length).toBe(1);
    expect(att[footIdx]).toBe(true);
    // every cloth node is detached → would fall / blow away
    rig.nodes.forEach((n, i) => {
      if (n.flags & NodeFlag.CLOTH) expect(att[i]).toBe(false);
    });
  });
});
