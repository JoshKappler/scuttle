import * as THREE from "three";

/**
 * One pooled particle system for all transient effects: muzzle smoke, water
 * splashes, wood splinters. CPU-integrated points — cheap and plenty for the
 * particle counts involved.
 */
const MAX = 1200;

interface Particle {
  life: number; // remaining s
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  drag: number;
}

export class Effects {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private positions = new Float32Array(MAX * 3);
  private colors = new Float32Array(MAX * 3);
  private particles: (Particle | null)[] = new Array(MAX).fill(null);
  private cursor = 0;

  constructor() {
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.55,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    // park dead particles far below the world
    this.positions.fill(-5000);
  }

  private spawn(
    x: number,
    y: number,
    z: number,
    v: [number, number, number],
    life: number,
    color: [number, number, number],
    gravity: number,
    drag: number,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;
    this.particles[i] = { life, maxLife: life, vx: v[0], vy: v[1], vz: v[2], gravity, drag };
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.colors[i * 3] = color[0];
    this.colors[i * 3 + 1] = color[1];
    this.colors[i * 3 + 2] = color[2];
  }

  muzzleSmoke(p: THREE.Vector3, dir: THREE.Vector3): void {
    for (let i = 0; i < 14; i++) {
      const s = 6 + Math.random() * 5;
      this.spawn(
        p.x,
        p.y,
        p.z,
        [
          dir.x * s + (Math.random() - 0.5) * 2.4,
          dir.y * s + Math.random() * 1.8 + 0.6,
          dir.z * s + (Math.random() - 0.5) * 2.4,
        ],
        0.9 + Math.random() * 0.7,
        [0.82, 0.8, 0.76],
        0.6,
        3.2,
      );
    }
  }

  splash(x: number, y: number, z: number, scale = 1): void {
    const n = Math.round(16 * scale);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = (1.4 + Math.random() * 3.2) * scale;
      this.spawn(
        x,
        y,
        z,
        [Math.cos(a) * r * 0.5, 3.5 * scale + Math.random() * 4 * scale, Math.sin(a) * r * 0.5],
        0.8 + Math.random() * 0.5,
        [0.88, 0.94, 0.95],
        -9.81,
        0.4,
      );
    }
  }

  splinters(p: THREE.Vector3, normal: THREE.Vector3): void {
    for (let i = 0; i < 18; i++) {
      this.spawn(
        p.x,
        p.y,
        p.z,
        [
          normal.x * 4 + (Math.random() - 0.5) * 6,
          2.5 + Math.random() * 4,
          normal.z * 4 + (Math.random() - 0.5) * 6,
        ],
        0.7 + Math.random() * 0.8,
        [0.32, 0.22, 0.13],
        -9.81,
        0.6,
      );
    }
  }

  update(dt: number): void {
    for (let i = 0; i < MAX; i++) {
      const p = this.particles[i];
      if (!p) continue;
      p.life -= dt;
      if (p.life <= 0) {
        this.particles[i] = null;
        this.positions[i * 3 + 1] = -5000;
        continue;
      }
      const dragF = Math.max(1 - p.drag * dt, 0);
      p.vx *= dragF;
      p.vy = p.vy * dragF + p.gravity * dt;
      p.vz *= dragF;
      this.positions[i * 3] += p.vx * dt;
      this.positions[i * 3 + 1] += p.vy * dt;
      this.positions[i * 3 + 2] += p.vz * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
