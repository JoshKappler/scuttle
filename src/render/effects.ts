import * as THREE from "three";
import type { Spray } from "./spray";

/**
 * Pooled particle systems for all transient effects. Two layers:
 *  - `points`: normal-blended motes (smoke, splinters, spray, blood)
 *  - `fire`: additive-blended hot stuff (muzzle flame, sparks, embers)
 * plus a small pool of PointLights for muzzle/impact flashes. The lights are
 * pre-added at intensity 0 — adding a light at runtime recompiles every
 * shader in the scene, which is a guaranteed hitch mid-broadside.
 */
const MAX = 1600;
const MAX_FIRE = 700;
const FLASH_POOL = 6;

// reused launch vectors for the per-voxel waterline fizz (r18) — no per-call allocation
const _fizzP = new THREE.Vector3();
const _fizzV = new THREE.Vector3();

/** Soft round particle sprite (radial gradient → transparent). Without it
 *  THREE.Points draws hard SQUARES — "the particles … are basically just a
 *  scatter of white squares" (round 10). Built once, shared by both layers. */
let _softSprite: THREE.Texture | null = null;
function softSprite(): THREE.Texture {
  if (_softSprite) return _softSprite;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.beginPath();
  g.arc(32, 32, 32, 0, Math.PI * 2);
  g.fill();
  _softSprite = new THREE.CanvasTexture(c);
  return _softSprite;
}

interface Particle {
  life: number; // remaining s
  maxLife: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  drag: number;
}

interface Layer {
  geo: THREE.BufferGeometry;
  positions: Float32Array;
  colors: Float32Array;
  particles: (Particle | null)[];
  cursor: number;
  max: number;
}

function makeLayer(max: number, size: number, additive: boolean): { layer: Layer; points: THREE.Points } {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(max * 3);
  const colors = new Float32Array(max * 3);
  positions.fill(-5000); // park dead particles far below the world
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size,
    map: softSprite(), // soft round dots, not hard squares
    vertexColors: true,
    transparent: true,
    opacity: additive ? 1 : 0.9,
    depthWrite: false,
    sizeAttenuation: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    layer: { geo, positions, colors, particles: new Array(max).fill(null), cursor: 0, max },
    points,
  };
}

export class Effects {
  /** Add THIS to the scene — contains both particle layers and the lights. */
  readonly group = new THREE.Group();
  /** Kept for back-compat with existing scene.add(effects.points) callers. */
  readonly points: THREE.Points;

  private smoke: Layer;
  private fire: Layer;
  private flashes: { light: THREE.PointLight; life: number; maxLife: number; peak: number }[] = [];

  // P5: when set, the bow/crest/directional WATER spray is emitted by the GPU-
  // instanced ballistic system (src/render/spray.ts) instead of the CPU Points
  // pool — "this should utilize the GPU heavily". Smoke/fire/debris/blood stay on
  // the CPU pool. `_simTime` is the absolute sim clock the GPU arcs need.
  private gpuSpray: Spray | null = null;
  private _simTime = 0;
  /** Route water spray to the GPU instanced system. */
  attachSpray(spray: Spray): void {
    this.gpuSpray = spray;
  }

  constructor() {
    const s = makeLayer(MAX, 0.55, false);
    this.smoke = s.layer;
    this.points = s.points;
    this.group.add(s.points);
    const f = makeLayer(MAX_FIRE, 0.85, true);
    this.fire = f.layer;
    this.group.add(f.points);
    for (let i = 0; i < FLASH_POOL; i++) {
      const light = new THREE.PointLight(0xffb05a, 0, 34, 2);
      this.group.add(light);
      this.flashes.push({ light, life: 0, maxLife: 1, peak: 0 });
    }
  }

  private spawnInto(
    L: Layer,
    x: number,
    y: number,
    z: number,
    v: [number, number, number],
    life: number,
    color: [number, number, number],
    gravity: number,
    drag: number,
  ): void {
    const i = L.cursor;
    L.cursor = (L.cursor + 1) % L.max;
    L.particles[i] = { life, maxLife: life, vx: v[0], vy: v[1], vz: v[2], gravity, drag };
    L.positions[i * 3] = x;
    L.positions[i * 3 + 1] = y;
    L.positions[i * 3 + 2] = z;
    L.colors[i * 3] = color[0];
    L.colors[i * 3 + 1] = color[1];
    L.colors[i * 3 + 2] = color[2];
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
    this.spawnInto(this.smoke, x, y, z, v, life, color, gravity, drag);
  }

  /** Short light pop (muzzle blast, ball strike). */
  flash(p: THREE.Vector3, peak = 70, life = 0.12, color = 0xffb05a): void {
    let best = this.flashes[0];
    for (const f of this.flashes) if (f.life < best.life) best = f;
    best.life = life;
    best.maxLife = life;
    best.peak = peak;
    best.light.color.set(color);
    best.light.position.copy(p);
    best.light.intensity = peak;
  }

  /** A real gun going off (round 10: "much more intense … feel like a real
   *  loud explosion is coming, with smoke"). A hot bloom at the bore, a long
   *  flame tongue, a shower of embers, a fat brilliant flash. Pair with
   *  muzzleSmoke for the powder cloud. */
  muzzleFlash(p: THREE.Vector3, dir: THREE.Vector3): void {
    // hot bloom: a dense ball of white-hot flame right at the muzzle
    for (let i = 0; i < 16; i++) {
      this.spawnInto(
        this.fire,
        p.x + dir.x * 0.3,
        p.y + dir.y * 0.3,
        p.z + dir.z * 0.3,
        [dir.x * 4 + (Math.random() - 0.5) * 4.5, dir.y * 4 + (Math.random() - 0.5) * 4.5, dir.z * 4 + (Math.random() - 0.5) * 4.5],
        0.1 + Math.random() * 0.14,
        [1.0, 0.85, 0.5],
        0,
        5.5,
      );
    }
    // flame tongue: a long jet of fire blasting out the bore
    for (let i = 0; i < 44; i++) {
      const s = 17 + Math.random() * 24;
      this.spawnInto(
        this.fire,
        p.x,
        p.y,
        p.z,
        [
          dir.x * s + (Math.random() - 0.5) * 5.5,
          dir.y * s + (Math.random() - 0.5) * 5.5,
          dir.z * s + (Math.random() - 0.5) * 5.5,
        ],
        0.08 + Math.random() * 0.16,
        [1.0, 0.55 + Math.random() * 0.3, 0.18],
        0,
        4.2,
      );
    }
    // embers/sparks tumbling out and falling to the sea
    for (let i = 0; i < 18; i++) {
      const s = 6 + Math.random() * 11;
      this.spawnInto(
        this.fire,
        p.x,
        p.y,
        p.z,
        [
          dir.x * s + (Math.random() - 0.5) * 5,
          dir.y * s + Math.random() * 2.6,
          dir.z * s + (Math.random() - 0.5) * 5,
        ],
        0.35 + Math.random() * 0.55,
        [1.0, 0.42, 0.1],
        -7,
        1.0,
      );
    }
    this.flash(p, 145, 0.17);
  }

  /** Hull timber blown off by a cannon strike. The visual now MATCHES the
   *  damage: roughly one flying chunk per voxel actually removed from the hull
   *  (round 13: "too much coming off … just the voxels that were actually
   *  removed"). Brown oak/pine motes thrown OUTWARD along the impact normal,
   *  under gravity so they arc and fall into the sea — plus a small dust puff
   *  off the fresh wound. No sparks, no flash, no generic white storm.
   *
   *  `removed` is the voxel count from the carve that spawned it; 0 emits nothing. */
  impactDebris(p: THREE.Vector3, normal: THREE.Vector3, removed: number): void {
    if (removed <= 0) return;
    // one chunk per removed voxel (playtest round 13: "should not be capped at
    // 24, much higher"). Only a high safety cap remains so a single colossal bite
    // can't drain the whole particle pool; a normal strike throws its real count.
    const chunks = Math.min(removed, 250);
    for (let i = 0; i < chunks; i++) {
      // weathered hull-timber browns (oak ↔ pine), a touch brighter than the
      // unlit material colors so the chunks read against the sea.
      const shade = 0.7 + Math.random() * 0.6;
      this.spawn(
        p.x,
        p.y,
        p.z,
        [
          normal.x * 4.5 + (Math.random() - 0.5) * 5,
          2.5 + Math.random() * 4,
          normal.z * 4.5 + (Math.random() - 0.5) * 5,
        ],
        0.7 + Math.random() * 0.8,
        [0.34 * shade, 0.23 * shade, 0.13 * shade],
        -9.81,
        0.6,
      );
    }
    // a small dust/splinter-haze puff off the wound, scaled to the bite —
    // a glancing 1-voxel hit barely smokes; a 12-voxel gouge breathes dust.
    const dust = Math.min(2 + removed, 10);
    for (let i = 0; i < dust; i++) {
      this.spawn(
        p.x,
        p.y,
        p.z,
        [
          normal.x * 1.6 + (Math.random() - 0.5) * 2,
          0.6 + Math.random() * 1.2,
          normal.z * 1.6 + (Math.random() - 0.5) * 2,
        ],
        0.9 + Math.random() * 0.8,
        [0.5, 0.47, 0.43],
        0.4,
        2.4,
      );
    }
  }

  muzzleSmoke(p: THREE.Vector3, dir: THREE.Vector3): void {
    // a fat billowing powder cloud that rolls out the bore and lingers
    for (let i = 0; i < 30; i++) {
      const s = 3.5 + Math.random() * 8;
      this.spawn(
        p.x,
        p.y,
        p.z,
        [
          dir.x * s + (Math.random() - 0.5) * 4,
          dir.y * s + Math.random() * 2.4 + 0.5,
          dir.z * s + (Math.random() - 0.5) * 4,
        ],
        1.3 + Math.random() * 1.6,
        [0.86 - Math.random() * 0.18, 0.84 - Math.random() * 0.18, 0.8 - Math.random() * 0.18],
        0.4,
        2.2,
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

  /** Bow wave: two sheets of spray peeling off the stem to PORT and STARBOARD
   *  (round 10: "spraying out in either direction like the real front of a ship
   *  cutting through water"). Particles leave at the waterline and arc OUTWARD,
   *  away from the hull — they never climb onto the deck. */
  bowWave(x: number, y: number, z: number, fwdX: number, fwdZ: number, strength = 1): void {
    if (this.gpuSpray) {
      this.gpuSpray.bow(x, y, z, fwdX, fwdZ, strength, this._simTime);
      return;
    }
    const rx = -fwdZ; // starboard (right) unit, horizontal
    const rz = fwdX;
    const n = Math.round(8 * strength);
    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const lat = 0.75 + Math.random() * 0.7; // mostly sideways
        const fwd = 0.15 + Math.random() * 0.45; // a little forward
        const vmag = 2.6 + Math.random() * 3.6 * strength;
        const ox = rx * side;
        const oz = rz * side;
        this.spawn(
          x + ox * (0.3 + Math.random() * 0.9),
          y + Math.random() * 0.25,
          z + oz * (0.3 + Math.random() * 0.9),
          [(ox * lat + fwdX * fwd) * vmag, 1.3 + Math.random() * 2.1 * strength, (oz * lat + fwdZ * fwd) * vmag],
          0.5 + Math.random() * 0.5,
          [0.92, 0.96, 0.97],
          -9.81,
          0.6,
        );
      }
    }
  }

  /** r18: a light fizz of spray straight up off ONE hull voxel sitting at the waterline —
   *  the subtle "every waterline voxel throws a little water" layer. Much smaller and
   *  gentler than bowWave; the caller stipples many of these along the whole hull line. */
  waterlineFizz(x: number, y: number, z: number, strength = 1): void {
    const s = Math.min(strength, 1);
    if (this.gpuSpray) {
      _fizzP.set(x, y, z);
      // a fuller upward puff (r18.1: the side spray was too faint) — a little outward scatter
      // and a real vertical kick so it breaks visibly along the hull.
      _fizzV.set((Math.random() - 0.5) * 0.8, 1.5 + Math.random() * 1.6 * s, (Math.random() - 0.5) * 0.8);
      this.gpuSpray.emit(_fizzP, _fizzV, 2, 0.55, 0.16 + 0.09 * s, this._simTime);
      return;
    }
    // CPU fallback: a few small motes
    for (let i = 0; i < 3; i++) {
      this.spawn(
        x,
        y,
        z,
        [(Math.random() - 0.5) * 0.8, 1.4 + Math.random() * 1.6 * s, (Math.random() - 0.5) * 0.8],
        0.45 + Math.random() * 0.35,
        [0.92, 0.96, 0.97],
        -9.81,
        0.5,
      );
    }
  }

  /** Directional sheet of spray (bow plunging through a sea). */
  spray(x: number, y: number, z: number, dirX: number, dirZ: number, strength = 1): void {
    if (this.gpuSpray) {
      // a forward-leaning sheet: reuse the bow emitter aimed along the dir.
      this.gpuSpray.bow(x, y, z, dirX, dirZ, strength, this._simTime);
      return;
    }
    const n = Math.round(10 * strength);
    for (let i = 0; i < n; i++) {
      const a = (Math.random() - 0.5) * 1.7;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const dx = dirX * c - dirZ * s;
      const dz = dirX * s + dirZ * c;
      const v = 2.5 + Math.random() * 4 * strength;
      this.spawn(
        x + (Math.random() - 0.5) * 1.6,
        y,
        z + (Math.random() - 0.5) * 1.6,
        [dx * v, 2.2 + Math.random() * 3.2 * strength, dz * v],
        0.6 + Math.random() * 0.5,
        [0.9, 0.96, 0.97],
        -9.81,
        0.5,
      );
    }
  }

  /** A lick of white water flung off a breaking / crossing wave crest. A few
   *  droplets launched mostly UP with a little lateral scatter and a downwind
   *  lean — the open-sea "waves crash together and shoot water up" that the bow
   *  wave and wake (both hull-driven) can't provide. Driven by the ambient
   *  crest probe in the render loop, NOT by any ship. */
  crestSpray(x: number, y: number, z: number, windX: number, windZ: number, strength = 1): void {
    if (this.gpuSpray) {
      this.gpuSpray.crest(x, y, z, windX, windZ, strength, this._simTime);
      return;
    }
    const s = Math.min(strength, 2.6);
    // a DENSE tight cluster launched up together reads as a sheet of thrown water;
    // a handful of scattered motes just reads as floating dots.
    const n = 6 + Math.round(s * 5);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const lat = 0.3 + Math.random() * 0.9; // tight base — mostly a vertical plume
      const up = 3.4 + Math.random() * 4.6 * s; // high launch, varied → a fan of spray
      this.spawn(
        x + (Math.random() - 0.5) * 1.0,
        y + Math.random() * 0.3,
        z + (Math.random() - 0.5) * 1.0,
        [Math.cos(a) * lat + windX * 1.8 * s, up, Math.sin(a) * lat + windZ * 1.8 * s],
        0.6 + Math.random() * 0.8,
        [0.92, 0.96, 0.98],
        -9.81,
        0.45,
      );
    }
  }

  splinters(p: THREE.Vector3, normal: THREE.Vector3): void {
    for (let i = 0; i < 26; i++) {
      this.spawn(
        p.x,
        p.y,
        p.z,
        [
          normal.x * 4 + (Math.random() - 0.5) * 7,
          2.5 + Math.random() * 4.5,
          normal.z * 4 + (Math.random() - 0.5) * 7,
        ],
        0.7 + Math.random() * 0.8,
        [0.32, 0.22, 0.13],
        -9.81,
        0.6,
      );
    }
  }

  blood(x: number, y: number, z: number): void {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      this.spawn(
        x,
        y,
        z,
        [Math.cos(a) * (0.8 + Math.random() * 1.6), 1.0 + Math.random() * 1.6, Math.sin(a) * (0.8 + Math.random() * 1.6)],
        0.4 + Math.random() * 0.4,
        [0.42, 0.04, 0.04],
        -9.81,
        0.5,
      );
    }
  }

  private updateLayer(L: Layer, dt: number): void {
    for (let i = 0; i < L.max; i++) {
      const p = L.particles[i];
      if (!p) continue;
      p.life -= dt;
      if (p.life <= 0) {
        L.particles[i] = null;
        L.positions[i * 3 + 1] = -5000;
        continue;
      }
      const dragF = Math.max(1 - p.drag * dt, 0);
      p.vx *= dragF;
      p.vy = p.vy * dragF + p.gravity * dt;
      p.vz *= dragF;
      L.positions[i * 3] += p.vx * dt;
      L.positions[i * 3 + 1] += p.vy * dt;
      L.positions[i * 3 + 2] += p.vz * dt;
    }
    L.geo.attributes.position.needsUpdate = true;
    L.geo.attributes.color.needsUpdate = true;
  }

  update(dt: number, time?: number): void {
    if (time !== undefined) this._simTime = time;
    this.updateLayer(this.smoke, dt);
    this.updateLayer(this.fire, dt);
    // tick the GPU spray clock (its arcs are evaluated in the vertex shader).
    if (this.gpuSpray) this.gpuSpray.update(this._simTime);
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(f.life / f.maxLife, 0);
      f.light.intensity = f.peak * k * k;
    }
  }
}
