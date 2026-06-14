import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { FleetManager, type EnemyUnit, type FleetWorld } from "../src/game/fleet";
import { TUN } from "../src/core/tunables";
import type { Ship } from "../src/game/ship";

// minimal fake ship with a movable position + a wreck flag (_y < -12)
function fakeShip(x: number, y = 0, z = 0): Ship & { _y: number } {
  const s: any = {
    _y: y,
    visual: { group: new THREE.Group() },
    body: { translation: () => ({ x, y: s._y, z }) },
  };
  return s;
}

function fakeWorld(): FleetWorld & { ships: Ship[] } {
  return {
    ships: [] as Ship[],
    addShip(s: Ship) {
      this.ships.push(s);
    },
    removeShip(s: Ship) {
      const i = this.ships.indexOf(s);
      if (i >= 0) this.ships.splice(i, 1);
    },
  };
}

const noopCaptain = { update() {}, sailing: { rudder: 0, sailSet: 0 } } as unknown as EnemyUnit["captain"];

function makeFleet(spawnAt: () => Ship) {
  const world = fakeWorld();
  const target = fakeShip(0, 0, 0); // the player at the origin
  let n = 0;
  const spawn = (): EnemyUnit => {
    n++;
    return { ship: spawnAt(), captain: noopCaptain };
  };
  const isWreck = (s: Ship) => (s as any)._y < -12;
  const fleet = new FleetManager({ world, target, spawn, isWreck, maxVis: 6 });
  return { fleet, world, target, spawnCount: () => n };
}

describe("FleetManager.reconcile", () => {
  it("spawns one ship per step up to the target count", () => {
    let i = 0;
    const { fleet, world } = makeFleet(() => fakeShip(10 + i++));
    TUN.fleet.enemyCount = 3;
    fleet.reconcile();
    expect(world.ships.length).toBe(1);
    fleet.reconcile();
    expect(world.ships.length).toBe(2);
    fleet.reconcile();
    expect(world.ships.length).toBe(3);
    fleet.reconcile();
    expect(world.ships.length).toBe(3); // steady
  });

  it("despawns the FARTHEST ship when the count drops", () => {
    const near = fakeShip(5),
      mid = fakeShip(20),
      far = fakeShip(100);
    const ships = [near, mid, far];
    let i = 0;
    const { fleet, world } = makeFleet(() => ships[i++]);
    TUN.fleet.enemyCount = 3;
    fleet.reconcile();
    fleet.reconcile();
    fleet.reconcile();
    expect(world.ships.length).toBe(3);
    TUN.fleet.enemyCount = 2;
    fleet.reconcile();
    expect(world.ships).not.toContain(far); // farthest gone first
    expect(world.ships).toContain(near);
    expect(world.ships).toContain(mid);
  });

  it("never despawns the boarding target", () => {
    const near = fakeShip(5),
      far = fakeShip(100);
    const ships = [near, far];
    let i = 0;
    const { fleet, world } = makeFleet(() => ships[i++]);
    TUN.fleet.enemyCount = 2;
    fleet.reconcile();
    fleet.reconcile();
    fleet.boardingTarget = far; // we're grappled to the far one
    TUN.fleet.enemyCount = 1;
    fleet.reconcile();
    expect(world.ships).toContain(far); // protected
    expect(world.ships).not.toContain(near); // next-farthest removed instead
  });

  it("clamps the target to maxVis", () => {
    let i = 0;
    const { fleet, world } = makeFleet(() => fakeShip(10 + i++));
    TUN.fleet.enemyCount = 99;
    for (let s = 0; s < 20; s++) fleet.reconcile();
    expect(world.ships.length).toBe(6);
  });

  it("auto-replaces a sunk wreck (even at count 1)", () => {
    let i = 0;
    const made: (Ship & { _y: number })[] = [];
    const { fleet, world } = makeFleet(() => {
      const s = fakeShip(10 + i++);
      made.push(s);
      return s;
    });
    TUN.fleet.enemyCount = 1;
    fleet.reconcile();
    expect(world.ships.length).toBe(1);
    made[0]._y = -50; // she founders
    fleet.reconcile(); // wreck culled this step
    expect(world.ships).not.toContain(made[0]);
    fleet.reconcile(); // backfilled next step
    expect(world.ships.length).toBe(1);
    expect(world.ships[0]).toBe(made[1]);
  });
});

describe("FleetManager.rankLOD", () => {
  it("picks the nearest living enemy as the premium ship", () => {
    const near = fakeShip(5),
      far = fakeShip(100);
    const ships = [far, near];
    let i = 0;
    const { fleet } = makeFleet(() => ships[i++]);
    TUN.fleet.enemyCount = 2;
    fleet.reconcile();
    fleet.reconcile();
    fleet.rankLOD(new THREE.Vector3(0, 0, 0));
    expect(fleet.premiumEnemy).toBe(near);
  });

  it("holds the current premium ship within the hysteresis band", () => {
    const a = fakeShip(10),
      b = fakeShip(11);
    const ships = [a, b];
    let i = 0;
    const { fleet } = makeFleet(() => ships[i++]);
    TUN.fleet.enemyCount = 2;
    fleet.reconcile();
    fleet.reconcile();
    fleet.rankLOD(new THREE.Vector3(0, 0, 0)); // a (10) is premium
    expect(fleet.premiumEnemy).toBe(a);
    // b becomes marginally closer (9.9 vs 10) — within the band, keep a
    (b as any).body.translation = () => ({ x: 9.9, y: 0, z: 0 });
    fleet.rankLOD(new THREE.Vector3(0, 0, 0));
    expect(fleet.premiumEnemy).toBe(a);
  });
});
