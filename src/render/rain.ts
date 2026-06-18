import * as THREE from "three";

/**
 * Camera-locked GPU-instanced rain. A fixed pool of streak instances lives in a box around the
 * camera; each falls and recycles to the top. setIntensity scales how many are visible + their
 * opacity/length. VISUAL only (THE LAW #1). Heavy rain naturally cuts visibility (no fog mechanic).
 */
const BOX = 60; // half-extent (m) of the rain box around the camera
const FALL = 26; // m/s fall speed
export class RainSystem {
  readonly object: THREE.Group;
  private mesh: THREE.InstancedMesh;
  private max: number;
  private offs: Float32Array; // per-instance [x,y,z] within the box
  private mat: THREE.MeshBasicMaterial;
  private dummy = new THREE.Object3D();
  private intensity = 0;

  constructor(max = 4000) {
    this.max = max;
    const geo = new THREE.PlaneGeometry(0.025, 1.4); // a thin vertical streak
    this.mat = new THREE.MeshBasicMaterial({
      color: 0xaebccc,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, max);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.offs = new Float32Array(max * 3);
    for (let i = 0; i < max; i++) {
      this.offs[i * 3] = (Math.random() * 2 - 1) * BOX;
      this.offs[i * 3 + 1] = (Math.random() * 2 - 1) * BOX;
      this.offs[i * 3 + 2] = (Math.random() * 2 - 1) * BOX;
    }
    this.object = new THREE.Group();
    this.object.add(this.mesh);
    this.mesh.count = 0;
  }

  setIntensity(i: number): void {
    this.intensity = Math.max(0, Math.min(1, i));
  }

  update(dt: number, cam: THREE.Vector3): void {
    const target = Math.floor(this.intensity * this.max);
    this.mesh.count = target;
    if (target === 0) return;
    this.mat.opacity = 0.15 + 0.35 * this.intensity;
    const slant = 1.5 * this.intensity; // wind slant
    const sy = 0.6 + 1.2 * this.intensity; // longer streaks in heavy rain
    for (let i = 0; i < target; i++) {
      let y = this.offs[i * 3 + 1] - FALL * dt;
      if (y < -BOX) y += 2 * BOX; // recycle to top
      this.offs[i * 3 + 1] = y;
      this.dummy.position.set(cam.x + this.offs[i * 3] + slant * 0.4, cam.y + y, cam.z + this.offs[i * 3 + 2]);
      this.dummy.rotation.set(0, 0, 0);
      this.dummy.scale.set(1, sy, 1);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
