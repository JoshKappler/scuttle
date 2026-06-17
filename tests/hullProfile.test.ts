import { describe, it, expect } from "vitest";
import { buildHullProfile, HULL_PROFILE_OPEN } from "../src/sim/buoyancy";
import { createGrid } from "../src/sim/voxelGrid";
import { OAK } from "../src/sim/materials";
import { VOXEL_SIZE } from "../src/core/constants";

/**
 * Open-breach detection in buildHullProfile (cutout task). The profile carries, per (x,z) column,
 * [keelY, deckY, sealFlag]. A column is SEALED (sealFlag == deckY) when it still has solid at the
 * ship's deck plane — the deck planking caps it, so the ocean shader keeps the sea off it. It is OPEN
 * (sealFlag == HULL_PROFILE_OPEN) when the deck/upper skin over it has been carved away, so the ocean
 * shader lets the sea render straight into the hole. A SIDE hole bored UNDER an intact deck plank stays
 * SEALED (that breach shows the hull side / submerges, no spurious cutout).
 */
describe("buildHullProfile open-breach signal", () => {
  // a tiny sealed box: solid y∈[1..5] over a 3×3 (x,z) footprint, on an empty y=0 floor.
  // deck plane voxel-Y = 5 (top of the box). keel = y=1.
  const NX = 3, NY = 10, NZ = 3, DECK = 5;
  const fresh = () => {
    const g = createGrid(NX, NY, NZ);
    for (let z = 0; z < NZ; z++)
      for (let x = 0; x < NX; x++)
        for (let y = 1; y <= DECK; y++) g.set(x, y, z, OAK);
    return g;
  };
  const at = (p: ReturnType<typeof buildHullProfile>, x: number, z: number) => {
    const o = (z * p.nx + x) * 3;
    return { keel: p.data[o], deck: p.data[o + 1], seal: p.data[o + 2] };
  };
  const isOpen = (seal: number) => seal < -500;

  it("an intact column is SEALED (sealFlag == deckY)", () => {
    const p = buildHullProfile(fresh(), DECK);
    const c = at(p, 1, 1);
    expect(c.keel).toBeCloseTo(1 * VOXEL_SIZE, 6);
    expect(c.deck).toBeCloseTo((DECK + 1) * VOXEL_SIZE, 6);
    expect(isOpen(c.seal)).toBe(false);
    expect(c.seal).toBeCloseTo(c.deck, 6);
  });

  it("carving the deck cells off a column marks it OPEN", () => {
    const g = fresh();
    // remove the top THREE cells of the centre column (y=5,4,3): clears the whole deck-plane seal band
    // (planeY±) → the deck over (1,1) is gone, the sea can reach straight in.
    g.remove(1, DECK, 1);
    g.remove(1, DECK - 1, 1);
    g.remove(1, DECK - 2, 1);
    const p = buildHullProfile(g, DECK);
    const c = at(p, 1, 1);
    expect(isOpen(c.seal)).toBe(true);
    expect(c.seal).toBeCloseTo(HULL_PROFILE_OPEN, 6);
    // deck top falls to the highest surviving solid (y=2) → (2+1)·VS — the open hole's floor.
    expect(c.deck).toBeCloseTo((DECK - 2) * VOXEL_SIZE, 6);
    // neighbours untouched → still sealed.
    expect(isOpen(at(p, 0, 1).seal)).toBe(false);
  });

  it("a hole bored UNDER an intact deck plank stays SEALED (no cutout)", () => {
    const g = fresh();
    // bore a cavity in the middle (remove y=2,3) but leave the deck plank (y=5,4) intact → the deck
    // still caps the column, water can't enter from straight above → sealed, shows hull side / submerges.
    g.remove(1, 2, 1);
    g.remove(1, 3, 1);
    const p = buildHullProfile(g, DECK);
    const c = at(p, 1, 1);
    expect(c.deck).toBeCloseTo((DECK + 1) * VOXEL_SIZE, 6); // deck plank still there
    expect(isOpen(c.seal)).toBe(false);
    expect(c.seal).toBeCloseTo(c.deck, 6);
  });

  it("a column with no hull stores the never-cut sentinel (deck < keel)", () => {
    const p = buildHullProfile(createGrid(2, 4, 2), 2);
    const c = at(p, 0, 0);
    expect(c.deck).toBeLessThan(c.keel);
  });

  it("derives the deck plane itself when none is supplied (self-contained fallback)", () => {
    // omit the deck-plane arg; the max top-solid (y=5) is the reference → an intact box reads SEALED.
    const p = buildHullProfile(fresh());
    for (let z = 0; z < NZ; z++)
      for (let x = 0; x < NX; x++) {
        const c = at(p, x, z);
        expect(isOpen(c.seal)).toBe(false);
        expect(c.seal).toBeCloseTo(c.deck, 6);
      }
  });
});
