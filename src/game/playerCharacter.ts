import * as THREE from "three";
import type { Wave } from "../sim/gerstner";
import { Pirate } from "./crew";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

/**
 * The on-foot captain — extracted from the retired BoardingSystem. He walks his
 * own deck, swims, kicks, and toggles first/third person, but spends most of his
 * time at the wheel. Everything boarding-specific (enemy crew, grapple, the prize
 * chest, cross-ship melee) is gone; the gold wallet and toast channel moved to
 * {@link Wallet}/{@link MessageBus}. He only ever rides the player ship now, so
 * the old nearest-hull selection collapses to a single deck.
 */
export class PlayerCharacter {
  player: Pirate | null = null;
  /** Vestigial: there is no enemy melee anymore, so HP never drops. Kept so the
   *  HUD's on-foot health bar stays valid without a special-case. */
  playerHp = 5;

  constructor(
    private phys: Physics,
    private scene: THREE.Scene,
    private playerShip: Ship,
  ) {}

  /** Walk-surface height in local meters at a station (quarterdecks rise). */
  private deckTop(ship: Ship, xM = 4): number {
    return (ship.build.deckYAt(Math.round(xM / 0.25)) + 2) * 0.25;
  }
  private midZ(ship: Ship): number {
    return ship.build.footprint.zC;
  }

  /** Re-point the captain at a freshly-built hull (after a ship swap). */
  setShip(ship: Ship): void {
    this.playerShip = ship;
    if (this.player) this.player.ship = ship;
  }

  /** Put the captain on his own deck. Idempotent. */
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

  /** One fixed step of the on-foot captain. */
  update(
    dt: number,
    simTime: number,
    waves: Wave[],
    input: { moveX: number; moveZ: number; jump: boolean; sprint: boolean; slash: boolean; kick: boolean },
    onFoot: boolean,
  ): void {
    // the captain is always aboard once the ship is in the water
    if (!this.player && simTime > 1.5) this.spawnPlayer();
    if (!this.player) return;

    this.player.ship = this.playerShip; // his own deck is the only deck now
    if (onFoot) {
      this.player.step(dt, input.moveX, input.moveZ, input.jump, waves, simTime, input.sprint);
    } else {
      // at the wheel the caller pins the body — keep the animation alive
      this.player.idleTick(dt);
    }

    if (onFoot && input.slash) this.player.swingAnim(); // a flourish — nothing to hit
    if (onFoot && input.kick) this.player.kickAnim();
  }
}
