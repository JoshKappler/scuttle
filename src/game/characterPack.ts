/**
 * Which on-foot character pack to use.
 *
 * Default is the Quaternius pirate (the look we're keeping for now). KayKit
 * ("Adventurers", CC0) was prototyped for its modular limbs + 76 melee clips
 * but its chibi proportions read as a "cartoon pill", so it's parked behind
 * `?char=kk` (or `?char=kaykit`) for reference only while we pick a better
 * model.
 *
 * Resolved once per page load and cached so crew.ts and main.ts always agree.
 */
export type CharPack = "quaternius" | "kaykit";

let cached: CharPack | null = null;

export function characterPack(): CharPack {
  if (cached) return cached;
  let pack: CharPack = "quaternius";
  try {
    const q = new URLSearchParams(location.search).get("char");
    if (q === "kaykit" || q === "kk") pack = "kaykit";
    else if (q === "quaternius" || q === "q" || q === "old") pack = "quaternius";
  } catch {
    // non-browser (vitest): keep the default
  }
  cached = pack;
  return pack;
}
