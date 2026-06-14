# Quaternius "Modular Character Outfits — Fantasy" (RAW DROP — gitignored)

- **Source:** https://quaternius.com/packs/modularcharacteroutfitsfantasy.html
  (itch: https://quaternius.itch.io/modular-character-outfits-fantasy)
- **License:** CC0 (public domain — commercial OK, no attribution required)
- **Downloaded:** 2026-06-14 — the free **[Standard]** tier (glTF / FBX / OBJ).

This folder holds the **unzipped RAW pack** and is **gitignored** (large). Only the
optimized `web/` subset (committed) is what the game actually loads.

The outfits are skinned to the **same 65-bone Universal skeleton** as our base
character, so they bind to our existing animation clips with **zero retargeting**.
The free tier ships two outfit styles — **Peasant** and **Ranger** (M/F) — as both
full Outfits and individual Modular Parts (body / arms / legs / feet / boots / hood /
pauldron / belts).

We use **Male_Ranger** (pirate-adjacent: boots, pauldron, belted tunic, hood) as the
captain's default outfit. Binding lives in `src/render/universalModel.ts`.

**To re-acquire:** download the `[Standard]` zip from the link above, unzip anywhere,
and re-copy the `web/` subset (Ranger/Peasant glTF + .bin + downscaled textures).
