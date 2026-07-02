import { describe, it, expect } from "vitest";
import { buildCutter } from "../src/sim/shipwright";
import { SPAR, CANVAS, EMPTY } from "../src/sim/materials";
import { mastFootingCells } from "../src/sim/mastSupport";
import { planRigRepair } from "../src/game/ship";

// ROUND-12 (SP1 wave-2 half): port repair must be able to re-step a FELLED mast — re-stamp its
// SPAR trunk + CANVAS sails from the build lists — not only regrow standing masts. The pure
// planner is unit-tested here; Ship.repairSails composes it with the collider/surface/mass
// bookkeeping (no Rapier in tests — verified in-browser at wave hand-off).
function fresh() {
  const build = buildCutter();
  const mastCells = build.mastVoxels.map((c) => c.slice());
  const sailCells = build.sailVoxels.map((c) => c.slice());
  const footInit = build.masts.map((m) => mastFootingCells(build.grid, m.x, build.deckYAt(m.x)));
  return { build, mastCells, sailCells, footInit };
}

describe("planRigRepair (pure port sail-repair planner)", () => {
  it("healthy rig → empty plan (nothing to restore)", () => {
    const { build, mastCells, sailCells, footInit } = fresh();
    expect(planRigRepair(build, mastCells, sailCells, [true], footInit)).toHaveLength(0);
  });

  it("standing mast: restores EXACTLY the shot-out cells with the right materials", () => {
    const { build, mastCells, sailCells, footInit } = fresh();
    const holedTrunk = mastCells[0].slice(4, 7);
    const holedSail = sailCells[0].slice(0, 5);
    for (const c of [...holedTrunk, ...holedSail]) build.grid.remove(c.x, c.y, c.z);
    const plan = planRigRepair(build, mastCells, sailCells, [true], footInit);
    expect(plan).toHaveLength(1);
    expect(plan[0].mi).toBe(0);
    expect(plan[0].cells).toHaveLength(holedTrunk.length + holedSail.length);
    for (const c of plan[0].cells) {
      expect(build.grid.get(c.x, c.y, c.z)).toBe(EMPTY);
      expect([SPAR, CANVAS]).toContain(c.mat);
    }
    expect(plan[0].cells.filter((c) => c.mat === SPAR)).toHaveLength(holedTrunk.length);
    expect(plan[0].cells.filter((c) => c.mat === CANVAS)).toHaveLength(holedSail.length);
  });

  it("FELLED mast with its step intact: restores the ENTIRE trunk + canvas", () => {
    const { build, mastCells, sailCells, footInit } = fresh();
    for (const c of [...mastCells[0], ...sailCells[0]]) build.grid.remove(c.x, c.y, c.z);
    const plan = planRigRepair(build, mastCells, sailCells, [false], footInit);
    expect(plan).toHaveLength(1);
    expect(plan[0].cells).toHaveLength(mastCells[0].length + sailCells[0].length);
  });

  it("FELLED mast whose footing hull is destroyed is NOT re-stepped (mirrors flushDamage's rule)", () => {
    const { build, mastCells, sailCells } = fresh();
    for (const c of [...mastCells[0], ...sailCells[0]]) build.grid.remove(c.x, c.y, c.z);
    // an absurdly large build-time footing denominator → live fraction ≈ 0 < MAST_SUPPORT_MIN_FRAC
    const plan = planRigRepair(build, mastCells, sailCells, [false], [Number.MAX_SAFE_INTEGER]);
    expect(plan).toHaveLength(0);
  });
});
