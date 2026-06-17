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
