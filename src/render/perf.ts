import type * as THREE from "three";
import { TUN } from "../core/tunables";

/**
 * Performance watchdog — the answer to "why does it oscillate between 5 fps and
 * smooth on a fresh launch with no code change?"
 *
 * The render code is identical run-to-run, so that swing is almost never the
 * code — it's which GPU the browser handed the tab and whether it fell back to
 * SOFTWARE rendering (SwiftShader). Two defences live here:
 *
 *  1. {@link detectGpu} reads the real renderer string. If it's a software
 *     rasteriser we surface a one-time banner — single-digit fps then has a
 *     KNOWN cause (and a known fix: fully restart the browser), instead of
 *     looking like a game bug. (Forcing the discrete GPU is done at renderer
 *     construction in main.ts via powerPreference:"high-performance".)
 *
 *  2. {@link PerfMonitor} measures the true frame time, shows it in a small HUD,
 *     and runs an ADAPTIVE-QUALITY governor: when the framerate sits below the
 *     target it steps the post-FX down (render-resolution scale, then god rays),
 *     and steps back up when there's headroom. So the frame can't silently park
 *     at 5 fps — it self-corrects toward TUN.gfx.auto.targetFps. On a healthy
 *     discrete GPU (locked at vsync) it sits at tier 0 and touches nothing.
 *
 * Pure VISUALS / diagnostics — nothing here feeds physics or the vitest oracle.
 */

export interface GpuInfo {
  /** the unmasked renderer string, e.g. "ANGLE (NVIDIA GeForce RTX 3070 ...)". */
  name: string;
  /** true when the context is a software rasteriser (no real GPU acceleration). */
  software: boolean;
}

/** Read the actual WebGL renderer behind three's context. */
export function detectGpu(renderer: THREE.WebGLRenderer): GpuInfo {
  let name = "unknown";
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    name = (ext && (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string)) || (gl.getParameter(gl.RENDERER) as string) || name;
  } catch {
    /* getParameter can throw on a lost context — leave "unknown" */
  }
  const software = /swiftshader|software|llvmpipe|basic render|microsoft basic|mesa offscreen/i.test(name);
  return { name, software };
}

/** Strip the verbose ANGLE wrapper down to the GPU model for the HUD line. */
function shortGpu(name: string): string {
  const m = name.match(/ANGLE \(([^,]+),\s*([^,]+)/i);
  if (m) return m[2].replace(/\([^)]*\)/g, "").replace(/Direct3D.*/i, "").trim() || m[1].trim();
  return name.replace(/\([^)]*\)/g, "").trim().slice(0, 48);
}

/** quality tiers the governor walks: render-scale + whether god rays are dropped.
 *  tier 0 = full; higher = cheaper. Scale multiplies the post chain's resolution
 *  (the dominant fill cost), god rays are the next-heaviest pass.
 *  FLOORED at 0.8 (was 0.5): the deep resolution drops were the soft "mush" the player
 *  disliked — with MSAA off + FXAA + the cheaper sky, the frame holds full res in normal
 *  play, and the worst case the governor can reach is a barely-soft 0.8, never 0.5. */
const TIERS: { scale: number; dropGodrays: boolean }[] = [
  { scale: 1.0, dropGodrays: false },
  { scale: 0.85, dropGodrays: false },
  { scale: 0.8, dropGodrays: true },
];

export class PerfMonitor {
  private emaMs = 16.7; // exponential moving average of the frame time
  private evalAccum = 0; // seconds since the last governor decision
  private holdAccum = 99; // seconds since the last tier CHANGE (anti-flap cooldown)
  private total = 0; // total seconds the monitor has run (for the warm-up grace)
  private lowAccum = 0; // seconds of continuous low fps on a HARDWARE GPU (stale-GPU-profile hint)
  private lowHintShown = false;
  private overlay: HTMLDivElement | null = null;
  private banner: HTMLDivElement | null = null;
  private gpu: GpuInfo;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gpu = detectGpu(renderer);
    // log it always — the first thing to check when "it's running at 5 fps".
    console.info(`[scuttle] GPU: ${this.gpu.name}${this.gpu.software ? "  ⚠ SOFTWARE RENDERING" : ""}`);
    if (this.gpu.software) this.showSoftwareBanner();
    this.buildOverlay();
    // a hard GPU-context loss also reads as a hang/black screen — name it.
    const canvas = renderer.domElement;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.showBanner("⚠ The graphics context was lost (a GPU/driver reset). Reload the page to recover.", "#7a1f1f");
    });
  }

  get gpuInfo(): GpuInfo {
    return this.gpu;
  }

  /** Call once per rendered frame with the real wall-clock dt (seconds). */
  tick(dt: number): void {
    this.total += dt;
    const ms = Math.min(dt * 1000, 1000);
    // EMA so a single hitch doesn't yank the governor; ~0.1 tracks ~10 frames.
    this.emaMs += (ms - this.emaMs) * 0.1;
    const fps = 1000 / Math.max(this.emaMs, 0.01);
    TUN.gfx.auto.fps = fps;

    if (TUN.gfx.auto.enabled) this.governor(dt, fps);
    else {
      // governor off → don't hold the chain down; release any prior throttle.
      TUN.gfx.auto.scale = 1;
      TUN.gfx.auto.suppressGodrays = false;
    }
    this.checkStaleGpu(dt, fps);
    this.updateOverlay(fps);
  }

  /** Adaptive quality: walk the tier ladder toward TUN.gfx.auto.targetFps with
   *  a hysteresis DEADBAND + a cooldown so it can't flap every frame.
   *
   *  Two things this gets right that the obvious version doesn't:
   *   • WARM-UP GRACE — the first few seconds are dominated by shader compilation
   *     and asset loads (huge frame times). Acting on those would wrongly downgrade
   *     a fast GPU and, because of the next point, leave it stuck. So we don't touch
   *     quality until the frame time has had time to settle.
   *   • REACHABLE UPGRADE — the screen is vsync-capped (~60 fps), so an "upgrade only
   *     if fps > target+margin" test is UNREACHABLE when target is near 60 → a single
   *     boot hitch would permanently pin the quality low. We upgrade whenever the frame
   *     is simply MEETING the target (with a long cooldown), which is reachable under
   *     vsync; if a probe-up proves too greedy the downgrade rule pulls it back. */
  private governor(dt: number, fps: number): void {
    this.evalAccum += dt;
    this.holdAccum += dt;
    if (this.evalAccum < 0.5) return; // decide ~twice a second
    this.evalAccum = 0;
    if (this.total < 3) return; // warm-up grace: ignore boot-time shader/asset stutter

    const target = Math.max(20, TUN.gfx.auto.targetFps);
    let tier = Math.max(0, Math.min(TIERS.length - 1, Math.round(TUN.gfx.auto.tier)));

    // DOWNGRADE: clearly missing the target → drop a tier (short cooldown). The 7-fps
    // gap below `target` is the bottom of the deadband (so we don't fight tiny dips).
    if (fps < target - 7 && tier < TIERS.length - 1 && this.holdAccum > 1.0) {
      tier++;
      this.holdAccum = 0;
    }
    // UPGRADE: comfortably meeting the target for a good while → probe one tier back up
    // (long cooldown; if that tier can't hold the target the downgrade rule undoes it).
    else if (fps >= target && tier > 0 && this.holdAccum > 5.0) {
      tier--;
      this.holdAccum = 0;
    }

    TUN.gfx.auto.tier = tier;
    TUN.gfx.auto.scale = TIERS[tier].scale;
    TUN.gfx.auto.suppressGodrays = TIERS[tier].dropGodrays;
  }

  /** Stale-GPU-profile hint. A healthy discrete GPU renders this game well above 30 fps; if the frame
   *  rate sits low for several seconds on a HARDWARE GPU (the software path has its own banner), the
   *  browser is most likely on a STALE / degraded GPU profile — the exact failure mode behind a
   *  "wrong GPU name + ~20 fps" report (e.g. a machine upgraded from an old card whose browser profile
   *  cached the old GPU). A full browser restart spins up a fresh GPU process and fixes it. Fires once. */
  private checkStaleGpu(dt: number, fps: number): void {
    if (this.gpu.software || this.lowHintShown || this.total < 10) return;
    this.lowAccum = fps < 28 ? this.lowAccum + dt : 0;
    if (this.lowAccum > 6) {
      this.lowHintShown = true;
      this.showBanner(
        `⚠ Low frame rate (~${fps.toFixed(0)} fps) on a hardware GPU: ${shortGpu(this.gpu.name)}. If that name ` +
          `looks wrong or this persists, your browser is likely on a stale GPU profile — fully QUIT and reopen the ` +
          `browser (then Ctrl+Shift+R to hard-reload), or try another browser.`,
        "#6b4a12",
      );
    }
  }

  // ---- HUD overlay (small fps/ms/tier/GPU readout, top-left) ----
  private buildOverlay(): void {
    const el = document.createElement("div");
    Object.assign(el.style, {
      position: "fixed",
      top: "6px",
      left: "8px",
      zIndex: "10005",
      font: '11px/1.35 ui-monospace, "Cascadia Mono", Consolas, monospace',
      color: "#bfe8c0",
      background: "rgba(6,10,7,0.5)",
      padding: "3px 7px",
      borderRadius: "4px",
      border: "1px solid rgba(150,200,150,0.18)",
      pointerEvents: "none",
      whiteSpace: "pre",
      textShadow: "0 1px 2px #000",
      display: "none",
    } as Partial<CSSStyleDeclaration>);
    document.body.appendChild(el);
    this.overlay = el;
  }

  private updateOverlay(fps: number): void {
    const el = this.overlay;
    if (!el) return;
    if (!TUN.gfx.auto.hud) {
      if (el.style.display !== "none") el.style.display = "none";
      return;
    }
    if (el.style.display === "none") el.style.display = "block";
    const tier = Math.round(TUN.gfx.auto.tier);
    const col = fps >= 50 ? "#bfe8c0" : fps >= 30 ? "#e8dca0" : "#e8a0a0";
    el.style.color = col;
    const sw = this.gpu.software ? " · ⚠SW" : "";
    const q = tier > 0 ? ` · q${tier}` : "";
    el.textContent = `${fps.toFixed(0)} fps · ${this.emaMs.toFixed(1)} ms${q}${sw}\n${shortGpu(this.gpu.name)}`;
  }

  // ---- banners ----
  private showSoftwareBanner(): void {
    this.showBanner(
      "⚠ Running on SOFTWARE rendering (no GPU acceleration) — this is why it's slow. " +
        "Fully QUIT and reopen your browser; if it persists, enable hardware acceleration in browser settings.",
      "#6b4a12",
    );
  }

  private showBanner(text: string, bg: string): void {
    if (this.banner) this.banner.remove();
    const b = document.createElement("div");
    Object.assign(b.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      zIndex: "10020",
      font: '600 13px/1.4 Georgia, serif',
      color: "#f3e6c8",
      background: bg,
      borderBottom: "1px solid rgba(0,0,0,0.5)",
      padding: "9px 40px 9px 14px",
      boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
      cursor: "default",
    } as Partial<CSSStyleDeclaration>);
    b.textContent = text;
    const close = document.createElement("span");
    close.textContent = "✕";
    Object.assign(close.style, {
      position: "absolute",
      top: "8px",
      right: "12px",
      cursor: "pointer",
      opacity: "0.8",
    } as Partial<CSSStyleDeclaration>);
    close.addEventListener("click", () => b.remove());
    b.appendChild(close);
    document.body.appendChild(b);
    this.banner = b;
  }
}
