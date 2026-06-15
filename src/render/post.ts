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
    // clear colour + depth + stencil once, then leave autoClear OFF so the two
    // following renders (seam mask, then scene) accumulate into the same buffer.
    renderer.autoClear = true;
    renderer.clear();
    renderer.autoClear = false;
    this.seam.write(renderer, this.scene, this.camera); // stencil = 1 on hulls/islands
    renderer.render(this.scene, this.camera); // full scene incl. ocean, stencil-tested
    renderer.autoClear = prevAutoClear;
  }
}

export class Post {
  readonly composer: EffectComposer;
  private rt: THREE.WebGLRenderTarget;
  private bloom: UnrealBloomPass;

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    seam: SeamMask,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    // HDR + stencil + MSAA render target. HalfFloat keeps linear highlights (the
    // sun, glints) un-clipped so the ACES rolloff in OutputPass reads nicely;
    // stencilBuffer:true is REQUIRED for the seam mask; samples:4 keeps edges AA'd
    // (the canvas's own antialias does nothing once we render to a target).
    this.rt = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: true,
      samples: 4,
    });

    this.composer = new EffectComposer(renderer, this.rt);
    // _pixelRatio stays 1 and we feed setSize device pixels directly (see setSize).
    this.composer.addPass(new ScenePass(scene, camera, seam));

    // clamp the HDR before bloom so the sun's monster luminance can't white-wash
    // the frame (see ClampShader). Bloom then reads a bounded source.
    this.composer.addPass(new ShaderPass(ClampShader));

    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      TUN.gfx.bloom.strength,
      TUN.gfx.bloom.radius,
      TUN.gfx.bloom.threshold,
    );
    this.composer.addPass(this.bloom);

    this.composer.addPass(new OutputPass());
  }

  /** Resize to match the renderer's drawing buffer (called from main's fitViewport
   *  AFTER renderer.setSize, so the drawing-buffer size is already current). */
  setSize(_w: number, _h: number): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer.setSize(size.x, size.y);
    this.bloom.setSize(size.x, size.y);
  }

  render(): void {
    // live dev-panel knobs
    this.bloom.enabled = TUN.gfx.bloom.enabled;
    this.bloom.strength = TUN.gfx.bloom.strength;
    this.bloom.radius = TUN.gfx.bloom.radius;
    this.bloom.threshold = TUN.gfx.bloom.threshold;
    this.composer.render();
  }

  /** Free GPU resources (not currently called — the Post lives for the session). */
  dispose(): void {
    this.rt.dispose();
    this.composer.dispose();
  }
}
