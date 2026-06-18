import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { isFoundered, makeEnemyWreck, ENEMY_SINK_HOLD_STEPS, type FounderingShip } from "../src/game/foundering";

// A minimal stand-in for the bits of a Ship the predicate reads.
const ship = (y: number, waterlog: number) => ({
  body: { translation: () => ({ x: 0, y, z: 0 }) },
  waterlog,
});

/** A mutable stand-in for the bits of a Ship the ENEMY-cull predicate reads. */
function enemyShip(opts: { waterlog?: number; submergedFrac?: number; aabbTopY?: number } = {}): FounderingShip {
  const s = { waterlog: 0, submergedFrac: 0, aabbTopY: 5, ...opts };
  return {
    body: { translation: () => ({ y: -3 }) },
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
    set aabbTopY(v: number) {
      s.aabbTopY = v;
    },
    aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }) {
      out.min.set(0, -3, 0);
      out.max.set(0, s.aabbTopY, 0);
      return out;
    },
  } as FounderingShip & { aabbTopY: number };
}

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

describe("makeEnemyWreck — strict enemy cull: linger until she's actually under", () => {
  it("a hull only ~60% submerged (player-bar waterlog 0.45) is NOT yet a wreck", () => {
    // the loose isFoundered fires here (waterlog>=0.45); the enemy predicate must NOT, so she
    // stays visible while a third of her freeboard still shows.
    const isWreck = makeEnemyWreck();
    expect(isFoundered({ body: { translation: () => ({ y: -3 }) }, waterlog: 0.45 })).toBe(true);
    expect(isWreck(enemyShip({ waterlog: 0.45, submergedFrac: 0.6, aabbTopY: 4 }))).toBe(false);
  });

  it("requires the underwater state to PERSIST the hold window before culling", () => {
    const isWreck = makeEnemyWreck();
    const s = enemyShip({ submergedFrac: 0.98, aabbTopY: 4 }); // essentially fully under
    for (let i = 0; i < ENEMY_SINK_HOLD_STEPS - 1; i++) expect(isWreck(s)).toBe(false);
    expect(isWreck(s)).toBe(true); // the Nth consecutive step trips it
  });

  it("culls via the AABB-top-below-sea test too (max.y < 0)", () => {
    const isWreck = makeEnemyWreck(3);
    const s = enemyShip({ submergedFrac: 0.5, aabbTopY: -0.5 }); // top voxel under, frac modest
    expect(isWreck(s)).toBe(false);
    expect(isWreck(s)).toBe(false);
    expect(isWreck(s)).toBe(true);
  });

  it("a bobbing-but-afloat hull never culls — a swell crest RESETS the counter", () => {
    const isWreck = makeEnemyWreck(3);
    const s = enemyShip({ submergedFrac: 0.98, aabbTopY: 4 }) as FounderingShip & { aabbTopY: number; submergedFrac: number };
    expect(isWreck(s)).toBe(false); // 1
    expect(isWreck(s)).toBe(false); // 2
    s.submergedFrac = 0.5; // a crest lifts her — back afloat
    expect(isWreck(s)).toBe(false); // resets; would-be 3rd does not trip
    s.submergedFrac = 0.98; // settles back under
    expect(isWreck(s)).toBe(false); // count restarts at 1
    expect(isWreck(s)).toBe(false); // 2
    expect(isWreck(s)).toBe(true); // 3 — eventually goes
  });

  it("a fully-saturated hull (waterlog>=0.5) founders at once — no permanent limbo", () => {
    // even if she rests just shy of full submersion forever, waterlog caps at 0.5 → she still goes.
    const isWreck = makeEnemyWreck();
    expect(isWreck(enemyShip({ waterlog: 0.5, submergedFrac: 0.9, aabbTopY: 2 }))).toBe(true);
  });

  it("per-ship counters are independent (WeakMap, no shared global)", () => {
    const isWreck = makeEnemyWreck(2);
    const a = enemyShip({ submergedFrac: 0.99, aabbTopY: 4 });
    const b = enemyShip({ submergedFrac: 0.99, aabbTopY: 4 });
    expect(isWreck(a)).toBe(false); // a: 1
    expect(isWreck(b)).toBe(false); // b: 1 (not a's 2)
    expect(isWreck(a)).toBe(true); // a: 2
    expect(isWreck(b)).toBe(true); // b: 2
  });
});
