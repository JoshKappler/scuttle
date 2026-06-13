import * as THREE from "three";
import { G, VOXEL_SIZE } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import type { Effects } from "../render/effects";
import { BALL_DRAG, MUZZLE_SPEED, muzzleWorld, velocityAtPoint, type MuzzleOut } from "./gunnery";
import type { Ship } from "./ship";

/**
 * Broadside batteries + pooled cannonball projectiles. Projectiles are
 * integrated manually (quadratic drag + gravity) — not rapier bodies — and
 * ray-march against target ships' voxel grids for impact detection.
 */
const MAX_BALLS = 64;
// no stagger: every loaded gun fires the tick you click. Staggered barrels
// launched later balls from a muzzle that had MOVED since the preview was
// drawn — "it's not really firing along where the trajectory line is"
// (playtest round 6: "fire all simultaneously with the left click")
const STAGGER = 0;
// round 8: "faster and more powerful" — bigger bite per ball
const BLAST_RADIUS_VOX = 2.1;

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
  private pendingShots: {
    delay: number;
    side: 1 | -1;
    portIndex: number;
    owner: Ship;
    elevation: number;
    traverse: number;
  }[] = [];
  /** Per-port reload clocks (simTime when that gun is loaded again) —
   *  firing one gun from the deck must not lock the whole battery. */
  private portReloadAt = new Map<string, number>();
  static RELOAD = 6; // s — player battery; AI crews pass a slower reload

  private portKey(ship: Ship, portIndex: number): string {
    return `${this.shipId(ship)}:${portIndex}`;
  }

  private shipIds = new WeakMap<Ship, number>();
  private nextShipId = 1;
  private shipId(ship: Ship): number {
    let id = this.shipIds.get(ship);
    if (id === undefined) {
      id = this.nextShipId++;
      this.shipIds.set(ship, id);
    }
    return id;
  }

  /** Seconds until the given gun is ready (0 = ready). */
  portReload(ship: Ship, portIndex: number, simTime: number): number {
    return Math.max((this.portReloadAt.get(this.portKey(ship, portIndex)) ?? 0) - simTime, 0);
  }

  /** Fraction of one side's guns currently loaded, for the HUD. */
  sideReadiness(ship: Ship, side: 1 | -1, simTime: number): number {
    let total = 0;
    let ready = 0;
    for (let p = 0; p < ship.build.cannonPorts.length; p++) {
      if (ship.build.cannonPorts[p].side !== side) continue;
      total++;
      if (this.portReload(ship, p, simTime) <= 0) ready++;
    }
    return total > 0 ? ready / total : 0;
  }

  private tmpV = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private tmpMuzzle: MuzzleOut = { pos: new THREE.Vector3(), dir: new THREE.Vector3() };

  constructor(
    scene: THREE.Scene,
    private effects: Effects,
    private reloadS = Cannons.RELOAD,
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

  /** Queue a broadside: every LOADED gun on the side fires. */
  fireBroadside(ship: Ship, side: 1 | -1, simTime: number, elevationDeg = 5, traverseDeg = 0): boolean {
    let i = 0;
    for (let p = 0; p < ship.build.cannonPorts.length; p++) {
      if (ship.build.cannonPorts[p].side !== side) continue;
      if (this.portReload(ship, p, simTime) > 0) continue;
      this.portReloadAt.set(this.portKey(ship, p), simTime + this.reloadS);
      this.pendingShots.push({
        delay: i * STAGGER,
        side,
        portIndex: p,
        owner: ship,
        elevation: elevationDeg,
        traverse: traverseDeg,
      });
      i++;
    }
    return i > 0;
  }

  /** Advance projectiles + pending shots one fixed step. */
  update(dt: number, simTime: number, waves: Wave[], targets: Ship[]): void {
    // launch pending barrels
    for (const shot of this.pendingShots) shot.delay -= dt;
    for (let s = this.pendingShots.length - 1; s >= 0; s--) {
      const shot = this.pendingShots[s];
      if (shot.delay > 0) continue;
      this.pendingShots.splice(s, 1);
      // the ball leaves the actual barrel tip, along the actual barrel axis,
      // PLUS the ship's velocity at the muzzle. Round 7 stripped the carry
      // because the preview didn't show it; round 8 put it back the right way
      // around — "I do absolutely want the cannonballs to fire with the
      // ship's velocity vector taken into account … But I also need the
      // outline trajectory to be consistent with that." The aim arc now
      // integrates from the SAME initial velocity, so line ≡ ball, underway
      // or becalmed. (Without carry, broadsides visibly lagged the ship.)
      const m = muzzleWorld(shot.owner, shot.portIndex, shot.elevation, shot.traverse, this.tmpMuzzle);
      velocityAtPoint(shot.owner, m.pos, this.tmpV);
      this.launch(m.pos, m.dir, this.tmpV);
      this.effects.muzzleFlash(m.pos, m.dir);
      this.effects.muzzleSmoke(m.pos, m.dir);
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

      // rig first (round 7): cloth tears and the ball flies on; a mast trunk
      // or the rudder blade stops it cold
      let stopped = false;
      for (const ship of targets) {
        const rig = ship.rigImpacts(b.prev, b.pos);
        for (const s of rig.sails) {
          ship.visual.puncture(s.rec, s.y, s.z);
          ship.hitSail(s.rec.mastIdx);
          this.effects.muzzleSmoke(b.pos, this.tmpDir.copy(b.vel).normalize());
        }
        if (rig.stop) {
          if (rig.stop.kind === "mast") ship.hitMast(rig.stop.mi);
          else ship.hitRudder();
          this.effects.splinters(b.pos, this.tmpDir.copy(b.vel).normalize().negate());
          this.kill(b);
          stopped = true;
          break;
        }
      }
      if (stopped) continue;

      // voxel impact: march the segment prev→pos through each target grid
      for (const ship of targets) {
        const hit = this.marchGrid(ship, b.prev, b.pos);
        if (hit) {
          const removed = ship.applyDamage(hit.cell, BLAST_RADIUS_VOX);
          if (removed > 0) {
            const normal = this.tmpDir.copy(b.vel).normalize().negate();
            // full drama: splinter storm + sparks + smoke + flash (round 8:
            // "a more dramatic collection of effects when the cannonballs
            // hit the other ship")
            this.effects.impactBurst(hit.world, normal);
            // momentum transfer (9 kg ball — round 8: "more powerful")
            ship.body.applyImpulseAtPoint(
              { x: b.vel.x * 9, y: b.vel.y * 9, z: b.vel.z * 9 },
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

  private launch(pos: THREE.Vector3, dir: THREE.Vector3, baseVel: THREE.Vector3): void {
    const b = this.balls.find((x) => !x.alive);
    if (!b) return;
    b.alive = true;
    b.age = 0;
    b.pos.copy(pos);
    b.prev.copy(pos);
    b.vel.copy(dir).multiplyScalar(MUZZLE_SPEED).add(baseVel);
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
