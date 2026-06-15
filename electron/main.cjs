// Electron main process for the SCUTTLE desktop build.
//
// WHY a wrapper (note: it is NOT the fps fix — that's CPU-side JS physics we optimise in the game;
// this shell runs the same V8 single-threaded). What it DOES buy us:
//   • Locks ONE known Chromium/V8 version → identical behaviour on every machine, no more
//     "fine in Firefox, weird in Chrome" guesswork.
//   • Reads the REAL GPU. Browsers mask WEBGL_debug_renderer_info for fingerprinting (that's the
//     bogus "GTX 980" reported on a real 5080); Electron does not, so the HUD shows the true card.
//   • Lets us FORCE the discrete GPU + skip the GPU blocklist (a brand-new card can otherwise be
//     shoved to software), and turn on SharedArrayBuffer so the physics can move to Web Workers
//     (multi-core) later — the actual "use more of my CPU" lever.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

// ---- correct GPU utilisation — these MUST be set before the app 'ready' event ----
app.commandLine.appendSwitch("force_high_performance_gpu"); // pick the dGPU on hybrid-GPU rigs
app.commandLine.appendSwitch("ignore-gpu-blocklist"); // don't fall back to software on a too-new card
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer"); // unblock worker multithreading

const DEV_URL = "http://localhost:5173";
// In a packaged EXE always load the built files; in `npm run electron:dev` load the live Vite server.
const isDev = !app.isPackaged && process.env.SCUTTLE_DEV !== "0";

function createWindow() {
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    backgroundColor: "#05080a",
    title: "SCUTTLE",
    autoHideMenuBar: true,
    webPreferences: {
      // first-party, local, trusted game code — no remote content and no Node in the page.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (isDev) {
    win.loadURL(DEV_URL);
  } else {
    // vite.config.ts already uses base "./", so the built index.html has relative asset paths
    // that resolve correctly under file://.
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
