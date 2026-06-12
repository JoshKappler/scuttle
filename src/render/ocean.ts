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
  /** Cutaway support: punch a box-shaped HOLE in the sea around the ship's
   *  footprint (clipIntersection of 4 outward planes). Unlike a half-plane
   *  clip, this neither splits the ocean to the horizon nor lets the open
   *  sea read as "water inside the hull" (playtest rounds 2–4). */
  setCutawayHole(planes: THREE.Plane[] | null): void;
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

void main() {
  #include <clipping_planes_fragment>
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
  col = mix(col, vec3(0.92, 0.96, 0.95), clamp(foam * (1.0 - flat_ * 0.4) * 0.85 + cap * 0.9, 0.0, 1.0));

  // exponential-squared fog toward horizon
  float dist = length(uCameraPos - vWorldPos);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
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
    },
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;

  return {
    mesh,
    setCutawayHole(planes) {
      mat.clippingPlanes = planes;
      // intersection semantics: a fragment is discarded only when it is on
      // the clipped side of ALL planes — i.e. inside the ship's box
      mat.clipIntersection = planes !== null;
      mat.needsUpdate = true;
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
