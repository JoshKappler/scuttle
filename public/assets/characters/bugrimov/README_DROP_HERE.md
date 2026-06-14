# Drop the Bugrimov pirate files in THIS folder

We're integrating **"Pirate Character Captain"** by Maksim Bugrimov — a free,
semi-realistic pirate. Claude can't download it (it's behind a free account
login), so this is your one manual step.

## 1. Download it (free)
- **RenderHub (simplest — gives FBX directly):**
  https://www.renderhub.com/maksim-bugrimov/pirate
  → make a free account → download → **choose the FBX format**.
- (Alt: it's also free on Fab — https://www.fab.com/sellers/Bugrimov%20Maksim —
  but RenderHub's FBX is the least hassle. Skip the `.uasset`/`.unity` versions.)

## 2. Unzip and drop the files HERE
Put **everything from the FBX download** into this folder
(`public/assets/characters/bugrimov/`):
- the main character **`.fbx`** (the pirate body)
- the **sword `.fbx`** and **pistol `.fbx`** if they're separate files
- **every texture image** (`.png`/`.jpg` — base color/albedo, normal, metallic,
  AO). Keep their original names — the FBX references them.

Don't rename anything; just dump the unzipped contents in here.

## 3. Tell Claude "files are in"
Then Claude will:
1. Inspect the FBX (mesh + bone names, scale) and load it onto the deck so you
   can confirm the **look** first — before any more work.
2. Decimate a web-friendly copy (it's ~259k tris / 4K textures — heavy for a
   browser; the full-res original is kept for the Steam build).
3. Add animations via Mixamo (idle/walk/run + sword combat) — Claude will give
   you the exact clips to grab.
4. Attach the cutlass, then sort first person.

## License
RenderHub "Extended Use License" — commercial use (incl. shipping in a game) is
allowed. For the eventual *paid* Steam build, skim RenderHub's full license once,
but it permits use in games. CREDITS will note the asset.
