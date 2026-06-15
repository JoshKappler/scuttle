/**
 * The player's gold of record. Engine-free — was `BoardingSystem.gold`, rehomed
 * here so the wallet survives the boarding removal and the economy can mirror into
 * it without depending on the on-foot system. The HUD reads `wallet.gold`.
 */
export class Wallet {
  constructor(public gold = 0) {}

  add(n: number): void {
    this.gold += n;
  }

  /** Overwrite the balance — used to mirror `economy.doubloons` after a transaction. */
  set(n: number): void {
    this.gold = n;
  }

  /** Deduct `n` only if affordable. Returns whether the spend happened. */
  spend(n: number): boolean {
    if (this.gold < n) return false;
    this.gold -= n;
    return true;
  }
}
