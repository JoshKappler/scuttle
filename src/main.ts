import * as THREE from "three";
import { Rng } from "./core/rng";
import { makeWaves } from "./sim/gerstner";
import { createOcean } from "./render/ocean";
import { createSky } from "./render/sky";

const app = document.getElementById("app")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);

const seed = new URLSearchParams(location.search).get("seed") ?? "scuttle-dev";
const rng = new Rng(seed);
const waves = makeWaves(rng, 4);

const skySetup = createSky();
skySetup.addTo(scene);

const ocean = createOcean(waves, skySetup.sunDir);
scene.add(ocean.mesh);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();

  // debug camera: hold position facing into the sun until the player camera lands (plan Task 8)
  const sd = skySetup.sunDir;
  camera.position.set(-sd.x * 30, 6.5, -sd.z * 30);
  camera.lookAt(sd.x * 50, 2.5, sd.z * 50);

  ocean.update(t, camera.position);
  renderer.render(scene, camera);
});
