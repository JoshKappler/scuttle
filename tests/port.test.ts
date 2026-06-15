import { describe, it, expect, beforeEach } from "vitest";
import { PortController, DevDockProvider } from "../src/game/port";
import { Economy } from "../src/sim/economy";
import { Wallet } from "../src/game/wallet";
import { MessageBus } from "../src/game/messageBus";
import type { Ship } from "../src/game/ship";
import type { PortScreen, PortView } from "../src/render/portScreen";

// --- node localStorage shim (the controller's save/load uses the global) ---
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
});

// --- lightweight fakes (duck-typed; PortController only imports these as types) ---
function fakeShip(over: Partial<Record<string, unknown>> = {}) {
  const ship = {
    columns: [{ cellY: [0, 1, 2] }, { cellY: [0, 1] }], // value = 5 displacing cells
    sailIntegrity: [1, 1],
    mastAlive: [true, true],
    rudderHp: 3,
    rudderEff: 1,
    planks: 8,
    _breaches: 0,
    hasBreaches() {
      return (ship._breaches as number) > 0;
    },
    plugBreach() {
      if (ship.planks > 0 && (ship._breaches as number) > 0) {
        ship.planks--;
        (ship._breaches as number)--;
        return true;
      }
      return false;
    },
    ...over,
  };
  return ship as unknown as Ship & { _breaches: number };
}
function fakeUi() {
  const ui = {
    isOpen: false,
    last: null as PortView | null,
    refreshes: 0,
    open(v: PortView) {
      ui.isOpen = true;
      ui.last = v;
    },
    refresh(v: PortView) {
      ui.last = v;
      ui.refreshes++;
    },
    close() {
      ui.isOpen = false;
    },
  };
  return ui as unknown as PortScreen & { last: PortView | null; refreshes: number };
}

function make(econInit?: ConstructorParameters<typeof Economy>[0]) {
  const economy = new Economy(econInit);
  const ship = fakeShip();
  const wallet = new Wallet(0);
  const msg = new MessageBus();
  const ui = fakeUi() as PortScreen & { last: PortView | null; refreshes: number };
  let pos = { x: 0, z: 0 };
  const port = new PortController({
    economy,
    ship,
    wallet,
    msg,
    ui,
    getPlayerPos: () => pos,
    rand: () => 0.5, // fixed draw → deterministic loot
  });
  return { economy, ship, wallet, msg, ui, port, setPos: (p: { x: number; z: number }) => (pos = p) };
}

describe("PortController — plunder", () => {
  it("turns a kill into doubloons and mirrors them to the wallet", () => {
    const { economy, ship, wallet, msg, port } = make();
    port.plunder(ship);
    expect(economy.state.doubloons).toBeGreaterThan(0);
    expect(wallet.gold).toBe(economy.state.doubloons);
    expect(msg.current).toContain("PLUNDER");
  });
});

describe("PortController — transactions mirror gold and refresh the UI", () => {
  it("sell converts the hold and refreshes", () => {
    const { economy, wallet, ui, port } = make();
    economy.addLoot({ doubloons: 0, cargo: { rum: 3 }, notoriety: 0 });
    port.sell();
    expect(economy.state.doubloons).toBeGreaterThan(0);
    expect(economy.cargoUsed()).toBe(0);
    expect(wallet.gold).toBe(economy.state.doubloons);
    expect((ui as unknown as { refreshes: number }).refreshes).toBeGreaterThan(0);
  });

  it("buying Larger Hold raises cargo capacity and spends gold", () => {
    const { economy, wallet, port } = make({ doubloons: 500 });
    const before = economy.state.cargoCapacity;
    port.buy("hold");
    expect(economy.upgradeLevel("hold")).toBe(1);
    expect(economy.state.cargoCapacity).toBe(before + 20);
    expect(economy.state.doubloons).toBe(300);
    expect(wallet.gold).toBe(300);
  });
});

describe("PortController — repair", () => {
  it("restores rig/rudder/planks and charges for the damage", () => {
    const { economy, ship, port } = make({ doubloons: 300 });
    const s = ship as unknown as {
      sailIntegrity: number[];
      rudderHp: number;
      planks: number;
      _breaches: number;
      hasBreaches(): boolean;
    };
    s.sailIntegrity = [0.5, 0.5];
    s.rudderHp = 1;
    s.planks = 4;
    s._breaches = 1;

    port.repair();

    expect(s.sailIntegrity).toEqual([1, 1]);
    expect(s.rudderHp).toBe(3);
    expect(s.planks).toBe(8);
    expect(s.hasBreaches()).toBe(false);
    expect(economy.state.doubloons).toBeLessThan(300);
  });

  it("is a no-op on a sound hull", () => {
    const { economy, port } = make({ doubloons: 300 });
    port.repair();
    expect(economy.state.doubloons).toBe(300);
  });
});

describe("PortController — persistence (save at the docks)", () => {
  it("save then a fresh load restores the empire and re-applies upgrades", () => {
    const a = make({ doubloons: 500 });
    a.port.buy("hold"); // level 1 → capacity 60, doubloons 300
    a.port.save();

    const b = make(); // fresh economy/ship/wallet, same localStorage
    b.port.load();
    expect(b.economy.state.doubloons).toBe(300);
    expect(b.economy.upgradeLevel("hold")).toBe(1);
    expect(b.economy.state.cargoCapacity).toBe(60); // re-derived from the owned level
    expect(b.wallet.gold).toBe(300);
  });

  it("load with no save falls back to a clean economy", () => {
    const { economy, port } = make();
    port.load();
    expect(economy.state.doubloons).toBe(0);
  });
});

describe("PortController — docking", () => {
  it("flags canDock and surfaces a hint within range, clears it outside", () => {
    const { msg, port, setPos } = make();
    setPos({ x: 5, z: 0 }); // 5 m from the origin dock (< range)
    port.update(0.016);
    expect(port.canDock).toBe(true);
    expect(msg.current).toContain("make port");

    setPos({ x: 100, z: 0 }); // far away
    port.update(0.016);
    expect(port.canDock).toBe(false);
  });

  it("tryDock opens the port screen when in range", () => {
    const { ui, port, setPos } = make();
    setPos({ x: 2, z: 0 });
    port.update(0.016);
    port.tryDock();
    expect((ui as unknown as { isOpen: boolean }).isOpen).toBe(true);
  });

  it("DevDockProvider always offers its fixed anchor", () => {
    const d = new DevDockProvider({ x: 10, y: 0, z: -4 });
    expect(d.nearestDock()).toEqual({ x: 10, y: 0, z: -4 });
  });
});
