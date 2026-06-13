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

  // sky bounce carries the shade: at 0.55 anything out of the sun read as
  // pitch black (round 7) — real overcast-side light is a big soft source
  const fillLight = new THREE.HemisphereLight(0xbfd8e2, 0x1c3a44, 0.95);

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
  };
}
