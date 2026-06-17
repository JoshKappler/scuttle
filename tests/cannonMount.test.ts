import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { buildSloop } from "../src/sim/shipwright";
import { cannonMountCells, mountSolidCount, mountLost } from "../src/sim/cannonMount";
import { Cannons } from "../src/game/cannons";
import type { Ship } from "../src/game/ship";

// ---- the pure mount-detection helpers (no Rapier — sim-pure, the oracle's style) ----
describe("cannonMount — a gun's hull mount, sampled from the grid", () => {
  const build = buildSloop();

  it("an intact hull has a real mount under every gun", () => {
    for (const p of build.cannonPorts) {
      expect(mountSolidCount(build.grid, p)).toBeGreaterThan(0);
    }
  });

  it("a fully intact mount is NOT lost", () => {
    for (const p of build.cannonPorts) {
      const init = mountSolidCount(build.grid, p);
      expect(mountLost(build.grid, p, init, 0.5)).toBe(false);
    }
  });

  it("carving a gun's anchor cells away drops its mount below the threshold → lost", () => {
    // a broadside gun (deck mount); copy the grid so we don't disturb the shared build.
    const port = build.cannonPorts.find((p) => !p.facing)!;
    const init = mountSolidCount(build.grid, port);
    expect(init).toBeGreaterThan(0);

    // remove every one of its mount cells: nothing left to bolt to.
    for (const [x, y, z] of cannonMountCells(port)) build.grid.remove(x, y, z);

    expect(mountSolidCount(build.grid, port)).toBe(0);
    expect(mountLost(build.grid, port, init, 0.5)).toBe(true);
  });

  it("a degenerate (zero-init) mount never reports lost (no churn)", () => {
    const phantom = { x: -999, y: -999, z: -999, side: 1 as const };
    expect(mountLost(build.grid, phantom, mountSolidCount(build.grid, phantom), 0.5)).toBe(false);
  });
});

// ---- firing + readiness skip a dismounted gun (player AND AI go through these) ----
// A minimal Ship stand-in: Cannons only reads `build.cannonPorts` and `cannonAlive`.
function fakeShip(ports: Ship["build"]["cannonPorts"], alive: boolean[]): Ship {
  return { build: { cannonPorts: ports }, cannonAlive: alive } as unknown as Ship;
}

describe("Cannons — a gun off its mount neither fires nor counts", () => {
  const scene = new THREE.Scene();
  const noopEffects = {
    muzzleFlash() {}, muzzleSmoke() {}, cannonBoom() {}, splash() {},
    puncture() {}, splinters() {}, impactDebris() {}, impact() {},
  } as never;

  const ports: Ship["build"]["cannonPorts"] = [
    { x: 10, y: 5, z: 0, side: 1 },
    { x: 12, y: 5, z: 0, side: 1 },
    { x: 14, y: 5, z: 0, side: 1 },
  ];

  it("sideReadiness ignores a dead gun in BOTH numerator and denominator", () => {
    const cannons = new Cannons(scene, noopEffects);
    // all three alive, none fired → fully ready.
    expect(cannons.sideReadiness(fakeShip(ports, [true, true, true]), 1, 0)).toBe(1);
    // kill one: the readiness is still 1 (the survivors are all loaded), and the count is 2 not 3.
    const ship = fakeShip(ports, [true, false, true]);
    expect(cannons.sideReadiness(ship, 1, 0)).toBe(1);
  });

  it("fireBroadside skips a dead port: a 1-gun side with that gun dead fires nothing", () => {
    const cannons = new Cannons(scene, noopEffects);
    const oneGun: Ship["build"]["cannonPorts"] = [{ x: 10, y: 5, z: 0, side: 1 }];
    expect(cannons.fireBroadside(fakeShip(oneGun, [false]), 1, 0)).toBe(false);
    // a live gun on the same side DOES fire.
    expect(cannons.fireBroadside(fakeShip(oneGun, [true]), 1, 0)).toBe(true);
  });
});
