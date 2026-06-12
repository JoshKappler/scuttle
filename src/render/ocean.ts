import * as THREE from "three";
import type { Wave } from "../sim/gerstner";

/**
 * Ocean surface: a displaced plane whose vertex shader evaluates the SAME
 * Gerstner equations as src/sim/gerstner.ts, from the same Wave parameters.
 * Per-wave uniforms are precomputed so GPU and CPU stay in exact agreement:
 *   uWaveA[i] = (dirX, dirZ, amplitude, k)
 *   uWaveB[i] = (qa, omega)  with qa = horizontal coefficient, omega = k·phaseSpeed
 */

const OCEAN_SIZE = 1200; // m square
const SEGMENTS = 400;

export interface Ocean {
  mesh: THREE.Mesh;
  update(time: number, cameraPos: THREE.Vector3): void;
  /** Cutaway support (playtest rounds 2–4): discard the sea (a) inside the
   *  ship's footprint, so the hull never reads "full of ocean", and (b) in a
   *  BOUNDED wedge on the camera side of the cut plane, so the exterior sea
   *  can't occlude the view into the hull from low angles. Unlike clip
   *  planes this never splits the ocean to the horizon. */
  setCutaway(on: boolean): void;
  /** Size the cutaway hole/wedge for the ship being inspected (half-length,
   *  half-beam in meters — the brig and the sloop differ). */
  setFootprint(halfL: number, halfB: number): void;
  updateCutaway(shipPos: THREE.Vector3, fwdX: number, fwdZ: number, cutPlane: THREE.Plane): void;
  /** Feed a ship's state once per frame (slot 0 = player, 1 = enemy): drives
   *  the bow swell (the sea genuinely lifts at the stem), the white water
   *  shouldered along the forward flanks, and a stern trail the foam laces
   *  between — a wake that follows the actual path sailed, curves and all
   *  (round 6: the old white water "appeared painted onto the ship"). */
  updateShipWake(
    slot: 0 | 1,
    centerX: number,
    centerZ: number,
    fwdX: number,
    fwdZ: number,
    speed: number,
    halfL: number,
    halfB: number,
    time: number,
  ): void;
}

function waveUniforms(waves: Wave[]) {
  const a: THREE.Vector4[] = [];
  const b: THREE.Vector2[] = [];
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    const q = Math.min(w.steepness / (k * w.amplitude * waves.length || 1), 1);
    a.push(new THREE.Vector4(w.dirX, w.dirZ, w.amplitude, k));
    b.push(new THREE.Vector2(q * w.amplitude, k * w.phaseSpeed));
  }
  return { a, b };
}

const VERT = /* glsl */ `
#include <clipping_planes_pars_vertex>
uniform float uTime;
uniform vec4 uWaveA[4]; // dirX, dirZ, amplitude, k
uniform vec2 uWaveB[4]; // qa, omega
uniform vec4 uShipA[2]; // bow x, bow z, fwdX, fwdZ
uniform vec4 uShipB[2]; // speed, halfL, halfB, 0

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCrest;

void main() {
  vec3 rest = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 p = rest;
  float nx = 0.0;
  float nz = 0.0;
  float ny = 1.0;
  float crest = 0.0;

  for (int i = 0; i < 4; i++) {
    vec2 dir = vec2(uWaveA[i].x, uWaveA[i].y);
    float amp = uWaveA[i].z;
    float k = uWaveA[i].w;
    float qa = uWaveB[i].x;
    float omega = uWaveB[i].y;

    float phase = k * dot(dir, rest.xz) - omega * uTime;
    float c = cos(phase);
    float s = sin(phase);

    p.x += dir.x * qa * c;
    p.z += dir.y * qa * c;
    p.y += amp * s;

    nx -= dir.x * k * amp * c;
    nz -= dir.y * k * amp * c;
    ny -= k * qa * s;
    crest += (s * 0.5 + 0.5) * amp;
  }

  // bow wave: the sea physically mounds at a moving stem — a swell that
  // rides with the bow point, scaled by speed (round 6: "see it actually
  // pushing some water up as it cuts through")
  for (int s2 = 0; s2 < 2; s2++) {
    float spd = uShipB[s2].x;
    if (spd < 1.0) continue;
    vec2 bow = uShipA[s2].xy;
    float bd2 = dot(p.xz - bow, p.xz - bow);
    float sF = clamp(spd / 8.0, 0.0, 1.2);
    p.y += sF * 0.55 * exp(-bd2 / 5.0);
    crest += sF * 0.8 * exp(-bd2 / 5.0);
  }

  vWorldPos = p;
  vNormal = normalize(vec3(nx, ny, nz));
  vCrest = crest;
  vec4 mvPosition = viewMatrix * vec4(p, 1.0);
  #include <clipping_planes_vertex>
  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = /* glsl */ `
#include <clipping_planes_pars_fragment>
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSkyColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uAmpTotal;
uniform vec3 uCameraPos;
uniform float uTime;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vCrest;

// cheap value noise for foam break-up
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}

uniform float uCutOn;
uniform vec2 uShipPos; // world xz of the cutaway ship
uniform vec2 uFwd; // unit fore-aft axis, world xz
uniform vec2 uHalf; // half-length, half-beam of the footprint
uniform vec4 uCutPlane; // xyz = normal, w = constant (THREE.Plane form)
uniform vec4 uShipA[2]; // bow x, bow z, fwdX, fwdZ
uniform vec4 uShipB[2]; // speed, halfL, halfB, 0
uniform vec4 uTrail[64]; // stern-path points: x, z, age (s), strength

void main() {
  #include <clipping_planes_fragment>

  // cutaway: the sea over the hull footprint is removed outright (the hold
  // is air, not water); the bounded wedge on the camera side of the cut
  // goes TRANSLUCENT — "make the ocean transparent … so that you can see
  // down to where the water level is" (playtest), with no black void
  float cutAlpha = 1.0;
  if (uCutOn > 0.5) {
    vec2 rel = vWorldPos.xz - uShipPos;
    float along = dot(rel, uFwd);
    float across = dot(rel, vec2(-uFwd.y, uFwd.x));
    if (abs(along) < uHalf.x) {
      if (abs(across) < uHalf.y) discard;
      if (abs(across) < uHalf.y * 4.5 &&
          dot(vWorldPos, uCutPlane.xyz) + uCutPlane.w < 0.0) {
        cutAlpha = 0.22;
      }
    }
  }

  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCameraPos - vWorldPos);
  vec3 L = normalize(uSunDir);

  // fine ripple detail: perturb the normal with scrolling noise gradients so
  // sun glints scatter into sparkle instead of a solid stripe
  vec2 p1 = vWorldPos.xz * 1.6 + vec2(uTime * 0.35, uTime * 0.21);
  vec2 p2 = vWorldPos.xz * 4.7 - vec2(uTime * 0.27, uTime * 0.44);
  float e = 0.35;
  float g1x = noise(p1 + vec2(e, 0.0)) - noise(p1 - vec2(e, 0.0));
  float g1z = noise(p1 + vec2(0.0, e)) - noise(p1 - vec2(0.0, e));
  float g2x = noise(p2 + vec2(e, 0.0)) - noise(p2 - vec2(e, 0.0));
  float g2z = noise(p2 + vec2(0.0, e)) - noise(p2 - vec2(0.0, e));
  vec3 Nd = normalize(N + vec3(g1x * 0.45 + g2x * 0.25, 0.0, g1z * 0.45 + g2z * 0.25));

  // base water color: deeper where we look straight down, lighter at grazing
  float facing = max(dot(N, V), 0.0);
  vec3 water = mix(uShallowColor, uDeepColor, facing);

  // fresnel sky reflection
  float fresnel = pow(1.0 - facing, 5.0);
  vec3 col = mix(water, uSkyColor, clamp(fresnel * 0.85 + 0.05, 0.0, 1.0));

  // sun glints (detailed normal → sparkle)
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(Nd, H), 0.0), 420.0) * 1.8;
  spec += pow(max(dot(Nd, H), 0.0), 90.0) * 0.22;
  col += uSunColor * spec;

  // subsurface light through wave crests facing the sun
  float sss = pow(max(dot(V, -L), 0.0), 3.0) * smoothstep(0.3, 1.0, vCrest / uAmpTotal);
  col += vec3(0.05, 0.18, 0.16) * sss;

  // crest foam + whitecaps, broken up by noise
  float foamNoise = noise(vWorldPos.xz * 0.9 + uTime * 0.15) * 0.6
                  + noise(vWorldPos.xz * 3.1 - uTime * 0.1) * 0.4;
  float crestF = vCrest / uAmpTotal;
  float foam = smoothstep(0.5, 0.85, crestF) * smoothstep(0.35, 0.72, foamNoise);
  // hard whitecaps right at breaking crests (steep + high)
  float cap = smoothstep(0.72, 0.92, crestF) * smoothstep(0.97, 0.88, N.y);
  float flat_ = smoothstep(0.94, 1.0, N.y);

  // ship wash: (a) churned white along the forward hull flanks where the
  // stem shoulders the sea aside, (b) a turbulent trail laced between the
  // recorded stern-path points — it follows the actual track, curves and
  // all, widening and fading as it ages (round 6: "leaving a wake behind")
  float wash = 0.0;
  for (int s = 0; s < 2; s++) {
    float spd = uShipB[s].x;
    if (spd < 1.0) continue;
    vec2 fwd2 = uShipA[s].zw;
    vec2 bow = uShipA[s].xy;
    vec2 cen = bow - fwd2 * uShipB[s].y; // hull center
    vec2 rel = vWorldPos.xz - cen;
    float along = dot(rel, fwd2);
    float across = dot(rel, vec2(-fwd2.y, fwd2.x));
    float sF = clamp(spd / 8.0, 0.0, 1.2);
    if (along > uShipB[s].y * 0.1 && along < uShipB[s].y * 1.18) {
      float taper = 1.0 - 0.55 * max(along - uShipB[s].y * 0.45, 0.0) / (uShipB[s].y * 0.75);
      float edge = abs(across) - (uShipB[s].z * taper + 0.25);
      wash += sF * 0.95 * exp(-pow(max(edge, 0.0) / 1.0, 2.0));
    }
  }
  for (int i = 0; i < 63; i++) {
    if (i == 31) continue; // slot boundary: don't lace ship 0's tail to ship 1's head
    vec4 A = uTrail[i];
    vec4 B = uTrail[i + 1];
    if (A.w <= 0.0 || B.w <= 0.0) continue;
    vec2 ab = B.xy - A.xy;
    float L2 = dot(ab, ab);
    if (L2 < 0.04 || L2 > 400.0) continue;
    float h = clamp(dot(vWorldPos.xz - A.xy, ab) / L2, 0.0, 1.0);
    float dseg = length(vWorldPos.xz - (A.xy + ab * h));
    float ageM = mix(A.z, B.z, h);
    float width = 0.95 + ageM * 0.9;
    wash += exp(-pow(dseg / width, 2.0)) * exp(-ageM * 0.26) * mix(A.w, B.w, h);
  }
  // break the wash up so it reads as churned water, not paint
  wash *= 0.5 + 0.5 * noise(vWorldPos.xz * 1.6 + uTime * 0.45);

  col = mix(col, vec3(0.92, 0.96, 0.95),
            clamp(foam * (1.0 - flat_ * 0.4) * 0.85 + cap * 0.9 + wash * 0.7, 0.0, 0.93));

  // exponential-squared fog toward horizon
  float dist = length(uCameraPos - vWorldPos);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(col, cutAlpha);
}
`;

export function createOcean(waves: Wave[], sunDir: THREE.Vector3): Ocean {
  const geo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);

  const { a, b } = waveUniforms(waves);
  const ampTotal = waves.reduce((s, w) => s + w.amplitude, 0);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    clipping: true,
    transparent: true, // the cutaway wedge fades to glass; alpha 1 elsewhere
    depthWrite: true,
    side: THREE.DoubleSide, // a submerged camera must see the surface above
    // it, not a missing polygon that cuts straight to the skybox (playtest)
    uniforms: {
      uTime: { value: 0 },
      uWaveA: { value: a },
      uWaveB: { value: b },
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: new THREE.Color(1.0, 0.78, 0.55) },
      uDeepColor: { value: new THREE.Color(0x0a3340) },
      uShallowColor: { value: new THREE.Color(0x1a6a72) },
      uSkyColor: { value: new THREE.Color(0x9fc4d4) },
      uFogColor: { value: new THREE.Color(0xc4d6d6) },
      uFogDensity: { value: 0.0016 },
      uAmpTotal: { value: ampTotal },
      uCameraPos: { value: new THREE.Vector3() },
      uCutOn: { value: 0 },
      uShipPos: { value: new THREE.Vector2() },
      uFwd: { value: new THREE.Vector2(1, 0) },
      uHalf: { value: new THREE.Vector2(12.9, 3.7) },
      uCutPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
      uShipA: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uShipB: { value: [new THREE.Vector4(), new THREE.Vector4()] },
      uTrail: { value: Array.from({ length: 64 }, () => new THREE.Vector4()) },
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  // stern-path ring buffers (one per ship slot): points are laid every few
  // meters of travel and age out; the fragment shader laces foam between them
  const trails: { x: number; z: number; t: number; w: number }[][] = [[], []];

  return {
    mesh,
    setCutaway(on) {
      mat.uniforms.uCutOn.value = on ? 1 : 0;
    },
    setFootprint(halfL, halfB) {
      (mat.uniforms.uHalf.value as THREE.Vector2).set(halfL, halfB);
    },
    updateShipWake(slot, centerX, centerZ, fwdX, fwdZ, speed, halfL, halfB, time) {
      const a = (mat.uniforms.uShipA.value as THREE.Vector4[])[slot];
      const b = (mat.uniforms.uShipB.value as THREE.Vector4[])[slot];
      a.set(centerX + fwdX * halfL, centerZ + fwdZ * halfL, fwdX, fwdZ);
      b.set(speed, halfL, halfB, 0);

      const trail = trails[slot];
      const sx = centerX - fwdX * (halfL + 0.8);
      const sz = centerZ - fwdZ * (halfL + 0.8);
      const last = trail[trail.length - 1];
      if (speed > 1.5 && (!last || Math.hypot(sx - last.x, sz - last.z) > 2.4)) {
        trail.push({ x: sx, z: sz, t: time, w: Math.min(speed / 6, 1.1) });
      }
      while (trail.length > 31 || (trail.length > 0 && time - trail[0].t > 16)) trail.shift();

      const u = mat.uniforms.uTrail.value as THREE.Vector4[];
      const base = slot * 32;
      for (let i = 0; i < 32; i++) {
        const pt = trail[i];
        if (pt) u[base + i].set(pt.x, pt.z, time - pt.t, pt.w);
        else u[base + i].set(0, 0, 0, 0);
      }
    },
    updateCutaway(shipPos, fwdX, fwdZ, cutPlane) {
      (mat.uniforms.uShipPos.value as THREE.Vector2).set(shipPos.x, shipPos.z);
      (mat.uniforms.uFwd.value as THREE.Vector2).set(fwdX, fwdZ);
      (mat.uniforms.uCutPlane.value as THREE.Vector4).set(
        cutPlane.normal.x,
        cutPlane.normal.y,
        cutPlane.normal.z,
        cutPlane.constant,
      );
    },
    update(time, cameraPos) {
      mat.uniforms.uTime.value = time;
      mat.uniforms.uCameraPos.value.copy(cameraPos);
      // keep the ocean tile centered under the camera (snapped to avoid swimming)
      mesh.position.x = Math.round(cameraPos.x / 10) * 10;
      mesh.position.z = Math.round(cameraPos.z / 10) * 10;
    },
  };
}
