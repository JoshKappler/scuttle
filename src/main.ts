import * as THREE from "three";
import { Rng } from "./core/rng";
import { makeWaves, surfaceHeight } from "./sim/gerstner";
import { createOcean } from "./render/ocean";
import { createSky } from "./render/sky";
import { buildBrig, buildSloop } from "./sim/shipwright";
import { ShipVisual } from "./render/shipVisual";
import { initPhysics } from "./game/physics";
import { Ship } from "./game/ship";
import { GameWorld } from "./game/world";
import { SailingController, type Wind } from "./game/sailing";
import { PlayerControls } from "./game/player";
import { AICaptain } from "./game/ai";
import { BoardingSystem } from "./game/boarding";
import { Cannons } from "./game/cannons";
import { Ramming } from "./game/ramming";
import { BALL_DRAG, MUZZLE_SPEED, muzzleWorld } from "./game/gunnery";
import { FIXED_DT, G, VOXEL_SIZE } from "./core/constants";
import { CharacterSpike } from "./game/character";
import { DebrisManager } from "./game/debris";
import { Effects } from "./render/effects";

async function main() {
  const app = document.getElementById("app")!;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // 1.0 + the stronger hemisphere fill: shade reads as shade, not a void
  // (round 7: "anything that's not in direct sunlight is completely pitch black")
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);

  const seed = new URLSearchParams(location.search).get("seed") ?? "scuttle-dev";
  const rng = new Rng(seed);
  // 16-wave directional spectrum (round 8: four waves read as "the same
  // series of waves repeating over and over"); physics rides the swell subset
  const waves = makeWaves(rng, 16);

  const skySetup = createSky();
  skySetup.addTo(scene);
  // image-based skylight: PBR materials get ambient from the actual sky dome
  // (round 8: shade must read as shade, not a void)
  skySetup.bakeEnvironment(renderer, scene);

  const ocean = createOcean(waves, skySetup.sunDir);
  scene.add(ocean.mesh);

  const physics = await initPhysics();
  // rigged CC0 pirates (Quaternius) — loaded up front so every Pirate can be
  // built synchronously; falls back to procedural bodies if it fails
  const { loadPirateLibrary } = await import("./render/pirateModel");
  await loadPirateLibrary();
  const world = new GameWorld(physics, waves, scene);

  // the player's brig splashes down and settles (round 6: "a realistically
  // sized sixteen-hundreds-era fighting vessel"); `sloop` names the player
  // ship throughout for history's sake
  const sloopBuild = buildBrig();
  const sloopVisual = new ShipVisual(sloopBuild);
  const sloop = new Ship(physics, sloopBuild, sloopVisual, { x: -9, y: 0.4, z: -3 });
  world.addShip(sloop);
  // the cutaway hole in the sea matches the player hull's footprint
  ocean.setFootprint(sloopBuild.lengthM / 2 + 1.2, sloopBuild.beamM / 2 + 1.0);

  // enemy captain: the old, smaller sloop — kept as the easier opponent
  // (round 6) — spawns upwind, ALREADY POINTED AT YOU, and runs down on you
  // (round 8: 250 m + a random heading meant a minute of "running away"
  // before first contact)
  const enemyBuild = buildSloop();
  const enemyVisual = new ShipVisual(enemyBuild);
  const enemy = new Ship(physics, enemyBuild, enemyVisual, {
    x: -9 - waves[0].dirX * 160,
    y: 0.2,
    z: -3 - waves[0].dirZ * 160,
  });
  {
    const etr = enemy.body.translation();
    const ea = -Math.atan2(-3 - etr.z, -9 - etr.x);
    enemy.body.setRotation({ x: 0, y: Math.sin(ea / 2), z: 0, w: Math.cos(ea / 2) }, true);
  }
  world.addShip(enemy);

  // wind blows with the dominant swell
  const wind: Wind = { dirX: waves[0].dirX, dirZ: waves[0].dirZ, speed: 7 };
  const sailing = new SailingController();
  const controls = new PlayerControls(renderer.domElement);

  const effects = new Effects();
  scene.add(effects.group); // both particle layers + pooled flash lights
  const cannons = new Cannons(scene, effects);
  const debris = new DebrisManager(physics, scene);
  sloop.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, sloop));
  enemy.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, enemy));

  const captain = new AICaptain(enemy, scene, effects);
  const boarding = new BoardingSystem(physics, scene, effects, sloop, enemy);

  // rig damage feedback (round 7): masts fall, rudders splinter
  sloop.onMastFelled = () => (boarding.message = "YOUR MAST GOES BY THE BOARD!");
  enemy.onMastFelled = () => (boarding.message = "her mast goes by the board!");
  sloop.onRudderHit = (hp) => {
    sloopVisual.chipRudder(hp / 3);
    boarding.message = hp > 0 ? "rudder hit — she answers slow!" : "RUDDER SHOT AWAY!";
  };
  enemy.onRudderHit = (hp) => {
    enemyVisual.chipRudder(hp / 3);
    boarding.message = hp > 0 ? "her rudder is hit!" : "her rudder hangs in splinters!";
  };

  // hull-on-hull: meeting with way on carves voxels out of BOTH ships at the
  // contact point (round 7). No toast, no scripted "ramming event" — it's just
  // timber coming off where two hulls grind together (round 9: "voxel based
  // and dynamic … we don't really need any mechanical logic or an alert").
  const ramming = new Ramming(effects);
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
  let manOverboard = false;
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
        // sails and rudder HOLD as set — leaving the helm changes nothing
        // (playtest round 5); the ship-frame carry keeps deck walking safe
        boarding.message = "you leave the wheel — she holds her course";
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
          boarding.player.teleport(
            sloop.localToWorld(
              [2.6, (sloop.build.deckYAt(10) + 1) * 0.25 + 1.05, sloop.build.footprint.zC],
              climbTarget,
            ),
          );
          boarding.message = "you haul yourself up the stern ladder";
        } else {
          interact = true;
        }
      }
    }
    onFoot = !atWheel;

    if (atWheel) controls.updateSailing(sailing, dt);
    // man overboard! the crew backs the sails so she slows and waits while
    // you swim for the stern ladder (round 6: "your imaginary crew should
    // throttle down all the way so you at least have the chance to climb up")
    if (boarding.player && boarding.player.swimming) {
      sailing.sailSet = Math.max(sailing.sailSet - dt * 0.5, 0);
      if (!manOverboard) {
        manOverboard = true;
        boarding.message = "MAN OVERBOARD — the crew backs the sails!";
      }
    } else {
      manOverboard = false;
    }
    sailing.apply(sloop, wind);
    if (!gameOver) captain.update(dt, t, waves, wind, sloop);

    // one action button (round 6): LMB fires the broadside while RMB-aiming
    // — from the wheel, the deck, first or third person, all identically —
    // and swings the sword on foot otherwise
    const mv = onFoot ? controls.footMove() : { x: 0, z: 0, jump: false, sprint: false };
    let slash = false;
    if (controls.lmbPressed) {
      controls.lmbPressed = false;
      if (controls.aiming) {
        if (plugChannel <= 0 && !gameOver) {
          cannons.fireBroadside(sloop, aimSide(), t, controls.elevationDeg, controls.traverseDeg);
        }
      } else if (onFoot) {
        slash = boarding.canFight();
      }
    }
    let kick = false;
    if (controls.kickPressed) {
      controls.kickPressed = false;
      kick = onFoot;
    }
    boarding.update(
      dt,
      t,
      waves,
      { moveX: mv.x, moveZ: mv.z, jump: mv.jump, sprint: mv.sprint, slash, kick, interact },
      onFoot,
    );

    // pin the captain to the wheel while steering
    if (atWheel && boarding.player) {
      const rot2 = sloop.body.rotation();
      const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(
        new THREE.Quaternion(rot2.x, rot2.y, rot2.z, rot2.w),
      );
      const stand = wheelWorld.clone();
      stand.x -= fwd.x * 0.45; // close enough to put both hands on the rim
      stand.z -= fwd.z * 0.45;
      stand.y -= 0.2; // feet on the deck, not levitating at hub height
      boarding.player.pin(stand, Math.atan2(fwd.z, fwd.x), sailing.rudder);
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

    cannons.update(dt, t, waves, [enemy]);
    ramming.update(dt, [sloop, enemy]);
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
  // dark abyss disc under the ship: the cutaway trench shows "the depths"
  // instead of glowing white skybox-below-the-sea
  const abyss = new THREE.Mesh(
    new THREE.CircleGeometry(70, 40),
    new THREE.MeshBasicMaterial({ color: 0x0a2832 }),
  );
  abyss.geometry.rotateX(-Math.PI / 2);
  abyss.position.y = -9;
  abyss.visible = false;
  scene.add(abyss);
  const holeQ = new THREE.Quaternion();
  const holeFwd = new THREE.Vector3();
  const holeCenter = new THREE.Vector3();
  const updateHole = () => {
    const rotS = sloop.body.rotation();
    holeQ.set(rotS.x, rotS.y, rotS.z, rotS.w);
    holeFwd.set(1, 0, 0).applyQuaternion(holeQ);
    holeFwd.y = 0;
    holeFwd.normalize();
    const fp = sloop.build.footprint;
    sloop.localToWorld([(fp.minX + fp.maxX) / 2, 2, fp.zC], holeCenter);
    ocean.updateCutaway(holeCenter, holeFwd.x, holeFwd.z, cutPlane);
  };
  // fullscreen (round 7/8): F or the brass corner button. The request can be
  // REFUSED (browser policy, missing user-activation edge cases) — surface
  // the reason as a toast instead of silently doing nothing, and re-grab
  // pointer lock after the transition (Chrome drops it on the way in).
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    const hadLock = document.pointerLockElement !== null;
    document.documentElement
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => {
        if (hadLock) renderer.domElement.requestPointerLock();
      })
      .catch((err: Error) => {
        boarding.message = `fullscreen refused: ${err.message}`;
      });
  };
  document.getElementById("fs-btn")!.addEventListener("click", toggleFullscreen);

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return; // holding X must not strobe the cutaway (playtest)
    if (e.code === "KeyV" && boarding.player) {
      firstPerson = !firstPerson;
      boarding.player.setFirstPerson(firstPerson);
      controls.syncFirstPerson(firstPerson);
    }
    if (e.code === "KeyF") toggleFullscreen();
    if (e.code === "KeyX") {
      cutaway = !cutaway;
      for (const s of [sloop, enemy]) s.visual.setCutaway(cutaway ? cutPlane : null);
      ocean.setCutaway(cutaway);
      abyss.visible = cutaway;
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
    controls,
    camera,
    sailing,
    ramming,
    debris,
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
    stamRow: $("stam-row"),
    stamBar: $("stam-bar"),
    spyglass: $("spyglass"),
    gunStatus: $("gun-status"),
    gunBar: $("gun-bar"),
    gunSub: $("gun-sub"),
    gold: $("gold"),
    rose: $("rose"),
    hdg: $("hdg"),
    rudderInd: $("rudder-ind"),
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

    const readiness = cannons.sideReadiness(sloop, aimSide(), world.simTime);
    hudEls.gunBar.style.width = `${readiness * 100}%`;
    // helm indicator: where the rudder is SET (it holds until changed)
    hudEls.rudderInd.style.left = `${50 - sailing.rudder * 42}%`;

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

    const ready2 = cannons.sideReadiness(sloop, aimSide(), world.simTime);
    if (plugChannel > 0) {
      hudEls.gunStatus.textContent = "REPAIRING";
      hudEls.gunStatus.className = "";
    } else if (ready2 >= 0.999) {
      hudEls.gunStatus.textContent = "GUNS READY";
      hudEls.gunStatus.className = "ready";
    } else {
      const sideGuns = sloop.build.cannonPorts.filter((p) => p.side === aimSide()).length;
      hudEls.gunStatus.textContent = `LOADING ${Math.round(ready2 * sideGuns)}/${sideGuns}`;
      hudEls.gunStatus.className = "";
    }
    hudEls.gunSub.textContent =
      `elev ${controls.elevationDeg.toFixed(1)}° · trav ${controls.traverseDeg >= 0 ? "+" : ""}${controls.traverseDeg.toFixed(0)}°` +
      `${controls.aiming ? " — AIMING" : ""}`;
    hudEls.gold.textContent = String(boarding.gold);

    hudEls.hpRow.style.display = onFoot ? "flex" : "none";
    if (onFoot) hudEls.hpBar.style.width = `${(boarding.playerHp / 5) * 100}%`;
    hudEls.stamRow.style.display = onFoot ? "flex" : "none";
    if (onFoot && boarding.player) hudEls.stamBar.style.width = `${boarding.player.stamina * 100}%`;

    const lockHint = controls.locked ? "" : "CLICK to capture mouse · ";
    hudEls.hints.textContent = onFoot
      ? `${lockHint}WASD move · Shift sprint · Space jump · LMB slash · hold RMB aim + LMB fire · C kick · E wheel/grab · V view · F fullscreen${boarding.chestCarried ? "  — CARRYING CHEST" : ""}  foes ${boarding.enemiesLeft()}`
      : `${lockHint}W/S sails · A/D helm · hold RMB aim + LMB fire · E leave wheel · V view · Q spyglass (wheel zooms) · R plank · P pump · G grapple · F fullscreen`;
  }

  // broadside trajectory preview while aiming (RMB): one arc PER CANNON on
  // the aiming side (playtest: "all four cannons … should show their
  // trajectory as well and articulate")
  const ARC_PTS = 64; // vertices in the preview polyline
  // integrate the preview at the ball's exact step; record 1 vertex per this
  // many sim steps → ARC_PTS·ARC_SUB·FIXED_DT ≈ 4.3 s of flight covered
  const ARC_SUB = 4;
  const gunsPerSide = Math.max(
    sloop.build.cannonPorts.filter((p) => p.side === 1).length,
    sloop.build.cannonPorts.filter((p) => p.side === -1).length,
  );
  const aimLines: { line: THREE.Line; pos: Float32Array }[] = [];
  for (let i = 0; i < gunsPerSide; i++) {
    const pos = new Float32Array(ARC_PTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const line = new THREE.Line(
      geo,
      // red dashes: reads as a gunner's PREDICTION, not a laser (round 6.5)
      new THREE.LineDashedMaterial({
        color: 0xe03434,
        dashSize: 1.1,
        gapSize: 0.85,
        transparent: true,
        opacity: 0.95,
      }),
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
    // the WHOLE broadside, wherever you stand — looking across a side while
    // holding RMB lays every gun on it (playtest round 6: "regardless of
    // where you are standing on the ship, it should enter aiming mode for
    // all cannons and then fire all simultaneously")
    const portIdxs: number[] = [];
    if (controls.aiming && !gameOver) {
      const side = aimSide();
      sloop.build.cannonPorts.forEach((p, i) => {
        if (p.side === side) portIdxs.push(i);
      });
    }

    for (let pi = 0; pi < aimLines.length; pi++) {
      const arc = aimLines[pi];
      if (pi >= portIdxs.length) {
        arc.line.visible = false;
        continue;
      }
      arc.line.visible = true;
      // PURE-bore trajectory — muzzle velocity along the barrel, NO ship carry
      // (round 8). The line is redrawn every frame from the MOVING muzzle, so
      // it lives in the ship's frame; a pure curve co-moving with the ship has
      // the ball ride along it as both translate together, and it stays aligned
      // with the visible barrel so you can aim. Folding the ship's velocity in
      // bent the line off the barrel and away from the ball you actually watch
      // fly ("30° off, worse with speed"). The carry belongs to the projectile
      // alone — its launch point is already moving at ship speed. Integrated
      // with the ball's OWN step (FIXED_DT)/G/drag, sub-sampled 1 vertex per
      // ARC_SUB steps, so the curve's SHAPE and range match the shot exactly.
      muzzleWorld(sloop, portIdxs[pi], controls.elevationDeg, controls.traverseDeg, arcMuzzle);
      const v = arcMuzzle.dir.clone().multiplyScalar(MUZZLE_SPEED);
      const p = arcMuzzle.pos.clone();
      let vi = 0;
      for (let stepN = 0; vi < ARC_PTS; stepN++) {
        if (stepN % ARC_SUB === 0) {
          arc.pos[vi * 3] = p.x;
          arc.pos[vi * 3 + 1] = p.y;
          arc.pos[vi * 3 + 2] = p.z;
          vi++;
        }
        const sp = v.length();
        v.x += -BALL_DRAG * sp * v.x * FIXED_DT;
        v.y += (-G - BALL_DRAG * sp * v.y) * FIXED_DT;
        v.z += -BALL_DRAG * sp * v.z * FIXED_DT;
        p.addScaledVector(v, FIXED_DT);
        if (p.y < surfaceHeight(waves, p.x, p.z, world.simTime)) {
          for (let j = vi; j < ARC_PTS; j++) {
            arc.pos[j * 3] = p.x;
            arc.pos[j * 3 + 1] = p.y;
            arc.pos[j * 3 + 2] = p.z;
          }
          break;
        }
      }
      (arc.line.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      arc.line.computeLineDistances(); // dashes need fresh arc lengths
    }
  }

  // ship wash lives in the ocean shader now: bow swell + flank white water +
  // a stern trail the foam follows (round 6: the sprite spray "appeared
  // painted onto the ship itself instead of being a physical presence")
  const wakeV = new THREE.Vector3();
  const wakeF = new THREE.Vector3();
  // hull vertical span (ship-local m): keel bottom → just above the deck. The
  // ocean removes its surface ONLY within the footprint AND between these, so
  // the hold never shows ocean and a hull riding high shows no void (round 10).
  const hullSpan = (ship: Ship) => {
    const g = ship.build.grid;
    const [nx, ny, nz] = g.dims;
    const cx = Math.floor(nx / 2);
    const cz = Math.floor(nz / 2);
    let lo = 0;
    while (lo < ny && !g.isSolid(cx, lo, cz)) lo++;
    return { keel: lo * VOXEL_SIZE, deck: (ship.build.deckY + 1) * VOXEL_SIZE };
  };
  const spans = [hullSpan(sloop), hullSpan(enemy)];
  const feedWake = (slot: 0 | 1, ship: Ship) => {
    const v = ship.body.linvel();
    const speed = ship.submergedFrac < 0.05 ? 0 : Math.hypot(v.x, v.z);
    const rot = ship.body.rotation();
    wakeF.set(1, 0, 0).applyQuaternion(new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w));
    wakeF.y = 0;
    wakeF.normalize();
    const fp = ship.build.footprint;
    ship.localToWorld([(fp.minX + fp.maxX) / 2, 2.5, fp.zC], wakeV);
    const tr = ship.body.translation();
    const span = spans[slot];
    ocean.updateShipWake(
      slot,
      wakeV.x,
      wakeV.z,
      wakeF.x,
      wakeF.z,
      speed,
      ship.build.lengthM / 2,
      ship.build.beamM / 2,
      world.simTime,
      tr.y + span.keel,
      tr.y + span.deck,
    );
  };

  // bow spray (round 8: "adding splashes when it's breaking through waves"):
  // when the stem plunges into a rising face with way on, throw white water
  const sprayState = [
    { imm: 0, cd: 0 },
    { imm: 0, cd: 0 },
  ];
  const sprayP = new THREE.Vector3();
  const sprayQ = new THREE.Quaternion();
  const sprayF = new THREE.Vector3();
  const checkBowSpray = (slot: 0 | 1, ship: Ship, dt: number) => {
    const st = sprayState[slot];
    st.cd -= dt;
    const fp = ship.build.footprint;
    // stem reference rides just above the static waterline at the cutwater
    ship.localToWorld([fp.maxX - 1.5, ship.comLocal[1] + 0.4, fp.zC], sprayP);
    const surf = surfaceHeight(waves, sprayP.x, sprayP.z, world.simTime);
    const imm = surf - sprayP.y;
    const rate = dt > 1e-3 ? (imm - st.imm) / dt : 0;
    st.imm = imm;
    const v = ship.body.linvel();
    const spd = Math.hypot(v.x, v.z);
    // fire when the cutwater drives into the sea — from forward way OR from the
    // hull crashing back down off a crest (round 9: "the boat crashing down
    // over a wave to cause a real splash"). `rate` folds in both: the surface
    // rising and the stem dropping, so a hard slam triggers even at rest.
    if (imm > 0 && rate > 1.2 && (spd > 2.0 || rate > 2.4) && st.cd <= 0 && ship.submergedFrac < 0.5) {
      st.cd = 0.2;
      const rot = ship.body.rotation();
      sprayQ.set(rot.x, rot.y, rot.z, rot.w);
      sprayF.set(1, 0, 0).applyQuaternion(sprayQ);
      effects.spray(
        sprayP.x,
        surf + 0.25,
        sprayP.z,
        sprayF.x,
        sprayF.z,
        Math.min(0.7 + rate * 0.5 + spd * 0.06, 3.0),
      );
    }
  };

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    world.step(dt);
    feedWake(0, sloop);
    feedWake(1, enemy);
    checkBowSpray(0, sloop, dt);
    checkBowSpray(1, enemy, dt);
    effects.update(dt);
    // helm pose rides on top of the final mixer state, once per frame —
    // re-posing per fixed step stacked offsets ("arm absolutely spasming")
    boarding.player?.postPose();
    controls.aimSideSign = aimSide(); // traverse input is screen-relative
    updateAimArc();
    sloopVisual.animate(
      world.simTime,
      sailing.rudder,
      sailing.sailSet,
      controls.aiming
        ? { side: aimSide(), elevationDeg: controls.elevationDeg, traverseDeg: controls.traverseDeg }
        : null,
    );
    enemyVisual.animate(world.simTime, captain.sailing.rudder, captain.sailing.sailSet);

    const tr = sloop.body.translation();
    const sd = skySetup.sunDir;
    if (firstPerson && boarding.player) {
      // eye-level camera — at the model's eye line, not its collar
      // (playtest round 5: "really only shows the inside of the uniform")
      const pt = boarding.player.body.translation();
      const eyeY = pt.y + 0.95;
      camera.position.set(pt.x, eyeY, pt.z);
      const yaw = controls.cameraYaw();
      const pitch = controls.lookPitch();
      camera.lookAt(
        pt.x + Math.cos(yaw) * Math.cos(pitch),
        eyeY + Math.sin(pitch),
        pt.z + Math.sin(yaw) * Math.cos(pitch),
      );
    } else {
      // bird's-eye orbit on the ship's CENTER (the body origin is the grid
      // corner, aft — orbiting that made every view sit off-center). The
      // look-at rides at deck height so close zooms don't dip into the hull.
      const c0 = sloop.body.worldCom();
      const deckLift = (sloop.build.deckY + 2) * 0.25 + (sloop.body.translation().y - c0.y);
      controls.updateCamera(camera, new THREE.Vector3(c0.x, c0.y + Math.max(deckLift, 2.5), c0.z));
    }

    // spyglass zoom (Q) — wheel works the draw-tube while it's up; the brass
    // viewport overlay raises with it (round 7)
    const targetFov = controls.spyglass ? controls.spyFov : 60;
    if (Math.abs(camera.fov - targetFov) > 0.1) {
      camera.fov += (targetFov - camera.fov) * 0.18;
      camera.updateProjectionMatrix();
    }
    hudEls.spyglass.classList.toggle("up", controls.spyglass);

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
      // hide the half of each hull facing the camera; keep the ocean trench
      // tracking the hull footprint
      const com = sloop.body.worldCom();
      const n = new THREE.Vector3(com.x - camera.position.x, 0, com.z - camera.position.z).normalize();
      cutPlane.setFromNormalAndCoplanarPoint(n, new THREE.Vector3(com.x, com.y, com.z));
      updateHole();
      abyss.position.x = com.x;
      abyss.position.z = com.z;
    }
    skySetup.sunLight.target.position.set(tr.x, tr.y, tr.z);
    skySetup.sunLight.position.set(tr.x + sd.x * 120, tr.y + sd.y * 120, tr.z + sd.z * 120);

    ocean.update(world.simTime, camera.position);
    renderer.render(scene, camera);

    updateHud(dt, tr);
  });
}

main();
