import { describe, it, expect } from "vitest";
import { SeverDebounce, SEVER_QUIET, SEVER_MAX_STALE } from "../src/game/ship";

// The full-grid connectivity sever scan (findSevered, ~3 ms) is debounced so it runs once carving
// PAUSES (or a max-stale backstop during a long grind), not on every carve. The bug it had: the
// evaluation was gated behind the consumable `damageDirty`/10 Hz flush, so a SHORT ram consumed that
// flag before the quiet window opened, and the scan then never ran — leaving disconnected / corner-only
// voxels "levitating" forever. SeverDebounce is the extracted pure decision: feed it a per-step record
// of (did we carve this step?) and it reports when the heavy scan is due. It must ALWAYS fire within a
// bounded number of steps after the last carve, regardless of the 10 Hz mass-recompute cadence.

/** Drive the debounce over a script of booleans (carved? per step) and return the step indices
 *  (0-based, relative to script start) on which the heavy scan fired. */
function run(script: boolean[]): number[] {
  const d = new SeverDebounce();
  const fired: number[] = [];
  for (let i = 0; i < script.length; i++) {
    if (script[i]) d.markCarved();
    if (d.due()) fired.push(i);
  }
  return fired;
}

describe("SeverDebounce", () => {
  it("does not fire while no carving has happened", () => {
    expect(run(Array(50).fill(false))).toEqual([]);
  });

  it("fires SEVER_QUIET steps after a SHORT ram ends (the levitation-persistence bug)", () => {
    // a 10-step ram, then 30 quiet steps. The scan MUST fire — and within SEVER_QUIET of the last carve.
    const script = [...Array(10).fill(true), ...Array(30).fill(false)];
    const fired = run(script);
    expect(fired.length).toBeGreaterThan(0);                 // it fires at all (the bug: it never did)
    const first = fired[0];
    expect(first).toBeGreaterThanOrEqual(10);                // not while still carving
    expect(first).toBeLessThanOrEqual(10 + SEVER_QUIET);     // within the quiet window after the last carve
  });

  it("does not fire DURING a sustained ram until the max-stale backstop", () => {
    // carve every step for longer than SEVER_MAX_STALE: the quiet window never opens, so the only fire
    // is the backstop at SEVER_MAX_STALE.
    const script = Array(SEVER_MAX_STALE + 20).fill(true);
    const fired = run(script);
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0]).toBe(SEVER_MAX_STALE - 1); // backstop fires by ~3 s even mid-grind
  });

  it("re-arms after firing: a second ram triggers a second scan", () => {
    const script = [
      ...Array(5).fill(true),  ...Array(SEVER_QUIET + 2).fill(false), // ram 1 → fires
      ...Array(5).fill(true),  ...Array(SEVER_QUIET + 2).fill(false), // ram 2 → fires again
    ];
    const fired = run(script);
    expect(fired.length).toBe(2);
  });

  it("only fires once per quiet period (not every quiet step)", () => {
    const script = [...Array(3).fill(true), ...Array(60).fill(false)];
    const fired = run(script);
    expect(fired.length).toBe(1); // one scan when carving paused, not 50
  });
});
