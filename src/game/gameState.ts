import { Wallet } from "./wallet";
import { MessageBus } from "./messageBus";

export type GameMode = "career" | "sandbox";
export type GamePhase = "menu" | "playing" | "port" | "paused";

/**
 * The game-shell state: which mode + phase we're in, plus the shared wallet and
 * toast channel. The render loop reads {@link isSimRunning} to decide whether to
 * advance `world.step()` — the sim only runs in the `playing` phase, so the menu,
 * pause screen, and port all freeze the world without touching the sim internals
 * (keeping the deterministic fixed-step oracle intact).
 */
export class GameState {
  mode: GameMode = "career";
  phase: GamePhase = "menu";
  readonly wallet = new Wallet(0);
  readonly msg = new MessageBus();

  isSimRunning(): boolean {
    return this.phase === "playing";
  }
  isSandbox(): boolean {
    return this.mode === "sandbox";
  }

  startGame(mode: GameMode): void {
    this.mode = mode;
    this.phase = "playing";
  }
  pause(): void {
    if (this.phase === "playing") this.phase = "paused";
  }
  resume(): void {
    if (this.phase === "paused") this.phase = "playing";
  }
  enterPort(): void {
    this.phase = "port";
  }
  leavePort(): void {
    this.phase = "playing";
  }
  quitToMenu(): void {
    this.phase = "menu";
  }
}
