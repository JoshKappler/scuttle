import * as THREE from "three";
import { Rng } from "./core/rng";
import { makeWaves } from "./sim/gerstner";
import { createOcean } from "./render/ocean";
import { createSky } from "./render/sky";
import { buildSloop } from "./sim/shipwright";
import { ShipVisual } from "./render/shipVisual";
import { initPhysics } from "./game/physics";
import { Ship } from "./game/ship";
import { GameWorld } from "./game/world";

async function main() {
  const app = document.getElementById("app")!;
  const hud = document.getElementById("hud")!;
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

  const physics = await initPhysics();
  const world = new GameWorld(physics, waves, scene);

  // spawn the sloop just above the surface; it splashes down and settles
  const sloopBuild = buildSloop();
  const sloopVisual = new ShipVisual(sloopBuild);
  const sloop = new Ship(physics, sloopBuild, sloopVisual, { x: -9, y: 0.4, z: -3 });
  world.addShip(sloop);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();
  let hudTimer = 0;

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    world.step(dt);

    // debug camera: sun-side 3/4 view tracking the ship (player camera lands in plan Task 8)
    const tr = sloop.body.translation();
    const sd = skySetup.sunDir;
    const side = new THREE.Vector3(-sd.z, 0, sd.x);
    camera.position.set(tr.x + sd.x * 16 + side.x * 13, tr.y + 6.5, tr.z + sd.z * 16 + side.z * 13);
    camera.lookAt(tr.x, tr.y + 1.2, tr.z);
    skySetup.sunLight.target.position.set(tr.x, tr.y, tr.z);
    skySetup.sunLight.position.set(tr.x + sd.x * 120, tr.y + sd.y * 120, tr.z + sd.z * 120);

    ocean.update(world.simTime, camera.position);
    renderer.render(scene, camera);

    hudTimer += dt;
    if (hudTimer > 0.5) {
      hudTimer = 0;
      const rot = sloop.body.rotation();
      const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
      const e = new THREE.Euler().setFromQuaternion(q, "ZYX");
      hud.textContent =
        `draft frac ${sloop.submergedFrac.toFixed(2)} (expect ~${sloop.expectedSubmergedFrac().toFixed(2)})\n` +
        `roll ${THREE.MathUtils.radToDeg(e.x).toFixed(1)}°  pitch ${THREE.MathUtils.radToDeg(e.z).toFixed(1)}°  y ${tr.y.toFixed(2)}`;
    }
  });
}

main();
