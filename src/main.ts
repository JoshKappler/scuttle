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
import { muzzleWorld } from "./game/gunnery";
import { CharacterSpike } from "./game/character";
import { DebrisManager } from "./game/debris";
import { Effects } from "./render/effects";

async function main() {
  const app = document.getElementById("app")!;
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
  // helm model (playtest round 2): you ARE a pirate on deck at all times.
  // Steering only happens at the wheel (E to take/leave it); V toggles
  // first person. Third person keeps a bird's-eye orbit on the ship.
  let atWheel = true;
  let onFoot = false; // derived each step: !atWheel
  let firstPerson = false;
  const wheelWorld = new THREE.Vector3();
  const ladderWorld = new THREE.Vector3();
  const climbTarget = new THREE.Vector3();
  let ladderHinted = false;
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
    controls.modePressed = false; // legacy T — the wheel gates the helm now
    if (controls.grapplePressed) {
      controls.grapplePressed = false;
      boarding.toggleGrapple();
    }

    // wheel + ladder positions in world (for E proximity)
    sloop.localToWorld(sloopVisual.wheelLocal, wheelWorld);
    sloop.localToWorld(sloopVisual.ladderLocal, ladderWorld);

    // swimming near the stern ladder? surface the hint
    if (boarding.player && boarding.player.swimming) {
      const pp = boarding.player.body.translation();
      const nearLadder =
        Math.hypot(pp.x - ladderWorld.x, pp.y - ladderWorld.y, pp.z - ladderWorld.z) < 3.4;
      if (nearLadder && !ladderHinted) {
        boarding.message = "press E — stern ladder";
        ladderHinted = true;
      } else if (!nearLadder) {
        ladderHinted = false;
      }
    }

    // E: take/leave the wheel when close to it; climb the stern ladder when
    // swimming beside it; otherwise it's the interact key (chest)
    let interact = false;
    if (controls.interactPressed) {
      controls.interactPressed = false;
      if (atWheel) {
        atWheel = false;
        // the watch douses sail while the captain is off the helm — also
        // keeps deck-walking sane (12 m/s under your boots is a lot)
        sailing.sailSet = Math.min(sailing.sailSet, 0.25);
        boarding.message = "you leave the wheel — the watch shortens sail";
      } else if (boarding.player) {
        const pp = boarding.player.body.translation();
        if (Math.hypot(pp.x - wheelWorld.x, pp.y - wheelWorld.y, pp.z - wheelWorld.z) < 2.4) {
          atWheel = true;
          boarding.message = "you take the wheel";
        } else if (
          boarding.player.swimming &&
          Math.hypot(pp.x - ladderWorld.x, pp.y - ladderWorld.y, pp.z - ladderWorld.z) < 3.4
        ) {
          boarding.player.ship = sloop;
          boarding.player.teleport(sloop.localToWorld([2.6, 5.3, 4.0], climbTarget));
          boarding.message = "you haul yourself up the stern ladder";
        } else {
          interact = true;
        }
      }
    }
    onFoot = !atWheel;

    if (atWheel) controls.updateSailing(sailing, dt);
    sailing.apply(sloop, wind);
    if (!gameOver) captain.update(dt, t, waves, wind, sloop);

    // F: broadside at the wheel, sword off it
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
    boarding.update(dt, t, waves, { moveX: mv.x, moveZ: mv.z, jump: mv.jump, slash, kick, interact }, onFoot);

    // pin the captain to the wheel while steering
    if (atWheel && boarding.player) {
      const rot2 = sloop.body.rotation();
      const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(
        new THREE.Quaternion(rot2.x, rot2.y, rot2.z, rot2.w),
      );
      const stand = wheelWorld.clone();
      stand.x -= fwd.x * 0.8;
      stand.z -= fwd.z * 0.8;
      stand.y -= 0.2; // feet on the deck, not levitating at hub height
      boarding.player.pin(stand, Math.atan2(fwd.z, fwd.x));
    }

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
        // fire the broadside on the side the camera looks across, with the
        // player's laid elevation + traverse
        cannons.fireBroadside(sloop, aimSide(), t, controls.elevationDeg, controls.traverseDeg);
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
  // water levels read at a glance — flooding legibility is a core spec feature.
  // The ocean gets a box hole around the PLAYER ship (one hole is all the
  // clip-plane intersection can express; the enemy hull is inspected from afar)
  let cutaway = false;
  const cutPlane = new THREE.Plane();
  const holePlanes = [new THREE.Plane(), new THREE.Plane(), new THREE.Plane(), new THREE.Plane()];
  const holeQ = new THREE.Quaternion();
  const holeFwd = new THREE.Vector3();
  const holeLat = new THREE.Vector3();
  const holeN = new THREE.Vector3();
  const holeCenter = new THREE.Vector3();
  const holePt = new THREE.Vector3();
  const updateHole = () => {
    const rotS = sloop.body.rotation();
    holeQ.set(rotS.x, rotS.y, rotS.z, rotS.w);
    holeFwd.set(1, 0, 0).applyQuaternion(holeQ);
    holeFwd.y = 0;
    holeFwd.normalize();
    holeLat.set(-holeFwd.z, 0, holeFwd.x);
    sloop.localToWorld([13, 2, 4], holeCenter);
    const HX = 13.6; // half-length of the hole, m
    const HZ = 4.5; // half-width
    holePlanes[0].setFromNormalAndCoplanarPoint(holeFwd, holePt.copy(holeCenter).addScaledVector(holeFwd, HX));
    holePlanes[1].setFromNormalAndCoplanarPoint(holeN.copy(holeFwd).negate(), holePt.copy(holeCenter).addScaledVector(holeFwd, -HX));
    holePlanes[2].setFromNormalAndCoplanarPoint(holeLat, holePt.copy(holeCenter).addScaledVector(holeLat, HZ));
    holePlanes[3].setFromNormalAndCoplanarPoint(holeN.copy(holeLat).negate(), holePt.copy(holeCenter).addScaledVector(holeLat, -HZ));
  };
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return; // holding X must not strobe the cutaway (playtest)
    if (e.code === "KeyV" && boarding.player) {
      firstPerson = !firstPerson;
      boarding.player.setFirstPerson(firstPerson);
    }
    if (e.code === "KeyX") {
      cutaway = !cutaway;
      for (const s of [sloop, enemy]) s.visual.setCutaway(cutaway ? cutPlane : null);
      if (cutaway) updateHole();
      ocean.setCutawayHole(cutaway ? holePlanes : null);
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

  // ---- styled HUD ----
  const $ = (id: string) => document.getElementById(id)!;
  const hudEls = {
    spd: $("spd"),
    sailsBar: $("sails-bar"),
    fl: [$("fl0"), $("fl1"), $("fl2")],
    crewLine: $("crew-line"),
    hpRow: $("hp-row"),
    hpBar: $("hp-bar"),
    gunStatus: $("gun-status"),
    gunBar: $("gun-bar"),
    gunSub: $("gun-sub"),
    gold: $("gold"),
    rose: $("rose"),
    hdg: $("hdg"),
    enemyMarker: $("enemy-marker"),
    windMarker: $("wind-marker"),
    toast: $("toast"),
    hints: $("hints"),
    underwater: $("underwater"),
  };
  let lastToast = "";
  let toastTimer = 0;
  const hdgQ = new THREE.Quaternion();
  const hdgV = new THREE.Vector3();
  let wasUnder = false;
  const underFog = new THREE.FogExp2(0x0c3a44, 0.055);

  function updateHud(dt: number, tr: { x: number; y: number; z: number }): void {
    // smooth elements every frame
    const rot = sloop.body.rotation();
    hdgQ.set(rot.x, rot.y, rot.z, rot.w);
    hdgV.set(1, 0, 0).applyQuaternion(hdgQ);
    const heading = Math.atan2(hdgV.z, hdgV.x); // world yaw of the bow
    hudEls.rose.style.transform = `rotate(${(-heading * 180) / Math.PI}deg)`;
    hudEls.hdg.textContent = `${Math.round(((heading * 180) / Math.PI + 360) % 360)}°`;
    const et = enemy.body.translation();
    const enemyBearing = Math.atan2(et.z - tr.z, et.x - tr.x) - heading;
    hudEls.enemyMarker.style.transform = `rotate(${(enemyBearing * 180) / Math.PI}deg)`;
    const windBearing = Math.atan2(-wind.dirZ, -wind.dirX) - heading;
    hudEls.windMarker.style.transform = `rotate(${(windBearing * 180) / Math.PI}deg)`;

    const reload = Math.max(cannons.reloadAt - world.simTime, 0);
    hudEls.gunBar.style.width = `${(1 - reload / Cannons.RELOAD) * 100}%`;

    // toast lifecycle
    if (boarding.message && boarding.message !== lastToast) {
      lastToast = boarding.message;
      hudEls.toast.textContent = boarding.message;
      hudEls.toast.style.opacity = "1";
      toastTimer = 3.2;
    }
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) {
        hudEls.toast.style.opacity = "0";
        boarding.message = "";
        lastToast = "";
      }
    }

    hudTimer += dt;
    if (hudTimer < 0.2) return;
    hudTimer = 0;

    hudEls.spd.textContent = (sailing.speed * 1.944).toFixed(1);
    hudEls.sailsBar.style.width = `${sailing.sailSet * 100}%`;
    sloop.build.compartments.forEach((c, i) => {
      if (hudEls.fl[i]) hudEls.fl[i].style.width = `${(c.waterVolume / c.volume) * 100}%`;
    });
    hudEls.crewLine.textContent =
      `planks ${sloop.planks} · pump ${sloop.pumpOn ? "ON" : "off"}` +
      `${boarding.grappled ? " · GRAPPLED" : ""}` +
      `${plugChannel > 0 ? ` · plugging ${plugChannel.toFixed(1)}s` : ""}`;

    if (plugChannel > 0) {
      hudEls.gunStatus.textContent = "REPAIRING";
      hudEls.gunStatus.className = "";
    } else if (reload > 0) {
      hudEls.gunStatus.textContent = `${reload.toFixed(1)}s`;
      hudEls.gunStatus.className = "";
    } else {
      hudEls.gunStatus.textContent = "GUNS READY";
      hudEls.gunStatus.className = "ready";
    }
    hudEls.gunSub.textContent =
      `elev ${controls.elevationDeg.toFixed(1)}° · trav ${controls.traverseDeg >= 0 ? "+" : ""}${controls.traverseDeg.toFixed(0)}°` +
      `${controls.aiming ? " — AIMING" : ""}`;
    hudEls.gold.textContent = String(boarding.gold);

    hudEls.hpRow.style.display = onFoot ? "flex" : "none";
    if (onFoot) hudEls.hpBar.style.width = `${(boarding.playerHp / 5) * 100}%`;

    const lockHint = controls.locked ? "" : "CLICK to capture mouse · ";
    hudEls.hints.textContent = onFoot
      ? `${lockHint}WASD move · Space jump · F slash · C kick · E wheel/grab · V view · G grapple${boarding.chestCarried ? "  — CARRYING CHEST" : ""}  foes ${boarding.enemiesLeft()}`
      : `${lockHint}W/S sails · A/D rudder · F fire · RMB aim · E leave wheel · V view · Q spyglass · R plank · P pump · G grapple · X cutaway`;
  }

  // broadside trajectory preview while aiming (RMB): one arc PER CANNON on
  // the aiming side (playtest: "all four cannons … should show their
  // trajectory as well and articulate")
  const ARC_PTS = 48;
  const aimLines: { line: THREE.Line; pos: Float32Array }[] = [];
  for (let i = 0; i < 4; i++) {
    const pos = new Float32Array(ARC_PTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const line = new THREE.Line(
      geo,
      new THREE.LineBasicMaterial({ color: 0xe3b341, transparent: true, opacity: 0.8 }),
    );
    line.frustumCulled = false;
    line.visible = false;
    scene.add(line);
    aimLines.push({ line, pos });
  }

  // which broadside the camera is looking ACROSS — from the camera's look
  // direction, so it works identically in first person and orbit views
  const lookV = new THREE.Vector3();
  function aimSide(): 1 | -1 {
    const rot2 = sloop.body.rotation();
    const inv = new THREE.Quaternion(rot2.x, rot2.y, rot2.z, rot2.w).invert();
    camera.getWorldDirection(lookV).applyQuaternion(inv);
    return lookV.z >= 0 ? 1 : -1;
  }

  const arcMuzzle = { pos: new THREE.Vector3(), dir: new THREE.Vector3() };
  function updateAimArc(): void {
    if (!controls.aiming || onFoot) {
      for (const a of aimLines) a.line.visible = false;
      return;
    }
    const side = aimSide();
    const portIdxs: number[] = [];
    sloop.build.cannonPorts.forEach((p, i) => {
      if (p.side === side) portIdxs.push(i);
    });

    for (let pi = 0; pi < aimLines.length; pi++) {
      const arc = aimLines[pi];
      if (pi >= portIdxs.length) {
        arc.line.visible = false;
        continue;
      }
      arc.line.visible = true;
      // arc starts at the barrel TIP and follows the true firing solution
      muzzleWorld(sloop, portIdxs[pi], controls.elevationDeg, controls.traverseDeg, arcMuzzle);
      const v = arcMuzzle.dir.clone().multiplyScalar(55);
      const p = arcMuzzle.pos.clone();
      const step = 0.06;
      for (let i = 0; i < ARC_PTS; i++) {
        arc.pos[i * 3] = p.x;
        arc.pos[i * 3 + 1] = p.y;
        arc.pos[i * 3 + 2] = p.z;
        const sp = v.length();
        v.x += -0.006 * sp * v.x * step;
        v.y += (-9.81 - 0.006 * sp * v.y) * step;
        v.z += -0.006 * sp * v.z * step;
        p.addScaledVector(v, step);
        if (p.y < surfaceHeight(waves, p.x, p.z, world.simTime)) {
          for (let j = i + 1; j < ARC_PTS; j++) {
            arc.pos[j * 3] = p.x;
            arc.pos[j * 3 + 1] = p.y;
            arc.pos[j * 3 + 2] = p.z;
          }
          break;
        }
      }
      (arc.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    }
  }

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
    ship.localToWorld([25.4, 1.8, 4], wakeV);
    wakeV.y = surfaceHeight(waves, wakeV.x, wakeV.z, world.simTime) + 0.05;
    effects.bowWake(wakeV, wakeF, speed);
  };

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    world.step(dt);
    emitBowWake(sloop);
    emitBowWake(enemy);
    effects.update(dt);
    updateAimArc();
    sloopVisual.animate(
      world.simTime,
      sailing.rudder,
      sailing.sailSet,
      controls.aiming && !onFoot
        ? { side: aimSide(), elevationDeg: controls.elevationDeg, traverseDeg: controls.traverseDeg }
        : null,
    );
    enemyVisual.animate(world.simTime, captain.sailing.rudder, captain.sailing.sailSet);

    const tr = sloop.body.translation();
    const sd = skySetup.sunDir;
    if (firstPerson && boarding.player) {
      // eye-level camera; drag to look around
      const pt = boarding.player.body.translation();
      camera.position.set(pt.x, pt.y + 0.78, pt.z);
      const yaw = controls.cameraYaw();
      const pitch = controls.lookPitch();
      camera.lookAt(
        pt.x + Math.cos(yaw) * Math.cos(pitch),
        pt.y + 0.78 + Math.sin(pitch),
        pt.z + Math.sin(yaw) * Math.cos(pitch),
      );
    } else {
      // bird's-eye orbit on the ship; your pirate stays visible on deck
      controls.updateCamera(camera, new THREE.Vector3(tr.x, tr.y + 1.5, tr.z));
    }

    // spyglass zoom (Q)
    const targetFov = controls.spyglass ? 16 : 60;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * 0.18;
      camera.updateProjectionMatrix();
    }

    // submerged camera: the sea closes over the lens — teal murk + dense fog
    // instead of a clean cut to the skybox (playtest round 4)
    const camUnder =
      camera.position.y < surfaceHeight(waves, camera.position.x, camera.position.z, world.simTime) - 0.05;
    if (camUnder !== wasUnder) {
      wasUnder = camUnder;
      hudEls.underwater.style.opacity = camUnder ? "1" : "0";
      scene.fog = camUnder ? underFog : null;
    }

    if (cutaway) {
      // hide the half of each hull facing the camera; keep the ocean hole
      // tracking the hull footprint
      const com = sloop.body.worldCom();
      const n = new THREE.Vector3(com.x - camera.position.x, 0, com.z - camera.position.z).normalize();
      cutPlane.setFromNormalAndCoplanarPoint(n, new THREE.Vector3(com.x, com.y, com.z));
      updateHole();
    }
    skySetup.sunLight.target.position.set(tr.x, tr.y, tr.z);
    skySetup.sunLight.position.set(tr.x + sd.x * 120, tr.y + sd.y * 120, tr.z + sd.z * 120);

    ocean.update(world.simTime, camera.position);
    renderer.render(scene, camera);

    updateHud(dt, tr);
  });
}

main();
