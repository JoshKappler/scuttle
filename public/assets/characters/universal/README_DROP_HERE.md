# Drop the Quaternius "Universal" files here

We're standardizing the on-foot character on the **Quaternius Universal rig**
(CC0, Mixamo-compatible) so characters become hot-swappable on one shared
animation set. Two free packs, both CC0. itch gates the direct link behind a
click, so this is a quick you-step (like Bugrimov was).

## 1. Download both (free, CC0)
- **Universal Animation Library 2** (the 130+ clips):
  https://quaternius.itch.io/universal-animation-library-2
- **Universal Base Characters** (the bearded rugged adventurer mesh):
  https://quaternius.itch.io/universal-base-characters

For each: click **Download**, then "**No thanks, just take me to the
downloads**", and grab the free **Standard** zip (it contains **glTF/GLB** — that's
what we want; FBX/OBJ in the same zip is fine to ignore).

## 2. Unzip both into THIS folder
Dump the unzipped contents of both into `public/assets/characters/universal/`.
Keep the `.glb`/`.gltf` files and any textures. Don't rename anything.

## 3. Tell Claude "universal in"
Then Claude will:
1. Inspect the GLBs (mesh + the shared bone names + clip list).
2. Load the bearded base character and bind the animation-library clips to it
   (same rig = no retargeting), wired behind `?char=u`.
3. Map idle / walk / run / attack into the existing PirateRig contract, so he
   walks, runs, and swings on the deck.

Then we make him the default and move on to combat — and from here, swapping in
a fancier character later is just dropping another Universal-rig mesh in.

## License
Both packs are **CC0 1.0** (public domain) — commercial/Steam use, no attribution.
CREDITS will note them anyway.
