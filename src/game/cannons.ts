import * as THREE from "three";
import { G, VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import type { Effects } from "../render/effects";
import { muzzleWorld, velocityAtPoint, type GunFacing, type MuzzleOut } from "./gunnery";
import type { Ship } from "./ship";

/**
 * Broadside batteries + pooled cannonball projectiles. Projectiles are
 * integrated manually (quadratic drag + gravity) — not rapier bodies — and
 * ray-march against target ships' voxel grids for impact detection.
 */
const MAX_BALLS = 64;

interface Ball {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  prev: THREE.Vector3;
  age: number;
  mesh: THREE.Mesh;
}

/** Live aim for a battery: read at the MOMENT each gun fires, not when the click landed.
 *  A scalar pair is also accepted (AI passes fixed numbers) and frozen into a constant aim. */
export type AimProvider = () => { elevationDeg: number; traverseDeg: number };

export class Cannons {
  private balls: Ball[] = [];
  private pendingShots: {
    delay: number;
    portIndex: number;
    owner: Ship;
    /** Read at LAUNCH so a gun still in the queue fires along the aim you're holding
     *  NOW, not the aim at click-time (later guns in a ripple track your live aim). */
    aim: AimProvider;
  }[] = [];

  /** A gun bears for this battery key: a number selects a broadside (by side, chasers
   *  excluded); "fore"/"aft" selects the chasers. */
  private bears(port: { side: 1 | -1; facing?: GunFacing }, key: 1 | -1 | GunFacing): boolean {
    return typeof key === "number" ? !port.facing && port.side === key : port.facing === key;
  }
  /** Per-port reload clocks (simTime when that gun is loaded again) —
   *  firing one gun from the deck must not lock the whole battery. */
  private portReloadAt = new Map<string, number>();
  static RELOAD = 6; // s — player battery; AI crews pass a slower reload
  /** Reload UPGRADE multiplier (≤1 = faster). Per-instance, so the "Faster Reload"
   *  upgrade speeds ONLY the player's battery; the AI captains keep their own at 1. */
  reloadMul = 1;
  /** Dev panel "semi-auto": when true every gun is treated as always loaded — the
   *  reload wait is removed, nothing else changes (you still click each shot). Per
   *  instance, so flipping the player's panel can't speed up the AI's own battery. */
  noReload = false;

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
    if (this.noReload) return 0;
    return Math.max((this.portReloadAt.get(this.portKey(ship, portIndex)) ?? 0) - simTime, 0);
  }

  /** How many of a ship's live guns are loaded RIGHT NOW (across every battery). main.ts
   *  watches this for the player ship: when it jumps up, a fresh gun (or a whole broadside)
   *  just finished reloading — the cue to ring the reload bell. */
  readyCount(ship: Ship, simTime: number): number {
    let ready = 0;
    for (let p = 0; p < ship.build.cannonPorts.length; p++) {
      if (!ship.cannonAlive[p]) continue;
      if (this.portReload(ship, p, simTime) <= 0) ready++;
    }
    return ready;
  }

  /** Fraction of a battery's guns currently loaded, for the HUD (side, or "fore"/"aft"). */
  sideReadiness(ship: Ship, key: 1 | -1 | GunFacing, simTime: number): number {
    let total = 0;
    let ready = 0;
    for (let p = 0; p < ship.build.cannonPorts.length; p++) {
      if (!this.bears(ship.build.cannonPorts[p], key)) continue;
      if (!ship.cannonAlive[p]) continue; // a dismounted gun is neither ready nor counted
      total++;
      if (this.portReload(ship, p, simTime) <= 0) ready++;
    }
    return total > 0 ? ready / total : 0;
  }

  private tmpV = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private tmpMuzzle: MuzzleOut = { pos: new THREE.Vector3(), dir: new THREE.Vector3() };
  private tmpQ = new THREE.Quaternion();
  private tmpLocal = new THREE.Vector3();
  private tmpLocalDir = new THREE.Vector3();

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

  /** Queue a battery: every LOADED gun that bears for `key` fires (a broadside by side,
   *  or the bow/stern chasers for "fore"/"aft").
   *
   *  `aim` is read PER GUN at the instant it actually fires, not at click time — so when a
   *  ripple volley is mid-flight and you swing your aim, the guns still queued follow the NEW
   *  trajectory. The bearing/side (which guns fire) is decided here at click; only the aim
   *  direction tracks. The player passes a live provider over `controls`; the AI passes fixed
   *  scalars (frozen into a constant aim). The aim-arc preview reads the same live controls,
   *  so line ≡ ball holds. */
  fireBroadside(
    ship: Ship,
    key: 1 | -1 | GunFacing,
    simTime: number,
    aim: AimProvider | number = 5,
    traverseDeg = 0,
  ): boolean {
    // scalar form (AI / tests): freeze the two numbers into a constant provider.
    const provider: AimProvider =
      typeof aim === "number" ? () => ({ elevationDeg: aim, traverseDeg }) : aim;
    let i = 0;
    const spread = Math.max(0, TUN.gun.broadsideSpread);
    for (let p = 0; p < ship.build.cannonPorts.length; p++) {
      if (!this.bears(ship.build.cannonPorts[p], key)) continue;
      if (!ship.cannonAlive[p]) continue; // a gun off its mount can't fire (player + AI)
      if (this.portReload(ship, p, simTime) > 0) continue;
      this.portReloadAt.set(this.portKey(ship, p), simTime + this.reloadS * this.reloadMul);
      // Ragged volley: the first bearing gun fires immediately (click feedback); the rest are
      // scattered across `spread` seconds so the battery ripples instead of cracking as one.
      this.pendingShots.push({
        delay: i === 0 ? 0 : Math.random() * spread,
        portIndex: p,
        owner: ship,
        aim: provider,
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
      // read the aim NOW, at launch — a gun still queued from an earlier click swings to
      // wherever you're aiming at THIS instant (live-aim tracking through a ripple volley).
      const a = shot.aim();
      const m = muzzleWorld(shot.owner, shot.portIndex, a.elevationDeg, a.traverseDeg, this.tmpMuzzle);
      velocityAtPoint(shot.owner, m.pos, this.tmpV);
      this.launch(m.pos, m.dir, this.tmpV);
      this.effects.muzzleFlash(m.pos, m.dir);
      this.effects.muzzleSmoke(m.pos, m.dir);
      this.effects.cannonBoom(m.pos);
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
      const drag = TUN.gun.drag;
      b.vel.x += -drag * v * b.vel.x * dt;
      b.vel.y += (-G - drag * v * b.vel.y) * dt;
      b.vel.z += -drag * v * b.vel.z * dt;
      b.pos.addScaledVector(b.vel, dt);
      b.mesh.position.copy(b.pos);

      // vapor contrail: a thin near-white streak dropped at the ball each step, fading over
      // ~0.4 s (the "supersonic bubbles" the player wanted). Render-only — never feeds the sim.
      this.effects.tracer(b.pos.x, b.pos.y, b.pos.z);

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
          // paint a ragged shot hole into the sail's alphaMap (the sail keeps its shape).
          ship.visual.puncture(s.rec, s.y, s.z);
          ship.hitSail(s.rec.mastIdx);
          this.effects.muzzleSmoke(b.pos, this.tmpDir.copy(b.vel).normalize());
        }
        if (rig.stop) {
          if (rig.stop.kind === "mast") ship.hitMast(rig.stop.mi, rig.stop.localY);
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
          // poke a hole through, but DEPTH IS EMERGENT: the ball spends its kinetic energy
          // boring along its path through the shared crush() core — a fast ball punches clean
          // out the far side, a slow one lodges, an iron belt stops it. boreRadiusVox sets only
          // the candidate-path WIDTH; how far the budget reaches down it is physics, not a cap.
          // Same primitive as ramming, just smaller + faster. Removed voxels → dust, never beams.
          const dir = this.tmpDir.copy(b.vel).normalize();
          const ke = 0.5 * TUN.gun.mass * b.vel.lengthSq(); // joules carried by the ball
          const { removed } = ship.crush(this.boreCells(ship, hit.world, dir), ke * TUN.gun.crushEfficiency);
          if (removed > 0) {
            // debris MATCHES the damage: ~one flying mote per voxel removed, thrown out
            // along the bore (dir negated → points outward). No sparks-and-flash storm.
            this.effects.impactDebris(hit.world, dir.negate(), removed);
            // a quick visible blast (flash + hot sparks + smoke puff) ON TOP of the timber
            // chunks, so the player clearly sees WHERE the shot landed.
            this.effects.impactBlast(hit.world);
            this.effects.impact(hit.world, removed);
            // momentum transfer: ball mass × impact velocity. Mass lives in
            // TUN.gun.mass (r18: dropped 9→4.3 so the faster muzzle doesn't shove
            // ships ~2× harder — see TUN.gun). Round 8: "more powerful".
            const m = TUN.gun.mass;
            ship.body.applyImpulseAtPoint(
              { x: b.vel.x * m, y: b.vel.y * m, z: b.vel.z * m },
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
    b.vel.copy(dir).multiplyScalar(TUN.gun.muzzleSpeed).add(baseVel);
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

  /** Every solid cell the ball's path grazes, ALL the way through the hull — a clean bore,
   *  not a capped cluster. Marches the ray in the ship's local voxel frame from the entry
   *  point, collecting solids within boreRadiusVox of the line, until it has passed out the
   *  far side (or hit the perf backstop maxCellsPerHit). */
  private boreCells(ship: Ship, fromWorld: THREE.Vector3, dirWorld: THREE.Vector3): [number, number, number][] {
    const tr = ship.body.translation();
    const rot = ship.body.rotation();
    const inv = this.tmpQ.set(rot.x, rot.y, rot.z, rot.w).invert();
    // entry point + direction in local VOXEL units
    const lp = this.tmpLocal
      .set(fromWorld.x - tr.x, fromWorld.y - tr.y, fromWorld.z - tr.z)
      .applyQuaternion(inv)
      .divideScalar(VOXEL_SIZE);
    const ld = this.tmpLocalDir.copy(dirWorld).applyQuaternion(inv).normalize();
    const grid = ship.build.grid;
    const [nx, ny, nz] = grid.dims;
    const r = Math.max(0, Math.round(TUN.gun.boreRadiusVox));
    const maxLen = Math.ceil(Math.hypot(nx, ny, nz)) + 2; // grid diagonal, in voxels
    const cap = TUN.gun.maxCellsPerHit;
    const seen = new Set<number>();
    const out: [number, number, number][] = [];
    let enteredSolid = false;
    for (let t = 0; t <= maxLen; t += 0.5) {
      const bx = Math.floor(lp.x + ld.x * t);
      const by = Math.floor(lp.y + ld.y * t);
      const bz = Math.floor(lp.z + ld.z * t);
      // once the ray core has entered the hull and then leaves the grid, the bore is through
      if (bx < -r || by < -r || bz < -r || bx >= nx + r || by >= ny + r || bz >= nz + r) {
        if (enteredSolid) break;
        continue;
      }
      let solidHere = false;
      for (let ox = -r; ox <= r; ox++) {
        for (let oy = -r; oy <= r; oy++) {
          for (let oz = -r; oz <= r; oz++) {
            const x = bx + ox, y = by + oy, z = bz + oz;
            if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
            if (!grid.isSolid(x, y, z)) continue;
            solidHere = true;
            const key = x + nx * (y + ny * z);
            if (!seen.has(key)) { seen.add(key); out.push([x, y, z]); }
          }
        }
      }
      if (solidHere) enteredSolid = true;
      if (out.length >= cap) break;
    }
    return out;
  }
}
