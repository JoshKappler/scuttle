/**
 * Which on-foot character pack to use.
 *
 * Default is the Bugrimov semi-realistic pirate (`?char=bug`). The legacy
 * Quaternius captain is `?char=q`; the KayKit rogue (too chibi — "cartoon
 * pill") is parked at `?char=kk` for reference only.
 *
 * Resolved once per page load and cached so crew.ts and main.ts always agree.
 */
export type CharPack = "quaternius" | "kaykit" | "bugrimov" | "universal";

let cached: CharPack | null = null;

export function characterPack(): CharPack {
  if (cached) return cached;
  let pack: CharPack = "bugrimov";
  try {
    const q = new URLSearchParams(location.search).get("char");
    if (q === "kaykit" || q === "kk") pack = "kaykit";
    else if (q === "bugrimov" || q === "bug" || q === "pirate") pack = "bugrimov";
    else if (q === "universal" || q === "u" || q === "adv") pack = "universal";
    else if (q === "quaternius" || q === "q" || q === "old") pack = "quaternius";
  } catch {
    // non-browser (vitest): keep the default
  }
  cached = pack;
  return pack;
}
