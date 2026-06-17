import { describe, it, expect } from "vitest";
import { SailingController, type Wind } from "../src/game/sailing";
import type { Ship } from "../src/game/ship";

// Minimal fake hull just rich enough for SailingController.apply(): one mast,
// full canvas, upright at the origin facing +x (identity rotation → fwd = +x).
// Captures the net thrust force applied along fwd so a test can read its sign.
function fakeShip(): { ship: Ship; net: { x: number; z: number } } {
  const net = { x: 0, z: 0 };
  const body = {
    rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
    linvel: () => ({ x: 0, y: 0, z: 0 }),
    mass: () => 1000,
    addForceAtPoint: (f: { x: number; y: number; z: number }) => {
      net.x += f.x;
      net.z += f.z;
    },
    addTorque: () => {},
  };
  const ship = {
    body,
    submergedFrac: 1,
    build: { masts: [{ x: 0, z: 0, h: 4 }] },
    mastAlive: [true],
    sailIntegrity: [1],
    comLocal: [0, 0, 0],
    rudderEff: 1,
    rudderPower: 1,
    // localToWorld is only used to pick a force-application point; identity here
    localToWorld: (l: [number, number, number], out: { set: (x: number, y: number, z: number) => unknown }) => {
      out.set(l[0], l[1], l[2]);
      return out;
    },
  } as unknown as Ship;
  return { ship, net };
}

// blowing toward +x at a brisk clip, so the bow-on heading still makes the
// half-power floor (the model never strands you in irons)
const wind: Wind = { dirX: 1, dirZ: 0, speed: 10 };

describe("SailingController astern thrust", () => {
  it("positive throttle drives the bow forward (+fwd, +x)", () => {
    const { ship, net } = fakeShip();
    const sail = new SailingController();
    sail.sailSet = 0.8;
    sail.apply(ship, wind);
    expect(net.x).toBeGreaterThan(0);
  });

  it("negative throttle (backed sails) drives astern (-fwd, -x)", () => {
    const { ship, net } = fakeShip();
    const sail = new SailingController();
    sail.sailSet = -0.5;
    sail.apply(ship, wind);
    expect(net.x).toBeLessThan(0);
  });

  it("zero throttle makes no thrust", () => {
    const { ship, net } = fakeShip();
    const sail = new SailingController();
    sail.sailSet = 0;
    sail.apply(ship, wind);
    expect(net.x).toBe(0);
    expect(net.z).toBe(0);
  });

  it("astern is weaker than ahead at the same throttle magnitude", () => {
    const ahead = fakeShip();
    const sa = new SailingController();
    sa.sailSet = 0.5;
    sa.apply(ahead.ship, wind);

    const astern = fakeShip();
    const sb = new SailingController();
    sb.sailSet = -0.5;
    sb.apply(astern.ship, wind);

    // same |throttle|, but astern magnitude is reduced by asternFrac (<1)
    expect(Math.abs(astern.net.x)).toBeLessThan(Math.abs(ahead.net.x));
    expect(Math.abs(astern.net.x)).toBeCloseTo(Math.abs(ahead.net.x) * sb.asternFrac, 5);
  });
});
