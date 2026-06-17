import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { G, VOXEL_SIZE, VOXEL_VOLUME, WATER_DENSITY } from "../core/constants";
import { TUN } from "../core/tunables";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { MATERIALS } from "../sim/materials";
import { createGrid } from "../sim/voxelGrid";
import { meshChunk } from "../render/voxelMesher";
import { CHUNK_SIZE } from "../core/constants";
import type { Island } from "../sim/connectivity";
import type { Effects } from "../render/effects";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

/**
 * Severed hull islands become dynamic bodies with their own voxel meshes.
 * Small pieces are short-lived flotsam (single-probe Archimedes). BIG pieces
 * — a bow rammed clean off, half a ship (round 7: "if a ship is rammed hard
 * enough, it can actually split in half") — become WRECKS: corner buoyancy
 * probes so they trim and list like a hull, floating at first on entrained
 * air, then waterlogging and foundering over the next minute.
 */
interface DebrisPiece {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  volume: number; // m³
  halfHeight: number;
  age: number;
  /** Local-frame buoyancy probe points (wrecks get four corners). */
  probes: [number, number, number][];
  wreck: boolean;
}

const LIFETIME = 35; // s — small flotsam
const WRECK_LIFETIME = 150; // s — or until it founders below 40 m
/** A severed island at least this many voxels is a wreck, not flotsam. */
export const WRECK_CELLS = 250;
/** Only a GENUINELY large disconnected piece — a ship torn in half — becomes a free
 *  rigid body. Anything smaller is pulverized to DUST, never a "floating beam": the
 *  player's rule is destroyed material is loose voxels/dust, not regrouped rigid chunks. */
export const BIG_SEVER = 1200;

/** Wreck lift multiplier vs age: fresh wreckage rides high on entrained air,
 *  then waterlogs. Wood alone needs ≈×0.5 lift to float — dropping well
 *  below that by a minute in guarantees she founders. */
export function wreckLift(age: number): number {
  return Math.max(1.45 - (age / 45) * 1.05, 0.32);
}

export class DebrisManager {
  private pieces: DebrisPiece[] = [];

  constructor(
    private physics: Physics,
    private scene: THREE.Scene,
    // optional so a 2-arg `new DebrisManager(physics, scene)` (e.g. mid-refactor) still
    // compiles — dust just no-ops without it. Pass it to get pulverization motes.
    private effects?: Effects,
  ) {}

  /** Spawn one debris body from a severed island, in the source ship's frame. */
  spawn(island: Island, ship: Ship): void {
    if (island.cells.length === 0) return;
    // small/medium chunks are dust, not rigid bodies (no floating beams) — only a hull
    // torn clean in half (≥ BIG_SEVER) earns a free-floating wreck.
    if (island.cells.length < BIG_SEVER) { this.dust(island, ship); return; }
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

    const wreck = island.cells.length >= WRECK_CELLS;
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinvel(vel.x + (Math.random() - 0.5), vel.y + (wreck ? 0 : 0.5), vel.z + (Math.random() - 0.5))
      .setAngvel(
        wreck
          ? ship.body.angvel()
          : { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5), z: (Math.random() - 0.5) * 2 },
      )
      .setLinearDamping(wreck ? 0.55 : 0.3)
      .setAngularDamping(wreck ? 1.6 : 1.0);
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

    // wrecks float on four corner probes (trim + list like a hull);
    // flotsam needs only its center
    const probes: [number, number, number][] = wreck
      ? [
          [hx * 0.35, 0, hz * 0.5],
          [hx * 1.65, 0, hz * 0.5],
          [hx * 0.35, 0, hz * 1.5],
          [hx * 1.65, 0, hz * 1.5],
        ]
      : [[hx, hy, hz]];

    this.pieces.push({
      body,
      mesh: group,
      volume: island.cells.length * VOXEL_VOLUME * 1.6, // entrained air bumps wood buoyancy
      halfHeight: hy,
      age: 0,
      probes,
      wreck,
    });
  }

  /** Shared falling-cannon barrel geometry/material (one ~2 m iron tube), built once. */
  private static cannonGeo: THREE.BufferGeometry | null = null;
  private static cannonMat: THREE.Material | null = null;

  /**
   * A cannon whose hull mount has been carved away (ship.loseCannon → onCannonLost): HIDE the static
   * gun mesh and drop a falling cast-iron barrel at its exact world pose, inheriting the ship's
   * velocity plus an OUTBOARD kick so it tips over the rail. It's a low-buoyancy flotsam piece — iron
   * is heavy, so it splashes alongside and sinks (the existing update() Archimedes + lifetime own it).
   * Headless / no-mesh ships no-op (hideCannon returns null).
   */
  spawnFallingCannon(ship: Ship, portIndex: number): void {
    const pose = ship.visual.hideCannon(portIndex);
    if (!pose) return;
    const { world, RAPIER: R } = this.physics;
    const port = ship.build.cannonPorts[portIndex];

    // shared mesh: a stubby iron tube, oriented along its length (x) like the real barrel.
    if (!DebrisManager.cannonGeo) {
      const g = new THREE.CylinderGeometry(0.13, 0.16, 2.0, 10);
      g.rotateZ(Math.PI / 2); // lie the tube along x
      DebrisManager.cannonGeo = g;
      DebrisManager.cannonMat = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.5, metalness: 0.7 });
    }
    const mesh = new THREE.Mesh(DebrisManager.cannonGeo, DebrisManager.cannonMat!);
    mesh.castShadow = true;
    mesh.position.copy(pose.pos);
    mesh.quaternion.copy(pose.quat);
    this.scene.add(mesh);

    // outboard world direction: a broadside gun tips out ±z (its side); a chaser tips out ±x.
    const rot = ship.body.rotation();
    const sq = this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    const outLocal = port.facing
      ? this.tmpP.set(port.facing === "fore" ? 1 : -1, 0, 0)
      : this.tmpP.set(0, 0, port.side);
    const out = outLocal.applyQuaternion(sq).normalize();
    const sv = ship.body.linvel();
    const kick = TUN.gun.fallKick;

    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pose.pos.x, pose.pos.y, pose.pos.z)
      .setRotation({ x: pose.quat.x, y: pose.quat.y, z: pose.quat.z, w: pose.quat.w })
      .setLinvel(sv.x + out.x * kick, sv.y + 0.4, sv.z + out.z * kick)
      .setAngvel({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 2 })
      .setLinearDamping(0.4)
      .setAngularDamping(0.9);
    const body = world.createRigidBody(desc);
    // a slim capsule-ish cuboid around the barrel; density 0 (mass set explicitly below).
    const col = R.ColliderDesc.cuboid(1.0, 0.16, 0.16).setDensity(0);
    world.createCollider(col, body);
    body.setAdditionalMassProperties(
      320, // a real iron 6-pounder barrel is heavy — it pulls itself under
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 40, z: 40 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.pieces.push({
      body,
      mesh,
      // small displacing volume so iron rides LOW and founders fast (a splash, then under).
      volume: 0.22,
      halfHeight: 0.16,
      age: 0,
      probes: [[0, 0, 0]],
      wreck: false,
    });
  }

  private dustTmp = new THREE.Vector3();
  private dustUp = new THREE.Vector3();
  /** A small/medium disconnected chunk does NOT become a rigid body. Its cells were already
   *  removed from the hull by flushDamage; here we just throw a burst of dust motes where it
   *  broke free, so it reads as pulverized (loose voxels), not a detached floating beam. */
  private dust(island: Island, ship: Ship): void {
    let sx = 0, sy = 0, sz = 0;
    for (const c of island.cells) { sx += c.x; sy += c.y; sz += c.z; }
    const n = island.cells.length;
    ship.localToWorld(
      [(sx / n + 0.5) * VOXEL_SIZE, (sy / n + 0.5) * VOXEL_SIZE, (sz / n + 0.5) * VOXEL_SIZE],
      this.dustTmp,
    );
    this.effects?.impactDebris(this.dustTmp, this.dustUp.set(0, 1, 0), Math.min(n, 40));
  }

  private tmpQ = new THREE.Quaternion();
  private tmpP = new THREE.Vector3();

  /** Buoyancy + lifetime for every piece. Call each fixed step. */
  update(dt: number, simTime: number, waves: Wave[]): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      const tr = p.body.translation();
      const lifetime = p.wreck ? WRECK_LIFETIME : LIFETIME;
      if (p.age > lifetime || tr.y < (p.wreck ? -40 : -60)) {
        this.scene.remove(p.mesh);
        this.physics.world.removeRigidBody(p.body);
        this.pieces.splice(i, 1);
        continue;
      }

      p.body.resetForces(true);
      const rot = p.body.rotation();
      this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
      const lift = p.wreck ? wreckLift(p.age) : 1;
      let wet = 0;
      for (const pr of p.probes) {
        this.tmpP.set(pr[0], pr[1], pr[2]).applyQuaternion(this.tmpQ);
        const wx = this.tmpP.x + tr.x;
        const wy = this.tmpP.y + tr.y;
        const wz = this.tmpP.z + tr.z;
        const surf = surfaceHeight(waves, wx, wz, simTime);
        const span = Math.max(p.halfHeight * 2, 0.1);
        const sub = Math.min(Math.max((surf - wy) / span, 0), 1);
        if (sub <= 0) continue;
        wet = Math.max(wet, sub);
        const f = ((WATER_DENSITY * G * p.volume * lift) / p.probes.length) * sub;
        p.body.addForceAtPoint({ x: 0, y: f, z: 0 }, { x: wx, y: wy, z: wz }, true);
      }
      if (wet > 0) {
        const v = p.body.linvel();
        const m = p.body.mass();
        // The vertical buoyancy spring was only ~0.18 of critically damped, so chunks
        // bobbed instead of settling. Raise VERTICAL damping near-critical to kill the
        // bob; keep HORIZONTAL light so wreckage still drifts calmly rather than freezing.
        const kv = m * 6 * wet;
        const kh = m * 0.8 * wet;
        p.body.addForce({ x: -v.x * kh, y: -v.y * kv, z: -v.z * kh }, true);
      }

      // sync visual
      p.mesh.position.set(tr.x, tr.y, tr.z);
      p.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
  }
}
