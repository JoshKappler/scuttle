/**
 * The HUD toast channel. Engine-free — was `BoardingSystem.message`, rehomed here.
 * Latest-wins: anything that wants to surface a line posts it; the HUD reads
 * `current`, shows it, then `clear()`s when the toast fades.
 */
export class MessageBus {
  current = "";

  post(msg: string): void {
    this.current = msg;
  }

  clear(): void {
    this.current = "";
  }
}
