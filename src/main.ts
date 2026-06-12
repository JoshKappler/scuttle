import * as THREE from "three";
import { Rng } from "./core/rng";
import { makeWaves } from "./sim/gerstner";
import { createOcean } from "./render/ocean";
import { createSky } from "./render/sky";
import { buildSloop } from "./sim/shipwright";
import { ShipVisual } from "./render/shipVisual";
import { VOXEL_SIZE } from "./core/constants";

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

// static sloop for the visual pass (physics arrives in plan Task 7)
const sloop = buildSloop();
const sloopVisual = new ShipVisual(sloop);
const [snx, , snz] = sloop.grid.dims;
sloopVisual.group.position.set((-snx / 2) * VOXEL_SIZE, -1.35, (-snz / 2) * VOXEL_SIZE);
scene.add(sloopVisual.group);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();

  // debug camera: sun-side 3/4 view of the ship until the player camera lands (plan Task 8)
  const sd = skySetup.sunDir;
  const side = new THREE.Vector3(-sd.z, 0, sd.x); // perpendicular to sun azimuth
  camera.position.set(sd.x * 16 + side.x * 13, 5.5, sd.z * 16 + side.z * 13);
  camera.lookAt(0, 1.2, 0);

  ocean.update(t, camera.position);
  renderer.render(scene, camera);
});
