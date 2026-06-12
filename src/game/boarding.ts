import * as THREE from "three";
import type { Wave } from "../sim/gerstner";
import type { Effects } from "../render/effects";
import { Pirate } from "./crew";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

/**
 * Boarding: enemy crew defend their deck, the player fights on foot
 * (F slash, C kick), ships lash together with the grapple (G), and the
 * prize is a physical gold chest — carry it home to bank it.
 */
const SLASH_RANGE = 2.0;
const SLASH_ARC = Math.PI * 0.42;
const ENEMY_SLASH_CD = 1.7; // mobs of four must not blend into a blender
const PLAYER_SLASH_CD = 0.45;
const KICK_CD = 0.9;
const KICK_PUSH = 4.2; // m of displacement burst over a few frames

export class BoardingSystem {
  player: Pirate | null = null;
  enemies: Pirate[] = [];
  playerHp = 5;
  gold = 0;
  grappled = false;
  chestCarried = false;
  chestBanked = false;
  message = "";

  private chest: THREE.Mesh;
  private slashCd = 0;
  private kickCd = 0;
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(
    private phys: Physics,
    private scene: THREE.Scene,
    private effects: Effects,
    private playerShip: Ship,
    private enemyShip: Ship,
  ) {
    // enemy crew spawn DEFERRED until the ships settle from splash-down —
    // spawning at t=0 dropped them into the sea (playtest bug)

    // the prize: an overflowing gold chest on the enemy quarterdeck
    const chestGroup = new THREE.Mesh(
      new THREE.BoxGeometry(0.8, 0.5, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x4a2e14, roughness: 0.7 }),
    );
    const goldHeap = new THREE.Mesh(
      new THREE.SphereGeometry(0.34, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0xd4a017,
        roughness: 0.25,
        metalness: 0.85,
        emissive: 0x453205,
        emissiveIntensity: 0.6,
      }),
    );
    goldHeap.position.y = 0.22;
    goldHeap.scale.set(1.05, 0.7, 0.75);
    chestGroup.add(goldHeap);
    chestGroup.castShadow = true;
    this.chest = chestGroup;
    this.chest.position.set(4.2, 3.6, 3); // enemy-ship local, near the stern
    enemyShip.visual.group.add(this.chest);
  }

  private crewSpawned = false;

  /** Walk-surface height in local meters at a station (quarterdecks rise). */
  private deckTop(ship: Ship, xM = 4): number {
    return (ship.build.deckYAt(Math.round(xM / 0.25)) + 2) * 0.25;
  }

  /** Centerline z in local meters. */
  private midZ(ship: Ship): number {
    return ship.build.footprint.zC;
  }

  /** Spawn crews shortly after launch — pirates are anchored in their
   *  ship's frame now, so they ride the splash-down instead of missing it. */
  private ensureCrew(simTime: number): void {
    if (this.crewSpawned || simTime < 1.5) return;
    this.crewSpawned = true;
    const dt = this.deckTop(this.enemyShip);
    const posts: [number, number, number][] = [
      [10, dt, 4],
      [14, dt, 3.2],
      [17, dt, 4.8],
      [12, dt, 5.2],
    ];
    const looks = ["henry", "mako", "sharky", "anne"] as const;
    posts.forEach((p, i) => {
      const pirate = new Pirate(this.phys, this.scene, this.enemyShip, "enemy", p, 0x4a2330, 0x802020, looks[i % looks.length]);
      pirate.slashCd = Math.random() * ENEMY_SLASH_CD; // desync the mob
      this.enemies.push(pirate);
    });
    this.chest.position.set(4.2, dt, 4);
  }

  /** Put the player pirate at the helm of their own ship. */
  spawnPlayer(): void {
    if (this.player) return;
    this.player = new Pirate(
      this.phys,
      this.scene,
      this.playerShip,
      "player",
      [4.2, this.deckTop(this.playerShip, 4.2), this.midZ(this.playerShip)],
      0x1d3a52,
      0x1c6e6e,
      "captain",
    );
  }

  shipsRange(): number {
    const a = this.playerShip.body.translation();
    const b = this.enemyShip.body.translation();
    return Math.hypot(b.x - a.x, b.z - a.z);
  }

  toggleGrapple(): void {
    if (this.grappled) {
      this.grappled = false;
      this.message = "grapple cut loose";
    } else if (this.shipsRange() < 18) {
      this.grappled = true;
      this.message = "GRAPPLED — haul alongside and board!";
    } else {
      this.message = "too far to grapple (need <18m)";
    }
  }

  /** One fixed step. Returns whether the player pirate died this step. */
  update(
    dt: number,
    simTime: number,
    waves: Wave[],
    input: { moveX: number; moveZ: number; jump: boolean; slash: boolean; kick: boolean; interact: boolean },
    onFoot: boolean,
  ): boolean {
    this.ensureCrew(simTime);
    this.slashCd = Math.max(this.slashCd - dt, 0);
    this.kickCd = Math.max(this.kickCd - dt, 0);
    let playerDied = false;

    // grapple: pull the hulls alongside with anchored forces
    if (this.grappled) {
      const a = this.playerShip.body.translation();
      const b = this.enemyShip.body.translation();
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dist = Math.hypot(dx, dz) || 1;
      if (dist > 9) {
        const pull = Math.min((dist - 9) * 28000, 220000);
        const fx = (dx / dist) * pull;
        const fz = (dz / dist) * pull;
        this.playerShip.body.addForce({ x: fx, y: 0, z: fz }, true);
        this.enemyShip.body.addForce({ x: -fx, y: 0, z: -fz }, true);
      }
      // damp relative drift so the lash holds
      const va = this.playerShip.body.linvel();
      const vb = this.enemyShip.body.linvel();
      const rvx = vb.x - va.x;
      const rvz = vb.z - va.z;
      const damp = 9000;
      this.playerShip.body.addForce({ x: rvx * damp * dt * 60, y: 0, z: rvz * damp * dt * 60 }, true);
      this.enemyShip.body.addForce({ x: -rvx * damp * dt * 60, y: 0, z: -rvz * damp * dt * 60 }, true);
    }

    // the captain is always aboard once the ship is in the water
    if (!this.player && simTime > 1.5) this.spawnPlayer();

    // ---- player pirate ----
    if (this.player) {
      // ride whichever hull is underfoot
      this.player.ship = this.nearestShip(this.player);
      if (onFoot) {
        this.player.step(dt, input.moveX, input.moveZ, input.jump, waves, simTime);
      } else {
        // at the wheel the caller pins the body — keep the animation alive
        this.player.idleTick(dt);
      }

      if (onFoot && input.slash && this.slashCd <= 0) {
        this.slashCd = PLAYER_SLASH_CD;
        this.player.attackTimer = 0.28;
        this.swing(this.player, this.enemies, 1);
      }
      if (onFoot && input.kick && this.kickCd <= 0) {
        this.kickCd = KICK_CD;
        this.player.kickTimer = 0.3;
        this.kick(this.player, this.enemies);
      }

      // chest pickup / hauling / banking
      if (onFoot) this.updateChest(input.interact);

      // drowning / overboard with no rescue is non-lethal for now: respawn aboard
      const pt = this.player.worldPos(this.tmpA);
      const st = this.playerShip.body.translation();
      const adrift = Math.hypot(pt.x - st.x, pt.z - st.z);
      if (pt.y < st.y - 14 || (this.player.swimming && adrift > 30)) {
        this.respawnPlayer();
        this.message = "your crew fishes you out of the sea";
      }
    }

    // ---- enemy crew AI ----
    for (const e of this.enemies) {
      if (!e.alive) {
        e.step(dt, 0, 0, false, waves, simTime);
        continue;
      }
      e.ship = this.nearestShip(e);
      e.slashCd = Math.max(e.slashCd - dt, 0);
      let mx = 0;
      let mz = 0;
      if (this.player && onFoot) {
        const pp = this.player.worldPos(this.tmpA);
        const ep = e.worldPos(this.tmpB);
        const dx = pp.x - ep.x;
        const dz = pp.z - ep.z;
        const dist = Math.hypot(dx, dz);
        const engaged = this.grappled || dist < 22;
        if (engaged && dist > 1.5) {
          mx = dx / dist;
          mz = dz / dist;
        }
        if (engaged && dist < SLASH_RANGE && e.slashCd <= 0) {
          e.slashCd = ENEMY_SLASH_CD;
          e.attackTimer = 0.28;
          e.facing = Math.atan2(dz, dx);
          this.effects.blood(pp.x, pp.y + 0.9, pp.z);
          this.playerHp -= 1;
          if (this.playerHp <= 0) {
            playerDied = true;
            this.respawnPlayer();
          }
        }
      }
      e.step(dt, mx, mz, false, waves, simTime);
    }

    // bury the dead
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].doneFor(waves, simTime)) {
        this.enemies[i].dispose(this.scene);
        this.enemies.splice(i, 1);
      }
    }

    return playerDied;
  }

  enemiesLeft(): number {
    return this.enemies.filter((e) => e.alive).length;
  }

  private respawnPlayer(): void {
    if (!this.player) return;
    this.playerHp = 5;
    if (this.chestCarried) {
      // the chest goes down with you — back to the enemy deck it falls
      this.chestCarried = false;
      this.player.mesh.remove(this.chest);
      this.enemyShip.visual.group.add(this.chest);
      this.chest.position.set(4.2, this.deckTop(this.enemyShip), 3);
      this.message = "you lost the chest overboard!";
    }
    this.player.ship = this.playerShip;
    const p = this.playerShip.localToWorld(
      [4.2, this.deckTop(this.playerShip, 4.2) + 1, this.midZ(this.playerShip)],
      this.tmpA,
    );
    this.player.teleport(p);
  }

  private nearestShip(p: Pirate): Ship {
    const t = p.body.translation();
    const a = this.playerShip.body.translation();
    const b = this.enemyShip.body.translation();
    const af = this.playerShip.build.footprint;
    const bf = this.enemyShip.build.footprint;
    const da = Math.hypot(a.x + (af.minX + af.maxX) / 2 - t.x, a.z + af.zC - t.z);
    const db = Math.hypot(b.x + (bf.minX + bf.maxX) / 2 - t.x, b.z + bf.zC - t.z);
    return da <= db ? this.playerShip : this.enemyShip;
  }

  private swing(attacker: Pirate, targets: Pirate[], dmg: number): void {
    const ap = attacker.worldPos(this.tmpA);
    for (const t of targets) {
      if (!t.alive) continue;
      const tp = t.worldPos(this.tmpB);
      const dx = tp.x - ap.x;
      const dz = tp.z - ap.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SLASH_RANGE) continue;
      const ang = Math.abs(this.angleDelta(Math.atan2(dz, dx), attacker.facing));
      if (ang > SLASH_ARC) continue;
      if (t.hurt(dmg, this.effects)) this.message = "enemy down!";
    }
  }

  private kick(attacker: Pirate, targets: Pirate[]): void {
    const ap = attacker.worldPos(this.tmpA);
    for (const t of targets) {
      if (!t.alive) continue;
      const tp = t.worldPos(this.tmpB);
      const dx = tp.x - ap.x;
      const dz = tp.z - ap.z;
      const dist = Math.hypot(dx, dz);
      if (dist > SLASH_RANGE * 0.9) continue;
      const ang = Math.abs(this.angleDelta(Math.atan2(dz, dx), attacker.facing));
      if (ang > SLASH_ARC) continue;
      // a boot's worth of displacement — repeated over a few steps via shove
      t.shove((dx / dist) * (KICK_PUSH / 4.2), (dz / dist) * (KICK_PUSH / 4.2));
      this.message = "kicked!";
    }
  }

  private updateChest(interact: boolean): void {
    if (!this.player || this.chestBanked) return;
    const pp = this.player.worldPos(this.tmpA);

    if (this.chestCarried) {
      // bank when back near your own quarterdeck
      const home = this.playerShip.localToWorld(
        [3.4, this.deckTop(this.playerShip, 3.4), this.midZ(this.playerShip)],
        this.tmpB,
      );
      if (Math.hypot(home.x - pp.x, home.y - pp.y, home.z - pp.z) < 3.2) {
        this.chestBanked = true;
        this.chestCarried = false;
        this.gold += 500;
        this.scene.remove(this.chest);
        this.player.mesh.remove(this.chest);
        this.message = "GOLD SECURED +500";
      }
      return;
    }

    if (!interact) return;
    // pick up: chest sits on the enemy ship; must be close
    const cw = this.chest.getWorldPosition(this.tmpB);
    if (Math.hypot(cw.x - pp.x, cw.y - pp.y, cw.z - pp.z) < 2.4) {
      this.chestCarried = true;
      this.enemyShip.visual.group.remove(this.chest);
      this.player.mesh.add(this.chest);
      this.chest.position.set(0, 2.05, 0); // hoisted overhead, lid open, gold gleaming
      this.message = "chest hoisted — get it home! (you can't fight while carrying)";
    }
  }

  /** While carrying, the player can't swing. */
  canFight(): boolean {
    return !this.chestCarried;
  }

  private angleDelta(a: number, b: number): number {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  }
}
