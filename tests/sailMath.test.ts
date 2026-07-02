import { describe, it, expect } from "vitest";
import {
  splitSheets,
  sheetBounds,
  buildOccupancy,
  billowFactor,
  sheetTouchesChunk,
  OCC_ALIVE,
  OCC_DEAD,
  OCC_NEVER,
  type RigCell,
} from "../src/render/sailMath";
import { buildCutter } from "../src/sim/shipwright";
import { CANVAS } from "../src/sim/materials";
import { CHUNK_SIZE } from "../src/core/constants";

/**
 * Pure sheet-derivation helpers for the round-12 cloth sails (render/sailVisual.ts).
 * The voxel truth is unchanged (sim/shipwright stampRig lays 1-thin CANVAS sheets in the
 * mast x-plane between yard levels); these helpers derive the render sheets from
 * build.sailVoxels[mi] + the LIVE grid, so the cloth mesh always matches the sim.
 */

const cell = (x: number, y: number, z: number): RigCell => ({ x, y, z });

describe("splitSheets — group a mast's sail cells into y-contiguous bays", () => {
  it("splits two bays separated by a yard row into two sheets", () => {
    // bay A at y 5..7, bay B at y 9..10 (y=8 is the yard's SPAR row — no canvas)
    const cells = [
      cell(40, 5, 10), cell(40, 5, 11), cell(40, 6, 10), cell(40, 7, 11),
      cell(40, 9, 10), cell(40, 10, 11),
    ];
    const sheets = splitSheets(cells);
    expect(sheets).toHaveLength(2);
    expect(sheets[0].every((c) => c.y >= 5 && c.y <= 7)).toBe(true);
    expect(sheets[1].every((c) => c.y >= 9 && c.y <= 10)).toBe(true);
    // no cell lost or duplicated
    expect(sheets[0].length + sheets[1].length).toBe(cells.length);
  });

  it("one contiguous bay stays one sheet; empty input yields no sheets", () => {
    expect(splitSheets([cell(1, 2, 3), cell(1, 3, 3)])).toHaveLength(1);
    expect(splitSheets([])).toHaveLength(0);
  });
});

describe("sheetBounds", () => {
  it("returns the voxel AABB of the sheet (single x plane)", () => {
    const b = sheetBounds([cell(40, 5, 10), cell(40, 7, 14), cell(40, 6, 12)])!;
    expect(b.x).toBe(40);
    expect(b.y0).toBe(5);
    expect(b.y1).toBe(7);
    expect(b.z0).toBe(10);
    expect(b.z1).toBe(14);
    expect(b.w).toBe(5); // z texels
    expect(b.h).toBe(3); // y texels
  });
  it("null on empty", () => {
    expect(sheetBounds([])).toBeNull();
  });
});

describe("buildOccupancy — 3-state R8 mask against the LIVE grid", () => {
  const build = buildCutter();
  const sheets = splitSheets(build.sailVoxels[0]);

  it("the cutter's first mast has at least one real sheet of canvas", () => {
    expect(sheets.length).toBeGreaterThanOrEqual(1);
    expect(sheets[0].length).toBeGreaterThan(10);
  });

  it("intact sheet: every stamped cell ALIVE, taper margin NEVER", () => {
    const s = sheets[0];
    const b = sheetBounds(s)!;
    const { mask, alive, total } = buildOccupancy(build.grid, s, b);
    expect(mask.length).toBe(b.w * b.h);
    expect(total).toBe(s.length);
    expect(alive).toBe(s.length);
    let aliveTexels = 0;
    for (let i = 0; i < mask.length; i++) {
      expect(mask[i] === OCC_ALIVE || mask[i] === OCC_NEVER).toBe(true);
      if (mask[i] === OCC_ALIVE) aliveTexels++;
    }
    expect(aliveTexels).toBe(s.length); // one texel per stamped cell, row-major (z-x0) + (y-y0)*w
  });

  it("shot-out cells flip to DEAD and the alive count drops", () => {
    const s = sheets[0];
    const b = sheetBounds(s)!;
    const killed = s.slice(0, 3);
    for (const c of killed) build.grid.remove(c.x, c.y, c.z);
    const { mask, alive, total } = buildOccupancy(build.grid, s, b);
    expect(total).toBe(s.length);
    expect(alive).toBe(s.length - 3);
    for (const c of killed) {
      const idx = (c.z - b.z0) + (c.y - b.y0) * b.w;
      expect(mask[idx]).toBe(OCC_DEAD);
    }
    // sanity: the untouched cells still read CANVAS in the grid
    expect(build.grid.get(s[4].x, s[4].y, s[4].z)).toBe(CANVAS);
  });
});

describe("billowFactor — visual wind-vs-heading response (need not bit-match sailing.ts)", () => {
  it("following wind: full fill, no luff", () => {
    const r = billowFactor(1, 0, 1, 0); // wind blows toward +x, bow +x
    expect(r.fill).toBeCloseTo(1, 5);
    expect(r.luff).toBeCloseTo(0, 5);
  });
  it("head-to-wind: no fill, full luff", () => {
    const r = billowFactor(-1, 0, 1, 0);
    expect(r.fill).toBeCloseTo(0, 5);
    expect(r.luff).toBeCloseTo(1, 5);
  });
  it("beam reach sits between, and fill is monotone in the downwind component", () => {
    const beam = billowFactor(0, 1, 1, 0);
    expect(beam.fill).toBeGreaterThan(0);
    expect(beam.fill).toBeLessThan(1);
    let prev = -1;
    for (const run of [-1, -0.5, 0, 0.5, 1]) {
      const f = billowFactor(run, Math.sqrt(Math.max(1 - run * run, 0)), 1, 0).fill;
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
  it("degenerate zero vectors are safe (no NaN)", () => {
    const r = billowFactor(0, 0, 0, 0);
    expect(Number.isFinite(r.fill)).toBe(true);
    expect(Number.isFinite(r.luff)).toBe(true);
  });
});

describe("sheetTouchesChunk — dirty-chunk overlap for damage-mask refresh", () => {
  const b = sheetBounds([cell(40, 20, 10), cell(40, 30, 20)])!;
  it("hits the chunks the sheet spans", () => {
    expect(sheetTouchesChunk(b, Math.floor(40 / CHUNK_SIZE), Math.floor(20 / CHUNK_SIZE), Math.floor(10 / CHUNK_SIZE))).toBe(true);
    expect(sheetTouchesChunk(b, Math.floor(40 / CHUNK_SIZE), Math.floor(30 / CHUNK_SIZE), Math.floor(20 / CHUNK_SIZE))).toBe(true);
  });
  it("misses far chunks", () => {
    expect(sheetTouchesChunk(b, 0, 0, 0)).toBe(false);
    expect(sheetTouchesChunk(b, Math.floor(40 / CHUNK_SIZE) + 2, 1, 1)).toBe(false);
  });
});
