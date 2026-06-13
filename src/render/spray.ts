import * as THREE from "three";
import { G } from "../core/constants";

/**
 * P5 — GPU-INSTANCED ballistic spray (the "she throws white water" half of the
 * ship-interaction work; the user: "the front of the ship pushes up and sprays
 * water … this should utilize the GPU heavily").
 *
 * Every droplet is ONE instance of a single camera-facing quad. The vertex shader
 * runs the whole ballistic arc on the GPU — there is no per-frame CPU position
 * update at all, unlike the older THREE.Points pool in effects.ts. Each instance
 * carries its spawn state and the shader evaluates
 *     p(age) = p0 + v0·age + ½·g·age²,   age = uTime − t0
 * billboards the quad toward the camera, and fades it out over its life. A dead
 * instance is PARKED (life 0 → the shader collapses the quad to a point far below
 * the world) so it draws nothing until the ring buffer reuses its slot.
 *
 * effects.ts delegates its bow-wave and crest spray here (its park-dead / ring-
 * recycle pool contract is preserved). The CPU still owns the closed-form LANDING
 * point of each droplet (we know p0, v0, t0, so the splash-down time/place is exact
 * without any GPU readback) and surfaces recent landings so the dynamic-wave field
 * can stamp foam where the spray comes down.
 */

const MAX = 4000; // instances in the pool

export interface SprayLanding {
  x: number;
  z: number;
  /** simulation time the droplet splashes down. */
  t: number;
  /** 0..1 weight (size) of the landing splash. */
  strength: number;
}

const VERT = /* glsl */ `
precision highp float;
attribute vec3 iPos;    // spawn position p0 (world)
attribute vec4 iVel;    // xyz = launch velocity v0, w = spawn time t0
attribute vec4 iParam;  // x = life (s, 0 = dead), y = size (m), z = seed, w = unused
uniform float uTime;
uniform float uG;       // gravity magnitude (downward)
varying float vAge01;   // 0 at spawn → 1 at death
varying vec2 vQuad;     // [-1,1] quad coords for the round mask
void main() {
  float life = iParam.x;
  float age = uTime - iVel.w;
  if (life <= 0.0 || age < 0.0 || age > life) {
    // parked / expired: collapse far below the world so nothing rasterizes.
    gl_Position = vec4(0.0, -10.0, 0.0, 1.0);
    vAge01 = 1.0;
    vQuad = vec2(0.0);
    return;
  }
  vAge01 = age / life;
  // ballistic arc, entirely on the GPU.
  vec3 wp = iPos + iVel.xyz * age + vec3(0.0, -0.5 * uG * age * age, 0.0);

  // camera-facing billboard: offset along the view-space right/up axes.
  float sz = iParam.y * (1.0 - 0.35 * vAge01); // shrink a touch as it ages
  vec2 q = position.xy; // the unit quad corner in [-0.5,0.5]
  vQuad = q * 2.0;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  mv.xy += q * sz;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying float vAge01;
varying vec2 vQuad;
uniform vec3 uColor;
void main() {
  // round soft droplet: radial falloff, fade over life.
  float r = dot(vQuad, vQuad);
  if (r > 1.0) discard;
  float a = (1.0 - r) * (1.0 - vAge01);
  if (a <= 0.01) discard;
  gl_FragColor = vec4(uColor, a * 0.9);
}
`;

export interface Spray {
  /** Add this to the scene. */
  readonly object: THREE.Object3D;
  /** Advance time (only updates the shader clock — the arc is GPU-evaluated). */
  update(time: number): void;
  /** Emit `count` droplets from `p0` with a base launch velocity `v0` plus
   *  scatter. `size` is the droplet radius (m). Returns nothing; landings are
   *  queued and drained via {@link drainLandings}. */
  emit(p0: THREE.Vector3, v0: THREE.Vector3, count: number, spread: number, size: number, time: number): void;
  /** Bow-wave sheets peeling off the stem to port & starboard (replaces the
   *  effects.ts bowWave look on the GPU). `fwd` is the hull's heading (unit). */
  bow(x: number, y: number, z: number, fwdX: number, fwdZ: number, strength: number, time: number): void;
  /** A vertical plume flung off a breaking/crossing crest (replaces crestSpray). */
  crest(x: number, y: number, z: number, windX: number, windZ: number, strength: number, time: number): void;
  /** Drain the spray landings recorded since the last call (for foam stamping). */
  drainLandings(): SprayLanding[];
  dispose(): void;
}

export function createSpray(): Spray {
  // unit quad centred at origin, corners in [-0.5, 0.5].
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;

  const iPos = new Float32Array(MAX * 3);
  const iVel = new Float32Array(MAX * 4);
  const iParam = new Float32Array(MAX * 4);
  const aPos = new THREE.InstancedBufferAttribute(iPos, 3);
  const aVel = new THREE.InstancedBufferAttribute(iVel, 4);
  const aParam = new THREE.InstancedBufferAttribute(iParam, 4);
  aPos.setUsage(THREE.DynamicDrawUsage);
  aVel.setUsage(THREE.DynamicDrawUsage);
  aParam.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("iPos", aPos);
  geo.setAttribute("iVel", aVel);
  geo.setAttribute("iParam", aParam);
  geo.instanceCount = MAX;
  // a generous bounding sphere so the whole pool is never frustum-culled (the
  // billboards live wherever ships are, not at the origin).
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uG: { value: G },
      uColor: { value: new THREE.Color(0.93, 0.97, 0.99) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5; // over the sea, under HUD

  let cursor = 0;
  const landings: SprayLanding[] = [];

  function spawnOne(
    px: number,
    py: number,
    pz: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    time: number,
  ): void {
    const i = cursor;
    cursor = (cursor + 1) % MAX;
    iPos[i * 3] = px;
    iPos[i * 3 + 1] = py;
    iPos[i * 3 + 2] = pz;
    iVel[i * 4] = vx;
    iVel[i * 4 + 1] = vy;
    iVel[i * 4 + 2] = vz;
    iVel[i * 4 + 3] = time; // t0
    iParam[i * 4] = life;
    iParam[i * 4 + 1] = size;
    iParam[i * 4 + 2] = Math.random();
    iParam[i * 4 + 3] = 0;

    // closed-form splash-down: solve py + vy·a − ½g·a² = py_land. We treat the
    // launch height as the splash plane (the droplet returns to where it left the
    // sea), so a = 2·vy/g when vy>0; record the landing for foam stamping.
    if (vy > 0.2) {
      const a = (2 * vy) / G;
      const lx = px + vx * a;
      const lz = pz + vz * a;
      landings.push({ x: lx, z: lz, t: time + Math.min(a, life), strength: Math.min(size * 1.6, 1) });
    }
    aPos.needsUpdate = true;
    aVel.needsUpdate = true;
    aParam.needsUpdate = true;
  }

  return {
    object: mesh,
    update(time) {
      mat.uniforms.uTime.value = time;
    },
    emit(p0, v0, count, spread, size, time) {
      for (let i = 0; i < count; i++) {
        const sx = (Math.random() - 0.5) * spread;
        const sy = (Math.random() - 0.5) * spread;
        const sz = (Math.random() - 0.5) * spread;
        spawnOne(
          p0.x + (Math.random() - 0.5) * 0.6,
          p0.y + Math.random() * 0.2,
          p0.z + (Math.random() - 0.5) * 0.6,
          v0.x + sx,
          v0.y + sy * 0.6 + Math.random() * 0.8,
          v0.z + sz,
          0.5 + Math.random() * 0.6,
          size * (0.7 + Math.random() * 0.6),
          time,
        );
      }
    },
    bow(x, y, z, fwdX, fwdZ, strength, time) {
      const rx = -fwdZ; // starboard unit (horizontal)
      const rz = fwdX;
      const n = Math.round(6 + 8 * Math.min(strength, 3));
      for (const side of [-1, 1]) {
        for (let i = 0; i < n; i++) {
          const lat = 0.8 + Math.random() * 0.9; // mostly outward
          const fwd = 0.1 + Math.random() * 0.4;
          const vmag = 3.0 + Math.random() * 4.0 * Math.min(strength, 2.5);
          const ox = rx * side;
          const oz = rz * side;
          spawnOne(
            x + ox * (0.3 + Math.random() * 1.0),
            y + Math.random() * 0.3,
            z + oz * (0.3 + Math.random() * 1.0),
            (ox * lat + fwdX * fwd) * vmag,
            2.2 + Math.random() * 3.2 * Math.min(strength, 2.0),
            (oz * lat + fwdZ * fwd) * vmag,
            0.55 + Math.random() * 0.5,
            0.34 + Math.random() * 0.22,
            time,
          );
        }
      }
    },
    crest(x, y, z, windX, windZ, strength, time) {
      const s = Math.min(strength, 2.6);
      const n = 6 + Math.round(s * 5);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const lat = 0.3 + Math.random() * 0.9;
        const up = 3.4 + Math.random() * 4.6 * s;
        spawnOne(
          x + (Math.random() - 0.5) * 1.0,
          y + Math.random() * 0.3,
          z + (Math.random() - 0.5) * 1.0,
          Math.cos(a) * lat + windX * 1.8 * s,
          up,
          Math.sin(a) * lat + windZ * 1.8 * s,
          0.6 + Math.random() * 0.7,
          0.3 + Math.random() * 0.24,
          time,
        );
      }
    },
    drainLandings() {
      if (landings.length === 0) return [];
      const out = landings.slice();
      landings.length = 0;
      return out;
    },
    dispose() {
      base.dispose();
      geo.dispose();
      mat.dispose();
    },
  };
}
