import * as THREE from "three";

/**
 * Cinematic lightning: forked bolts (midpoint-displaced polylines) that flash and fade, plus a
 * scene-wide flash envelope the WeatherController reads and pushes to sky/ocean (so the water and
 * hulls light from the strike side). Scheduling lives in the controller; this is a dumb visual.
 */
interface Bolt {
  line: THREE.LineSegments;
  mat: THREE.LineBasicMaterial;
  age: number;
  life: number;
}
export class LightningSystem {
  readonly object: THREE.Group;
  private bolts: Bolt[] = [];
  private flashEnv = 0; // current 0..1 flash
  private flashDecay = 0;
  private dir: [number, number] = [0, 1];

  constructor() {
    this.object = new THREE.Group();
  }

  /** dx,dz = horizontal unit dir to the strike; distance in m; intensity 0..1; originX,Z = the
   *  point the ring is centred on (the camera/player, so strikes surround the player at sea). */
  spawnBolt(dx: number, dz: number, distance: number, intensity: number, originX = 0, originZ = 0): void {
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    this.dir = [dx, dz];
    // strike point on the horizon ring at `distance`, bolt from cloud height down to the sea.
    const sx = originX + dx * distance,
      sz = originZ + dz * distance;
    const top = new THREE.Vector3(sx + (Math.random() - 0.5) * 40, 380, sz + (Math.random() - 0.5) * 40);
    const bottom = new THREE.Vector3(sx, 0, sz);
    const pts = this.fork(top, bottom, 6);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: 0xcfe0ff,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = new THREE.LineSegments(geo, mat);
    line.frustumCulled = false;
    this.object.add(line);
    this.bolts.push({ line, mat, age: 0, life: 0.18 });
    // flash envelope: bright, fast attack; nearer + stronger = brighter.
    const near = 1 / (1 + distance / 300);
    this.flashEnv = Math.min(1, 0.5 + 0.7 * intensity * near);
    this.flashDecay = 3.0;
  }

  /** Build a fork: a displaced main channel as LINE SEGMENTS, plus a couple of branches. */
  private fork(a: THREE.Vector3, b: THREE.Vector3, depth: number): THREE.Vector3[] {
    let path = [a, b];
    for (let d = 0; d < depth; d++) {
      const next: THREE.Vector3[] = [];
      for (let i = 0; i < path.length - 1; i++) {
        const p = path[i],
          q = path[i + 1];
        const m = p.clone().lerp(q, 0.5);
        const jitter = (q.y - p.y) * 0.18 * (Math.random() - 0.5);
        m.x += jitter;
        m.z += jitter * 0.5;
        next.push(p, m);
        if (d > 2 && Math.random() < 0.25) {
          // a branch
          const bx = m
            .clone()
            .add(new THREE.Vector3((Math.random() - 0.5) * 60, -40 - Math.random() * 60, (Math.random() - 0.5) * 60));
          next.push(m.clone(), bx);
        }
      }
      next.push(path[path.length - 1]);
      path = next;
    }
    // LineSegments wants pairs; expand the polyline into consecutive segment endpoints.
    const seg: THREE.Vector3[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      seg.push(path[i], path[i + 1]);
    }
    return seg;
  }

  update(dt: number): void {
    if (this.flashEnv > 0) {
      this.flashEnv = Math.max(0, this.flashEnv - this.flashDecay * dt);
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.age += dt;
      const k = 1 - b.age / b.life;
      b.mat.opacity = Math.max(0, k) * (0.6 + 0.4 * Math.sin(b.age * 80)); // flicker
      if (b.age >= b.life) {
        this.object.remove(b.line);
        b.line.geometry.dispose();
        b.mat.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  flash(): number {
    return this.flashEnv;
  }
  flashDir(): [number, number] {
    return this.dir;
  }
  dispose(): void {
    for (const b of this.bolts) {
      b.line.geometry.dispose();
      b.mat.dispose();
    }
    this.bolts.length = 0;
  }
}
