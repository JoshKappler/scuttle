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
    // SENSOR: a kinematic capsule with a solid collider has infinite
    // effective mass and will physically shove (and capsize!) the dynamic
    // ship it stands on. Sensors generate no contact forces; the character
    // controller still sweeps the capsule SHAPE against the world, so
    // walking/standing is unaffected. (Playtest: "standing in the center,
    // the boat has completely capsized.")
    this.collider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.28).setSensor(true), this.body);
    this.controller = world.createCharacterController(0.05);
    this.controller.enableAutostep(0.35, 0.2, true);
    this.controller.enableSnapToGround(0.6); // generous: decks drop with the swell
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);

    // built pirate: legs, torso, arms, head, hat/bandana, cutlass — placeholder
    // until a real CC0 character pack lands, but no longer a pill
    this.mesh = new THREE.Group();
    const skin = new THREE.MeshStandardMaterial({ color: 0xc8a07a, roughness: 0.7 });
    const cloth = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 });
    const accent = new THREE.MeshStandardMaterial({ color: sashColor, roughness: 0.8 });

    const legGeo = new THREE.CapsuleGeometry(0.085, 0.42, 3, 8);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, cloth);
      leg.position.set(0, 0.33, s * 0.12);
      leg.castShadow = true;
      this.mesh.add(leg);
    }
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.5, 4, 10), cloth);
    torso.position.y = 0.95;
    torso.castShadow = true;
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 10), accent);
    belt.position.y = 0.72;
    const armGeo = new THREE.CapsuleGeometry(0.07, 0.42, 3, 8);
    this.swordArm = new THREE.Group();
    const armR = new THREE.Mesh(armGeo, cloth);
    armR.position.y = -0.22;
    this.swordArm.add(armR);
    this.swordArm.position.set(0, 1.28, 0.32);
    this.swordArm.rotation.x = 0.18;
    const armL = new THREE.Mesh(armGeo, cloth);
    armL.position.set(0, 1.05, -0.32);
    armL.rotation.x = -0.15;
    armL.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), skin);
    head.position.y = 1.62;
    head.castShadow = true;

    let headgear: THREE.Object3D;
    if (faction === "player") {
      // captain's hat: squashed cone + brim
      const hat = new THREE.Group();
      const crown = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.26, 10), accent);
      crown.position.y = 1.88;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.035, 12), accent);
      brim.position.y = 1.77;
      hat.add(crown, brim);
      headgear = hat;
    } else {
      const bandana = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.215, 0.12, 10), accent);
      bandana.position.y = 1.74;
      headgear = bandana;
    }

    const sword = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.85, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.8 }),
    );
    sword.position.y = -0.75;
    this.swordArm.add(sword);

    this.headParts = [head, headgear];
    this.mesh.add(torso, belt, this.swordArm, armL, head, headgear);
    scene.add(this.mesh);
  }

  private swordArm!: THREE.Group;
  private headParts: THREE.Object3D[] = [];
  /** Set by combat when this pirate swings; drives the chop animation. */
  attackTimer = 0;
  /** Set by combat on kick; drives the lunge animation. */
  kickTimer = 0;

  worldPos(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  /** First-person: hide the head + hat so the camera doesn't sit inside them. */
  setFirstPerson(fp: boolean): void {
    for (const part of this.headParts) part.visible = !fp;
  }

  /** Pin to a world position with a fixed facing (used while at the wheel). */
  pin(pos: THREE.Vector3, facing: number): void {
    this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
    this.facing = facing;
    const t = this.body.translation();
    this.mesh.position.set(t.x, t.y - 0.78, t.z);
    this.mesh.rotation.set(0, -facing, 0);
  }

  /** Move one fixed step. moveX/moveZ are a world-space direction (≤1). */
  step(dt: number, moveX: number, moveZ: number, jump: boolean, waves: Wave[], simTime: number): void {
    this.attackTimer = Math.max(this.attackTimer - dt, 0);
    this.kickTimer = Math.max(this.kickTimer - dt, 0);
    if (!this.alive) {
      this.syncMesh();
      this.ragdollAge += dt;
      return;
    }
    const tr = this.body.translation();
    const surf = surfaceHeight(waves, tr.x, tr.z, simTime);

    // chest-deep before swim mode kicks in — an awash deck is still walkable
    // (playtest: bow dipped, walking/jumping died because swim engaged early)
    this.swimming = tr.y < surf - 0.45;
    if (this.swimming) {
      // damped spring to the surface — undamped buoyancy made swimmers
      // oscillate into 50-foot breaches (playtest bug)
      this.vy += ((surf - 0.45 - tr.y) * 5 - this.vy * 3.2) * dt;
      this.vy = Math.min(Math.max(this.vy, -3), 3);
      const k = 0.55;
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

    // deck-carry from this pirate's ship — HORIZONTAL only: vertical deck
    // motion is handled by ground collision + snap-to-ground; adding it to
    // the desired movement double-counts and makes characters hop in waves
    const sv = this.ship.body.linvel();
    const om = this.ship.body.angvel();
    const com = this.ship.body.worldCom();
    const ry = tr.y - com.y;
    const rz = tr.z - com.z;
    const desired = {
      x: (moveX * WALK_SPEED + sv.x + om.y * rz - om.z * ry) * dt,
      y: this.vy * dt,
      z: (moveZ * WALK_SPEED + sv.z + om.x * ry - om.y * (tr.x - com.x)) * dt,
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
      // kick: brief forward lunge of the whole body
      const kickP = this.kickTimer > 0 ? Math.sin((1 - this.kickTimer / 0.3) * Math.PI) : 0;
      this.mesh.rotation.set(0, -this.facing, kickP * 0.28);
      // slash: overhead chop of the sword arm
      const swingP = this.attackTimer > 0 ? Math.sin((1 - this.attackTimer / 0.28) * Math.PI) : 0;
      this.swordArm.rotation.x = 0.18 - swingP * 1.9;
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
