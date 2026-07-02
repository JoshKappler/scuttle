import { Ship } from "./ship";
import { ShipVisual } from "../render/shipVisual";
import type { Physics } from "./physics";
import type { GameWorld } from "./world";
import type { PortController } from "./port";
import type { FleetManager } from "./fleet";
import type { PlayerCharacter } from "./playerCharacter";
import type { DebrisManager } from "./debris";
import type { MessageBus } from "./messageBus";
import type { ShipTierId } from "./saveState";
import type { ShipBuild } from "../sim/shipwright";
import { tierById } from "./shipyard";

// ---- hull swap (shipyard purchase / save restore / respawn) ----
// Rebuild the player ship as a fresh hull, keeping world position/heading, and
// re-point every system that holds a player-ship reference. Extracted from main.ts
// (round 12, pure move): the COMPLETE rebind list lives HERE; the pieces main.ts
// owns (the live `sloop`/`sloopVisual`/`currentTier` bindings, render hooks, HUD
// flood strip, cutaway carry-over, atWheel) arrive through PlayerShipBinding.

export interface PlayerShipBinding {
  getShip(): Ship;
  setShip(ship: Ship, visual: ShipVisual): void;
  getTier(): ShipTierId;
  setTier(id: ShipTierId): void;
  rebindRenderHooks(): void;
  rebuildFloodSegments(): void;
  reapplyCutaway(): void;
  setAtWheel(v: boolean): void;
}

export interface ShipSwapDeps {
  physics: Physics;
  world: GameWorld;
  port: PortController;
  fleet: FleetManager;
  character: PlayerCharacter;
  debris: DebrisManager;
  msg: MessageBus;
  dock: { nearestDock(x: number, z: number): { x: number; z: number } | null };
  binding: PlayerShipBinding;
}

export class ShipSwap {
  constructor(private readonly d: ShipSwapDeps) {}

  swapPlayerShip(tierId: ShipTierId): void {
    this.d.binding.setTier(tierId);
    this.rebuildPlayerShip(tierById(tierId).build());
    this.d.port.syncAfterLoad(); // account-wide upgrades land on the new hull
  }

  rebuildPlayerShip(build: ShipBuild): void {
    const d = this.d;
    const old = d.binding.getShip();
    const at = old.body.translation();
    const rot = old.body.rotation();
    d.world.removeShip(old); // scene + geometry + rigid-body cleanup
    const visual = new ShipVisual(build);
    const fresh = new Ship(d.physics, build, visual, { x: at.x, y: Math.max(at.y, 0.5), z: at.z });
    fresh.body.setRotation(rot, true);
    fresh.onSevered = (isl) => isl.forEach((i) => d.debris.spawn(i, fresh));
    fresh.onCannonLost = (pi) => d.debris.spawnFallingCannon(fresh, pi);
    fresh.onMastFelled = () => d.msg.post("YOUR MAST GOES BY THE BOARD!");
    fresh.onRudderHit = (hp) => {
      visual.chipRudder(hp / 3);
      d.msg.post(hp > 0 ? "rudder hit — she answers slow!" : "RUDDER SHOT AWAY!");
    };
    d.world.addShip(fresh);
    d.binding.setShip(fresh, visual); // main.ts re-points its live `sloop`/`sloopVisual` lets
    d.world.focus = fresh; // keep the buoyancy LOD focus on the live player hull
    d.port.setShip(fresh);
    d.fleet.setTarget(fresh);
    d.character.setShip(fresh);
    d.binding.rebindRenderHooks();
    d.binding.rebuildFloodSegments(); // new hull → new compartment count → rebuild the flood readout
    d.binding.reapplyCutaway(); // if the cutaway is on, carry it onto the freshly-built hull
  }

  // Respawn a fresh hull of the current tier in clear water just seaward of the home
  // dock, and re-seat the captain at the wheel. (Used by the sink penalty.)
  respawnPlayerAtPort(): void {
    const d = this.d;
    this.rebuildPlayerShip(tierById(d.binding.getTier()).build());
    const sloop = d.binding.getShip(); // the FRESH hull just bound above
    const tr = sloop.body.translation();
    const dock = d.dock.nearestDock(tr.x, tr.z);
    if (dock) {
      sloop.body.setTranslation({ x: dock.x + 54, y: 0.6, z: dock.z }, true);
      sloop.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true); // bow SEAWARD (+x) — sail away from the dock
    }
    sloop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    sloop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    d.port.syncAfterLoad();
    d.character.reseat();
    d.binding.setAtWheel(true); // back at the helm
  }
}
