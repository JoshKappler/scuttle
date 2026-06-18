import { describe, it, expect } from "vitest";
import { isFoundered, makeEnemyWreck, ENEMY_SINK_HOLD_STEPS, type FounderingShip } from "../src/game/foundering";

// A minimal stand-in for the bits of a Ship the player predicate reads.
const ship = (y: number, waterlog: number) => ({
  body: { translation: () => ({ x: 0, y, z: 0 }) },
  waterlog,
});

const LEN = 20; // a representative hull length (metres) for the enemy-cull stub.

/** A mutable stand-in for the bits of a Ship the ENEMY-cull predicate reads. `hullTopY` is the
 *  honest top of the HULL in world space (spar masts excluded) — the value the rewritten predicate
 *  keys off. */
function enemyShip(opts: { waterlog?: number; submergedFrac?: number; hullTopY?: number; lengthM?: number } = {}) {
  const s = { waterlog: 0, submergedFrac: 0, hullTopY: 5, lengthM: LEN, ...opts };
  const obj = {
    body: { translation: () => ({ y: -3 }) },
    build: { lengthM: s.lengthM },
    get waterlog() {
      return s.waterlog;
    },
    set waterlog(v: number) {
      s.waterlog = v;
    },
    get submergedFrac() {
      return s.submergedFrac;
    },
    set submergedFrac(v: number) {
      s.submergedFrac = v;
    },
    set hullTopY(v: number) {
      s.hullTopY = v;
    },
    hullAabbTopWorldY() {
      return s.hullTopY;
    },
  };
  return obj as FounderingShip & { hullTopY: number; submergedFrac: number };
}

describe("isFoundered — the player respawn predicate (UNCHANGED by the enemy rewrite)", () => {
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

describe("makeEnemyWreck — strict enemy cull: linger until the WHOLE hull is a ship-length under", () => {
  it("a HALF-SUNK enemy (hull top just below the surface, but < a ship-length under) is NOT a wreck", () => {
    // the player-bar isFoundered already fires here (waterlog>=0.45) — the enemy predicate must NOT,
    // so she stays visible and keeps sinking instead of vanishing while half her hull still shows.
    const isWreck = makeEnemyWreck();
    expect(isFoundered({ body: { translation: () => ({ y: -3 }) }, waterlog: 0.45 })).toBe(true);
    // hull top is 2 m under the surface — under water, but nowhere near a full 20 m ship-length down.
    expect(isWreck(enemyShip({ waterlog: 0.45, submergedFrac: 0.6, hullTopY: -2 }))).toBe(false);
  });

  it("a hull still showing freeboard (top ABOVE the sea) is never a wreck", () => {
    const isWreck = makeEnemyWreck();
    expect(isWreck(enemyShip({ submergedFrac: 0.9, hullTopY: 1 }))).toBe(false);
  });

  it("requires the whole-hull-under state to PERSIST the hold window before culling", () => {
    const isWreck = makeEnemyWreck();
    // hull top a full ship-length-plus under the sea (−25 < 0 − 20).
    const s = enemyShip({ hullTopY: -25 });
    for (let i = 0; i < ENEMY_SINK_HOLD_STEPS - 1; i++) expect(isWreck(s)).toBe(false);
    expect(isWreck(s)).toBe(true); // the Nth consecutive step trips it
  });

  it("trips exactly at the full-ship-length threshold (hull top < SEA_Y − lengthM)", () => {
    const justAbove = makeEnemyWreck(2);
    // −19.9 is under the surface but NOT yet a full 20 m down → never culls.
    const a = enemyShip({ hullTopY: -19.9 });
    expect(justAbove(a)).toBe(false);
    expect(justAbove(a)).toBe(false);

    const justBelow = makeEnemyWreck(2);
    const b = enemyShip({ hullTopY: -20.1 }); // a hair past a full ship-length under
    expect(justBelow(b)).toBe(false);
    expect(justBelow(b)).toBe(true);
  });

  it("a bobbing hull that rises back above the line RESETS the counter", () => {
    const isWreck = makeEnemyWreck(3);
    const s = enemyShip({ hullTopY: -25 }); // a ship-length under
    expect(isWreck(s)).toBe(false); // 1
    expect(isWreck(s)).toBe(false); // 2
    s.hullTopY = -5; // a swell crest lifts her so the hull top is no longer a ship-length down
    expect(isWreck(s)).toBe(false); // resets; would-be 3rd does not trip
    s.hullTopY = -25; // settles back fully under
    expect(isWreck(s)).toBe(false); // count restarts at 1
    expect(isWreck(s)).toBe(false); // 2
    expect(isWreck(s)).toBe(true); // 3 — eventually goes
  });

  it("safety fallback: a deep, saturated hull founders at once — BUT only once the hull top is under the sea", () => {
    // a saturated hull (waterlog>=0.5) whose top is below the surface still goes immediately…
    const isWreck = makeEnemyWreck();
    expect(isWreck(enemyShip({ waterlog: 0.5, submergedFrac: 0.9, hullTopY: -1 }))).toBe(true);
    // …but the SAME saturation while she's STILL showing freeboard (top above the sea) does NOT cull
    // her — the old `waterlog>=0.5` early-out that culled a half-showing ship is gone.
    const guarded = makeEnemyWreck();
    expect(guarded(enemyShip({ waterlog: 0.5, submergedFrac: 0.9, hullTopY: 2 }))).toBe(false);
  });

  it("per-ship counters are independent (WeakMap, no shared global)", () => {
    const isWreck = makeEnemyWreck(2);
    const a = enemyShip({ hullTopY: -25 });
    const b = enemyShip({ hullTopY: -25 });
    expect(isWreck(a)).toBe(false); // a: 1
    expect(isWreck(b)).toBe(false); // b: 1 (not a's 2)
    expect(isWreck(a)).toBe(true); // a: 2
    expect(isWreck(b)).toBe(true); // b: 2
  });

  it("makeEnemyWreck() takes no required args (the main.ts call site)", () => {
    const isWreck = makeEnemyWreck();
    expect(typeof isWreck).toBe("function");
    expect(isWreck(enemyShip({ hullTopY: 5 }))).toBe(false); // afloat, no throw
  });
});
