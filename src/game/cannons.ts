import * as THREE from "three";
import { G, VOXEL_SIZE } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import type { Effects } from "../render/effects";
import type { Ship } from "./ship";

/**
 * Broadside batteries + pooled cannonball projectiles. Projectiles are
 * integrated manually (quadratic drag + gravity) — not rapier bodies — and
 * ray-march against target ships' voxel grids for impact detection.
 */
const MUZZLE_SPEED = 55; // m/s
const BALL_DRAG = 0.006;
const MAX_BALLS = 64;
const STAGGER = 0.11; // s between barrels in a broadside
const BLAST_RADIUS_VOX = 1.7;

interface Ball {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  prev: THREE.Vector3;
  age: number;
  mesh: THREE.Mesh;
}

export class Cannons {
  private balls: Ball[] = [];
  private pendingShots: { delay: number; side: 1 | -1; portIndex: number }[] = [];
  reloadAt = 0; // simTime when the next broadside is allowed
  static RELOAD = 6; // s

  private tmpV = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private effects: Effects,
  ) {
    const geo = new THREE.SphereGeometry(0.16, 8, 8);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5, metalness: 0.6 });
    for (let i = 0; i < MAX_BALLS; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.balls.push({
        alive: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        prev: new THREE.Vector3(),
        age: 0,
        mesh,
      });
    }
  }

  /** Queue a full broadside from one side of the ship. */
  fireBroadside(ship: Ship, side: 1 | -1, simTime: number, elevationDeg = 5): boolean {
    if (simTime < this.reloadAt) return false;
    this.reloadAt = simTime + Cannons.RELOAD;
    let i = 0;
    for (let p = 0; p < ship.build.cannonPorts.length; p++) {
      if (ship.build.cannonPorts[p].side !== side) continue;
      this.pendingShots.push({ delay: i * STAGGER, side, portIndex: p });
      i++;
    }
    this.elevation = elevationDeg;
    this.owner = ship;
    return true;
  }

  private elevation = 5;
  private owner: Ship | null = null;

  /** Advance projectiles + pending shots one fixed step. */
  update(dt: number, simTime: number, waves: Wave[], targets: Ship[]): void {
    // launch pending barrels
    for (const shot of this.pendingShots) shot.delay -= dt;
    for (let s = this.pendingShots.length - 1; s >= 0; s--) {
      const shot = this.pendingShots[s];
      if (shot.delay > 0) continue;
      this.pendingShots.splice(s, 1);
      if (!this.owner) continue;
      const port = this.owner.build.cannonPorts[shot.portIndex];
      const muzzleLocal: [number, number, number] = [
        (port.x + 0.5) * VOXEL_SIZE,
        (port.y + 0.5) * VOXEL_SIZE,
        (port.z + 0.5 + shot.side * 1.2) * VOXEL_SIZE,
      ];
      const muzzle = this.owner.localToWorld(muzzleLocal, this.tmpV.clone());

      // fire perpendicular to the hull on the chosen side, elevated
      const rot = this.owner.body.rotation();
      const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
      const dir = this.tmpDir.set(0, 0, shot.side).applyQuaternion(q);
      dir.y = 0;
      dir.normalize();
      const el = (this.elevation * Math.PI) / 180;
      dir.y = Math.tan(el);
      dir.normalize();

      this.launch(muzzle, dir);
      this.effects.muzzleSmoke(muzzle, dir);
    }

    // integrate balls
    for (const b of this.balls) {
      if (!b.alive) continue;
      b.age += dt;
      if (b.age > 9) {
        this.kill(b);
        continue;
      }
      b.prev.copy(b.pos);
      const v = b.vel.length();
      b.vel.x += -BALL_DRAG * v * b.vel.x * dt;
      b.vel.y += (-G - BALL_DRAG * v * b.vel.y) * dt;
      b.vel.z += -BALL_DRAG * v * b.vel.z * dt;
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);

      // water splash
      const sy = surfaceHeight(waves, b.pos.x, b.pos.z, simTime);
      if (b.pos.y < sy) {
        this.effects.splash(b.pos.x, sy, b.pos.z, 1);
        this.kill(b);
        continue;
      }

      // voxel impact: march the segment prev→pos through each target grid
      for (const ship of targets) {
        const hit = this.marchGrid(ship, b.prev, b.pos);
        if (hit) {
          const removed = ship.applyDamage(hit.cell, BLAST_RADIUS_VOX);
          if (removed > 0) {
            const normal = this.tmpDir.copy(b.vel).normalize().negate();
            this.effects.splinters(hit.world, normal);
            // momentum transfer (6 kg ball)
            ship.body.applyImpulseAtPoint(
              { x: b.vel.x * 6, y: b.vel.y * 6, z: b.vel.z * 6 },
              { x: hit.world.x, y: hit.world.y, z: hit.world.z },
              true,
            );
          }
          this.kill(b);
          break;
        }
      }
    }
  }

  private launch(pos: THREE.Vector3, dir: THREE.Vector3): void {
    const b = this.balls.find((x) => !x.alive);
    if (!b) return;
    b.alive = true;
    b.age = 0;
    b.pos.copy(pos);
    b.prev.copy(pos);
    b.vel.copy(dir).multiplyScalar(MUZZLE_SPEED);
    b.mesh.visible = true;
    b.mesh.position.copy(pos);
  }

  private kill(b: Ball): void {
    b.alive = false;
    b.mesh.visible = false;
  }

  /** Step along the world segment, checking the ship's grid every quarter-voxel. */
  private marchGrid(
    ship: Ship,
    from: THREE.Vector3,
    to: THREE.Vector3,
  ): { cell: [number, number, number]; world: THREE.Vector3 } | null {
    const tr = ship.body.translation();
    const rot = ship.body.rotation();
    const inv = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w).invert();

    const stepLen = VOXEL_SIZE * 0.5;
    const seg = this.tmpV.copy(to).sub(from);
    const len = seg.length();
    if (len < 1e-6) return null;
    const steps = Math.max(Math.ceil(len / stepLen), 1);

    const p = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      p.copy(from).addScaledVector(seg, i / steps);
      // world → ship local
      const lx = p.x - tr.x;
      const ly = p.y - tr.y;
      const lz = p.z - tr.z;
      const local = new THREE.Vector3(lx, ly, lz).applyQuaternion(inv);
      const cx = Math.floor(local.x / VOXEL_SIZE);
      const cy = Math.floor(local.y / VOXEL_SIZE);
      const cz = Math.floor(local.z / VOXEL_SIZE);
      if (ship.build.grid.isSolid(cx, cy, cz)) {
        return { cell: [cx, cy, cz], world: p.clone() };
      }
    }
    return null;
  }
}
