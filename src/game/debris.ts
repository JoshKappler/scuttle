import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { G, VOXEL_SIZE, VOXEL_VOLUME, WATER_DENSITY } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { MATERIALS } from "../sim/materials";
import { createGrid } from "../sim/voxelGrid";
import { meshChunk } from "../render/voxelMesher";
import { CHUNK_SIZE } from "../core/constants";
import type { Island } from "../sim/connectivity";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

/**
 * Severed hull islands become short-lived dynamic bodies with their own
 * voxel meshes. Wood floats, iron-heavy chunks sink — single-probe Archimedes
 * per piece is plenty at debris scale.
 */
interface DebrisPiece {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  volume: number; // m³
  halfHeight: number;
  age: number;
}

const LIFETIME = 35; // s

export class DebrisManager {
  private pieces: DebrisPiece[] = [];

  constructor(
    private physics: Physics,
    private scene: THREE.Scene,
  ) {}

  /** Spawn one debris body from a severed island, in the source ship's frame. */
  spawn(island: Island, ship: Ship): void {
    if (island.cells.length === 0) return;
    const { world, RAPIER: R } = this.physics;

    // island bounds
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let mass = 0;
    for (const c of island.cells) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
      mass += MATERIALS[c.mat].density * VOXEL_VOLUME;
    }

    // re-grid the island at its bbox origin and greedy-mesh it
    const gnx = maxX - minX + 1;
    const gny = maxY - minY + 1;
    const gnz = maxZ - minZ + 1;
    const grid = createGrid(gnx, gny, gnz);
    for (const c of island.cells) grid.set(c.x - minX, c.y - minY, c.z - minZ, c.mat);

    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
    for (let cx = 0; cx <= Math.floor((gnx - 1) / CHUNK_SIZE); cx++) {
      for (let cy = 0; cy <= Math.floor((gny - 1) / CHUNK_SIZE); cy++) {
        for (let cz = 0; cz <= Math.floor((gnz - 1) / CHUNK_SIZE); cz++) {
          const data = meshChunk(grid, cx, cy, cz);
          if (!data) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
          geo.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
          geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
          const m = new THREE.Mesh(geo, mat);
          m.castShadow = true;
          group.add(m);
        }
      }
    }
    this.scene.add(group);

    // body at the island origin, inheriting the ship's frame + velocity
    const origin = ship.localToWorld(
      [minX * VOXEL_SIZE, minY * VOXEL_SIZE, minZ * VOXEL_SIZE],
      new THREE.Vector3(),
    );
    const rot = ship.body.rotation();
    const vel = ship.body.linvel();
    const hx = (gnx * VOXEL_SIZE) / 2;
    const hy = (gny * VOXEL_SIZE) / 2;
    const hz = (gnz * VOXEL_SIZE) / 2;

    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinvel(vel.x + (Math.random() - 0.5), vel.y + 0.5, vel.z + (Math.random() - 0.5))
      .setAngvel({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5), z: (Math.random() - 0.5) * 2 })
      .setLinearDamping(0.3)
      .setAngularDamping(1.0);
    const body = world.createRigidBody(desc);
    const collider = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(hx, hy, hz).setDensity(0);
    world.createCollider(collider, body);
    body.setAdditionalMassProperties(
      Math.max(mass, 5),
      { x: hx, y: hy, z: hz },
      { x: (mass / 12) * (hy * hy + hz * hz) * 4 + 1, y: (mass / 12) * (hx * hx + hz * hz) * 4 + 1, z: (mass / 12) * (hx * hx + hy * hy) * 4 + 1 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.pieces.push({
      body,
      mesh: group,
      volume: island.cells.length * VOXEL_VOLUME * 1.6, // entrained air bumps wood buoyancy
      halfHeight: hy,
      age: 0,
    });
  }

  /** Buoyancy + lifetime for every piece. Call each fixed step. */
  update(dt: number, simTime: number, waves: Wave[]): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      const tr = p.body.translation();
      if (p.age > LIFETIME || tr.y < -60) {
        this.scene.remove(p.mesh);
        this.physics.world.removeRigidBody(p.body);
        this.pieces.splice(i, 1);
        continue;
      }
      const surf = surfaceHeight(waves, tr.x, tr.z, simTime);
      const com = p.body.worldCom();
      const depth = surf - (com.y - p.halfHeight);
      const sub = Math.min(Math.max(depth / Math.max(p.halfHeight * 2, 0.1), 0), 1);
      if (sub > 0) {
        const f = WATER_DENSITY * G * p.volume * sub;
        p.body.resetForces(true);
        p.body.addForce({ x: 0, y: f, z: 0 }, true);
        const v = p.body.linvel();
        const k = p.body.mass() * 1.2 * sub;
        p.body.addForce({ x: -v.x * k, y: -v.y * k, z: -v.z * k }, true);
      } else {
        p.body.resetForces(true);
      }
      // sync visual
      const rot = p.body.rotation();
      p.mesh.position.set(tr.x, tr.y, tr.z);
      p.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
  }
}
