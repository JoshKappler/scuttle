import * as THREE from "three";
import { TUN } from "../core/tunables";

/**
 * Procedural cloud dome — a large inward-facing sphere whose fragment shader
 * raises soft FBM cumulus over the atmospheric Sky. It follows the camera (clouds
 * sit at "infinity", you never sail up to them) and is also rendered into the sky
 * env cube (render/sky.ts) so the sea reflects it.
 *
 * The view direction is the normalized OBJECT-space vertex position (the camera is
 * at the dome's centre), so the shader is independent of where the dome sits —
 * the same mesh renders correctly from the player camera AND from the env cube
 * camera, as long as that camera is at the dome's centre.
 *
 * VISUAL ONLY: nothing here is read by physics (THE LAW #1).
 */

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position); // object-space dir from dome centre = view dir
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uCoverage;  // 0..1 — how much sky is cloud
uniform float uDensity;   // 0..1 — opacity/contrast of each puff
uniform float uSpeed;     // drift rate
uniform vec3 uHorizon;    // sky horizon-haze colour — low clouds dissolve into it (no "wall")
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * noise(p); p = m * p; a *= 0.5; }
  return v;
}

void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  if (up < 0.02) discard; // below the horizon: leave the sky alone

  // cloud projection by VIEW DIRECTION (zero parallax → reads as infinitely far). round 3
  // (2026-06-16): the hard floor max(up,0.30) FROZE the projection below up=0.30 into a static
  // SMEAR RING hugging the horizon — the "painted ceiling / wall" the player kept seeing. A small
  // additive bias (up+0.16) instead lets the cells stretch CONTINUOUSLY toward the horizon (no
  // frozen band); the fade + haze-tint below DISSOLVE that stretched low band into the horizon haze
  // rather than standing it up as a wall. (Research: direction-sampled clouds, viewDir.xz/(viewDir.y+bias).)
  vec2 uv = (d.xz / (up + 0.16)) * 1.7;
  uv += uTime * uSpeed * 0.01 * vec2(1.0, 0.6);

  float n = fbm(uv); // ~0.2..0.75, mean ~0.45
  // coverage drives the threshold DOWN (more sky becomes cloud); density sharpens
  // the cloud edge. Matched to fbm's actual range so mid coverage = a broken deck.
  float t = mix(0.60, 0.28, clamp(uCoverage, 0.0, 1.0));
  float soft = mix(0.16, 0.05, clamp(uDensity, 0.0, 1.0));
  float alpha = smoothstep(t, t + soft, n);
  // DISSOLVE clouds into the horizon: fade alpha to 0 by the horizon so the (now continuously
  // stretched) low band reads as thinning haze, not a hard cloud edge / ring. Clouds reach full
  // strength a little above the horizon; the haze-tint below then pulls the faint low band toward
  // the sky's horizon colour, so sea, sky and cloud all converge on ONE band at the horizon.
  alpha *= smoothstep(0.05, 0.32, up);

  // a second, finer FBM tints the puffs so they aren't flat
  float detail = fbm(uv * 2.7 + 11.0);

  // lighting: cloud colour must live near the sky's brightness to read against it,
  // but stay mostly BELOW the bloom threshold (~1.5) or bright clouds bloom into a
  // featureless white mush. Grey shadowed bases → bright (lightly blooming) tops,
  // warmer toward the sun; the fbm detail gives each puff internal form.
  float sun = max(dot(d, normalize(uSunDir)), 0.0);
  vec3 shadowed = vec3(0.45, 0.50, 0.62);
  vec3 sunlit = mix(vec3(1.7, 1.7, 1.8), uSunColor * 1.9, 0.35);
  float litFactor = clamp(0.30 + 0.45 * detail + 0.35 * pow(sun, 2.0), 0.0, 1.0);
  vec3 col = mix(shadowed, sunlit, litFactor);
  // atmospheric perspective: tint clouds toward the horizon haze as they near the horizon, so the
  // faint low clouds DISSOLVE into the same haze the sky dome and the ocean's far-fog fade to — sea,
  // sky and cloud all converge on ONE colour at the horizon (no "Hollywood set" wall or ceiling edge).
  float haze = 1.0 - smoothstep(0.16, 0.52, up);
  col = mix(col, uHorizon, haze * 0.85);

  gl_FragColor = vec4(col, alpha);
}
`;

export class CloudDome {
  readonly mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;

  constructor(sunDir: THREE.Vector3, sunColor: THREE.Color, horizonColor: THREE.Color, radius = 2000) {
    const geo = new THREE.SphereGeometry(radius, 32, 24);
    // The cloud dome lives in the separate BACKGROUND scene (render/post.ts renders
    // it first, then clears depth and draws the main scene over it, so the ship and
    // ocean naturally occlude the clouds). Within that bg scene it just blends over
    // the sky: transparent, depthTest OFF (it lost the depth test against the sky
    // dome), drawn after the sky (renderOrder -1000) at -999.
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSunDir: { value: sunDir.clone() },
        uSunColor: { value: sunColor.clone() },
        uCoverage: { value: TUN.gfx.clouds.coverage },
        uDensity: { value: TUN.gfx.clouds.density },
        uSpeed: { value: TUN.gfx.clouds.speed },
        uHorizon: { value: horizonColor.clone() },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    // after the sky (renderOrder -1000), before all scene geometry (default 0)
    this.mesh.renderOrder = -999;
  }

  /** Advance the drift and follow the camera so clouds stay at "infinity". */
  update(time: number, cameraPos: THREE.Vector3): void {
    this.mat.uniforms.uTime.value = time;
    this.mat.uniforms.uCoverage.value = TUN.gfx.clouds.coverage;
    this.mat.uniforms.uDensity.value = TUN.gfx.clouds.density;
    this.mat.uniforms.uSpeed.value = TUN.gfx.clouds.speed;
    this.mesh.position.copy(cameraPos);
  }
}
