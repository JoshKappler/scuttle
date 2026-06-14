import * as THREE from "three";

/** Marks ship-hull pixels in the stencil buffer so the ocean can be rejected
 *  there (no sea on the deck, in open holds, or as a void at the curved bow).
 *  Renders the hull groups with color+depth writes OFF and stencil write = 1,
 *  just before the ocean draws. Does NOT clear — the caller clears once. */
export class SeamMask {
  private maskMat = new THREE.MeshBasicMaterial({
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
