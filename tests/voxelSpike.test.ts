// @ts-nocheck -- throwaway spike (removed in Task 10); not part of the typed build.
// THROWAWAY (plan Task 0). Gated behind RUN_SPIKE=1 so it never runs in the
// normal suite. Run: RUN_SPIKE=1 npx vitest run tests/voxelSpike.test.ts
// Writes spike-result.json (vitest swallows console.log from passing tests).
// Removed in Task 10.
import { writeFileSync } from "node:fs";
import { it, expect } from "vitest";
import { runVoxelSpike } from "../src/dev/voxelSpike";

it.runIf(process.env.RUN_SPIKE === "1")(
  "voxel-collider perf gate: two hulls grinding + carving",
  async () => {
    const r = await runVoxelSpike();
    writeFileSync("spike-result.json", JSON.stringify(r, null, 2));
    expect(r.verdict).not.toBe("CRASH");
  },
  120000,
);
