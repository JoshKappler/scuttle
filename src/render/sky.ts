import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";

/**
 * Sky, sun, and scene lighting. Late-afternoon sun for long glints and warm
 * highlights (spec: lighting carries the look). Exports the sun direction so
 * the ocean shader and the directional light agree exactly.
 */
export interface SkySetup {
  sky: Sky;
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
  /** Re-render the background scene (sky + clouds) into envCube from `center` (the
   *  player camera position, so the camera-following cloud dome is sampled at its
   *  own centre). */
  updateEnv(renderer: THREE.WebGLRenderer, bgScene: THREE.Scene, center: THREE.Vector3): void;
  /** Bake the sky dome into a PMREM and set it as the main scene's environment
   *  (image-based fill so PBR materials aren't black in shade — round 8). Borrows
   *  the sky out of bgScene and returns it there. */
  bakeEnvironment(renderer: THREE.WebGLRenderer, mainScene: THREE.Scene, bgScene: THREE.Scene): void;
}

export function createSky(): SkySetup {
  const sky = new Sky();
  sky.scale.setScalar(450000);
  // draw the sky FIRST (before the cloud dome at -999 and all scene geometry), so
  // the opaque, depthTest-off cloud layer paints over it. render/clouds.ts relies
  // on this ordering.
  sky.renderOrder = -1000;

  const uniforms = sky.material.uniforms;
  uniforms.turbidity.value = 8;
  uniforms.rayleigh.value = 2.2;
  uniforms.mieCoefficient.value = 0.011;
  uniforms.mieDirectionalG.value = 0.92;

  const elevation = 14; // degrees above horizon — late afternoon
  const azimuth = 155;
  const phi = THREE.MathUtils.degToRad(90 - elevation);
  const theta = THREE.MathUtils.degToRad(azimuth);
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  uniforms.sunPosition.value.copy(sunDir);

  const sunColor = new THREE.Color(0xffd9b0);
  const sunLight = new THREE.DirectionalLight(sunColor.getHex(), 2.6);
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
  sunLight.shadow.intensity = 0.7;

  // sky bounce carries the shade: at 0.55 anything out of the sun read as
  // pitch black (round 7). 1.3 + a strong IBL env then over-lit it and
  // bleached the dark oak hull to "a light birch" (round 8 v2). Back to m10's
  // fill value — the lifted shadows + a faint IBL env keep shade out of the
  // void without brightening the wood's overall tone.
  const fillLight = new THREE.HemisphereLight(0xc6dce6, 0x2a505c, 0.95);

  // Live sky+cloud reflection cube for the ocean. 256² is plenty for a near-mirror
  // water surface whose wave normals smear the reflection anyway; mipmaps let the
  // ocean fetch blurrier reflections at grazing/rough angles. The cube camera renders
  // the BACKGROUND scene (sky + clouds) directly — no borrowing needed.
  const envCube = new THREE.WebGLCubeRenderTarget(256, {
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  // far must clear the 450000-unit sky dome; near small. Position is set per bake.
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
      // IBL ambient bleached the dark oak hull to birch (round 8 v2) at every
      // level I tried (0.72 → 0.16). m10 had NO environment and its wood was
      // right, so the env is now barely-there — just enough to keep the metal
      // guns from going dead-flat. The shade is lifted by shadow.intensity +
      // the hemisphere instead, neither of which touches the lit wood's tone.
      // (IBL is baked ONCE here: only a full page reload re-bakes it.)
      mainScene.environmentIntensity = 0.05;
      pmrem.dispose();
    },
  };
}
