/**
 * Which on-foot character pack to use.
 *
 * Default is the Quaternius Universal base character (no param, or `?char=u`):
 * a clean ~13k-tri body driven by the shared-skeleton Universal Animation
 * Library — interchangeable and pre-animated. The Bugrimov semi-realistic
 * pirate is parked at `?char=bug`, the legacy Quaternius captain at `?char=q`,
 * and the KayKit rogue (too chibi — "cartoon pill") at `?char=kk`.
 *
 * Resolved once per page load and cached so crew.ts and main.ts always agree.
 */
export type CharPack = "quaternius" | "kaykit" | "bugrimov" | "universal";

let cached: CharPack | null = null;

export function characterPack(): CharPack {
  if (cached) return cached;
  let pack: CharPack = "universal";
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
