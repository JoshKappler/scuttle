// Rasterize build/icon.svg at every Windows icon size via headless Edge/Chrome,
// then pack them into a single multi-resolution build/icon.ico. Pure Node + a
// system Chromium; no npm deps. Run: node build/make-icon.cjs
"use strict";
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BUILD = __dirname;
let SVG = fs.readFileSync(path.join(BUILD, "icon.svg"), "utf8");
// Inline the skull engraving as a data URI so the SVG is self-contained at render time.
if (SVG.includes("__SKULL_DATA_URI__")) {
  const png = fs.readFileSync(path.join(BUILD, "skull-cropped.png"));
  const uri = "data:image/png;base64," + png.toString("base64");
  SVG = SVG.split("__SKULL_DATA_URI__").join(uri);
}
const SIZES = [256, 128, 64, 48, 32, 16];
const TMP = path.join(BUILD, ".icontmp");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ---- locate a Chromium ----
const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];
const BROWSER = CANDIDATES.find((p) => fs.existsSync(p));
if (!BROWSER) throw new Error("No Edge/Chrome found for rasterizing.");
console.log("browser:", BROWSER);

const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");

function pngSize(buf) {
  // PNG: 8-byte sig, then IHDR (len 4 + 'IHDR' 4 + width 4 + height 4 ...)
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const pngs = [];
for (const s of SIZES) {
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:transparent;width:${s}px;height:${s}px;overflow:hidden}` +
    `svg{display:block;width:${s}px;height:${s}px}</style></head><body>${SVG}</body></html>`;
  const htmlPath = path.join(TMP, `r${s}.html`);
  const outPath = path.join(TMP, `r${s}.png`);
  fs.writeFileSync(htmlPath, html);
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--force-device-scale-factor=1",
    "--default-background-color=00000000", // transparent page
    `--user-data-dir=${path.join(TMP, "ud" + s)}`, // never hijack a running Edge
    `--window-size=${s},${s}`,
    `--screenshot=${outPath}`,
    fileUrl(htmlPath),
  ];
  try {
    execFileSync(BROWSER, args, { stdio: "ignore", timeout: 60000 });
  } catch (e) {
    /* Chromium often exits non-zero even on success; trust the output file. */
  }
  if (!fs.existsSync(outPath)) throw new Error(`render failed at ${s}px (no PNG)`);
  const buf = fs.readFileSync(outPath);
  const dim = pngSize(buf);
  console.log(`  ${s}px -> ${dim.w}x${dim.h}, ${buf.length} bytes`);
  if (dim.w !== s || dim.h !== s) throw new Error(`size mismatch at ${s}: got ${dim.w}x${dim.h}`);
  pngs.push({ s, buf });
}

// ---- pack ICO (PNG-compressed entries; Vista+ supports this) ----
const n = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(n, 4); // image count
const dir = Buffer.alloc(16 * n);
let offset = 6 + 16 * n;
pngs.forEach((p, i) => {
  const e = i * 16;
  dir.writeUInt8(p.s >= 256 ? 0 : p.s, e + 0); // width (0 = 256)
  dir.writeUInt8(p.s >= 256 ? 0 : p.s, e + 1); // height
  dir.writeUInt8(0, e + 2); // palette
  dir.writeUInt8(0, e + 3); // reserved
  dir.writeUInt16LE(1, e + 4); // color planes
  dir.writeUInt16LE(32, e + 6); // bits per pixel
  dir.writeUInt32LE(p.buf.length, e + 8); // bytes in resource
  dir.writeUInt32LE(offset, e + 12); // offset
  offset += p.buf.length;
});
const ico = Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
const icoPath = path.join(BUILD, "icon.ico");
fs.writeFileSync(icoPath, ico);
// also keep the 256 png as build/icon.png (electron-builder fallback + preview)
fs.writeFileSync(path.join(BUILD, "icon.png"), pngs[0].buf);
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nWrote ${icoPath} (${ico.length} bytes, ${n} sizes) + icon.png`);
