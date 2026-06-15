import { describe, it, expect } from "vitest";
import { SaveManager, defaultSave } from "../src/game/saveState";

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as unknown as Storage;
}

describe("SaveManager", () => {
  it("returns a default when nothing is stored", () => {
    const sm = new SaveManager(fakeStorage());
    const s = sm.load("career");
    expect(s.shipTier).toBe("cutter");
    expect(s.economy.doubloons).toBe(0);
    expect(s.unlockedClasses).toEqual(["cutter"]);
  });
  it("round-trips a save", () => {
    const store = fakeStorage();
    const sm = new SaveManager(store);
    const s = defaultSave("career");
    s.economy.doubloons = 500;
    s.shipTier = "brig";
    s.unlockedClasses = ["cutter", "sloop", "brig"];
    sm.save("career", s);
    const loaded = new SaveManager(store).load("career");
    expect(loaded.economy.doubloons).toBe(500);
    expect(loaded.shipTier).toBe("brig");
    expect(loaded.unlockedClasses).toContain("brig");
  });
  it("career and sandbox slots are independent", () => {
    const store = fakeStorage();
    const sm = new SaveManager(store);
    const c = defaultSave("career");
    c.economy.doubloons = 100;
    sm.save("career", c);
    const s = defaultSave("sandbox");
    s.economy.doubloons = 999;
    sm.save("sandbox", s);
    expect(sm.load("career").economy.doubloons).toBe(100);
    expect(sm.load("sandbox").economy.doubloons).toBe(999);
  });
  it("wipe clears a slot back to default", () => {
    const store = fakeStorage();
    const sm = new SaveManager(store);
    const c = defaultSave("career");
    c.economy.doubloons = 100;
    sm.save("career", c);
    sm.wipe("career");
    expect(sm.load("career").economy.doubloons).toBe(0);
  });
  it("hasSave reports whether a slot exists", () => {
    const store = fakeStorage();
    const sm = new SaveManager(store);
    expect(sm.hasSave("career")).toBe(false);
    sm.save("career", defaultSave("career"));
    expect(sm.hasSave("career")).toBe(true);
  });
  it("migrates a legacy scuttle.economy.v1 blob into career on first load", () => {
    const store = fakeStorage();
    store.setItem(
      "scuttle.economy.v1",
      JSON.stringify({ version: 1, doubloons: 250, cargo: {}, cargoCapacity: 40, upgrades: {}, notoriety: 3 }),
    );
    const sm = new SaveManager(store);
    const s = sm.load("career");
    expect(s.economy.doubloons).toBe(250);
    expect(s.economy.notoriety).toBe(3);
  });
  it("tolerates garbage JSON → default", () => {
    const store = fakeStorage();
    store.setItem("scuttle.save.career.v1", "{not json");
    expect(new SaveManager(store).load("career").economy.doubloons).toBe(0);
  });
});
