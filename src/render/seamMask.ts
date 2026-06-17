import * as THREE from "three";

/** Marks ABOVE-WATER ship-hull pixels in the stencil buffer so the ocean can be rejected there (no
 *  sea on the dry deck, in open holds, or as a void at the curved bow). Renders the hull groups with
 *  color+depth writes OFF and stencil write = 1, just before the ocean draws. Does NOT clear — the
 *  caller clears once.
 *
 *  HEIGHT-AWARE (round: deck submersion): only fragments above the waterline write the mask. A
 *  SUBMERGED hull (a sinking bow, a foundering wreck) is left UNmasked so the ocean closes over it —
 *  the ocean's own shader then renders that band as depth-faded translucent water. Masking the whole
 *  silhouette (as before) is what made a sunk bow read as a void: the stencil rejected the sea even
 *  where the hull had dropped below the surface.
 *
 *  CUTOUT TASK (2026-06-16): `uSeaLevel` is now FED the real Gerstner surface height each frame (it
 *  used to be stuck at 0.0, so the height gate never matched the moving sea). The mask is rendered
 *  from the actual hull MESHES, so a hole carved in the hull writes NO stencil there — the ocean is
 *  free to draw through the gap. Combined with the correct waterline, the stencil now agrees with the
 *  ocean FRAG's open-breach cut: above-water solid hull rejects the sea; an above-water hole and any
 *  below-water hull let it back in. */
export class SeamMask {
  private maskMat = new THREE.ShaderMaterial({
    uniforms: { uSeaLevel: { value: 0.0 } },
    vertexShader: /* glsl */ `
      varying float vWorldY;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldY = wp.y;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vWorldY;
      uniform float uSeaLevel;
      void main() {
        // below the waterline → don't mask, so the sea can close over the submerged hull.
        if (vWorldY < uSeaLevel) discard;
        gl_FragColor = vec4(0.0); // colorWrite is off; only the stencil write matters
      }
    `,
    colorWrite: false,
    depthWrite: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });

  constructor(private hulls: THREE.Object3D[]) {}

  /** Replace the set of hull silhouettes painted into the stencil (fleet changes). */
  setHulls(hulls: THREE.Object3D[]): void {
    this.hulls = hulls;
  }

  /** Feed the live water surface world-Y (cutout task): only hull fragments ABOVE this write the
   *  stencil, so the sea closes over a submerged hull and the gate tracks the moving swell instead of
   *  the old stuck-at-0 sea level. Call once per frame before write(). */
  setSeaLevel(y: number): void {
    this.maskMat.uniforms.uSeaLevel.value = y;
  }

  /** Render hull silhouettes into the stencil buffer of the current target. */
  write(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const prevOverride = scene.overrideMaterial;
    const prevVisible = new Map<THREE.Object3D, boolean>();
    scene.traverse((o) => prevVisible.set(o, o.visible));
    scene.traverse((o) => (o.visible = false));
    for (const h of this.hulls) {
      h.visible = true;
      h.traverse((o) => (o.visible = true));
    }
    scene.overrideMaterial = this.maskMat;
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    for (const [o, v] of prevVisible) o.visible = v;
  }
}
