import { describe, it, expect } from "vitest";
import { isFoundered } from "../src/game/foundering";

// A minimal stand-in for the bits of a Ship the predicate reads.
const ship = (y: number, waterlog: number) => ({
  body: { translation: () => ({ x: 0, y, z: 0 }) },
  waterlog,
});

describe("isFoundered — the ONE 'she's gone' test shared by player + fleet", () => {
  it("a healthy ship riding at her draft is not foundered", () => {
    expect(isFoundered(ship(-3, 0))).toBe(false);
  });

  it("a TRANSIENT deep dip with no waterlog is NOT foundered (the deck-dip reset bug)", () => {
    // a heel, a swell trough, or a ram shove drops the COM low for a moment — she's still afloat.
    expect(isFoundered(ship(-15, 0))).toBe(false);
  });

  it("genuinely deep AND waterlogged founders", () => {
    expect(isFoundered(ship(-15, 0.1))).toBe(true);
  });

  it("fully saturated founders at any depth", () => {
    expect(isFoundered(ship(-2, 0.45))).toBe(true);
  });

  it("just shy of saturation is still afloat (slow sink, not an instant reset)", () => {
    expect(isFoundered(ship(-2, 0.44))).toBe(false);
  });
});
