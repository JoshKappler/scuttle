import { describe, it, expect } from "vitest";
import { GameState } from "../src/game/gameState";

describe("GameState", () => {
  it("boots in the menu, sim not running", () => {
    const g = new GameState();
    expect(g.phase).toBe("menu");
    expect(g.isSimRunning()).toBe(false);
  });
  it("startGame enters playing in the chosen mode", () => {
    const g = new GameState();
    g.startGame("career");
    expect(g.mode).toBe("career");
    expect(g.phase).toBe("playing");
    expect(g.isSimRunning()).toBe(true);
  });
  it("pause/resume toggles sim without losing mode", () => {
    const g = new GameState();
    g.startGame("sandbox");
    g.pause();
    expect(g.phase).toBe("paused");
    expect(g.isSimRunning()).toBe(false);
    g.resume();
    expect(g.phase).toBe("playing");
    expect(g.mode).toBe("sandbox");
  });
  it("port freezes the sim and returns to playing on leave", () => {
    const g = new GameState();
    g.startGame("career");
    g.enterPort();
    expect(g.phase).toBe("port");
    expect(g.isSimRunning()).toBe(false);
    g.leavePort();
    expect(g.phase).toBe("playing");
  });
  it("quitToMenu resets phase to menu", () => {
    const g = new GameState();
    g.startGame("career");
    g.quitToMenu();
    expect(g.phase).toBe("menu");
  });
  it("isSandbox reflects the mode", () => {
    const g = new GameState();
    g.startGame("sandbox");
    expect(g.isSandbox()).toBe(true);
  });
});
