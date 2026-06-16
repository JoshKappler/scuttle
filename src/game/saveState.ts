/**
 * The persistent save. Wraps the economy state plus the things the game layer
 * needs to restore a Career: which hull you sail, which classes you've unlocked,
 * and player settings. Two independent slots (career / sandbox) so Sandbox never
 * touches your Career. Engine-free and tolerant of garbage / old shapes, mirroring
 * the {@link Economy} deserialize pattern — it takes a {@link Storage}-like object
 * so it can be unit-tested against a fake and wired to `localStorage` in the game.
 */
import { Economy, type EconomyState, defaultState as defaultEconomy } from "../sim/economy";
import type { GameMode } from "./gameState";

export const SAVE_VERSION = 1;
export type ShipTierId = "cutter" | "sloop" | "brig" | "frigate" | "manowar";

export interface Settings {
  masterVolume: number; // 0..1
  defaultCamera: 0 | 1 | 2; // matches main.ts camMode (char-3rd / char-1st / ship-orbit)
}

export interface SaveState {
  version: number;
  mode: GameMode;
  economy: EconomyState;
  shipTier: ShipTierId;
  unlockedClasses: ShipTierId[];
  settings: Settings;
}

const LEGACY_ECONOMY_KEY = "scuttle.economy.v1";
const slotKey = (mode: GameMode) => `scuttle.save.${mode}.v1`;

export function defaultSettings(): Settings {
  return { masterVolume: 0.8, defaultCamera: 0 };
}

export function defaultSave(mode: GameMode): SaveState {
  return {
    version: SAVE_VERSION,
    mode,
    economy: defaultEconomy(),
    shipTier: "cutter",
    unlockedClasses: ["cutter"],
    settings: defaultSettings(),
  };
}

export class SaveManager {
  constructor(private store: Storage) {}

  hasSave(mode: GameMode): boolean {
    try {
      return this.store.getItem(slotKey(mode)) != null;
    } catch {
      return false;
    }
  }

  load(mode: GameMode): SaveState {
    let raw: string | null = null;
    try {
      raw = this.store.getItem(slotKey(mode));
    } catch {
      raw = null;
    }
    // first-ever Career load: fold a legacy economy-only blob into the new slot.
    if (!raw && mode === "career") {
      const migrated = this.migrateLegacy();
      if (migrated) {
        this.save("career", migrated);
        return migrated;
      }
    }
    return this.parse(raw, mode);
  }

  save(mode: GameMode, s: SaveState): void {
    try {
      this.store.setItem(slotKey(mode), JSON.stringify(s));
    } catch {
      /* storage unavailable (private mode / headless) — skip silently */
    }
  }

  wipe(mode: GameMode): void {
    try {
      this.store.removeItem(slotKey(mode));
    } catch {
      /* ignore */
    }
  }

  private migrateLegacy(): SaveState | null {
    let raw: string | null = null;
    try {
      raw = this.store.getItem(LEGACY_ECONOMY_KEY);
    } catch {
      return null;
    }
    if (!raw) return null;
    const s = defaultSave("career");
    s.economy = Economy.deserialize(raw).state;
    return s;
  }

  private parse(raw: string | null, mode: GameMode): SaveState {
    const d = defaultSave(mode);
    if (!raw) return d;
    let p: unknown;
    try {
      p = JSON.parse(raw);
    } catch {
      return d;
    }
    if (!p || typeof p !== "object") return d;
    const o = p as Partial<SaveState>;
    return {
      version: SAVE_VERSION,
      mode,
      // re-run the economy's own tolerant deserialize over the sub-object
      economy: o.economy ? Economy.deserialize(JSON.stringify(o.economy)).state : d.economy,
      shipTier: (o.shipTier as ShipTierId) ?? d.shipTier,
      unlockedClasses:
        Array.isArray(o.unlockedClasses) && o.unlockedClasses.length
          ? (o.unlockedClasses as ShipTierId[])
          : d.unlockedClasses,
      settings: { ...d.settings, ...(o.settings ?? {}) },
    };
  }
}
