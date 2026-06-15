# SCUTTLE app icon — credits & regeneration

The desktop/app icon is a ship's-wheel badge (dark oak on a navy coin) framing a
real anatomical skull set as a parchment cameo.

## Assets

- **Wheel + badge** — original vector authored for SCUTTLE (`build/icon.svg`).
- **Skull** — *"Front View of Skull"*, an anatomical engraving plate, via Wikimedia Commons:
  <https://commons.wikimedia.org/wiki/File:Front_View_of_Skull.jpg>
  (source: Flickr / Sue Clark). **License: Public domain** — Wikimedia marks it PD and
  attribution is not required; credited here as good practice.
  - `build/skull.jpg` — the original download.
  - `build/skull-cropped.png` — caption cropped out; this is the file the build inlines.

## Build

`build/make-icon.cjs` inlines `skull-cropped.png` into `icon.svg`, rasterizes it at
256/128/64/48/32/16 px with a headless Edge/Chrome, and packs `build/icon.ico`.

```
node build/make-icon.cjs      # regenerate build/icon.ico after editing icon.svg / the skull
npm run dist                  # electron-builder embeds build/icon.ico into SCUTTLE.exe
```

`package.json` → `build.win.icon` points electron-builder at `build/icon.ico`; the packaged
exe's embedded icon is what the desktop shortcut and taskbar show. `electron/main.cjs` also
sets the BrowserWindow icon for dev runs (`npm run electron:dev`).
