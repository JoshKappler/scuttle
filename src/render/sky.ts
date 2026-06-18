import * as THREE from "three";

/**
 * Sky, sun, and scene lighting. Late-afternoon sun for long glints and warm
 * highlights (spec: lighting carries the look). Exports the sun direction so
 * the ocean shader and the directional light agree exactly.
 *
 * The sky is a cheap PROCEDURAL GRADIENT DOME (replaced THREE.Sky's atmospheric
 * scattering, 2026-06-15): a big inward-facing sphere whose fragment shader ramps
 * a horizon haze up to a zenith blue and paints a warm sun disc + halo. Two reasons
 * over the scattering model: (1) full control of the HORIZON — the lower hemisphere
 * holds the horizon haze colour (never the black skirt the scattering hack left, and
 * no "stretched tablecloth" droop), and that same colour is fed to the ocean fog so
 * the distant sea and the sky meet in ONE seamless band; (2) it is much cheaper,
 * especially re-baked into the reflection cube ×6 faces. VISUAL ONLY (THE LAW #1).
 */

/** The horizon haze colour — the SINGLE source of truth shared by the dome's lower
 *  band AND the ocean's distance fog (main.ts calls ocean.setFogColor with this), so
 *  the far sea fades into the sky with no visible seam, void box, or floating islands. */
// LINEAR working-space values (setRGB defaults to the linear working space), tuned in-browser on
// the real GPU through ACES + the 0.76 exposure — a luminous late-afternoon haze, not the dark
// stormy first guess.
// 2026-06-16: dialled the sky down ~12% — the player read the dome+sun as "too bright" against
// the dark ships. This also calms the water's sky reflection and the shared distance fog.
export const HORIZON_COLOR = new THREE.Color().setRGB(0.56, 0.65, 0.72);
/** Zenith blue overhead. */
const ZENITH_COLOR = new THREE.Color().setRGB(0.17, 0.35, 0.58);

export interface SkySetup {
  /** The gradient sky dome mesh (lives in the background scene). */
  sky: THREE.Mesh;
  sunDir: THREE.Vector3; // unit vector pointing FROM scene TOWARD the sun
  sunColor: THREE.Color; // warm sun tint shared by the dir light, clouds, ocean
  sunLight: THREE.DirectionalLight;
  fillLight: THREE.HemisphereLight;
  /** Live sky+cloud reflection cube the ocean samples (render/ocean.ts) — a real
   *  reflection of the actual sky gradient, sun and drifting clouds, re-rendered
   *  periodically by updateEnv() (clouds move slowly, so a couple Hz is plenty). */
  envCube: THREE.WebGLCubeRenderTarget;
  /** Add the SUN + FILL lights to the main scene, and the SKY dome to the separate
   *  background scene (rendered first, behind everything — see render/post.ts). The
   *  caller adds the cloud dome to the same bgScene. */
  addTo(mainScene: THREE.Scene, bgScene: THREE.Scene): void;
  /** Recentre the dome on the camera (it follows so the camera is always at its centre,
   *  like the cloud dome — the object-space view-dir shader then works for BOTH the main
   *  camera and the env-cube camera, and the camera can never sail "out" of the dome).
   *  Call once per frame before render + before updateEnv. */
  follow(center: THREE.Vector3): void;
  /** Storm darkening [0,1]: fade the sun, slate the sky, and dim+grey the lights. */
  setStorm(s: number): void;
  /** Lightning flash [0,..]: a brief desaturated brighten of the sky dome. */
  setFlash(f: number): void;
  /** Re-render the background scene (sky + clouds) into envCube from `center` (the
   *  player camera position, so the camera-following cloud dome is sampled at its
   *  own centre). */
  updateEnv(renderer: THREE.WebGLRenderer, bgScene: THREE.Scene, center: THREE.Vector3): void;
  /** Bake the sky dome into a PMREM and set it as the main scene's environment
   *  (image-based fill so PBR materials aren't black in shade — round 8). Borrows
   *  the sky out of bgScene and returns it there. */
  bakeEnvironment(renderer: THREE.WebGLRenderer, mainScene: THREE.Scene, bgScene: THREE.Scene): void;
}

/** Sun placement — the SINGLE source of truth shared by the sky dome, the directional
 *  light, the ocean shader AND the sail back-light (render/shipVisual.ts). Late
 *  afternoon: low + warm. The vector points FROM the scene TOWARD the sun. */
export const SUN_ELEVATION_DEG = 14;
export const SUN_AZIMUTH_DEG = 155;
export const SUN_DIR = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEG),
  THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG),
);

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  // object-space position = direction from the dome centre (the dome follows the camera,
  // so the camera sits at the centre). The same dir works from the env-cube camera too.
  vDir = position;
  vec4 mvp = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // pin to the far plane (z = w) so the huge backdrop dome is never near/far-clipped,
  // regardless of its radius or how far the camera has sailed.
  gl_Position = mvp.xyww;
}
`;

const DOME_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform float uStorm;   // 0..1
uniform float uFlash;   // 0..1 lightning flash
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  // vertical gradient: a generous horizon-haze band easing up to the zenith blue. The
  // 0.42 power keeps plenty of haze near the horizon line so the sea-meets-sky band reads
  // soft and atmospheric, not a hard ring.
  float up = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(up, 0.42));
  // a faint extra glow right on the horizon line, fading out by ~10 degrees up.
  col += uHorizon * 0.08 * (1.0 - smoothstep(0.0, 0.18, up));
  // BELOW the horizon: hold the horizon haze (never black). The ocean fog fades the far
  // sea to this exact colour, so sea and sky meet in one seamless band — no void, no skirt.
  if (d.y < 0.0) col = uHorizon;

  // sun: a warm disc with a soft halo. The disc is HDR (core ~12) so it still blooms and can
  // seed the god-rays; the pre-bloom clamp (TUN.gfx.bloom.clamp) caps it from white-washing.
  float md = max(dot(d, normalize(uSunDir)), 0.0);
  float halo = pow(md, 230.0) * 0.40 + pow(md, 22.0) * 0.11;
  float disc = smoothstep(0.9972, 0.9990, md);
  col += uSunColor * halo * (1.0 - uStorm);
  col += uSunColor * disc * 8.0 * (1.0 - uStorm);

  // STORM: drag the whole sky toward a dark slate and crush the sun disc/halo.
  vec3 slate = vec3(0.06, 0.08, 0.10);
  col = mix(col, slate, uStorm * 0.85);
  // FLASH: a brief desaturated brighten (lightning lights the cloud deck).
  col += vec3(0.9, 0.92, 1.0) * uFlash;

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createSky(): SkySetup {
  // sun placement lives at module scope (SUN_DIR) so the sail back-light
  // (render/shipVisual.ts) reads the SAME direction — single source of truth.
  const sunDir = SUN_DIR.clone();
  const sunColor = new THREE.Color(0xffd9b0);

  // The gradient dome. depthTest/Write OFF (a backdrop; render/post.ts clears depth after
  // it and draws the scene over it), BackSide (we view the inner surface), renderOrder
  // -1000 so it paints FIRST — before the cloud dome at -999 and all scene geometry.
  const domeMat = new THREE.ShaderMaterial({
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSunDir: { value: sunDir.clone() },
      uSunColor: { value: sunColor.clone() },
      uZenith: { value: ZENITH_COLOR.clone() },
      uHorizon: { value: HORIZON_COLOR.clone() },
      uStorm: { value: 0 },
      uFlash: { value: 0 },
    },
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(4000, 32, 16), domeMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;

  const sunLight = new THREE.DirectionalLight(sunColor.getHex(), 2.1);
  sunLight.position.copy(sunDir.clone().multiplyScalar(120));
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 10;
  sunLight.shadow.camera.far = 400;
  const ext = 60;
  sunLight.shadow.camera.left = -ext;
  sunLight.shadow.camera.right = ext;
  sunLight.shadow.camera.top = ext;
  sunLight.shadow.camera.bottom = -ext;
  sunLight.shadow.bias = -0.0005;
  // shadows ATTENUATE the sun rather than erase it — skylight still reaches
  // shadowed ground in life (round 8: "any part not directly in the sun").
  // This (plus the hemisphere fill) lifts the dark side WITHOUT the IBL env
  // that bleached the oak — shadow.intensity only touches shadowed pixels,
  // so the lit wood keeps m10's tone (round 8 v2: "same wood, was fine before").
  sunLight.shadow.intensity = 0.55;
  // The sun is a FIXED direction (SUN_DIR), so the shadow map only needs re-rendering as ships
  // move under it — not 60×/s. autoUpdate off + a ~15 Hz needsUpdate poke (main loop) turns a full
  // per-frame depth pass over every hull into ~4× fewer. The shadow frustum still follows the
  // player every frame; only the depth map refreshes on the throttle.
  sunLight.shadow.autoUpdate = false;
  sunLight.shadow.needsUpdate = true; // render once on the first frame

  // sky bounce carries the shade: at 0.55 anything out of the sun read as pitch black (round 7); 1.3 +
  // a strong IBL env then over-lit it and bleached the dark oak hull to "a light birch" (round 8 v2).
  // The user's standing note is that shade STILL goes near-black (2026-06-16: an enemy hull's shaded
  // flank read as a pure-black silhouette), so lift the hemisphere harder (1.7→2.4) and brighten the
  // ground term (0x46656f→0x586f78) — this is the safe shade-lift (hemisphere is normal-based fill, it
  // doesn't wash albedo the way the IBL env did), so down/away-facing faces read instead of crushing to
  // black while the lit wood keeps its tone. Paired with a calmer sun (2.1) this narrows the lit↔shade
  // range from both ends rather than just dropping exposure (which would darken the shade further).
  const fillLight = new THREE.HemisphereLight(0xc6dce6, 0x586f78, 2.4);

  // Base (clear-weather) intensities — setStorm dims relative to these.
  const baseSun = sunLight.intensity;
  const baseFill = fillLight.intensity;

  // Live sky+cloud reflection cube for the ocean. 128² — round 2 tried 512 for a sharper
  // reflection, but baking 6 faces of the FBM cloud scene is a periodic main-thread STALL
  // (512 read as "performance tanked"; 256 was round 1's smooth value). The water is matte
  // (reflection strength 0.22) and the bake runs every frag through the cloud FBM, so the
  // reflection res barely shows — dropped 256→128 (4× cheaper per bake, paired with
  // rebakeHz 2→1) to shrink that periodic hitch further. mipmaps let the ocean fetch
  // blurrier reflections at grazing/rough angles. The cube camera renders the BACKGROUND
  // scene (sky + clouds) directly.
  const envCube = new THREE.WebGLCubeRenderTarget(128, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
    // HDR (HalfFloat): the dome is rendered LINEAR into the cube (no tonemap when
    // rendering to a target), so the sun disc runs far past 1. An LDR cube would clamp
    // the whole bright sky to white; HalfFloat preserves it so the water reflects a
    // real sky gradient, and the ocean's own post chain tonemaps the result.
    type: THREE.HalfFloatType,
  });
  // far must clear the dome; near small. Position is set per bake.
  const cubeCam = new THREE.CubeCamera(1, 1_000_000, envCube);

  return {
    sky,
    sunDir,
    sunColor,
    sunLight,
    fillLight,
    envCube,
    addTo(mainScene: THREE.Scene, bgScene: THREE.Scene) {
      bgScene.add(sky); // background layer (rendered first, then depth is cleared)
      mainScene.add(sunLight);
      mainScene.add(sunLight.target);
      mainScene.add(fillLight);
    },
    follow(center: THREE.Vector3) {
      sky.position.copy(center);
    },
    setStorm(s: number) {
      const k = Math.max(0, Math.min(1, s));
      domeMat.uniforms.uStorm.value = k;
      // dim + grey the direct + fill light so lit hulls go flat-overcast, not sunny.
      sunLight.intensity = baseSun * (1 - 0.85 * k);
      fillLight.intensity = baseFill * (1 - 0.45 * k);
      sunLight.shadow.needsUpdate = true;
    },
    setFlash(f: number) {
      domeMat.uniforms.uFlash.value = Math.max(0, f);
    },
    updateEnv(renderer, bgScene, center) {
      cubeCam.position.copy(center);
      cubeCam.update(renderer, bgScene); // renders sky + clouds (the whole bg scene)
    },
    bakeEnvironment(renderer: THREE.WebGLRenderer, mainScene: THREE.Scene, bgScene: THREE.Scene) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = new THREE.Scene();
      env.add(sky); // borrow the dome (re-parents it)
      const rt = pmrem.fromScene(env, 0.04);
      bgScene.add(sky); // return it to the background scene
      mainScene.environment = rt.texture;
      // IBL ambient bleached the dark oak hull to birch (round 8 v2) at high levels (0.72 → 0.16), so
      // the env stays modest — a gentle 0.12 lifts metals/shade a touch and keeps the guns off dead-
      // flat without washing the wood. The heavy shade-lift is the hemisphere above; this just rounds
      // the corners. (IBL is baked ONCE here: only a full page reload re-bakes it.)
      mainScene.environmentIntensity = 0.17;
      pmrem.dispose();
    },
  };
}
