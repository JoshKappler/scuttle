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
  sunLight: THREE.DirectionalLight;
  fillLight: THREE.HemisphereLight;
  addTo(scene: THREE.Scene): void;
  /** Bake the sky dome into a PMREM and set it as the scene's environment.
   *  Hemisphere/directional lights alone leave PBR materials BLACK anywhere
   *  the analytic lights don't reach (round 8: "shadows are still crazy dark
   *  … there should be some level of ambient lighting") — image-based light
   *  from the actual sky is what fills shade the way the real sky does. */
  bakeEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void;
}

export function createSky(): SkySetup {
  const sky = new Sky();
  sky.scale.setScalar(450000);

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

  const sunLight = new THREE.DirectionalLight(0xffd9b0, 2.6);
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
  // shadowed ground in life (round 8: "any part not directly in the sun")
  sunLight.shadow.intensity = 0.82;

  // sky bounce carries the shade: at 0.55 anything out of the sun read as
  // pitch black (round 7); 0.95 still wasn't ambient enough (round 8) —
  // raised again, with the ground bounce brightened toward lit-sea teal
  const fillLight = new THREE.HemisphereLight(0xc6dce6, 0x2a505c, 1.3);

  return {
    sky,
    sunDir,
    sunLight,
    fillLight,
    addTo(scene: THREE.Scene) {
      scene.add(sky);
      scene.add(sunLight);
      scene.add(sunLight.target);
      scene.add(fillLight);
    },
    bakeEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const env = new THREE.Scene();
      env.add(sky); // borrow the dome (re-parents it)
      const rt = pmrem.fromScene(env, 0.04);
      scene.add(sky); // give it back
      scene.environment = rt.texture;
      scene.environmentIntensity = 0.72; // fill, not wash-out
      pmrem.dispose();
    },
  };
}
