import * as THREE from "three";
import { Rng } from "./core/rng";
import { makeWaves, surfaceHeight } from "./sim/gerstner";
import { createOcean } from "./render/ocean";
import { SeamMask } from "./render/seamMask";
import { createOceanField } from "./render/oceanField";
import { createDynamicWaves, type DynShip } from "./render/dynamicWaves";
import { buildHullProfile } from "./sim/buoyancy";
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
import { characterPack } from "./game/characterPack";
import { DebrisManager } from "./game/debris";
import { Effects } from "./render/effects";
import { createSpray } from "./render/spray";
import { TUN } from "./core/tunables";
import { createDevPanel } from "./render/devPanel";

async function main() {
  // THROWAWAY (plan Task 0): ?spike=1 runs the voxel-collider perf gate and bails.
  if (new URLSearchParams(location.search).has("spike")) {
    const { runVoxelSpike } = await import("./dev/voxelSpike");
    await runVoxelSpike();
    return;
  }
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

  // Round 14: a MULTI-CASCADE Tessendorf ocean surface (the AC4 / Sea of Thieves
  // recipe) replaces the single band-limited chop tile that could only shimmer and
  // tile. Three NON-COMMENSURATE FFT tiles (40 / 18 / 7 m), each windowed to its
  // own wavelength band and given its own CROSSING wind direction, sum into a sea
  // with sharp crashing crests and no visible grid. VISUAL ONLY and band-split
  // BELOW the analytic Gerstner swell, which stays the big slow waves AND the
  // deterministic physics truth (the hull never samples these). N=128/cascade
  // keeps 3× the DFT cheaper than the old single 256² tile.
  const swDx = waves[0].dirX;
  const swDz = waves[0].dirZ;
  const rotDir = (ang: number) => ({
    x: swDx * Math.cos(ang) - swDz * Math.sin(ang),
    z: swDx * Math.sin(ang) + swDz * Math.cos(ang),
  });
  const c0 = rotDir(0.0);
  const c1 = rotDir(0.85);
  const c2 = rotDir(-0.6);
  const oceanField = createOceanField(renderer, {
    rng: new Rng(seed + "-fft"),
    N: 128,
    L: 40, // base L is unused when cascades are present (each carries its own)
    windSpeed: 11,
    windDirX: swDx,
    windDirZ: swDz,
    cascades: [
      // amplitudes are uncalibrated Phillips scales — tuned in-browser via readback
      // to ~1.1 / 0.45 / 0.15 m crests (a rough, crashing, but not deck-flooding sea)
      { L: 40, band: [12, 40], windDirX: c0.x, windDirZ: c0.z, amplitude: 280, choppiness: 1.35 },
      { L: 18, band: [5, 18], windDirX: c1.x, windDirZ: c1.z, amplitude: 360, choppiness: 1.05 },
      { L: 7, band: [2, 7], windDirX: c2.x, windDirZ: c2.z, amplitude: 300, choppiness: 0.6 },
    ],
  });
  const ocean = createOcean(waves, skySetup.sunDir, oceanField);
  scene.add(ocean.mesh);

  const physics = await initPhysics();
  // rigged CC0 character pack — loaded up front so every Pirate can be built
  // synchronously. Default KayKit (modular limbs + 76 melee clips); ?char=q
  // selects the legacy Quaternius pirate. If KayKit fails to load, fall back to
  // Quaternius so the demo still has a real (if single-mesh) body.
  let charOk = false;
  if (characterPack() === "kaykit") {
    const { loadKayKitLibrary } = await import("./render/kaykitModel");
    charOk = await loadKayKitLibrary();
  }
  if (!charOk) {
    const { loadPirateLibrary } = await import("./render/pirateModel");
    await loadPirateLibrary();
  }
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

  // P4/P5: bake a hull's per-column keel/deck profile from the voxel grid (once)
  // into a float texture. P4 binds the PLAYER's for the voxel-accurate in-hull cut;
  // P5 stamps BOTH ships' profiles into the dynamic-wave field for the interaction
  // bulge. RG = keelYLocal, deckYLocal (m); Nearest so cut edges stay voxel-crisp.
  const makeProfileTex = (grid: typeof sloop.build.grid) => {
    const prof = buildHullProfile(grid);
    const texData = new Float32Array(prof.nx * prof.nz * 4);
    for (let i = 0; i < prof.nx * prof.nz; i++) {
      texData[i * 4] = prof.data[i * 2]; // keelYLocal → R
      texData[i * 4 + 1] = prof.data[i * 2 + 1]; // deckYLocal → G
      texData[i * 4 + 3] = 1;
    }
    const tex = new THREE.DataTexture(texData, prof.nx, prof.nz, THREE.RGBAFormat, THREE.FloatType);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = false; // texel (x,z) ↔ data idx z*nx+x
    tex.needsUpdate = true;
    return { tex, sizeX: prof.sizeX, sizeZ: prof.sizeZ };
  };
  const sloopProfile = makeProfileTex(sloop.build.grid);
  ocean.setHullProfile(0, sloopProfile.tex, sloopProfile.sizeX, sloopProfile.sizeZ);

  // enemy captain: the old, smaller sloop — kept as the easier opponent
  // (round 6) — spawns upwind, ALREADY POINTED AT YOU, and runs down on you.
  // 85 m, not 160 (round 10: "very hard to actually line up with the enemy …
  // just floating off way into the distance") — close enough to engage inside
  // a minute, and the brain now hunts instead of jockeying off to leeward.
  const enemyBuild = buildSloop();
  const enemyVisual = new ShipVisual(enemyBuild);
  const enemy = new Ship(physics, enemyBuild, enemyVisual, {
    x: -9 - waves[0].dirX * 85,
    y: 0.2,
    z: -3 - waves[0].dirZ * 85,
  });
  {
    const etr = enemy.body.translation();
    const ea = -Math.atan2(-3 - etr.z, -9 - etr.x);
    enemy.body.setRotation({ x: 0, y: Math.sin(ea / 2), z: 0, w: Math.cos(ea / 2) }, true);
  }
  world.addShip(enemy);
  const enemyProfile = makeProfileTex(enemy.build.grid);
  // P4: give the enemy hull the SAME voxel-accurate, attitude-aware cut as the
  // player — previously it fell back to the old flat waterline ellipse (the void
  // crescents / sea-through-hull on the "old ship").
  ocean.setHullProfile(1, enemyProfile.tex, enemyProfile.sizeX, enemyProfile.sizeZ);

  // P5: the dynamic-wave INTERACTION field (Crest/Atlas FDTD ping-pong, GPU
  // fragment passes). A 256 m height/velocity sheet re-centred on the camera each
  // frame that the ships stamp their waterline footprint into — the bow pushes
  // water up, the flanks bulge, the stern leaves a contrail — summed onto the ocean
  // surface in VERT. VISUAL ONLY: physics still rides the analytic swell. The flow
  // advection drifts disturbances downwind so they trail. Falls back to inert
  // (active=false) on a context without float RTs; the ocean then ignores it.
  const dynWaves = createDynamicWaves(renderer, {
    N: 256,
    window: 256,
    speed: 9,
    damping: 0.55,
    flowDirX: waves[0].dirX,
    flowDirZ: waves[0].dirZ,
    flowSpeed: 1.4,
    maxShips: 2,
  });

  // stencil seam mask: each frame, paint both hull silhouettes into the
  // stencil buffer before the ocean draws; the ocean's NotEqual stencil test
  // then rejects those pixels (no sea on the deck, in the hold, or bow void).
  const seam = new SeamMask([sloop.visual.group, enemy.visual.group]);

  // wind blows with the dominant swell
  const wind: Wind = { dirX: waves[0].dirX, dirZ: waves[0].dirZ, speed: 7 };
  const sailing = new SailingController();
  const controls = new PlayerControls(renderer.domElement);

  const effects = new Effects();
  scene.add(effects.group); // both particle layers + pooled flash lights
  // P5: GPU-instanced ballistic spray — effects.ts routes its bow/crest WATER spray
  // here (the arc runs in the vertex shader; "utilize the GPU heavily"). Spray splash-
  // downs are drained each frame and stamped as foam into the dynamic-wave field.
  const spray = createSpray();
  scene.add(spray.object);
  effects.attachSpray(spray);
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
  // r17: the "LOST AT SEA" / "PRIZE TAKEN" end-game was removed entirely. A sinking ship
  // — yours or the prize — no longer freezes the game or demands a reload; the voyage
  // just continues. Only the non-terminal man-overboard + enemy-salvage states remain.
  let manOverboard = false;
  let enemyScuttled = false; // enemy went down — non-terminal, salvage and sail on
  let plugChannel = 0; // seconds remaining on the current plank repair

  const isSunk = (s: Ship) =>
    s.body.translation().y < -12 ||
    s.build.compartments.every((c) => c.waterVolume / c.volume > 0.95);

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
    // man overboard! the crew drops the sheets — throttle goes straight to ZERO
    // so she loses way and waits while you swim for the stern ladder. (r18: the
    // old gradual sail-back read as a "lost at sea" mechanic; the player wants a
    // hard cut to 0 throttle the instant you go over the side.)
    if (boarding.player && boarding.player.swimming) {
      sailing.sailSet = 0;
      if (!manOverboard) {
        manOverboard = true;
        boarding.message = "MAN OVERBOARD — sails dropped, she loses way!";
      }
    } else {
      manOverboard = false;
    }
    sailing.apply(sloop, wind);
    captain.update(dt, t, waves, wind, sloop);

    // one action button (round 6): LMB fires the broadside while RMB-aiming
    // — from the wheel, the deck, first or third person, all identically —
    // and swings the sword on foot otherwise
    const mv = onFoot ? controls.footMove() : { x: 0, z: 0, jump: false, sprint: false };
    let slash = false;
    if (controls.lmbPressed) {
      controls.lmbPressed = false;
      if (controls.aiming) {
        if (plugChannel <= 0) {
          cannons.fireBroadside(sloop, aimBearing(), t, controls.elevationDeg, controls.traverseDeg);
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

    // r17: NO end-game. The prize sinking just yields salvage and the run continues; your
    // own ship sinking is survivable too (swim clear, board the enemy, or respawn) — it is
    // never a banner or a freeze. The game only ends when the player reloads.
    if (isSunk(enemy) && !enemyScuttled) {
      enemyScuttled = true;
      boarding.gold += 150; // flotsam — most of it went down with her
      boarding.message = `SHE'S SCUTTLED — salvaged ${boarding.gold}g from the flotsam. Sail on.`;
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
  // Bulletproofed r16. The Fullscreen API itself works (verified), so "F / the
  // button do nothing" is almost always (a) already in browser F11 fullscreen, so
  // the API request makes NO visible change, or (b) a browser that rejects the
  // options dict / needs the webkit prefix. So: try webkit too, DROP the options
  // dict (a compatibility risk), wrap in try/catch (a SYNC throw skips .catch and
  // looks like "nothing happened"), and surface every failure on-screen.
  const docAny = document as unknown as Record<string, () => Promise<void> | void>;
  const toggleFullscreen = () => {
    const fsEl = document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
    if (fsEl) {
      (document.exitFullscreen ? document.exitFullscreen() : docAny.webkitExitFullscreen?.call(document)) as unknown;
      return;
    }
    const el = document.documentElement as unknown as {
      requestFullscreen?: () => Promise<void>;
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    const reqFn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!reqFn) {
      boarding.message = "fullscreen not supported by this browser";
      return;
    }
    // r18.1: do NOT exit pointer lock first. Chrome holds pointer-lock AND fullscreen at once
    // (every FPS does it), so the old exit→request→re-grab-after-1.1s dance was just dropping
    // control on the way in — which read as "fullscreen is broken". Request straight from the
    // F / click user gesture and keep the lock.
    try {
      const p = reqFn.call(el); // NO options arg — maximal compatibility
      if (p && typeof (p as Promise<void>).then === "function") {
        (p as Promise<void>).catch((err: Error) => {
          boarding.message = `fullscreen refused: ${err.message} (already in F11?)`;
          console.warn("[fullscreen]", err);
        });
      }
    } catch (err) {
      boarding.message = `fullscreen error: ${(err as Error).message}`;
      console.warn("[fullscreen]", err);
    }
  };
  document.getElementById("fs-btn")?.addEventListener("click", toggleFullscreen);

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
    oceanField,
    dynWaves,
    spray,
    get character() {
      return character;
    },
  };

  // ---- first-person viewmodel: a right arm + cutlass always in frame ----
  // Playtest: "in first person I don't see any sword or anything … I want it always
  // in frame, the right arm carrying whatever tool is selected." The body is a single
  // skinned GLB (can't cheaply show just its arm), so this is a dedicated procedural
  // viewmodel in the game's blocky style, parented to the camera each frame and
  // swung when the player slashes.
  const viewModel = new THREE.Group();
  viewModel.visible = false;
  const vmArm = new THREE.Group();
  {
    const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x1d3a52, roughness: 0.85 });
    const cuffMat = new THREE.MeshStandardMaterial({ color: 0x1c6e6e, roughness: 0.8 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xc99066, roughness: 0.7 });
    const steelMat = new THREE.MeshStandardMaterial({
      color: 0xc2cad2,
      roughness: 0.3,
      metalness: 0.7,
      emissive: 0x2a2f36, // lifts the blade off pure-black when backlit against the sky
      emissiveIntensity: 0.6,
    });
    const brassMat = new THREE.MeshStandardMaterial({ color: 0xb08d3a, roughness: 0.45, metalness: 0.6 });
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x3a2415, roughness: 0.85 });
    // r17: the old viewmodel was a flat BOX blade on a ball "hand" — read as janky/blocky.
    // Rebuilt with a real curved+tapered cutlass blade (an extruded silhouette), a brass
    // knuckle-bow, a pommel, and a fist gripping the hilt.
    const forearm = new THREE.Mesh(new THREE.CapsuleGeometry(0.058, 0.34, 6, 12), sleeveMat);
    forearm.position.set(0, 0.17, 0);
    forearm.rotation.x = 0.1;
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.07, 0.06, 14), cuffMat);
    cuff.position.set(0, 0.34, 0.01);
    // a closed fist (rounded box) reads as a hand gripping the hilt, not a marble
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.095, 0.12), skinMat);
    hand.position.set(0, 0.41, 0.03);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.027, 0.14, 10), gripMat);
    grip.position.set(0, 0.45, 0.04);
    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.027, 10, 8), brassMat);
    pommel.position.set(0, 0.38, 0.04);
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.026, 0.04), brassMat);
    guard.position.set(0, 0.52, 0.04);
    // the cutlass's signature curved knuckle-bow, sweeping from guard to pommel
    const knuckle = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.01, 6, 16, Math.PI * 1.1), brassMat);
    knuckle.position.set(0.0, 0.45, 0.055);
    knuckle.rotation.set(Math.PI / 2, 0, -0.2);
    // curved, tapered blade silhouette → extruded thin (replaces the flat box + cone tip)
    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(0, 0);
    bladeShape.lineTo(0.03, 0.015);
    bladeShape.quadraticCurveTo(0.056, 0.34, 0.015, 0.55);
    bladeShape.lineTo(-0.004, 0.6);
    bladeShape.quadraticCurveTo(-0.056, 0.33, -0.022, 0.03);
    bladeShape.lineTo(0, 0);
    const blade = new THREE.Mesh(
      new THREE.ExtrudeGeometry(bladeShape, {
        depth: 0.014,
        bevelEnabled: true,
        bevelThickness: 0.004,
        bevelSize: 0.004,
        bevelSegments: 1,
      }),
      steelMat,
    );
    blade.position.set(0, 0.54, 0.026);
    vmArm.add(forearm, cuff, hand, grip, pommel, guard, knuckle, blade);
    vmArm.traverse((o) => {
      o.castShadow = false;
      o.frustumCulled = false;
    });
    // elbow toward the bottom-right corner, blade angled diagonally up-left across
    // the frame (classic FPS sword pose) so the tip stays comfortably in view
    vmArm.rotation.set(-0.12, 0.28, 0.78);
    viewModel.add(vmArm);
  }
  viewModel.scale.setScalar(0.85);
  scene.add(viewModel);
  const vmOffset = new THREE.Vector3();
  let vmBob = 0;

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

    const readiness = cannons.sideReadiness(sloop, aimBearing(), world.simTime);
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

    const ready2 = cannons.sideReadiness(sloop, aimBearing(), world.simTime);
    if (plugChannel > 0) {
      hudEls.gunStatus.textContent = "REPAIRING";
      hudEls.gunStatus.className = "";
    } else if (ready2 >= 0.999) {
      hudEls.gunStatus.textContent = "GUNS READY";
      hudEls.gunStatus.className = "ready";
    } else {
      const sideGuns = sloop.build.cannonPorts.filter((p) => gunBears(p, aimBearing())).length;
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

  // which battery the camera bears toward — from the camera's look direction (works
  // identically first-person or orbit). Looking more along the keel than across it lays
  // the bow/stern CHASERS; looking across it lays the broadside you're facing.
  const lookV = new THREE.Vector3();
  type Bearing = 1 | -1 | "fore" | "aft";
  function aimBearing(): Bearing {
    const rot2 = sloop.body.rotation();
    const inv = new THREE.Quaternion(rot2.x, rot2.y, rot2.z, rot2.w).invert();
    camera.getWorldDirection(lookV).applyQuaternion(inv);
    if (Math.abs(lookV.x) > Math.abs(lookV.z)) return lookV.x >= 0 ? "fore" : "aft";
    return lookV.z >= 0 ? 1 : -1;
  }
  function gunBears(p: { side: 1 | -1; facing?: "fore" | "aft" }, b: Bearing): boolean {
    return typeof b === "number" ? !p.facing && p.side === b : p.facing === b;
  }

  const arcMuzzle = { pos: new THREE.Vector3(), dir: new THREE.Vector3() };
  function updateAimArc(): void {
    // the WHOLE broadside, wherever you stand — looking across a side while
    // holding RMB lays every gun on it (playtest round 6: "regardless of
    // where you are standing on the ship, it should enter aiming mode for
    // all cannons and then fire all simultaneously")
    const portIdxs: number[] = [];
    if (controls.aiming) {
      const bearing = aimBearing();
      sloop.build.cannonPorts.forEach((p, i) => {
        if (gunBears(p, bearing)) portIdxs.push(i);
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
  // P4 pose temporaries (avoid per-frame allocation)
  const _poseQuat = new THREE.Quaternion();
  const _poseM4 = new THREE.Matrix4();
  const _poseInvRot = new THREE.Matrix3();
  const _poseTrans = new THREE.Vector3();
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
    // P4: feed BOTH hulls' live world→local pose so each ship's voxel-accurate cut
    // tracks its own heave/pitch/roll (the shader skips that slot's analytic ellipse).
    _poseQuat.set(rot.x, rot.y, rot.z, rot.w);
    _poseM4.makeRotationFromQuaternion(_poseQuat);
    _poseInvRot.setFromMatrix4(_poseM4).transpose(); // R⁻¹ = Rᵀ for a rotation
    _poseTrans.set(tr.x, tr.y, tr.z);
    ocean.updateHullPose(slot, _poseInvRot, _poseTrans);
  };

  // P5: assemble both ships' pose + plan for the dynamic-wave INJECTION pass. Each
  // ship stamps its waterline footprint (the P4 hull profile, posed live) into the
  // GPU field — the bow/side/stern impulses are computed in dynamicWaves.ts. The
  // profile texture is the same one P4 cuts with. Pre-allocated to avoid per-frame
  // garbage. wetness peaks while she floats normally and fades to 0 when she lifts
  // clear of the sea or sinks under it (no surface disturbance either way).
  const _dynShips: DynShip[] = [
    { profileTex: sloopProfile.tex, sizeX: sloopProfile.sizeX, sizeZ: sloopProfile.sizeZ,
      trans: new THREE.Vector3(), invRot: new THREE.Matrix3(), fwdX: 1, fwdZ: 0, speed: 0, wetness: 0, waterY: 0 },
    { profileTex: enemyProfile.tex, sizeX: enemyProfile.sizeX, sizeZ: enemyProfile.sizeZ,
      trans: new THREE.Vector3(), invRot: new THREE.Matrix3(), fwdX: 1, fwdZ: 0, speed: 0, wetness: 0, waterY: 0 },
  ];
  const _dynQuat = new THREE.Quaternion();
  const _dynM4 = new THREE.Matrix4();
  const _dynFwd = new THREE.Vector3();
  const buildDynShips = (): DynShip[] => {
    const ships = [sloop, enemy];
    for (let i = 0; i < 2; i++) {
      const ship = ships[i];
      const d = _dynShips[i];
      const rot = ship.body.rotation();
      const tr = ship.body.translation();
      _dynQuat.set(rot.x, rot.y, rot.z, rot.w);
      _dynM4.makeRotationFromQuaternion(_dynQuat);
      d.invRot.setFromMatrix4(_dynM4).transpose(); // world→local = Rᵀ
      d.trans.set(tr.x, tr.y, tr.z);
      _dynFwd.set(1, 0, 0).applyQuaternion(_dynQuat);
      _dynFwd.y = 0;
      _dynFwd.normalize();
      d.fwdX = _dynFwd.x;
      d.fwdZ = _dynFwd.z;
      const v = ship.body.linvel();
      d.speed = Math.hypot(v.x, v.z);
      const sf = ship.submergedFrac;
      d.wetness = (sf <= 0.02 ? 0 : Math.min((sf - 0.02) / 0.1, 1)) * (1 - Math.min(Math.max((sf - 0.7) / 0.25, 0), 1));
      // still-water surface height at the hull centre (the analytic swell the field
      // rides on top of). The footprint zC is amidships; localToWorld gives world XZ.
      const fp = ship.build.footprint;
      ship.localToWorld([(fp.minX + fp.maxX) / 2, 0, fp.zC], wakeV);
      d.waterY = surfaceHeight(waves, wakeV.x, wakeV.z, world.simTime);
    }
    return _dynShips;
  };

  // bow spray (round 8: "adding splashes when it's breaking through waves"):
  // when the stem plunges into a rising face with way on, throw white water
  const sprayState = [
    { cd: 0, fizzCd: 0 },
    { cd: 0, fizzCd: 0 },
  ];
  const sprayQ = new THREE.Quaternion();
  const sprayF = new THREE.Vector3();
  const checkBowSpray = (slot: 0 | 1, ship: Ship, dt: number) => {
    const st = sprayState[slot];
    st.cd -= dt;
    st.fizzCd -= dt;
    if (!TUN.spray.enabled) return;
    const v = ship.body.linvel();
    const spd = Math.hypot(v.x, v.z);
    // r18: spray is fully VOXEL-DRIVEN, not a forced outline. ship.bowSpray is the frontmost
    // column STILL IN THE WATER (the stem at the waterline), recomputed each physics step in
    // the buoyancy pass — as the bow lifts clear, the origin retreats to the next wet column,
    // so the sheet rides the real cutwater and never blinks out in mid-air. We emit ONE
    // bowWave there (it already peels port AND starboard off that single stem), which kills
    // the old two-shoulder double image ("two spray animations spaced a couple meters apart").
    if (spd < 2.0 || ship.submergedFrac > 0.6) return;
    const rot = ship.body.rotation();
    sprayQ.set(rot.x, rot.y, rot.z, rot.w);
    sprayF.set(1, 0, 0).applyQuaternion(sprayQ);
    if (st.cd <= 0 && ship.bowSpray.wet) {
      const b = ship.bowSpray;
      const strength = Math.min(0.5 + spd * 0.12, 2.4) * TUN.spray.bow;
      // emit from JUST BENEATH the surface so the spawn point is hidden under the water — the
      // sheet appears to erupt out of the sea, never from a visible dot floating above it.
      effects.bowWave(b.x, b.y - 0.25, b.z, sprayF.x, sprayF.z, strength);
      st.cd = 0.05; // ~20 Hz → a continuous sheet, not bursts
    }
    // per-voxel waterline fizz off the hull's edge columns (the whole hull line), speed-scaled.
    // More pronounced than r18.0 — the player wants to see water breaking all along the sides,
    // not just barely catch it. Also emitted from beneath the surface so it springs from the sea.
    if (st.fizzCd <= 0 && ship.waterlineN > 0) {
      const fizzStr = Math.min(spd * 0.08, 1.2) * TUN.spray.bow;
      if (fizzStr > 0.02) {
        const k = Math.min(11, ship.waterlineN);
        for (let i = 0; i < k; i++) {
          const idx = ((Math.random() * ship.waterlineN) | 0) * 3;
          effects.waterlineFizz(
            ship.waterline[idx],
            ship.waterline[idx + 1] - 0.12,
            ship.waterline[idx + 2],
            fizzStr,
          );
        }
      }
      st.fizzCd = 0.07;
    }
  };

  // r16: the ambient open-water crest spray was REMOVED. It probed a ring around
  // the CAMERA every frame and threw plumes at any tall swell crest — those were the
  // "random white particle bursts a few ship-lengths away, appearing/disappearing at
  // random". The player wants ONLY bow spray (checkBowSpray) + the wake. crestSpray()
  // is left in effects.ts/spray.ts, dormant, for a future deliberate re-implementation.

  // r15 DEV PANEL: live knobs for the sea + boat feel the player asked to tune
  // themselves. Backtick (`) toggles it; sliders write straight into TUN, which
  // physics + render read every step. A reload resets (TUN is not persisted).
  const devPanel = createDevPanel([
    {
      // r17: pitch/roll/trim/keel-depth/heel-cap/turn-bank are GONE — attitude is now
      // emergent from the voxels. What's left are the four real physical coefficients.
      title: "Hull physics",
      controls: [
        { type: "slider", label: "lift ×", obj: TUN.phys, key: "buoyancy", min: 0.5, max: 2, step: 0.05 },
        { type: "slider", label: "heave ζ", obj: TUN.phys, key: "heaveDamp", min: 0.05, max: 1.2, step: 0.05 },
        { type: "slider", label: "leeway grip", obj: TUN.phys, key: "lateralDrag", min: 0.5, max: 3, step: 0.1 },
        { type: "slider", label: "yaw damp", obj: TUN.phys, key: "yawDamp", min: 0, max: 2, step: 0.05 },
      ],
    },
    {
      title: "Waves / Chop",
      controls: [
        { type: "slider", label: "chop", obj: TUN.chop, key: "strength", min: 0, max: 2, step: 0.05 },
        { type: "slider", label: "choppiness", obj: TUN.chop, key: "choppiness", min: 0, max: 2, step: 0.05 },
      ],
    },
    {
      title: "Dynamic Waves (wake)",
      controls: [
        { type: "toggle", label: "enabled", obj: TUN.dyn, key: "enabled" },
        { type: "slider", label: "height", obj: TUN.dyn, key: "heightScale", min: 0, max: 1.5, step: 0.05 },
        { type: "slider", label: "inject", obj: TUN.dyn, key: "inject", min: 0, max: 2, step: 0.05 },
        { type: "slider", label: "damping", obj: TUN.dyn, key: "damping", min: 0.2, max: 4, step: 0.1 },
        { type: "slider", label: "foam", obj: TUN.dyn, key: "foam", min: 0, max: 2, step: 0.05 },
      ],
    },
    {
      title: "Spray",
      controls: [
        { type: "toggle", label: "enabled", obj: TUN.spray, key: "enabled" },
        { type: "slider", label: "bow", obj: TUN.spray, key: "bow", min: 0, max: 2, step: 0.05 },
      ],
    },
  ]);
  const _roQ = new THREE.Quaternion();
  const _roF = new THREE.Vector3();
  const _roR = new THREE.Vector3();
  const updateDevReadout = () => {
    if (!devPanel.open) return;
    const rot = sloop.body.rotation();
    _roQ.set(rot.x, rot.y, rot.z, rot.w);
    _roF.set(1, 0, 0).applyQuaternion(_roQ);
    _roR.set(0, 0, 1).applyQuaternion(_roQ);
    const pitchDeg = (Math.asin(Math.min(Math.max(_roF.y, -1), 1)) * 180) / Math.PI;
    const heelDeg = (Math.asin(Math.min(Math.max(_roR.y, -1), 1)) * 180) / Math.PI;
    const v = sloop.body.linvel();
    const kn = Math.hypot(v.x, v.z) * 1.94384;
    devPanel.setReadout(
      `pitch ${pitchDeg >= 0 ? "+" : ""}${pitchDeg.toFixed(1)}°  heel ${heelDeg >= 0 ? "+" : ""}${heelDeg.toFixed(1)}°\n` +
        `submerged ${(sloop.submergedFrac * 100).toFixed(0)}%  waterlog ${(sloop.waterlog * 100).toFixed(0)}%\n` +
        `speed ${kn.toFixed(1)} kn`,
    );
  };

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    world.step(dt);
    feedWake(0, sloop);
    feedWake(1, enemy);
    checkBowSpray(0, sloop, dt);
    checkBowSpray(1, enemy, dt);
    effects.update(dt, world.simTime);
    // helm pose rides on top of the final mixer state, once per frame —
    // re-posing per fixed step stacked offsets ("arm absolutely spasming")
    boarding.player?.postPose();
    const bearNow = aimBearing();
    // r18: traverse must be SCREEN-RELATIVE for EVERY battery (mouse-right swings the muzzle
    // to screen-right), not just the broadside. With aimBearing's look dirs, screenRight =
    // cross(look,up): a broadside bears out ±z so aimSideSign = the side (±1, as before); a
    // fore chaser (look +x) has screenRight +z so it needs aimSideSign −1, an aft chaser
    // (look −x) has screenRight −z so it needs +1. The old hardcoded 1 left the BOW gun
    // inverted. (Signs derived against the real barrelDirLocal+input map and checked by
    // re-deriving the known-good broadside ±1 — see the aim-sign oracle.)
    controls.aimSideSign = bearNow === "fore" ? -1 : bearNow === "aft" ? 1 : bearNow;
    updateAimArc();
    sloopVisual.animate(
      world.simTime,
      sailing.rudder,
      sailing.sailSet,
      controls.aiming
        ? { bearing: aimBearing(), elevationDeg: controls.elevationDeg, traverseDeg: controls.traverseDeg }
        : null,
    );
    enemyVisual.animate(world.simTime, captain.sailing.rudder, captain.sailing.sailSet);

    const tr = sloop.body.translation();
    const sd = skySetup.sunDir;
    if (firstPerson && boarding.player) {
      // eye-level camera — at the model's eye line, not its collar
      // (playtest round 5: "really only shows the inside of the uniform")
      const pt = boarding.player.body.translation();
      // r18.1: seat the eye at the true eye line (the old 0.95 sat at the crown, which pushed the
      // body-attached arm + cutlass off the bottom of the frame). Lower brings the weapon into the
      // forward view; the head bone is collapsed in FP so the camera isn't inside any mesh.
      const eyeY = pt.y + (boarding.player.rig ? 0.74 : 0.95);
      const yaw = controls.cameraYaw();
      const pitch = controls.lookPitch();
      boarding.player.fpLookPitch = pitch; // carry pose lifts with the view (stays in frame)
      // r18.1: feed the look yaw — crew.syncMesh faces the body to THIS (not the run direction) in
      // FP, so the arm/cutlass hold their screen spot when you strafe instead of clipping in.
      boarding.player.fpLookYaw = yaw;
      const lookX = Math.cos(yaw) * Math.cos(pitch);
      const lookZ = Math.sin(yaw) * Math.cos(pitch);
      // r18.1: with the REAL arm shown, seat the eye slightly BEHIND the shoulder so the right
      // arm extends FORWARD into frame (the shoulder sits ~at the capsule centre; without the
      // pull-back the short arm hangs beside the lens and never reaches the view). The head is
      // collapsed in FP so there's no mesh to clip into back here.
      const back = boarding.player.rig ? 0.42 : 0;
      camera.position.set(pt.x - lookX * back, eyeY, pt.z - lookZ * back);
      camera.lookAt(camera.position.x + lookX, eyeY + Math.sin(pitch), camera.position.z + lookZ);
      // viewmodel: the procedural stand-in arm shows ONLY when there's no rigged model — the
      // rigged pirate now carries its REAL right arm + cutlass in first person (r18.1).
      viewModel.visible = !boarding.player.rig;
      const swingT = boarding.player.attackTimer ?? 0;
      const swingP = swingT > 0 ? Math.sin((1 - swingT / 0.7) * Math.PI) : 0;
      vmBob += dt * 3.2;
      const bob = Math.sin(vmBob) * 0.01;
      vmOffset.set(0.28, -0.4 + bob, -0.62).applyQuaternion(camera.quaternion);
      viewModel.position.copy(camera.position).add(vmOffset);
      viewModel.quaternion.copy(camera.quaternion);
      // a diagonal cutlass slash: the blade sweeps down-and-across the view (more roll +
      // yaw than the old straight chop) with a little follow-through, then recovers.
      vmArm.rotation.set(-0.12 - swingP * 1.7, 0.28 + swingP * 0.55, 0.78 - swingP * 0.95);
    } else {
      viewModel.visible = false;
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

    oceanField.update(world.simTime);
    // P5/r15: advance the dynamic-wave interaction field (off-screen GPU passes),
    // now under the dev knobs, and bind its texture + snapped window/origin to the
    // ocean BEFORE the main render. Always drain spray landings (so the queue can't
    // grow unbounded) but only stamp them as foam when foam is dialed up. When the
    // field is disabled we still tick it (empty ships → it decays to rest) and the
    // ocean simply ignores it (on=false) for a perfectly clean cascade sea.
    dynWaves.setTunables(TUN.dyn.damping, TUN.dyn.inject, TUN.dyn.foam);
    const dynLandings = spray.drainLandings();
    dynWaves.update(
      dt,
      camera.position,
      TUN.dyn.enabled ? buildDynShips() : [],
      TUN.dyn.foam > 0 ? dynLandings : undefined,
    );
    ocean.setDynamicField(
      dynWaves.texture,
      dynWaves.window,
      dynWaves.origin.x,
      dynWaves.origin.y,
      dynWaves.active && TUN.dyn.enabled,
      TUN.dyn.heightScale,
    );
    ocean.setChop(TUN.chop.strength, TUN.chop.choppiness);
    ocean.update(world.simTime, camera.position);
    renderer.autoClear = true;
    renderer.clear(); // clears color + depth + stencil
    renderer.autoClear = false;
    seam.write(renderer, scene, camera); // hull → stencil (no color/depth)
    renderer.render(scene, camera);      // full scene incl. ocean, stencil-tested
    renderer.autoClear = true;

    updateHud(dt, tr);
    updateDevReadout();
  });
}

main();
