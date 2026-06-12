import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { G } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import type { Effects } from "../render/effects";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

/**
 * Pirates. Kinematic capsules driven by rapier character controllers, riding
 * ship decks via the deck-carry velocity field (validated in the M1 spike).
 * Combat: slash (cone, damage) and kick (impulse — physics decides if they
 * swim). Death = ragdoll-lite: the capsule goes dynamic, bleeds, and is
 * claimed by the sea.
 */
const WALK_SPEED = 3.4;

export type Faction = "player" | "enemy";

export class Pirate {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController | null;
  readonly mesh: THREE.Group;
  hp = 3;
  alive = true;
  /** Seconds until this pirate may slash again. */
  slashCd = 0;
  kickCd = 0;
  facing = 0; // world yaw
  private vy = 0;
  private ragdollAge = 0;
  swimming = false;

  constructor(
    private phys: Physics,
    scene: THREE.Scene,
    public ship: Ship,
    public faction: Faction,
    deckLocal: [number, number, number],
    bodyColor: number,
    sashColor: number,
  ) {
    const { world, RAPIER: R } = phys;
    const spawn = ship.localToWorld(deckLocal, new THREE.Vector3());
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + 1.2, spawn.z),
    );
    this.collider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.28), this.body);
    this.controller = world.createCharacterController(0.05);
    this.controller.enableAutostep(0.35, 0.2, true);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);

    // capsule pirate: body, head, sash — readable at gameplay distance
    this.mesh = new THREE.Group();
    const bodyMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.28, 0.95, 4, 10),
      new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.8 }),
    );
    bodyMesh.position.y = 0.78;
    bodyMesh.castShadow = true;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.21, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0xc8a07a, roughness: 0.7 }),
    );
    head.position.y = 1.62;
    head.castShadow = true;
    const sash = new THREE.Mesh(
      new THREE.CylinderGeometry(0.225, 0.225, 0.14, 10),
      new THREE.MeshStandardMaterial({ color: sashColor, roughness: 0.85 }),
    );
    sash.position.y = 1.78;
    const sword = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 0.85),
      new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.8 }),
    );
    sword.position.set(0.34, 0.95, 0.3);
    this.mesh.add(bodyMesh, head, sash, sword);
    scene.add(this.mesh);
  }

  worldPos(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  /** Move one fixed step. moveX/moveZ are a world-space direction (≤1). */
  step(dt: number, moveX: number, moveZ: number, jump: boolean, waves: Wave[], simTime: number): void {
    if (!this.alive) {
      this.syncMesh();
      this.ragdollAge += dt;
      return;
    }
    const tr = this.body.translation();
    const surf = surfaceHeight(waves, tr.x, tr.z, simTime);

    this.swimming = tr.y < surf + 0.4;
    if (this.swimming) {
      // crude swim: buoyed to the surface, slow movement, ships don't carry you
      this.vy = Math.min(this.vy + (surf + 0.55 - tr.y) * 6 * dt, 2.5);
      const k = 0.35;
      this.body.setNextKinematicTranslation({
        x: tr.x + moveX * WALK_SPEED * k * dt,
        y: tr.y + this.vy * dt,
        z: tr.z + moveZ * WALK_SPEED * k * dt,
      });
      this.syncMesh();
      return;
    }

    const grounded = this.controller!.computedGrounded();
    if (grounded) {
      this.vy = jump ? 5.6 : Math.max(this.vy, -0.5);
    } else {
      this.vy = Math.max(this.vy - G * dt, -18);
    }

    // deck-carry from this pirate's ship
    const sv = this.ship.body.linvel();
    const om = this.ship.body.angvel();
    const com = this.ship.body.worldCom();
    const rx = tr.x - com.x;
    const ry = tr.y - com.y;
    const rz = tr.z - com.z;
    const desired = {
      x: (moveX * WALK_SPEED + sv.x + om.y * rz - om.z * ry) * dt,
      y: (this.vy + sv.y + om.z * rx - om.x * rz) * dt,
      z: (moveZ * WALK_SPEED + sv.z + om.x * ry - om.y * rx) * dt,
    };
    this.controller!.computeColliderMovement(this.collider, desired);
    const m = this.controller!.computedMovement();
    this.body.setNextKinematicTranslation({ x: tr.x + m.x, y: tr.y + m.y, z: tr.z + m.z });

    if (moveX * moveX + moveZ * moveZ > 0.01) this.facing = Math.atan2(moveZ, moveX);
    this.syncMesh();
  }

  private syncMesh(): void {
    const t = this.body.translation();
    this.mesh.position.set(t.x, t.y - 0.78, t.z);
    if (this.alive) {
      this.mesh.rotation.set(0, -this.facing, 0);
    } else {
      const r = this.body.rotation();
      this.mesh.position.set(t.x, t.y, t.z);
      this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Take damage; returns true if this killed them. */
  hurt(dmg: number, effects: Effects): boolean {
    if (!this.alive) return false;
    this.hp -= dmg;
    const t = this.body.translation();
    effects.blood(t.x, t.y + 0.9, t.z);
    if (this.hp <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  /** Physics shove. Strong enough kicks send pirates overboard. */
  shove(dirX: number, dirZ: number): void {
    if (!this.alive) return;
    // kinematic bodies ignore impulses — go ragdoll-lite briefly via velocity
    const tr = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: tr.x + dirX * 0.55,
      y: tr.y + 0.1,
      z: tr.z + dirZ * 0.55,
    });
  }

  /** Ragdoll-lite: swap the kinematic capsule for a tumbling dynamic one. */
  die(): void {
    if (!this.alive) return;
    this.alive = false;
    const { world, RAPIER: R } = this.phys;
    const tr = this.body.translation();
    const fx = Math.cos(this.facing);
    const fz = Math.sin(this.facing);
    world.removeRigidBody(this.body);
    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(tr.x, tr.y, tr.z)
        .setLinvel(-fx * 1.5, 1.2, -fz * 1.5)
        .setAngvel({ x: (Math.random() - 0.5) * 6, y: 0, z: (Math.random() - 0.5) * 6 })
        .setLinearDamping(0.4)
        .setAngularDamping(1.2),
    );
    this.collider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.28).setDensity(985), this.body);
    this.controller = null;
  }

  /** True once a corpse can be cleaned up (sunk or 8 s old). */
  doneFor(waves: Wave[], simTime: number): boolean {
    if (this.alive) return false;
    const t = this.body.translation();
    return this.ragdollAge > 8 || t.y < surfaceHeight(waves, t.x, t.z, simTime) - 2.5;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.phys.world.removeRigidBody(this.body);
  }
}
