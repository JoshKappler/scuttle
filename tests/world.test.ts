import { describe, it, expect, vi } from "vitest";
import * as THREE from "three";
import { GameWorld } from "../src/game/world";
import { makeWaves } from "../src/sim/gerstner";
import { Rng } from "../src/core/rng";
import type { Ship } from "../src/game/ship";
import type { Physics } from "../src/game/physics";

function fakeShip(): Ship {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  return { visual: { group }, body: {} } as unknown as Ship;
}

function fakeWorld() {
  const scene = new THREE.Scene();
  const removeRigidBody = vi.fn();
  const physics = { world: { removeRigidBody }, RAPIER: {}, shipBodies: new Set<number>() } as unknown as Physics;
  const waves = makeWaves(new Rng("test"), 4);
  return { world: new GameWorld(physics, waves, scene), scene, removeRigidBody };
}

describe("GameWorld.removeShip", () => {
  it("removes the ship from the list, the scene, and the physics world", () => {
    const { world, scene, removeRigidBody } = fakeWorld();
    const ship = fakeShip();
    world.addShip(ship);
    expect(world.ships).toContain(ship);
    expect(scene.children).toContain(ship.visual.group);

    world.removeShip(ship);
    expect(world.ships).not.toContain(ship);
    expect(scene.children).not.toContain(ship.visual.group);
    expect(removeRigidBody).toHaveBeenCalledWith(ship.body);
  });

  it("is a no-op for a ship that was never added", () => {
    const { world, removeRigidBody } = fakeWorld();
    expect(() => world.removeShip(fakeShip())).not.toThrow();
    expect(removeRigidBody).not.toHaveBeenCalled();
  });
});
