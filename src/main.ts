import * as THREE from "three";
import { Rng } from "./core/rng";
import { makeWaves, surfaceHeight } from "./sim/gerstner";
import { createOcean } from "./render/ocean";
import { createSky } from "./render/sky";
import { buildSloop } from "./sim/shipwright";
import { ShipVisual } from "./render/shipVisual";
import { initPhysics } from "./game/physics";
import { Ship } from "./game/ship";
import { GameWorld } from "./game/world";
import { SailingController, type Wind } from "./game/sailing";
import { PlayerControls } from "./game/player";
import { AICaptain } from "./game/ai";
import { BoardingSystem } from "./game/boarding";
import { Cannons } from "./game/cannons";
import { CharacterSpike } from "./game/character";
import { DebrisManager } from "./game/debris";
import { Effects } from "./render/effects";

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
  renderer.localClippingEnabled = true;
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

  // enemy captain: spawns upwind and runs down on you
  const enemyBuild = buildSloop();
  const enemyVisual = new ShipVisual(enemyBuild);
  const enemy = new Ship(physics, enemyBuild, enemyVisual, {
    x: -9 - waves[0].dirX * 250,
    y: 0.2,
    z: -3 - waves[0].dirZ * 250,
  });
  world.addShip(enemy);

  // wind blows with the dominant swell
  const wind: Wind = { dirX: waves[0].dirX, dirZ: waves[0].dirZ, speed: 7 };
  const sailing = new SailingController();
  const controls = new PlayerControls(renderer.domElement);

  const effects = new Effects();
  scene.add(effects.points);
  const cannons = new Cannons(scene, effects);
  const debris = new DebrisManager(physics, scene);
  sloop.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, sloop));
  enemy.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, enemy));

  const captain = new AICaptain(enemy, scene, effects);
  const boarding = new BoardingSystem(physics, scene, effects, sloop, enemy);
  let onFoot = false;
  const banner = document.getElementById("banner")!;
  let gameOver = false;
  let plugChannel = 0; // seconds remaining on the current plank repair

  const isSunk = (s: Ship) =>
    s.body.translation().y < -12 ||
    s.build.compartments.every((c) => c.waterVolume / c.volume > 0.95);

  const endGame = (title: string, sub: string) => {
    gameOver = true;
    banner.style.display = "flex";
    banner.innerHTML = `<div>${title}</div><small>${sub} — press Enter for another voyage</small>`;
  };
  window.addEventListener("keydown", (e) => {
    if (e.code === "Enter" && gameOver) location.reload();
  });

  world.onFixedStep = (t, dt) => {
    // T: step away from / back to the helm
    if (controls.modePressed) {
      controls.modePressed = false;
      boarding.spawnPlayer();
      onFoot = !onFoot;
    }
    if (controls.grapplePressed) {
      controls.grapplePressed = false;
      boarding.toggleGrapple();
    }

    if (!onFoot) controls.updateSailing(sailing, dt);
    sailing.apply(sloop, wind);
    if (!gameOver) captain.update(dt, t, waves, wind, sloop);

    // on-foot combat input (F doubles as slash when off the helm)
    const mv = onFoot ? controls.footMove() : { x: 0, z: 0, jump: false };
    let slash = false;
    if (onFoot && controls.firePressed) {
      controls.firePressed = false;
      slash = boarding.canFight();
    }
    let kick = false;
    if (controls.kickPressed) {
      controls.kickPressed = false;
      kick = onFoot;
    }
    let interact = false;
    if (controls.interactPressed) {
      controls.interactPressed = false;
      interact = onFoot;
    }
    boarding.update(dt, t, waves, { moveX: mv.x, moveZ: mv.z, jump: mv.jump, slash, kick, interact }, onFoot);

    // plank repair channel: 4s, blocks firing
    if (controls.plugPressed) {
      controls.plugPressed = false;
      if (plugChannel <= 0 && sloop.planks > 0 && sloop.hasBreaches()) plugChannel = 4;
    }
    if (plugChannel > 0) {
      plugChannel -= dt;
      if (plugChannel <= 0) sloop.plugBreach();
    }
    if (controls.pumpPressed) {
      controls.pumpPressed = false;
      sloop.pumpOn = !sloop.pumpOn;
    }

    if (controls.firePressed && !onFoot) {
      controls.firePressed = false;
      if (plugChannel <= 0) {
        // fire the broadside on the side the camera looks across
        const tr = sloop.body.translation();
        const rot = sloop.body.rotation();
        const inv = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w).invert();
        const rel = new THREE.Vector3(tr.x - camera.position.x, 0, tr.z - camera.position.z).applyQuaternion(inv);
        cannons.fireBroadside(sloop, rel.z >= 0 ? 1 : -1, t, controls.elevationDeg);
      }
    }
    cannons.update(dt, t, waves, [enemy]);
    debris.update(dt, t, waves);
    character?.update(dt, controls.cameraYaw());

    if (!gameOver) {
      if (boarding.chestBanked && boarding.enemiesLeft() === 0) {
        endGame("PRIZE TAKEN", `gold banked: ${boarding.gold} — a proper pirate's day`);
      } else if (isSunk(enemy)) {
        boarding.gold += 150; // flotsam — most of it went down with her
        endGame("PRIZE SUNK", `the sea takes most of her gold — salvaged ${boarding.gold}`);
      } else if (isSunk(sloop)) {
        endGame("SHE'S GONE", "your gold sinks with her");
      }
    }
  };

  // character-on-deck spike (plan Task 13): ?spike=char, IJKL walk, U jump.
  // Spawns once the ship has settled from its splash-down.
  let character: CharacterSpike | null = null;
  if (new URLSearchParams(location.search).get("spike") === "char") {
    const trySpawn = setInterval(() => {
      if (world.simTime > 6) {
        character = new CharacterSpike(physics, scene, sloop);
        character.respawn();
        clearInterval(trySpawn);
      }
    }, 500);
  }

  // robust sizing: ResizeObserver catches fullscreen/zoom cases the resize
  // event misses (playtest: "unable to scale past a certain point")
  const fitViewport = () => {
    const w = app.clientWidth || window.innerWidth;
    const h = app.clientHeight || window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
  };
  window.addEventListener("resize", fitViewport);
  document.addEventListener("fullscreenchange", fitViewport);
  new ResizeObserver(fitViewport).observe(app);

  // cutaway damage view (X): clips the near half of each hull so compartment
  // water levels read at a glance — flooding legibility is a core spec feature
  let cutaway = false;
  const cutPlane = new THREE.Plane();
  window.addEventListener("keydown", (e) => {
    if (e.code === "KeyX") {
      cutaway = !cutaway;
      for (const s of [sloop, enemy]) s.visual.setCutaway(cutaway ? cutPlane : null);
    }
  });

  // dev console handle (also used by Playwright-driven verification)
  (window as unknown as Record<string, unknown>).DEBUG = {
    sloop,
    enemy,
    world,
    cannons,
    captain,
    boarding,
    get character() {
      return character;
    },
  };

  const clock = new THREE.Clock();
  let hudTimer = 0;

  // bow wake so hulls don't phase silently through the sea (playtest feedback)
  const wakeV = new THREE.Vector3();
  const wakeF = new THREE.Vector3();
  const emitBowWake = (ship: Ship) => {
    const v = ship.body.linvel();
    const speed = Math.hypot(v.x, v.z);
    if (speed < 1.6 || ship.submergedFrac < 0.05) return;
    const rot = ship.body.rotation();
    wakeF.set(1, 0, 0).applyQuaternion(new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w));
    wakeF.y = 0;
    wakeF.normalize();
    // stem position at the waterline
    ship.localToWorld([17, 1.5, 3], wakeV);
    wakeV.y = surfaceHeight(waves, wakeV.x, wakeV.z, world.simTime) + 0.05;
    effects.bowWake(wakeV, wakeF, speed);
  };

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    world.step(dt);
    emitBowWake(sloop);
    emitBowWake(enemy);
    effects.update(dt);

    const tr = sloop.body.translation();
    const sd = skySetup.sunDir;
    if (onFoot && boarding.player) {
      const pt = boarding.player.body.translation();
      controls.updateCamera(camera, new THREE.Vector3(pt.x, pt.y, pt.z));
    } else {
      controls.updateCamera(camera, new THREE.Vector3(tr.x, tr.y, tr.z));
    }

    // spyglass zoom (Q)
    const targetFov = controls.spyglass ? 16 : 60;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * 0.18;
      camera.updateProjectionMatrix();
    }

    if (cutaway) {
      // hide the half of each hull facing the camera
      const com = sloop.body.worldCom();
      const n = new THREE.Vector3(com.x - camera.position.x, 0, com.z - camera.position.z).normalize();
      cutPlane.setFromNormalAndCoplanarPoint(n, new THREE.Vector3(com.x, com.y, com.z));
    }
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
      const kn = (sailing.speed * 1.944).toFixed(1);
      const floods = sloop.build.compartments
        .map((c) => `${Math.round((c.waterVolume / c.volume) * 100)}%`)
        .join(" ");
      const reload = Math.max(cannons.reloadAt - world.simTime, 0);
      const et = enemy.body.translation();
      const range = Math.hypot(et.x - tr.x, et.z - tr.z);
      const modeLine = onFoot
        ? `ON FOOT  HP ${boarding.playerHp}/5  foes ${boarding.enemiesLeft()}` +
          `${boarding.chestCarried ? "  CARRYING CHEST" : ""}  |  WASD move  Space jump  F slash  C kick  E grab  T helm`
        : `W/S sails  A/D rudder  F fire  RMB aim  Q spyglass  R plank  P pump  G grapple  T board  X cutaway`;
      hud.textContent =
        `${kn} kn   sails ${(sailing.sailSet * 100).toFixed(0)}%   wind ${sailing.angleOffWind.toFixed(0)}° off bow   enemy ${range.toFixed(0)}m   gold ${boarding.gold}\n` +
        `roll ${THREE.MathUtils.radToDeg(e.x).toFixed(1)}°  pitch ${THREE.MathUtils.radToDeg(e.z).toFixed(1)}°  ` +
        `flood [${floods}]  planks ${sloop.planks}  pump ${sloop.pumpOn ? "ON" : "off"}` +
        `${boarding.grappled ? "  GRAPPLED" : ""}\n` +
        `guns ${reload > 0 ? reload.toFixed(1) + "s" : "READY"} @ ${controls.elevationDeg.toFixed(1)}°` +
        `${plugChannel > 0 ? `   PLUGGING ${plugChannel.toFixed(1)}s` : ""}` +
        `${boarding.message ? `   » ${boarding.message}` : ""}\n` +
        modeLine;
    }
  });
}

main();
