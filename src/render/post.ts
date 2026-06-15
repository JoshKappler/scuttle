import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { Pass } from "three/addons/postprocessing/Pass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import type { SeamMask } from "./seamMask";
import { TUN } from "../core/tunables";

/** Clamp the HDR scene before bloom. The three.js atmospheric Sky produces
 *  ASTRONOMICAL luminance near the sun (thousands), so UnrealBloomPass would
 *  spread that one super-bright region across the entire frame as a white wash no
 *  matter how high the threshold. Clamping the linear colour to a sane ceiling
 *  bounds the bloom source (and harmlessly caps the base highlights — ACES maps
 *  everything past ~3 to near-white anyway). This is what makes the bloom usable. */
const ClampShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uMax: { value: 3.0 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uMax;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      gl_FragColor = vec4(min(c.rgb, vec3(uMax)), c.a);
    }
  `,
};

/** Screen-space god rays (GPU-Gems "volumetric light scattering as a post-process").
 *  Radially marches from each pixel toward the sun's projected screen position,
 *  accumulating only genuinely BRIGHT samples (the sun, thresholded) with distance
 *  decay — so light shafts fan out from the sun and dark geometry (sails, hull,
 *  islands) occludes them for free. Reads the post-bloom HDR buffer; added on top. */
const GodRayShader = {
  defines: { SAMPLES: 60 },
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uStrength: { value: 0.5 },
    uDensity: { value: 0.85 },
    uDecay: { value: 0.96 },
    uWeight: { value: 0.5 },
    uThreshold: { value: 4.0 },
    uSunVisible: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uSunScreen;
    uniform float uStrength, uDensity, uDecay, uWeight, uThreshold, uSunVisible;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uSunVisible < 0.5) { gl_FragColor = base; return; }
      vec2 delta = (vUv - uSunScreen) * (uDensity / float(SAMPLES));
      vec2 coord = vUv;
      float illum = 1.0;
      vec3 accum = vec3(0.0);
      for (int i = 0; i < SAMPLES; i++) {
        coord -= delta;
        vec3 s = texture2D(tDiffuse, coord).rgb;
        // only the sun (brightest pixels) seeds the shafts, not the whole sky
        float l = max(max(s.r, s.g), s.b);
        accum += s * step(uThreshold, l) * illum * uWeight;
        illum *= uDecay;
      }
      // fade out as the sun leaves the frame, so shafts don't pop at the edges
      float edgeFade = 1.0 - smoothstep(0.5, 1.15, length(uSunScreen - vec2(0.5)));
      gl_FragColor = vec4(base.rgb + accum * (uStrength / float(SAMPLES)) * edgeFade, base.a);
    }
  `,
};

/** Final colour grade (display space, after OutputPass tonemaps to sRGB): a little
 *  contrast + saturation + a soft vignette for the cinematic "punch". */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.1 },
    uVignette: { value: 0.2 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uContrast, uSaturation, uVignette;
    varying vec2 vUv;
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = (c - 0.5) * uContrast + 0.5;                 // contrast around mid-grey
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);                // saturation
      vec2 q = vUv - 0.5;
      c *= 1.0 - uVignette * dot(q, q) * 2.0;          // soft vignette
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * Post-processing spine for the visual pass.
 *
 * An EffectComposer whose FIRST pass is a custom ScenePass that reproduces the
 * game's stencil seam-mask dance (clear once → paint the hull/island silhouettes
 * into the stencil → render the stencil-tested scene) so the ocean still never
 * lands on the deck, in an open hold, or as a void at the bow. Bloom (and, in
 * later tasks, god rays + a colour grade) follow, then an OutputPass applies the
 * ACES tonemap + sRGB conversion at the very end.
 *
 * WHY OutputPass: the scene is rendered into the composer's render targets, and
 * three only applies tonemapping + output-colour-space conversion when rendering
 * to the CANVAS (target === null). Into a render target it stays LINEAR, which is
 * exactly what we want for the intermediate HDR passes (bloom/god rays work in
 * linear light); OutputPass then does the tonemap+sRGB when it draws to screen.
 *
 * The whole spine is gated by TUN.gfx.post.enabled; when off, main.ts renders via
 * the legacy direct renderer.render path (same look, minus the effects).
 */

/** First pass — mirrors three's RenderPass (renders into readBuffer, no swap) but
 *  inserts the seam-mask stencil write between the clear and the scene render,
 *  exactly like the pre-composer loop in main.ts. */
class ScenePass extends Pass {
  constructor(
    private bgScene: THREE.Scene,
    private scene: THREE.Scene,
    private camera: THREE.Camera,
    private seam: SeamMask,
  ) {
    super();
    this.needsSwap = false; // result stays in readBuffer for the next pass to read
  }

  override render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
    renderer.autoClear = false;
    // clear colour + depth + stencil once.
    renderer.clear(true, true, true);
    // 1) BACKGROUND: sky + clouds, as a flat backdrop (their own depthTest is off).
    renderer.render(this.bgScene, this.camera);
    // 2) clear DEPTH ONLY (keep the backdrop colour + the cleared stencil) so the
    //    main scene gets a fresh depth buffer and every piece of geometry draws OVER
    //    the clouds — which is how the ship/ocean/islands occlude them.
    renderer.clearDepth();
    // 3) seam-mask stencil, then the stencil-tested main scene (ocean off the deck).
    this.seam.write(renderer, this.scene, this.camera);
    renderer.render(this.scene, this.camera);
    renderer.autoClear = prevAutoClear;
  }
}

export class Post {
  readonly composer: EffectComposer;
  private rt: THREE.WebGLRenderTarget;
  private bloom: UnrealBloomPass;
  private clampPass: ShaderPass;
  private godray: ShaderPass;
  private grade: ShaderPass;
  private _tmp = new THREE.Vector2();
  private _lastW = 0;
  private _lastH = 0;

  constructor(
    private renderer: THREE.WebGLRenderer,
    bgScene: THREE.Scene,
    scene: THREE.Scene,
    camera: THREE.Camera,
    seam: SeamMask,
  ) {
    const size = this.targetSize();
    this._lastW = size.x;
    this._lastH = size.y;

    // HDR + stencil + MSAA render target. HalfFloat keeps linear highlights (the
    // sun, glints) un-clipped so the ACES rolloff in OutputPass reads nicely;
    // stencilBuffer:true is REQUIRED for the seam mask; samples:2 keeps edges AA'd
    // (the canvas's own antialias does nothing once we render to a target) — 2 not 4
    // because MSAA-resolving a full-screen HalfFloat target is bandwidth-heavy and 4
    // was a real share of the frame cost; 2 still removes the worst voxel-edge jaggies
    // and bloom softens the rest.
    this.rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: true,
      samples: 2,
    });

    this.composer = new EffectComposer(renderer, this.rt);
    // _pixelRatio stays 1 and we feed setSize device pixels directly (see targetSize).
    this.composer.addPass(new ScenePass(bgScene, scene, camera, seam));

    // clamp the HDR before bloom so the sun's monster luminance can't white-wash
    // the frame (see ClampShader). The ceiling must stay HIGH enough not to flatten
    // the sky/cloud HDR range (or clouds lose contrast against the sky) — it only
    // needs to tame the sun's thousands. Tunable via TUN.gfx.bloom.clamp.
    this.clampPass = new ShaderPass(ClampShader);
    this.composer.addPass(this.clampPass);

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      TUN.gfx.bloom.strength,
      TUN.gfx.bloom.radius,
      TUN.gfx.bloom.threshold,
    );
    this.composer.addPass(this.bloom);

    // god rays read the post-bloom HDR buffer (sun at its brightest) and add shafts.
    // SAMPLES is the per-pixel march length and the pass's dominant cost (dependent
    // texture fetches); bake it from TUN at construction (a compile-time #define, so
    // changing it needs a reload). 60 was the original — far heavier than the look needs.
    GodRayShader.defines.SAMPLES = Math.max(8, Math.round(TUN.gfx.godrays.samples));
    this.godray = new ShaderPass(GodRayShader);
    this.composer.addPass(this.godray);

    this.composer.addPass(new OutputPass()); // ACES tonemap + sRGB (to a buffer)
    // colour grade runs LAST in display space (reads OutputPass's sRGB result).
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
  }

  /** Feed the sun's projected screen position (UV 0..1) + whether it's on-screen. */
  setSun(x: number, y: number, visible: boolean): void {
    (this.godray.uniforms.uSunScreen.value as THREE.Vector2).set(x, y);
    this.godray.uniforms.uSunVisible.value = visible ? 1 : 0;
  }

  /** The pixel size the post chain renders at. The renderer's drawing buffer is
   *  canvas × devicePixelRatio (capped at 2 in main.ts); we cap THAT again at
   *  TUN.gfx.post.maxPixelRatio (1 = native res even on a 2× HiDPI display) and
   *  optionally scale by TUN.gfx.post.scale. Every post pass runs at this size and
   *  the final pass upscales to the full canvas — so a 2× display pays ~1× cost. */
  private targetSize(): THREE.Vector2 {
    const dbs = this.renderer.getDrawingBufferSize(this._tmp); // device px
    const ratio = this.renderer.getPixelRatio() || 1;
    const cap = Math.max(0.25, TUN.gfx.post.maxPixelRatio);
    const factor = (Math.min(ratio, cap) / ratio) * Math.max(0.25, TUN.gfx.post.scale);
    return this._tmp.set(Math.max(1, Math.round(dbs.x * factor)), Math.max(1, Math.round(dbs.y * factor)));
  }

  /** Resize to match the renderer's drawing buffer (called from main's fitViewport
   *  AFTER renderer.setSize, so the drawing-buffer size is already current). */
  setSize(_w: number, _h: number): void {
    const size = this.targetSize();
    this._lastW = size.x;
    this._lastH = size.y;
    this.composer.setSize(size.x, size.y);
    this.bloom.setSize(size.x, size.y);
  }

  render(): void {
    // re-derive the post resolution each frame so the maxPixelRatio / scale knobs are
    // live (cheap: only actually resizes the RTs when the target size changes).
    const t = this.targetSize();
    if (t.x !== this._lastW || t.y !== this._lastH) {
      this._lastW = t.x;
      this._lastH = t.y;
      this.composer.setSize(t.x, t.y);
      this.bloom.setSize(t.x, t.y);
    }
    // live dev-panel knobs
    this.clampPass.uniforms.uMax.value = TUN.gfx.bloom.clamp;
    this.bloom.enabled = TUN.gfx.bloom.enabled;
    this.bloom.strength = TUN.gfx.bloom.strength;
    this.bloom.radius = TUN.gfx.bloom.radius;
    this.bloom.threshold = TUN.gfx.bloom.threshold;
    this.godray.enabled = TUN.gfx.godrays.enabled;
    this.godray.uniforms.uStrength.value = TUN.gfx.godrays.strength;
    this.godray.uniforms.uDensity.value = TUN.gfx.godrays.density;
    this.godray.uniforms.uDecay.value = TUN.gfx.godrays.decay;
    this.godray.uniforms.uWeight.value = TUN.gfx.godrays.weight;
    this.godray.uniforms.uThreshold.value = TUN.gfx.godrays.threshold;
    this.grade.uniforms.uContrast.value = TUN.gfx.grade.contrast;
    this.grade.uniforms.uSaturation.value = TUN.gfx.grade.saturation;
    this.grade.uniforms.uVignette.value = TUN.gfx.grade.vignette;
    this.composer.render();
  }

  /** Free GPU resources (not currently called — the Post lives for the session). */
  dispose(): void {
    this.rt.dispose();
    this.composer.dispose();
  }
}
