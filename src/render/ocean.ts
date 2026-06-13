import * as THREE from "three";
import type { Wave } from "../sim/gerstner";
import { physicsWaves } from "../sim/gerstner";
import type { OceanField } from "./oceanField";

/**
 * Ocean surface: a camera-centered POLAR grid whose vertex shader evaluates
 * the SAME Gerstner equations as src/sim/gerstner.ts, from the same Wave
 * parameters. Per-wave uniforms are precomputed so GPU and CPU agree:
 *   uWaveA[i] = (dirX, dirZ, amplitude, k)
 *   uWaveB[i] = (qa, omega)  with qa = Q·amplitude, omega = k·phaseSpeed
 *
 * Round 8 rebuild: the old 1200 m uniform plane had 3 m vertices — too
 * coarse to show the bow swell at all — and snapped to a 10 m grid as the
 * camera moved, re-sampling every wave against a shifted lattice (the
 * "stuttering"). The polar grid puts ~0.8 m vertices beside the hull and
 * 40 m ones at the horizon, follows the camera CONTINUOUSLY (the surface is
 * world-anchored, so a sliding lattice samples a smooth field smoothly), and
 * fades each wave out before the local vertex spacing can alias it.
 */

const R_NEAR = 0.8; // m — innermost ring
const R_FAR = 950; // m — horizon ring (fog owns everything past it)
const RINGS = 156;
const SECTORS = 160;

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
    /** World-Y of the keel bottom and the deck top: the sea is removed only
     *  within the footprint AND between these (round 10) — no white void under
     *  a lifted hull, no ocean in the hold. */
    keelWorldY: number,
    deckWorldY: number,
  ): void;
}

function waveUniforms(waves: Wave[]) {
  const a: THREE.Vector4[] = [];
  const b: THREE.Vector2[] = [];
  for (const w of waves) {
    const k = (2 * Math.PI) / w.wavelength;
    // steepness IS the per-wave Q — identical to sim/gerstner.ts displace()
    const q = Math.min(w.steepness, 1);
    a.push(new THREE.Vector4(w.dirX, w.dirZ, w.amplitude, k));
    b.push(new THREE.Vector2(q * w.amplitude, k * w.phaseSpeed));
  }
  return { a, b };
}

/** Camera-centered polar grid: exponential ring spacing, fine in close. */
function makePolarGrid(): THREE.BufferGeometry {
  const positions = new Float32Array((RINGS * SECTORS + 1) * 3);
  let vi = 1; // index 0 is the center vertex at the origin
  for (let j = 0; j < RINGS; j++) {
    const r = R_NEAR * Math.pow(R_FAR / R_NEAR, j / (RINGS - 1));
    for (let s = 0; s < SECTORS; s++) {
      const ang = (s / SECTORS) * Math.PI * 2;
      positions[vi * 3] = Math.cos(ang) * r;
      positions[vi * 3 + 2] = Math.sin(ang) * r;
      vi++;
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < SECTORS; s++) {
    idx.push(0, 1 + ((s + 1) % SECTORS), 1 + s); // center fan
  }
  for (let j = 0; j < RINGS - 1; j++) {
    const r0 = 1 + j * SECTORS;
    const r1 = r0 + SECTORS;
    for (let s = 0; s < SECTORS; s++) {
      const s1 = (s + 1) % SECTORS;
      idx.push(r0 + s, r0 + s1, r1 + s1, r0 + s, r1 + s1, r1 + s);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setIndex(idx);
  return geo;
}

const VERT = /* glsl */ `
#include <clipping_planes_pars_vertex>
uniform float uTime;
uniform vec4 uWaveA[NWAVES]; // dirX, dirZ, amplitude, k
uniform vec2 uWaveB[NWAVES]; // qa, omega
uniform vec4 uShipA[2]; // bow x, bow z, fwdX, fwdZ
uniform vec4 uShipB[2]; // speed, halfL, halfB, 0
uniform sampler2D uFftDisp; // FFT chop displacement (RGB = Dx, height, Dz)
uniform float uFftTile; // world tile size (m) for the FFT field
uniform float uFftOn; // 1 when the FFT backend is live, else 0

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
  // distance from the camera (the mesh is camera-centered, so the LOCAL
  // radius is exactly it) — used to fade each wave out before the ring
  // spacing under-samples it into shimmer
  float rDist = length(position.xz);

  for (int i = 0; i < NWAVES; i++) {
    vec2 dir = vec2(uWaveA[i].x, uWaveA[i].y);
    float k = uWaveA[i].w;
    float lam = 6.28318530718 / k;
    float fade = 1.0 - smoothstep(lam * 6.0, lam * 14.0, rDist);
    if (fade <= 0.001) continue;
    float amp = uWaveA[i].z * fade;
    float qa = uWaveB[i].x * fade;
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

  // FFT chop on top of the analytic swell: band-limited so the ship stays
  // welded to the swell it floats on. Faded out by mid-distance (60→130 m)
  // before the ring spacing under-samples the short chop into shimmer.
  if (uFftOn > 0.5) {
    float chopFade = 1.0 - smoothstep(60.0, 130.0, rDist);
    vec3 d = texture2D(uFftDisp, rest.xz / uFftTile).xyz; // Dx, height, Dz
    p.x += d.x * chopFade;
    p.z += d.z * chopFade;
    p.y += d.y * chopFade;
    crest += max(d.y, 0.0) * chopFade;
  }

  // the hull's effect on the sea: a STANDING displacement collar at all times
  // (round 9: "real boats have an effect on the water … make it bulge as it
  // displaces it"), plus the speed-driven bow wave on top.
  for (int s2 = 0; s2 < 2; s2++) {
    float hL = uShipB[s2].y;
    if (hL < 0.5) continue; // unused/uninitialised slot
    float hB = uShipB[s2].z;
    float spd = uShipB[s2].x;
    vec2 bow = uShipA[s2].xy;
    vec2 f2 = uShipA[s2].zw;
    vec2 rel = p.xz - (bow - f2 * hL); // from hull center
    float along = dot(rel, f2);
    float across = dot(rel, vec2(-f2.y, f2.x));

    // displacement collar: rr = 1 at the waterline-ellipse edge; the sea
    // mounds in a ridge just OUTSIDE it (inside is discarded as the dry hull)
    // and falls away both directions — the water the hull shoves aside has to
    // pile up somewhere, moving or not.
    float rr = sqrt((along / hL) * (along / hL) + (across / hB) * (across / hB));
    float collar = exp(-pow((rr - 1.08) / 0.17, 2.0));
    p.y += collar * 0.22;
    crest += collar * 0.18;

    // bow wave: the stem physically shoulders water aside — a mound at the
    // cutting point spilling into a ridge down the forward flanks, which the
    // fragment stage froths into the wake (round 6.5, beefed up round 8:
    // "the front of the ship actually pushing up and bulging the water")
    if (spd < 1.0) continue;
    float sF = clamp(spd / 8.0, 0.0, 1.2);
    float bd2 = dot(p.xz - bow, p.xz - bow);
    p.y += sF * 1.05 * exp(-bd2 / 5.5);
    float ridge = exp(-pow((abs(across) - (hB + 0.4)) / 1.5, 2.0));
    float span = smoothstep(-hL * 0.35, hL * 0.55, along) * (1.0 - smoothstep(hL * 0.8, hL * 1.1, along));
    p.y += sF * 0.5 * ridge * span;
    // the GEOMETRY is the show now — foam only laces it (the first cut
    // painted the whole bow quarter white)
    crest += sF * (0.45 * exp(-bd2 / 5.5) + 0.28 * ridge * span);
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
uniform sampler2D uFftNormal; // FFT surface normal (RGB = normal*0.5+0.5)
uniform sampler2D uFftFoam; // FFT foam coverage (R)
uniform float uFftTile; // world tile size (m) for the FFT field
uniform float uFftOn; // 1 when the FFT backend is live, else 0

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
uniform vec2 uShipC[2]; // keel world-Y, deck-top world-Y (hull vertical span)
uniform vec4 uTrail[64]; // stern-path points: x, z, age (s), strength

void main() {
  #include <clipping_planes_fragment>

  // dry bilges, ALWAYS: the sea does not exist inside an intact hull. The
  // surface is discarded within each ship's waterline ellipse so the hold
  // shows timber, not "the wake and the water flowing by" through the hatch
  // (round 7). uShipB[s].w fades to 0 as she floods — the sea closes back in.
  for (int s0 = 0; s0 < 2; s0++) {
    float keelY = uShipC[s0].x;
    float deckY = uShipC[s0].y;
    if (deckY <= keelY) continue; // unused slot
    vec2 f0 = uShipA[s0].zw;
    vec2 ctr = uShipA[s0].xy - f0 * uShipB[s0].y;
    vec2 rel0 = vWorldPos.xz - ctr;
    float al0 = dot(rel0, f0) / max(uShipB[s0].y * 0.97, 0.1);
    float ac0 = dot(rel0, vec2(-f0.y, f0.x)) / max(uShipB[s0].z * 0.92, 0.1);
    // remove ONLY the sea that is genuinely inside the hull volume: within the
    // waterline footprint AND between the keel and the deck (round 10). A flat
    // 2D cut showed the white void under a lifted hull and let ocean waves into
    // the hold while sinking; the vertical gate fixes both — below the keel the
    // sea shows under the hull (no void), the hold never shows ocean (flooding
    // is the separate water-box system), and the sea closes over a sunk wreck.
    if (al0 * al0 + ac0 * ac0 < 1.0 && vWorldPos.y > keelY && vWorldPos.y < deckY) discard;
  }

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
  vec2 p3 = vWorldPos.xz * 9.3 + vec2(uTime * -0.5, uTime * 0.33);
  float e = 0.35;
  float g1x = noise(p1 + vec2(e, 0.0)) - noise(p1 - vec2(e, 0.0));
  float g1z = noise(p1 + vec2(0.0, e)) - noise(p1 - vec2(0.0, e));
  float g2x = noise(p2 + vec2(e, 0.0)) - noise(p2 - vec2(e, 0.0));
  float g2z = noise(p2 + vec2(0.0, e)) - noise(p2 - vec2(0.0, e));
  float g3x = noise(p3 + vec2(e, 0.0)) - noise(p3 - vec2(e, 0.0));
  float g3z = noise(p3 + vec2(0.0, e)) - noise(p3 - vec2(0.0, e));
  // round 9: more bite in the fine relief so the chop reads in the glints, not
  // just a glassy swell. With the FFT field live, take the surface normal from
  // the GPU normal texture instead of the hand-rolled noise gradients.
  vec3 Nd;
  if (uFftOn > 0.5) {
    vec3 fn = texture2D(uFftNormal, vWorldPos.xz / uFftTile).xyz * 2.0 - 1.0;
    Nd = normalize(N + vec3(fn.x, 0.0, fn.z));
  } else {
    Nd = normalize(N + vec3(g1x * 0.6 + g2x * 0.4 + g3x * 0.22, 0.0,
                            g1z * 0.6 + g2z * 0.4 + g3z * 0.22));
  }

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

  // crest foam + whitecaps, broken up by noise. A 16-wave sum spends most of
  // its time near the middle of its range, so the thresholds sit HIGH — only
  // genuine crest coincidences whiten (the first cut boiled the whole sea)
  float foamNoise = noise(vWorldPos.xz * 0.9 + uTime * 0.15) * 0.6
                  + noise(vWorldPos.xz * 3.1 - uTime * 0.1) * 0.4;
  float crestF = vCrest / uAmpTotal;
  float foam = smoothstep(0.62, 0.95, crestF) * smoothstep(0.42, 0.78, foamNoise);
  // hard whitecaps right at breaking crests (steep + high)
  float cap = smoothstep(0.8, 1.0, crestF) * smoothstep(0.97, 0.88, N.y);
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
    float hL = uShipB[s].y;
    float hB = uShipB[s].z;
    vec2 rel = vWorldPos.xz - (bow - fwd2 * hL);
    float along = dot(rel, fwd2);
    float across = dot(rel, vec2(-fwd2.y, fwd2.x));
    float sF = clamp(spd / 8.0, 0.0, 1.2);
    // froth grows continuously from a sliver at the stem to a full churned
    // band by the stern — no hard cutoffs (round 6.5: the froth "abruptly
    // cuts off slightly ahead of the ship and at the halfway mark")
    float inHull = smoothstep(hL * 1.25, hL * 0.95, along) * smoothstep(-hL * 1.35, -hL * 0.6, along);
    float devel = 1.0 - smoothstep(-hL * 0.55, hL * 1.1, along); // 0 at stem → 1 astern
    float taper = 1.0 - 0.5 * smoothstep(hL * 0.3, hL * 1.05, along);
    float edge = abs(across) - (hB * taper + 0.2);
    float bandW = mix(0.5, hB * 0.9, devel);
    wash += sF * (0.3 + 0.7 * devel) * inHull * exp(-pow(max(edge, 0.0) / bandW, 2.0));

    // waterline lace: a thin bright ring right at the hull skin (rr ≈ 1)
    float rr = sqrt((along / hL) * (along / hL) + (across / hB) * (across / hB));
    float ring = exp(-pow((rr - 1.0) / 0.06, 2.0));
    wash += 0.5 * ring;
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
    // the wake leaves the stern at FULL ship beam and spreads as it ages;
    // fresh segments RAMP IN over a third of a second instead of popping
    // into existence at full strength (round 8: "the wake … is not very
    // smooth and is also stuttering") — the hull-flank wash band covers the
    // first meters astern while they fade up
    float hb2 = i < 32 ? uShipB[0].z : uShipB[1].z;
    float width = hb2 + 0.3 + ageM * 0.75;
    wash += exp(-pow(dseg / width, 2.0)) * exp(-ageM * 0.24) * mix(A.w, B.w, h)
          * smoothstep(0.0, 0.35, ageM);
  }
  // break the wash up so it reads as churned water, not paint
  wash *= 0.5 + 0.5 * noise(vWorldPos.xz * 1.6 + uTime * 0.45);

  // FFT foam: the Jacobian-fold whitecaps from the chop field, folded into the
  // existing foam composite (analytic crest foam + caps + ship wash).
  float fftFoam = uFftOn > 0.5 ? texture2D(uFftFoam, vWorldPos.xz / uFftTile).r : 0.0;

  col = mix(col, vec3(0.92, 0.96, 0.95),
            clamp(foam * (1.0 - flat_ * 0.4) * 0.85 + cap * 0.9 + wash * 0.55 + fftFoam * 0.7, 0.0, 0.93));

  // exponential-squared fog toward horizon
  float dist = length(uCameraPos - vWorldPos);
  float fog = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

  gl_FragColor = vec4(col, cutAlpha);
}
`;

export function createOcean(waves: Wave[], sunDir: THREE.Vector3, field: OceanField): Ocean {
  const geo = makePolarGrid();

  // The analytic base is the SWELL subset, so the mesh's Gerstner sum equals
  // the physics field exactly — the ship stays welded to the swell it floats
  // on, and the FFT chop/normal/foam is added on top (band-limited).
  const swell = physicsWaves(waves);
  const { a, b } = waveUniforms(swell);
  const ampTotal = swell.reduce((s, w) => s + w.amplitude, 0);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    defines: { NWAVES: swell.length },
    clipping: true,
    transparent: true, // the cutaway wedge fades to glass; alpha 1 elsewhere
    depthWrite: true,
    side: THREE.DoubleSide, // a submerged camera must see the surface above
    // it, not a missing polygon that cuts straight to the skybox (playtest)
    // stencil seam mask: the SeamMask pre-pass writes 1 into every hull-
    // silhouette pixel; the ocean draws only where stencil != 1, so no sea
    // lands on the deck, in an open hold, or as a void at the curved bow.
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.NotEqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
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
      uShipC: { value: [new THREE.Vector2(0, -1), new THREE.Vector2(0, -1)] },
      uTrail: { value: Array.from({ length: 64 }, () => new THREE.Vector4()) },
      // FFT field: the displacement is sampled in the vertex stage, the normal
      // + foam in the fragment stage. uFftOn gates every use so a null field
      // (textures null → three.js binds a default) renders the Gerstner look.
      uFftDisp: { value: field.displacement },
      uFftNormal: { value: field.normal },
      uFftFoam: { value: field.foam },
      uFftTile: { value: field.tileSize },
      uFftOn: { value: field.active ? 1 : 0 },
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
    updateShipWake(slot, centerX, centerZ, fwdX, fwdZ, speed, halfL, halfB, time, keelWorldY, deckWorldY) {
      const a = (mat.uniforms.uShipA.value as THREE.Vector4[])[slot];
      const b = (mat.uniforms.uShipB.value as THREE.Vector4[])[slot];
      const c = (mat.uniforms.uShipC.value as THREE.Vector2[])[slot];
      a.set(centerX + fwdX * halfL, centerZ + fwdZ * halfL, fwdX, fwdZ);
      b.set(speed, halfL, halfB, 0);
      c.set(keelWorldY, deckWorldY);

      const trail = trails[slot];
      const sx = centerX - fwdX * (halfL + 0.8);
      const sz = centerZ - fwdZ * (halfL + 0.8);
      const last = trail[trail.length - 1];
      if (speed > 1.5 && (!last || Math.hypot(sx - last.x, sz - last.z) > 2.4)) {
        trail.push({ x: sx, z: sz, t: time, w: Math.min(speed / 8, 0.9) });
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
      // follow the camera CONTINUOUSLY: the displacement field is anchored
      // to world coordinates, so a smoothly sliding lattice samples it
      // smoothly. The old 10 m snap re-sampled every wave against a jumped
      // grid — the round-8 "stuttering".
      mesh.position.x = cameraPos.x;
      mesh.position.z = cameraPos.z;
    },
  };
}
