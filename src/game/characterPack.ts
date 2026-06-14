/**
 * Which on-foot character pack to use.
 *
 * KayKit ("Adventurers", CC0) is the default while we evaluate it against the
 * legacy Quaternius pirate: it ships modular limb meshes (clean first person)
 * and 76 melee clips (stab/slice/chop/block/dodge/hit/death). Add
 * `?char=quaternius` (or `?char=q`) to the URL to A/B the old captain.
 *
 * Resolved once per page load and cached so crew.ts and main.ts always agree.
 */
export type CharPack = "quaternius" | "kaykit";

let cached: CharPack | null = null;

export function characterPack(): CharPack {
  if (cached) return cached;
  let pack: CharPack = "kaykit";
  try {
    const q = new URLSearchParams(location.search).get("char");
    if (q === "quaternius" || q === "q" || q === "old") pack = "quaternius";
    else if (q === "kaykit" || q === "kk") pack = "kaykit";
  } catch {
    // non-browser (vitest): keep the default
  }
  cached = pack;
  return pack;
}
