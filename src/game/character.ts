import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { CHUNK_SIZE, G } from "../core/constants";
import { meshChunk } from "../render/voxelMesher";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

/**
 * SPIKE (plan Task 13): kinematic capsule character standing on a moving,
 * rolling, sinking ship deck. Enable with ?spike=char. Controls: IJKL to
 * walk (camera-relative), U to jump.
 *
 * Approach validated here for M4:
 * - the ship gets a TRIMESH collider built from its greedy mesh (ship-local
 *   verts, so it rides the rigid body for free)
 * - the capsule is kinematic, moved via rapier's KinematicCharacterController
 * - deck-carry: each step we add the ship's surface velocity at the
 *   character's position (linvel + angvel × r) so the deck carries the
 *   capsule; gravity is world-down, so a listing deck becomes a slope.
 */
export class CharacterSpike {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly mesh: THREE.Mesh;
  private controller: RAPIER.KinematicCharacterController;
  private vy = 0;
  private keys = new Set<string>();

  constructor(
    physics: Physics,
    scene: THREE.Scene,
    private ship: Ship,
  ) {
    const { world, RAPIER: R } = physics;

    // trimesh collider on the ship so the capsule can stand on the actual deck
    const grid = ship.build.grid;
    const [nx, ny, nz] = grid.dims;
    const verts: number[] = [];
    const idxs: number[] = [];
    for (let cx = 0; cx <= Math.floor((nx - 1) / CHUNK_SIZE); cx++) {
      for (let cy = 0; cy <= Math.floor((ny - 1) / CHUNK_SIZE); cy++) {
        for (let cz = 0; cz <= Math.floor((nz - 1) / CHUNK_SIZE); cz++) {
          const data = meshChunk(grid, cx, cy, cz);
          if (!data) continue;
          const base = verts.length / 3;
          verts.push(...data.positions);
          for (const i of data.indices) idxs.push(base + i);
        }
      }
    }
    world.createCollider(
      R.ColliderDesc.trimesh(new Float32Array(verts), new Uint32Array(idxs)),
      ship.body,
    );

    // capsule on the deck above midship
    const spawn = ship.localToWorld([9, (ship.build.deckY + 6) * 0.25, 3], new THREE.Vector3());
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z),
    );
    this.collider = world.createCollider(R.ColliderDesc.capsule(0.55, 0.3), this.body);

    this.controller = world.createCharacterController(0.05);
    this.controller.enableAutostep(0.35, 0.2, true);
    this.controller.enableSnapToGround(0.4);
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);

    this.mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 1.1, 4, 12),
      new THREE.MeshStandardMaterial({ color: 0x8a2f24, roughness: 0.7 }),
    );
    this.mesh.castShadow = true;
    scene.add(this.mesh);

    window.addEventListener("keydown", (e) => this.keys.add(e.code));
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
  }

  /** Teleport back above midship deck (spike-grade overboard recovery). */
  respawn(): void {
    const p = this.ship.localToWorld([9, (this.ship.build.deckY + 6) * 0.25, 3], new THREE.Vector3());
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.vy = 0;
  }

  /** One fixed step. cameraYaw orients IJKL movement. */
  update(dt: number, cameraYaw: number): void {
    const tr = this.body.translation();

    // fell off the world (no seafloor yet) → back aboard
    const shipY = this.ship.body.translation().y;
    if (tr.y < shipY - 15) {
      this.respawn();
      return;
    }

    // input in camera-yaw frame
    let mx = 0;
    let mz = 0;
    if (this.keys.has("KeyI")) mx += 1;
    if (this.keys.has("KeyK")) mx -= 1;
    if (this.keys.has("KeyJ")) mz -= 1;
    if (this.keys.has("KeyL")) mz += 1;
    const len = Math.hypot(mx, mz) || 1;
    const SPEED = 3.2;
    const fx = (Math.cos(cameraYaw) * mx - Math.sin(cameraYaw) * mz) * (SPEED / len);
    const fz = (Math.sin(cameraYaw) * mx + Math.cos(cameraYaw) * mz) * (SPEED / len);

    // gravity + jump
    const grounded = this.controller.computedGrounded();
    if (grounded) {
      this.vy = this.keys.has("KeyU") ? 5.5 : Math.max(this.vy, -0.5);
    } else {
      this.vy = Math.max(this.vy - G * dt, -18); // clamp: no trimesh tunneling
    }

    // deck-carry: ship surface velocity at the character's position
    const sv = this.ship.body.linvel();
    const om = this.ship.body.angvel();
    const com = this.ship.body.worldCom();
    const rx = tr.x - com.x;
    const ry = tr.y - com.y;
    const rz = tr.z - com.z;
    const carryX = sv.x + om.y * rz - om.z * ry;
    const carryY = sv.y + om.z * rx - om.x * rz;
    const carryZ = sv.z + om.x * ry - om.y * rx;

    const desired = {
      x: (fx + carryX) * dt,
      y: (this.vy + carryY) * dt,
      z: (fz + carryZ) * dt,
    };
    this.controller.computeColliderMovement(this.collider, desired);
    const moved = this.controller.computedMovement();
    this.body.setNextKinematicTranslation({
      x: tr.x + moved.x,
      y: tr.y + moved.y,
      z: tr.z + moved.z,
    });

    this.mesh.position.set(tr.x + moved.x, tr.y + moved.y + 0.85, tr.z + moved.z);
  }
}
