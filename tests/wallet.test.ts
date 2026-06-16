import { describe, it, expect } from "vitest";
import { Wallet } from "../src/game/wallet";
import { MessageBus } from "../src/game/messageBus";

describe("Wallet", () => {
  it("starts at the given balance and adds", () => {
    const w = new Wallet(100);
    w.add(50);
    expect(w.gold).toBe(150);
  });
  it("spends only when affordable", () => {
    const w = new Wallet(40);
    expect(w.spend(50)).toBe(false);
    expect(w.gold).toBe(40);
    expect(w.spend(30)).toBe(true);
    expect(w.gold).toBe(10);
  });
  it("set overwrites (mirror from economy)", () => {
    const w = new Wallet(0);
    w.set(999);
    expect(w.gold).toBe(999);
  });
});

describe("MessageBus", () => {
  it("holds the latest message until cleared", () => {
    const m = new MessageBus();
    expect(m.current).toBe("");
    m.post("ahoy");
    expect(m.current).toBe("ahoy");
    m.clear();
    expect(m.current).toBe("");
  });
});
