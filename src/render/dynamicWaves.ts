import * as THREE from "three";

/**
 * P5 — Crest/Atlas-style DYNAMIC-WAVE interaction field (WebGL2 fragment passes,
 * NO compute). A camera-centered ping-pong height/velocity field on which the
 * SHIPS stamp their waterline footprint each frame, producing the player-visible
 * "the bow pushes water up, the flanks bulge, the stern leaves a contrail" the
 * design calls for — all on the GPU.
 *
 * Mechanics
 * ---------
 *  - Two RGBA float render targets ping-ponged: R = surface height (m relative to
 *    the analytic swell), G = vertical velocity (∂h/∂t), B = transient foam.
 *  - The field covers a square WINDOW (default 256 m) re-CENTERED on the camera
 *    every frame, with the world origin SNAPPED TO WHOLE TEXELS. Without the snap
 *    a sub-texel slide each frame resamples the field against a shifted lattice
 *    and the whole sheet shimmers as it scrolls — the repo already learned this
 *    for the polar ocean grid (ocean.ts round-8 notes). The snapped scroll offset
 *    (in texels) is fed to the sim pass so it can re-fetch yesterday's field from
 *    the correctly-shifted texel and carry the disturbances with the camera.
 *  - SIM PASS: an explicit FDTD wave-equation step with semi-Lagrangian flow
 *    advection so disturbances TRAIL downstream:
 *        vNew = (v + dt·c²/h²·(L+R+U+D−4·C))·(1 − min(1, damping·dt))
 *        hNew = h + dt·vNew
 *    The whole 5-point stencil is sampled at the back-traced position
 *    (uv − dt·flow) so the propagating ripples drift with the water (a uniform
 *    wind-driven current here; the per-ship-path curve of a wake comes for free
 *    from the field being world-anchored while the ship sails on).
 *  - INJECTION PASS: each ship's hull plan (REUSING buoyancy.buildHullProfile from
 *    P4, posed by the live ship transform) is stamped into the velocity channel —
 *    a forward push-up at the bow, an outward bulge along the beam, and a
 *    speed-proportional couple at the stern (the contrail). Weighted by submerged
 *    depth so a ship out of the water stops disturbing it.
 *
 * Stability (the user is sick of shader bugs — belt AND braces):
 *  - Courant: the wave speed c is clamped so c·dt/gridSize ≤ COURANT (0.7) every
 *    frame, and the sim SUBSTEPS when dt is large (low FPS) so an explicit step
 *    never goes unstable. Passed in as uC already clamped.
 *  - NaN guard: isfinite() resets any poisoned texel to rest, so one bad sample
 *    cannot spread and kill the whole field.
 *  - Velocity/height are damped every step and the field decays toward rest at
 *    the window edge so injected energy can leave instead of reflecting forever.
 *
 * This field is VISUAL ONLY: its height is summed onto the ocean surface in the
 * ocean vertex shader, but the hull still floats on the analytic Gerstner swell
 * (buoyancy never samples this). Determinism / the vitest oracle are untouched.
 */

/** One ship's pose + plan for the injection pass (player + enemy). */
export interface DynShip {
  /** RG = keelYLocal, deckYLocal per grid column (the P4 hull-profile texture). */
  profileTex: THREE.Texture;
  /** local-space span (m) the profile grid occupies (uv = localXZ / size). */
  sizeX: number;
  sizeZ: number;
  /** world translation of the ship body (local origin). */
  trans: THREE.Vector3;
  /** world→local rotation (inverse of the body quaternion). */
  invRot: THREE.Matrix3;
  /** unit fore-aft axis in world XZ (the +x local axis, projected & normalized). */
  fwdX: number;
  fwdZ: number;
  /** speed over ground (m/s). */
  speed: number;
  /** 0..1 how wet she is — 0 disables her stamp (out of the water / sunk). */
  wetness: number;
  /** the still-water world Y at the hull (where the waterline sits). */
  waterY: number;
}

/** A spray splash-down point that froths the surface (world X, Z, 0..1 strength). */
export interface FoamStamp {
  x: number;
  z: number;
  strength: number;
}

export interface DynamicWaves {
  /** Advance the field one frame at simulation time t with timestep dt, centering
   *  the window on `cameraPos`, stamping each live ship in `ships`, and frothing the
   *  surface at any `landings` (GPU-spray splash-downs) recorded this frame. */
  update(dt: number, cameraPos: THREE.Vector3, ships: DynShip[], landings?: FoamStamp[]): void;
  /** The height/velocity/foam texture the ocean mesh samples (R = height). */
  readonly texture: THREE.Texture;
  /** The window's world-space size (m) — uv = (worldXZ − origin) / window. */
  readonly window: number;
  /** The window's current snapped world-space origin (min corner, XZ). */
  readonly origin: THREE.Vector2;
  /** true when the GPU backend is live (else the ocean ignores it). */
  readonly active: boolean;
  dispose(): void;
}

interface Pass {
  scene: THREE.Scene;
  cam: THREE.Camera;
  mat: THREE.ShaderMaterial;
}

function makePass(frag: string, uniforms: Record<string, THREE.IUniform>, defines?: Record<string, unknown>): Pass {
  const mat = new THREE.ShaderMaterial({
    uniforms,
    defines,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: frag,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
  return { scene, cam: new THREE.Camera(), mat };
}

function makeFieldRT(N: number): THREE.WebGLRenderTarget {
  // Linear + ClampToEdge: the ocean mesh samples this in world space (smooth
  // bilinear between texels) and a disturbance must not wrap across the window.
  return new THREE.WebGLRenderTarget(N, N, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

// ---------------------------------------------------------------------------
// SIM pass — FDTD wave-equation step + semi-Lagrangian advection + scroll re-fetch.
// Reads the PREVIOUS field (already scrolled by the snapped camera delta) and
// writes the new (height, velocity, foam). MAXSUB bounds the substep loop so the
// GLSL for-loop has a compile-time limit; the JS side sets uSubsteps ≤ MAXSUB.
// ---------------------------------------------------------------------------
const SIM_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uPrev;   // RGBA: R height, G velocity, B foam
uniform float uTexel;      // 1.0 / N
uniform float uMeterPerUv; // window meters across (uv 0..1 → meters)
uniform vec2  uScroll;     // camera-delta scroll in UV (added to lookups to re-center)
uniform vec2  uFlow;       // advection flow in UV/second (wind-driven drift)
uniform float uC;          // wave speed (m/s), already Courant-clamped for uDt/uSubsteps
uniform float uDamping;    // velocity damping (1/s)
uniform float uDt;         // frame dt (s)
uniform int   uSubsteps;   // explicit substeps this frame (1..MAXSUB)

// fetch the field at a uv, re-centred by the snapped scroll and clamped in-window.
vec4 fetch(vec2 uv) {
  vec2 s = clamp(uv + uScroll, 0.0, 1.0);
  return texture2D(uPrev, s);
}

void main() {
  float h = uTexel;
  float sdt = uDt / float(uSubsteps);
  // advect the whole stencil to make ripples trail with the flow (semi-Lagrangian:
  // look UP-stream by flow·dt). One back-trace for the frame is plenty at game scale.
  vec2 base = vUv - uFlow * uDt;

  vec4 st = fetch(base);
  float height = st.r;
  float vel = st.g;
  float foam = st.b;

  // edge falloff: fade the field to rest within a margin of the window border so
  // injected energy LEAVES instead of reflecting off a hard wall forever.
  vec2 d2 = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, 0.06, min(d2.x, d2.y));

  float c2 = uC * uC;
  float invh2 = 1.0 / (h * h * uMeterPerUv * uMeterPerUv); // 1/Δx² in world meters²
  for (int sub = 0; sub < MAXSUB; sub++) {
    if (sub >= uSubsteps) break;
    float cC = height;
    float cL = fetch(base + vec2(-h, 0.0)).r;
    float cR = fetch(base + vec2(h, 0.0)).r;
    float cU = fetch(base + vec2(0.0, h)).r;
    float cD = fetch(base + vec2(0.0, -h)).r;
    float lap = (cL + cR + cU + cD - 4.0 * cC) * invh2;
    vel = (vel + sdt * c2 * lap) * (1.0 - min(1.0, uDamping * sdt));
    height = height + sdt * vel;
  }

  height *= edge;
  vel *= edge;
  foam = foam * (1.0 - min(1.0, 1.2 * uDt)) * edge; // foam decays fast

  // NaN / inf reset guard: a single poisoned texel must not spread and kill the
  // sim. Any non-finite channel snaps the texel back to flat rest water.
  vec4 outc = vec4(height, vel, foam, 1.0);
  if (!(height == height) || !(vel == vel) || !(foam == foam) ||
      abs(height) > 1e3 || abs(vel) > 1e4) {
    outc = vec4(0.0, 0.0, 0.0, 1.0);
  }
  gl_FragColor = outc;
}
`;

// ---------------------------------------------------------------------------
// INJECTION pass — stamp each ship's waterline footprint into the VELOCITY channel
// (additively, on top of the sim result). Reuses the P4 per-column hull profile so
// the stamp follows the true hull plan + live pose. Up to MAXSHIP ships unrolled.
// ---------------------------------------------------------------------------
const INJECT_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uField;     // sim output to add onto
uniform vec2  uOrigin;        // window min-corner world XZ
uniform float uWindow;        // window size (m)
uniform float uDt;

uniform sampler2D uProfile[MAXSHIP]; // RG = keelYLocal, deckYLocal per column
uniform mat3  uInvRot[MAXSHIP];      // world→local rotation
uniform vec3  uTrans[MAXSHIP];       // ship body world translation
uniform vec2  uSize[MAXSHIP];        // local span (m): uv = localXZ / size
uniform vec4  uShip[MAXSHIP];        // fwdX, fwdZ, speed, wetness
uniform float uWaterY[MAXSHIP];      // still-water world Y at the hull
uniform int   uShipCount;

// P5: spray splash-down foam stamps — where GPU spray droplets land they froth the
// surface. xyz = world X, world Z, strength. uLandCount gates the active entries.
uniform vec3  uLandings[MAXLAND];
uniform int   uLandCount;

// one ship's contribution to the velocity impulse at world position p.xz. The
// surface point is posed into the hull's LOCAL frame (the same frame the P4
// profile + buoyancy probes live in); the column's keel/deck come from the
// profile texture, so the stamp follows the true hull plan AND the live pose.
float stampShip(vec2 world, sampler2D prof, mat3 invRot, vec3 trans, vec2 size,
                float speed, float wetness, float waterY) {
  if (wetness < 0.01) return 0.0;
  // pose the still-water surface point (world Y = waterY at this column) into the
  // hull-local frame. lp.y is then the LOCAL height of the waterline plane here.
  vec3 lp = invRot * (vec3(world.x, waterY, world.y) - trans);
  vec2 uvp = vec2(lp.x / size.x, lp.z / size.y);
  if (uvp.x <= 0.0 || uvp.x >= 1.0 || uvp.y <= 0.0 || uvp.y >= 1.0) return 0.0;
  vec2 kd = texture2D(prof, uvp).rg; // keelYLocal, deckYLocal (m)
  if (kd.y <= kd.x) return 0.0;       // no hull in this column

  // submerged depth of THIS column, IN THE HULL FRAME: how far the waterline plane
  // (lp.y) sits above the keel (kd.x). Pitch/roll fold in through invRot. >0 → wet.
  float depth = clamp((lp.y - kd.x) / 3.0, 0.0, 1.0);
  if (depth <= 0.0) return 0.0;

  // hull-local plan coordinates centred: along (−1 stern … +1 bow), across (−1..1).
  float along = uvp.x * 2.0 - 1.0;   // +x local is forward (bow at maxX)
  float across = uvp.y * 2.0 - 1.0;

  float spd = clamp(speed, 0.0, 12.0);
  float sF = spd / 8.0;

  // BOW push-up: a forward mound at the cutwater (along≈+1), strongest with way on.
  // The hero of the effect — "the front of the ship pushes up and sprays water".
  float bow = smoothstep(0.4, 1.0, along) * (0.6 + sF);
  // SIDE bulge: water shouldered outward along the beam (|across|≈1, amidships).
  float side = smoothstep(0.55, 1.0, abs(across)) * (1.0 - smoothstep(0.6, 1.0, abs(along))) * (0.4 + 0.4 * sF);
  // STERN contrail couple: a SPEED-proportional downward suck just aft (along≈−1)
  // that the FDTD spreads into the trailing wake astern. Kept modest so it shapes a
  // trough behind her without digging a bottomless crater when she lingers in place.
  float stern = smoothstep(-1.0, -0.5, along) * (1.0 - smoothstep(-0.5, 0.0, along)) * sF;

  // bow & side LIFT the water (+v), the stern sucks it down (−v) → a wake hollow
  // that fills behind her. Scaled by submerged depth and wetness.
  return (bow * 3.0 + side * 1.9 - stern * 0.8) * depth * wetness;
}

void main() {
  vec2 world = uOrigin + vUv * uWindow;
  float add = 0.0;
  // UNROLLED at CONSTANT sampler indices [0]/[1], mirroring the ocean.ts cascade
  // unroll: indexing a sampler array with a loop variable is rejected by ANGLE and
  // silently invalidates the whole program. uShipCount gates each block off.
  if (uShipCount > 0) {
    add += stampShip(world, uProfile[0], uInvRot[0], uTrans[0], uSize[0],
                     uShip[0].z, uShip[0].w, uWaterY[0]);
  }
  #if MAXSHIP > 1
  if (uShipCount > 1) {
    add += stampShip(world, uProfile[1], uInvRot[1], uTrans[1], uSize[1],
                     uShip[1].z, uShip[1].w, uWaterY[1]);
  }
  #endif
  // spray splash-down foam: stamp a small bright disc of foam where each landing
  // came down (uLandings is a plain vec3 array — loop-indexing it is fine; only
  // SAMPLER arrays carry the ANGLE constant-index restriction).
  float landFoam = 0.0;
  for (int i = 0; i < MAXLAND; i++) {
    if (i >= uLandCount) break;
    vec2 lp = uLandings[i].xy;
    float r = length(world - lp);
    landFoam = max(landFoam, uLandings[i].z * exp(-pow(r / 1.6, 2.0)));
  }

  vec4 f = texture2D(uField, vUv);
  // inject into velocity (G); seed a little foam (B) where we push hard so the
  // ocean fragment can lace whitewater onto the disturbance.
  f.g += add * uDt * 4.5;
  f.b = max(f.b, max(abs(add) * 0.12, landFoam));
  gl_FragColor = f;
}
`;

export interface DynamicWavesOptions {
  /** texels per side (default 256). */
  N?: number;
  /** window size in world meters (default 256). */
  window?: number;
  /** wave propagation speed (m/s) before Courant clamp (default 9). */
  speed?: number;
  /** velocity damping 1/s (default 0.6). */
  damping?: number;
  /** advection flow direction (world XZ, need not be unit). */
  flowDirX?: number;
  flowDirZ?: number;
  /** advection current speed (m/s, default 1.2). */
  flowSpeed?: number;
  /** max ships injected (default 2). */
  maxShips?: number;
}

const COURANT = 0.7; // c·dt/Δx ceiling for the explicit FDTD step

/** Returns the GPU dynamic-wave field if float RTs are supported, else an inert
 *  field (active=false) — the ocean treats that as "add nothing". */
export function createDynamicWaves(
  renderer: THREE.WebGLRenderer,
  opts: DynamicWavesOptions = {},
): DynamicWaves {
  const gl = renderer.getContext();
  const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const hasFloatRT = isWebGL2 && !!gl.getExtension("EXT_color_buffer_float");

  const N = opts.N && opts.N > 0 ? opts.N : 256;
  const WINDOW = opts.window && opts.window > 0 ? opts.window : 256;
  const baseSpeed = opts.speed ?? 9;
  const damping = opts.damping ?? 0.6;
  const MAXSHIP = Math.max(1, opts.maxShips ?? 2);
  const MAXSUB = 8;
  const MAXLAND = 16; // most recent spray splash-down foam stamps per frame
  const texelMeters = WINDOW / N;

  const origin = new THREE.Vector2();
  const dummyTex = new THREE.DataTexture(new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  dummyTex.needsUpdate = true;

  if (!hasFloatRT) {
    // Inert fallback: keeps the whole game running on a context without float RTs.
    return {
      update() {},
      texture: dummyTex,
      window: WINDOW,
      origin,
      active: false,
      dispose() {
        dummyTex.dispose();
      },
    };
  }

  // flow as UV/second (wind-driven current). Normalize the direction; magnitude in
  // meters/s → UV/s by dividing by the window meters.
  const flowLen = Math.hypot(opts.flowDirX ?? 1, opts.flowDirZ ?? 0) || 1;
  const flowSpeed = opts.flowSpeed ?? 1.2;
  const flowUv = new THREE.Vector2(
    ((opts.flowDirX ?? 1) / flowLen) * (flowSpeed / WINDOW),
    ((opts.flowDirZ ?? 0) / flowLen) * (flowSpeed / WINDOW),
  );

  let rtA = makeFieldRT(N);
  let rtB = makeFieldRT(N);
  // clear both to flat rest water.
  const prevTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rtA);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, false, false);
  renderer.setRenderTarget(rtB);
  renderer.clear(true, false, false);
  renderer.setRenderTarget(prevTarget);

  const simPass = makePass(
    SIM_FRAG,
    {
      uPrev: { value: rtA.texture },
      uTexel: { value: 1 / N },
      uMeterPerUv: { value: WINDOW },
      uScroll: { value: new THREE.Vector2() },
      uFlow: { value: flowUv },
      uC: { value: baseSpeed },
      uDamping: { value: damping },
      uDt: { value: 0 },
      uSubsteps: { value: 1 },
    },
    { MAXSUB },
  );

  const injectPass = makePass(
    INJECT_FRAG,
    {
      uField: { value: rtB.texture },
      uOrigin: { value: new THREE.Vector2() },
      uWindow: { value: WINDOW },
      uDt: { value: 0 },
      uProfile: { value: Array.from({ length: MAXSHIP }, () => dummyTex) },
      uInvRot: { value: Array.from({ length: MAXSHIP }, () => new THREE.Matrix3()) },
      uTrans: { value: Array.from({ length: MAXSHIP }, () => new THREE.Vector3()) },
      uSize: { value: Array.from({ length: MAXSHIP }, () => new THREE.Vector2(1, 1)) },
      uShip: { value: Array.from({ length: MAXSHIP }, () => new THREE.Vector4()) },
      uWaterY: { value: new Array(MAXSHIP).fill(0) },
      uShipCount: { value: 0 },
      uLandings: { value: Array.from({ length: MAXLAND }, () => new THREE.Vector3()) },
      uLandCount: { value: 0 },
    },
    { MAXSHIP, MAXLAND },
  );

  function renderTo(rt: THREE.WebGLRenderTarget, pass: Pass): void {
    renderer.setRenderTarget(rt);
    renderer.render(pass.scene, pass.cam);
  }

  // last snapped origin (texel-aligned) so we can scroll the field by whole texels.
  let lastOriginX = 0;
  let lastOriginZ = 0;
  let primed = false;

  function update(dt: number, cameraPos: THREE.Vector3, ships: DynShip[], landings?: FoamStamp[]): void {
    const cdt = Math.min(Math.max(dt, 0), 0.1);

    // Re-centre the window on the camera, SNAPPED to whole texels so the field does
    // not shimmer as it scrolls. origin = snap(camera − window/2).
    const desiredX = cameraPos.x - WINDOW / 2;
    const desiredZ = cameraPos.z - WINDOW / 2;
    const snapX = Math.round(desiredX / texelMeters) * texelMeters;
    const snapZ = Math.round(desiredZ / texelMeters) * texelMeters;
    if (!primed) {
      lastOriginX = snapX;
      lastOriginZ = snapZ;
      primed = true;
    }
    // scroll in UV between last and new origin: a texel of world shift = 1/N uv.
    const scrollX = (snapX - lastOriginX) / WINDOW;
    const scrollZ = (snapZ - lastOriginZ) / WINDOW;
    origin.set(snapX, snapZ);
    lastOriginX = snapX;
    lastOriginZ = snapZ;

    // Courant-stable substepping: pick the fewest substeps so c·(dt/sub)/Δx ≤ 0.7,
    // and clamp c itself as a final guard. At 60 fps one substep holds; at low FPS
    // we substep instead of letting the explicit integrator blow up.
    let substeps = 1;
    const maxStable = (COURANT * texelMeters) / Math.max(baseSpeed, 1e-3);
    if (cdt > maxStable) substeps = Math.min(MAXSUB, Math.ceil(cdt / maxStable));
    const subDt = cdt / substeps;
    const cClamped = Math.min(baseSpeed, (COURANT * texelMeters) / Math.max(subDt, 1e-3));

    // --- SIM PASS: read rtA (previous), write rtB ---
    simPass.mat.uniforms.uPrev.value = rtA.texture;
    (simPass.mat.uniforms.uScroll.value as THREE.Vector2).set(scrollX, scrollZ);
    simPass.mat.uniforms.uDt.value = cdt;
    simPass.mat.uniforms.uSubsteps.value = substeps;
    simPass.mat.uniforms.uC.value = cClamped;
    renderTo(rtB, simPass);

    // --- INJECTION PASS: read rtB, write rtA (additive stamp) ---
    const count = Math.min(ships.length, MAXSHIP);
    const profArr = injectPass.mat.uniforms.uProfile.value as THREE.Texture[];
    const invArr = injectPass.mat.uniforms.uInvRot.value as THREE.Matrix3[];
    const transArr = injectPass.mat.uniforms.uTrans.value as THREE.Vector3[];
    const sizeArr = injectPass.mat.uniforms.uSize.value as THREE.Vector2[];
    const shipArr = injectPass.mat.uniforms.uShip.value as THREE.Vector4[];
    const waterArr = injectPass.mat.uniforms.uWaterY.value as number[];
    for (let i = 0; i < count; i++) {
      const s = ships[i];
      profArr[i] = s.profileTex;
      invArr[i].copy(s.invRot);
      transArr[i].copy(s.trans);
      sizeArr[i].set(s.sizeX, s.sizeZ);
      shipArr[i].set(s.fwdX, s.fwdZ, s.speed, s.wetness);
      waterArr[i] = s.waterY;
    }
    injectPass.mat.uniforms.uShipCount.value = count;
    // spray splash-down foam stamps: take the most recent up to MAXLAND.
    const landArr = injectPass.mat.uniforms.uLandings.value as THREE.Vector3[];
    const lc = landings ? Math.min(landings.length, MAXLAND) : 0;
    for (let i = 0; i < lc; i++) {
      const l = landings![landings!.length - lc + i]; // newest tail
      landArr[i].set(l.x, l.z, l.strength);
    }
    injectPass.mat.uniforms.uLandCount.value = lc;
    injectPass.mat.uniforms.uField.value = rtB.texture;
    (injectPass.mat.uniforms.uOrigin.value as THREE.Vector2).set(snapX, snapZ);
    injectPass.mat.uniforms.uDt.value = cdt;
    renderTo(rtA, injectPass);

    renderer.setRenderTarget(null);
  }

  function dispose(): void {
    rtA.dispose();
    rtB.dispose();
    dummyTex.dispose();
    for (const p of [simPass, injectPass]) {
      p.mat.dispose();
      p.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
    }
  }

  const field: DynamicWaves = {
    update,
    // after update(), rtA holds the freshest (sim + injection) field.
    get texture() {
      return rtA.texture;
    },
    window: WINDOW,
    origin,
    active: true,
    dispose,
  };

  // Verification hook for the in-browser oracle: read the height (R) channel back
  // so Playwright can assert energy downstream > upstream and NO NaN after a slam.
  (field as unknown as { readbackHeight: () => Float32Array }).readbackHeight = (): Float32Array => {
    const buf = new Float32Array(N * N * 4);
    renderer.readRenderTargetPixels(rtA, 0, 0, N, N, buf);
    const h = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) h[i] = buf[i * 4]; // R channel = height
    return h;
  };
  (field as unknown as { __N: number }).__N = N;

  return field;
}
