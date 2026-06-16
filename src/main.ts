import * as THREE from "three";
import { Rng } from "./core/rng";
import { makeWaves, surfaceHeight } from "./sim/gerstner";
import { createOcean } from "./render/ocean";
import { SeamMask } from "./render/seamMask";
import { Post } from "./render/post";
import { createOceanField } from "./render/oceanField";
import { createDynamicWaves, type DynShip } from "./render/dynamicWaves";
import { buildHullProfile } from "./sim/buoyancy";
import { createSky, HORIZON_COLOR } from "./render/sky";
import { CloudDome } from "./render/clouds";
import { islandGritUniforms } from "./render/islandVisual";
import { buildCutter, buildSloop, type ShipBuild } from "./sim/shipwright";
import { tierById, SHIP_TIERS } from "./game/shipyard";
import { pickEnemyTier } from "./sim/fleetSpawn";
import { ShipVisual } from "./render/shipVisual";
import { initPhysics } from "./game/physics";
import { Ship } from "./game/ship";
import { GameWorld } from "./game/world";
import { SailingController, type Wind } from "./game/sailing";
import { PlayerControls } from "./game/player";
import { AICaptain } from "./game/ai";
import { FleetManager, type EnemyUnit } from "./game/fleet";
import { MAXVIS } from "./core/constants";
import { GameState } from "./game/gameState";
import { PlayerCharacter } from "./game/playerCharacter";
import {
  SaveManager,
  defaultSave,
  defaultSettings,
  SAVE_VERSION,
  type SaveState,
  type Settings,
  type ShipTierId,
} from "./game/saveState";
import { Cannons } from "./game/cannons";
import { muzzleWorld } from "./game/gunnery";
import { FIXED_DT, G, VOXEL_SIZE } from "./core/constants";
import { CharacterSpike } from "./game/character";
import { characterPack } from "./game/characterPack";
import { DebrisManager } from "./game/debris";
import { Effects } from "./render/effects";
import { createSpray } from "./render/spray";
import { TUN } from "./core/tunables";
import { createDevPanel } from "./render/devPanel";
import { Economy } from "./sim/economy";
import { createPortScreen } from "./render/portScreen";
import { PortController } from "./game/port";
import { createMenuScreen, type SandboxConfig } from "./render/menuScreen";
import { PerfMonitor } from "./render/perf";

async function main() {
  // THROWAWAY (plan Task 0): ?spike=1 runs the voxel-collider perf gate and bails.
  if (new URLSearchParams(location.search).has("spike")) {
    const { runVoxelSpike } = await import("./dev/voxelSpike");
    await runVoxelSpike();
    return;
  }
  const app = document.getElementById("app")!;
  // powerPreference:"high-performance" is the SINGLE most important fix for the
  // "5 fps one launch, smooth the next" swing: without it the browser may hand the
  // tab the weak INTEGRATED GPU (laptops switch by power state) or, after a GPU-process
  // hiccup, sit on SOFTWARE rendering. This strongly requests the discrete GPU; the
  // caveat flag stops the browser from silently refusing a context on a marginal one.
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
    failIfMajorPerformanceCaveat: false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // ACES exposure — live from TUN.gfx.tone.exposure (set again each frame in the
  // render loop so the dev-panel slider is live). <1 calms an over-bright sky/sun
  // without touching the individual effects; the hemisphere fill keeps shade out of the void.
  renderer.toneMappingExposure = TUN.gfx.tone.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  app.appendChild(renderer.domElement);

  // perf watchdog: logs the real GPU, warns if we're on SOFTWARE rendering (the usual
  // cause of the 5-fps launches), shows a small fps/ms HUD, and runs the adaptive-quality
  // governor (TUN.gfx.auto) so the frame can't silently park at single digits.
  const perf = new PerfMonitor(renderer);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 5000);

  // ---- game shell: built BEFORE the world so the menu shows on a clean screen ----
  // The heavy world (sky / ocean FFT / physics / ship / islands / fleet) is built only
  // AFTER the player picks a mode: main() awaits the choice below, so nothing loads or
  // renders behind the menu. (Old behaviour: the whole world was built up front and the
  // menu floated as a translucent overlay over a frozen game.)
  const gs = new GameState();
  const saves = new SaveManager(localStorage);
  // menu-facing state, hoisted here so the sandbox-config defaults can read currentTier
  // at click time; the world build + save/restore below read & write these same bindings.
  let currentTier: ShipTierId = "cutter";
  let unlockedClasses: ShipTierId[] = ["cutter"];
  let settings: Settings = defaultSettings();
  let forcedEnemyTier: ShipTierId | null = null;

  type StartChoice =
    | { kind: "career"; fresh: boolean }
    | { kind: "sandbox"; cfg: SandboxConfig };
  let resolveChoice!: (c: StartChoice) => void;
  const choicePromise = new Promise<StartChoice>((res) => {
    resolveChoice = res;
  });
  // false until the world is built. The FIRST Start resolves the await-gate (triggering the
  // build); later Starts (after Quit-to-Menu — world already built) re-apply directly.
  let worldReady = false;
  const start = (c: StartChoice) => {
    if (worldReady) applyChoice(c);
    else resolveChoice(c);
  };

  // Start buttons dispatch through start(); Resume/Quit fire only in-game, so they may close
  // over saveCurrent/applyChoice defined further down.
  const menu = createMenuScreen({
    onNewCareer: () => start({ kind: "career", fresh: true }),
    onContinue: () => start({ kind: "career", fresh: false }),
    onSandbox: () =>
      menu.showSandboxConfig({
        tiers: SHIP_TIERS.map((t) => ({ id: t.id, name: t.name })),
        maxEnemies: MAXVIS,
        defaults: { shipTier: currentTier, enemyCount: Math.round(TUN.fleet.enemyCount), enemyTier: "mixed" },
        onBack: () => menu.showStart(saves.hasSave("career")),
        onStart: (cfg: SandboxConfig) => start({ kind: "sandbox", cfg }),
      }),
    onResume: () => {
      gs.resume();
      menu.hide();
    },
    onQuitToMenu: () => {
      saveCurrent();
      gs.quitToMenu();
      document.body.classList.add("menu-active"); // hide the game HUD behind the menu
      menu.showStart(saves.hasSave("career"));
    },
  });

  // a clean dark screen behind the DOM menu while we wait for the player to choose
  renderer.setClearColor(0x05080a, 1);
  renderer.setAnimationLoop(() => {
    renderer.setRenderTarget(null);
    renderer.clear();
  });
  menu.showStart(saves.hasSave("career"));

  // BLOCK here until the player picks a mode — only then does the world build below run.
  const startChoice = await choicePromise;
  menu.hide();
  // a brief loading screen while the (main-thread-blocking) world build runs; paint it first.
  const loadingEl = document.createElement("div");
  loadingEl.textContent = "Setting sail…";
  Object.assign(loadingEl.style, {
    position: "fixed",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#05080a",
    color: "#d8c9a3",
    font: "italic 600 22px Georgia, serif",
    letterSpacing: "0.08em",
    zIndex: "10005",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(loadingEl);
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  const seed = new URLSearchParams(location.search).get("seed") ?? "scuttle-dev";
  const rng = new Rng(seed);
  // 16-wave directional spectrum (round 8: four waves read as "the same
  // series of waves repeating over and over"); physics rides the swell subset
  const waves = makeWaves(rng, 16);

  // Background scene: the sky dome + cloud dome render FIRST as a flat backdrop
  // (render/post.ts), then depth is cleared and the main scene draws over them, so
  // the ship/ocean/islands occlude the clouds without a depth fight against the sky.
  const bgScene = new THREE.Scene();

  const skySetup = createSky();
  skySetup.addTo(scene, bgScene); // lights → main scene, sky → bg scene
  // image-based skylight: PBR materials get ambient from the actual sky dome
  // (round 8: shade must read as shade, not a void)
  skySetup.bakeEnvironment(renderer, scene, bgScene);

  // procedural drifting clouds over the atmospheric sky; also rendered into the
  // sky env cube (skySetup.updateEnv) so the sea reflects them. Follows the camera.
  const clouds = new CloudDome(skySetup.sunDir, skySetup.sunColor);
  bgScene.add(clouds.mesh);
  // throttled re-bake of the sky+cloud reflection cube (clouds drift slowly)
  let lastEnvBake = -1;
  // throttle the two heaviest steady GPU items after post: the FFT-ocean spectral evolution to
  // ~30 Hz (it advances from absolute simTime, so a larger step never drifts) and the shadow-map
  // depth pass to ~15 Hz. The displacement RTs + the shadow map persist between updates, and the
  // live analytic swell (ocean.update, every frame) keeps the big waves perfectly smooth.
  let lastOceanFftUpdate = -1;
  let shadowAccum = 0;
  skySetup.follow(camera.position); // centre the dome on the camera before the first bake
  skySetup.updateEnv(renderer, bgScene, camera.position); // initial bake

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
  ocean.setSkyEnv(skySetup.envCube.texture); // mirror the live sky+cloud cube
  ocean.setFogColor(HORIZON_COLOR); // far sea fades to the sky's horizon band → one seamless horizon
  scene.add(ocean.mesh);

  const physics = await initPhysics();
  // rigged character pack — loaded up front so every Pirate can be built
  // synchronously. Default is the Bugrimov semi-realistic pirate; ?char=q the
  // Quaternius captain, ?char=kk the KayKit rogue. Whichever is chosen falls
  // back to Quaternius if it fails to load.
  let charOk = false;
  const charPack = characterPack();
  if (charPack === "kaykit") {
    const { loadKayKitLibrary } = await import("./render/kaykitModel");
    charOk = await loadKayKitLibrary();
  } else if (charPack === "bugrimov") {
    const { loadBugrimovLibrary } = await import("./render/bugrimovModel");
    charOk = await loadBugrimovLibrary();
  } else if (charPack === "universal") {
    const { loadUniversalLibrary } = await import("./render/universalModel");
    charOk = await loadUniversalLibrary();
  }
  if (!charOk) {
    const { loadPirateLibrary } = await import("./render/pirateModel");
    await loadPirateLibrary();
  }
  const world = new GameWorld(physics, waves, scene);

  // the player's brig splashes down and settles (round 6: "a realistically
  // sized sixteen-hundreds-era fighting vessel"); `sloop` names the player
  // ship throughout for history's sake
  // the player starts in the CUTTER — the cheap starter; bigger tiers are bought at
  // the shipyard. `sloop`/`sloopVisual` stay mutable so a hull swap can reassign them.
  const sloopBuild = buildCutter();
  let sloopVisual = new ShipVisual(sloopBuild);
  let sloop = new Ship(physics, sloopBuild, sloopVisual, { x: -9, y: 0.4, z: -3 });
  world.addShip(sloop);
  // the on-foot captain (deck-walk / kick / first-third person). He spends most of
  // his time at the wheel; the old boarding system (grapple/crew/chest) is gone.
  const character = new PlayerCharacter(physics, scene, sloop);
  // the cutaway hole in the sea matches the player hull's footprint
  ocean.setFootprint(sloopBuild.lengthM / 2 + 1.2, sloopBuild.beamM / 2 + 1.0);

  // ---- static voxel archipelago (game/islandField.ts) ----
  // seeded islands & cliffs with solid collision; one harbor island carries the
  // voxel dock + town. Built once, never remeshed; islands aren't in any ship
  // list so they never trip the ship-vs-ship destruction code.
  const { IslandField } = await import("./game/islandField");
  const islands = new IslandField(seed, physics, scene);
  // feed the archipelago's land-height field to the ocean so the sea SHOALS at each coast —
  // waves taper to flat where the seabed rises to the beach, instead of clipping through the
  // island, plus a surf-foam line at the waterline. Baked once; visual only (physics unaffected).
  {
    const lf = islands.buildLandField();
    if (lf) ocean.setLandField(lf.tex, lf.minX, lf.minZ, lf.sizeX, lf.sizeZ);
  }

  // dev/playtest convenience: ?at=harbor drops you in clear water just seaward of
  // the town dock, so you can look the island over without the opening sail out to
  // it. The dock anchor faces +x (bearing 0), so seaward is +x; spawn well clear of
  // the submerged shoal so the hull doesn't start inside the collider.
  if (new URLSearchParams(location.search).get("at") === "harbor") {
    const tr = sloop.body.translation();
    const dock = islands.nearestDock(tr.x, tr.z);
    if (dock) {
      sloop.body.setTranslation({ x: dock.x + 54, y: 0.5, z: dock.z }, true);
      sloop.body.setRotation({ x: 0, y: 1, z: 0, w: 0 }, true); // bow toward the town (-x)
      sloop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      sloop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

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
    return { tex, sizeX: prof.sizeX, sizeZ: prof.sizeZ, data: prof.data, nx: prof.nx, nz: prof.nz };
  };
  let sloopProfile = makeProfileTex(sloop.build.grid);
  ocean.setHullProfile(0, sloopProfile.data, sloopProfile.nx, sloopProfile.nz, sloopProfile.sizeX, sloopProfile.sizeZ);
  // Per-ship voxel sea-cut bookkeeping: which ship currently occupies each ocean slot (so a slot's
  // atlas band is re-stamped only when its ship changes) + a per-hull cache of the built profile.
  const slotShip: (Ship | null)[] = new Array(MAXVIS).fill(null);
  slotShip[0] = sloop;
  const profileCache = new WeakMap<Ship, ReturnType<typeof buildHullProfile>>();

  // the hostile fleet is set up below (it needs effects/cannons/debris);
  // ocean slot 1's shared enemy profile is bound there too.

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

  // stencil seam mask: each frame, paint every hull AND island silhouette into
  // the stencil buffer before the ocean draws; the ocean's NotEqual stencil test
  // then rejects those pixels (no sea on the deck, in the hold, the bow void — and
  // no wave-crests poking up through the shoreline: an island is a solid mass to
  // the sea, exactly like a hull). Islands are static, so capture their groups once.
  const islandHulls = islands.islands.map((i) => i.visual.group);
  const seam = new SeamMask([sloop.visual.group, ...islandHulls]); // hull+island list refreshed each frame from the fleet

  // post-processing spine (bloom now; god rays + grade added in later tasks). It
  // owns the stencil seam-mask dance internally (see render/post.ts ScenePass), so
  // the ocean still never lands on the deck. Gated by TUN.gfx.post.enabled.
  const post = new Post(renderer, bgScene, scene, camera, seam);
  // reused each frame to project the sun to screen space for the god-ray pass
  const _sunWorld = new THREE.Vector3();
  const _sunView = new THREE.Vector3();

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
  const debris = new DebrisManager(physics, scene, effects);
  sloop.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, sloop));

  // ---- the hostile fleet (game/fleet.ts) ----
  // Each enemy now gets its OWN voxel sea-cut profile, stamped into its ocean slot's atlas band when
  // it is assigned (see feedProfiled) — no more shared-sloop approximation. This sloop profile is
  // kept only for the dynamic-wave field's enemy slot below.
  const enemyProfile = makeProfileTex(buildSloop().grid);
  // which tier each live enemy is (for unlock-on-defeat). WeakMap so culled ships GC.
  const enemyTier = new WeakMap<Ship, ShipTierId>();

  const spawnEnemy = (): EnemyUnit => {
    // notoriety- and player-tier-scaled tier pick: small prey early, bigger hulls later.
    // Sandbox can FORCE a specific enemy tier (forcedEnemyTier); null = the scaled spread.
    const tierId = forcedEnemyTier ?? pickEnemyTier(economy.state.notoriety, currentTier, Math.random);
    const build = tierById(tierId).build();
    const visual = new ShipVisual(build);
    // fan upwind around the player so multiple hulls don't stack (the old single
    // enemy spawned dead upwind at 85 m, bow turned toward you — generalized here).
    const ang = (Math.random() - 0.5) * Math.PI * 1.2;
    const dist = 85 + Math.random() * 45;
    const dx = waves[0].dirX;
    const dz = waves[0].dirZ;
    const ox = dx * Math.cos(ang) - dz * Math.sin(ang);
    const oz = dx * Math.sin(ang) + dz * Math.cos(ang);
    const pc = sloop.body.translation();
    const ship = new Ship(physics, build, visual, { x: pc.x - ox * dist, y: 0.2, z: pc.z - oz * dist }, false); // enemy → no walkable deck collider
    const etr = ship.body.translation();
    const ea = -Math.atan2(pc.z - etr.z, pc.x - etr.x);
    ship.body.setRotation({ x: 0, y: Math.sin(ea / 2), z: 0, w: Math.cos(ea / 2) }, true);
    ship.onSevered = (islands) => islands.forEach((i) => debris.spawn(i, ship));
    ship.onMastFelled = () => gs.msg.post("her mast goes by the board!");
    ship.onRudderHit = (hp) => {
      visual.chipRudder(hp / 3);
      gs.msg.post(hp > 0 ? "her rudder is hit!" : "her rudder hangs in splinters!");
    };
    enemyTier.set(ship, tierId);
    const captain = new AICaptain(ship, scene, effects);
    return { ship, captain };
  };

  const fleet = new FleetManager({ world, target: sloop, spawn: spawnEnemy });
  let premiumSlot1: Ship | null = null; // which enemy holds premium ocean slot 1 (trail reset on swap)
  const salvaged = new WeakSet<Ship>(); // enemies that have paid salvage once
  let primaryEnemy: Ship | null = null; // nearest living enemy, for the HUD marker
  // (the fleet is seeded AFTER the economy + currentTier exist — the spawner reads them.)

  // ---- plunder economy (framework): wallet/cargo/upgrades + dock-triggered port + save ----
  // The wallet of record is gs.wallet (the HUD reads it); the port screen is a JS overlay.
  // The dock is the islands' real harbor: IslandField satisfies DockProvider, so "make port"
  // (press E within DOCK_RANGE) triggers at the town pier — not the DevDockProvider origin.
  const economy = new Economy();
  const portScreen = createPortScreen({
    onSell: () => port.sell(),
    onRepair: () => port.repair(),
    onBuy: (id) => port.buy(id),
    onBuyShip: (id) => port.buyShip(id),
    onClose: () => port.closePort(),
  });
  const port = new PortController({
    economy,
    ship: sloop,
    cannons,
    sailing,
    wallet: gs.wallet,
    msg: gs.msg,
    ui: portScreen,
    getPlayerPos: () => {
      const t = sloop.body.translation();
      return { x: t.x, z: t.z };
    },
    dock: islands, // IslandField.nearestDock → port triggers at the real harbor pier
    onEnter: () => {
      gs.enterPort(); // freeze the world while the port screen is up
      saveCurrent(); // making port banks your progress
    },
    onLeave: () => gs.leavePort(),
    // sandbox unlocks everything so the whole ladder is buyable for free play
    getShipState: () => ({
      unlocked: gs.isSandbox() ? (["cutter", "sloop", "brig", "frigate"] as ShipTierId[]) : unlockedClasses,
      current: currentTier,
    }),
    onSwapShip: (id) => swapPlayerShip(id),
  });

  // ---- game-shell save/restore (tier/unlocks/settings are hoisted to the top of main) ----
  const applySave = (s: SaveState) => {
    economy.state = s.economy;
    unlockedClasses = s.unlockedClasses.slice();
    settings = { ...s.settings };
    if (s.shipTier !== currentTier) {
      swapPlayerShip(s.shipTier); // rebuild the saved hull (also sets currentTier + re-applies upgrades)
    } else {
      port.syncAfterLoad(); // same hull → just re-apply owned upgrades + mirror gold
    }
  };
  const saveCurrent = () => {
    saves.save(gs.mode, {
      version: SAVE_VERSION,
      mode: gs.mode,
      economy: economy.state,
      shipTier: currentTier,
      unlockedClasses,
      settings,
    });
  };

  // (the start/pause menu is created at the top of main(); the player's choice was
  // awaited there and is applied just below, once the world is fully built.)

  // ---- hull swap (shipyard purchase / save restore / respawn) ----
  // Rebuild the player ship as a fresh hull, keeping world position/heading, and
  // re-point every system that holds a player-ship reference. (function decls so the
  // port/menu closures above can call them; only ever invoked at runtime.)
  function swapPlayerShip(tierId: ShipTierId): void {
    currentTier = tierId;
    rebuildPlayerShip(tierById(tierId).build());
    port.syncAfterLoad(); // account-wide upgrades land on the new hull
  }
  function rebuildPlayerShip(build: ShipBuild): void {
    const at = sloop.body.translation();
    const rot = sloop.body.rotation();
    world.removeShip(sloop); // scene + geometry + rigid-body cleanup
    const visual = new ShipVisual(build);
    const fresh = new Ship(physics, build, visual, { x: at.x, y: Math.max(at.y, 0.5), z: at.z });
    fresh.body.setRotation(rot, true);
    fresh.onSevered = (isl) => isl.forEach((i) => debris.spawn(i, fresh));
    fresh.onMastFelled = () => gs.msg.post("YOUR MAST GOES BY THE BOARD!");
    fresh.onRudderHit = (hp) => {
      visual.chipRudder(hp / 3);
      gs.msg.post(hp > 0 ? "rudder hit — she answers slow!" : "RUDDER SHOT AWAY!");
    };
    world.addShip(fresh);
    sloop = fresh;
    sloopVisual = visual;
    port.setShip(fresh);
    fleet.setTarget(fresh);
    character.setShip(fresh);
    rebindPlayerRenderHooks();
  }
  function rebindPlayerRenderHooks(): void {
    sloopProfile = makeProfileTex(sloop.build.grid);
    ocean.setHullProfile(0, sloopProfile.data, sloopProfile.nx, sloopProfile.nz, sloopProfile.sizeX, sloopProfile.sizeZ);
    ocean.setFootprint(sloop.build.lengthM / 2 + 1.2, sloop.build.beamM / 2 + 1.0);
    slotShip[0] = sloop; // the swapped-in hull now occupies slot 0 (profile re-stamped just above)
    _dynShips[0].profileTex = sloopProfile.tex;
    _dynShips[0].sizeX = sloopProfile.sizeX;
    _dynShips[0].sizeZ = sloopProfile.sizeZ;
  }
  // Respawn a fresh hull of the current tier in clear water just seaward of the home
  // dock, and re-seat the captain at the wheel. (Used by the sink penalty.)
  function respawnPlayerAtPort(): void {
    rebuildPlayerShip(tierById(currentTier).build());
    const tr = sloop.body.translation();
    const dock = islands.nearestDock(tr.x, tr.z);
    if (dock) {
      sloop.body.setTranslation({ x: dock.x + 54, y: 0.6, z: dock.z }, true);
      sloop.body.setRotation({ x: 0, y: 1, z: 0, w: 0 }, true); // bow toward the town
    }
    sloop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    sloop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    port.syncAfterLoad();
    character.reseat();
    atWheel = true; // back at the helm
  }

  // rig damage feedback (round 7): masts fall, rudders splinter. The enemy
  // equivalents are wired per-spawn in the fleet factory above.
  sloop.onMastFelled = () => gs.msg.post("YOUR MAST GOES BY THE BOARD!");
  sloop.onRudderHit = (hp) => {
    sloopVisual.chipRudder(hp / 3);
    gs.msg.post(hp > 0 ? "rudder hit — she answers slow!" : "RUDDER SHOT AWAY!");
  };

  // hull-on-hull: meeting with way on carves voxels out of BOTH ships at the
  // contact point. No toast, no scripted "ramming event" — it's just timber
  // coming off where two hulls grind together (round 9: "voxel based and
  // dynamic … we don't really need any mechanical logic or an alert"). The
  // deformable ship-vs-ship crunch lives in world.contact (game/voxelContact.ts),
  // driven each fixed step inside world.step — give it the effects sink so carved
  // voxels throw pulverization dust at the contact.
  world.contact.effects = effects;
  // helm model (playtest round 2): you ARE a pirate on deck at all times.
  // Steering only happens at the wheel (E to take/leave it). V cycles the view:
  // character 3rd-person (default) → character 1st-person → bird's-eye ship orbit.
  let atWheel = true;
  let onFoot = false; // derived each step: !atWheel
  // 0 = character 3rd-person, 1 = character 1st-person, 2 = ship orbit. firstPerson
  // (mode 1) is derived so the rest of the loop's checks stay simple.
  let camMode: 0 | 1 | 2 = 0;
  let firstPerson = false;
  const wheelWorld = new THREE.Vector3();
  const ladderWorld = new THREE.Vector3();
  const climbTarget = new THREE.Vector3();
  let ladderHinted = false;
  // r17: the "LOST AT SEA" / "PRIZE TAKEN" end-game was removed entirely. A sinking ship
  // — yours or the prize — no longer freezes the game or demands a reload; the voyage
  // just continues. Only the non-terminal man-overboard + enemy-salvage states remain.
  let manOverboard = false;
  let respawning = false; // guards the one-shot sink → respawn handoff
  let plugChannel = 0; // seconds remaining on the current plank repair

  const isSunk = (s: Ship) =>
    s.body.translation().y < -12 ||
    s.build.compartments.every((c) => c.waterVolume / c.volume > 0.95);

  world.onFixedStep = (t, dt) => {
    controls.modePressed = false; // legacy T — the wheel gates the helm now
    controls.grapplePressed = false; // legacy G — boarding removed; consume so it can't queue
    port.update(dt); // dock proximity → canDock + "press E — make port" hint

    // wheel + ladder positions in world (for E proximity)
    sloop.localToWorld(sloopVisual.wheelLocal, wheelWorld);
    sloop.localToWorld(sloopVisual.ladderLocal, ladderWorld);

    // swimming near the stern ladder? surface the hint
    if (character.player && character.player.swimming) {
      const pp = character.player.body.translation();
      const nearLadder =
        Math.hypot(pp.x - ladderWorld.x, pp.y - ladderWorld.y, pp.z - ladderWorld.z) < 3.4;
      if (nearLadder && !ladderHinted) {
        gs.msg.post("press E — stern ladder");
        ladderHinted = true;
      } else if (!nearLadder) {
        ladderHinted = false;
      }
    }

    // E: take/leave the wheel when close to it; climb the stern ladder when
    // swimming beside it; otherwise make port if at a dock.
    if (controls.interactPressed) {
      controls.interactPressed = false;
      if (atWheel) {
        atWheel = false;
        // sails and rudder HOLD as set — leaving the helm changes nothing
        // (playtest round 5); the ship-frame carry keeps deck walking safe
        gs.msg.post("you leave the wheel — she holds her course");
      } else if (character.player) {
        const pp = character.player.body.translation();
        if (Math.hypot(pp.x - wheelWorld.x, pp.y - wheelWorld.y, pp.z - wheelWorld.z) < 2.4) {
          atWheel = true;
          gs.msg.post("you take the wheel");
        } else if (
          character.player.swimming &&
          Math.hypot(pp.x - ladderWorld.x, pp.y - ladderWorld.y, pp.z - ladderWorld.z) < 3.4
        ) {
          character.player.ship = sloop;
          character.player.teleport(
            sloop.localToWorld(
              [2.6, (sloop.build.deckYAt(10) + 1) * 0.25 + 1.05, sloop.build.footprint.zC],
              climbTarget,
            ),
          );
          gs.msg.post("you haul yourself up the stern ladder");
        } else if (port.canDock) {
          port.tryDock(); // make port — opens the economy screen, banks progress
        }
      }
    }
    onFoot = !atWheel;

    if (atWheel) controls.updateSailing(sailing, dt);
    // man overboard! the crew drops the sheets — throttle goes straight to ZERO
    // so she loses way and waits while you swim for the stern ladder. (r18: the
    // old gradual sail-back read as a "lost at sea" mechanic; the player wants a
    // hard cut to 0 throttle the instant you go over the side.)
    if (character.player && character.player.swimming) {
      sailing.sailSet = 0;
      if (!manOverboard) {
        manOverboard = true;
        gs.msg.post("MAN OVERBOARD — sails dropped, she loses way!");
      }
    } else {
      manOverboard = false;
    }
    sailing.apply(sloop, wind);
    fleet.updateAI(dt, t, waves, wind);
    fleet.reconcile();

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
        slash = true; // a cutlass flourish on deck — nothing to fight anymore
      }
    }
    let kick = false;
    if (controls.kickPressed) {
      controls.kickPressed = false;
      kick = onFoot;
    }
    character.update(
      dt,
      t,
      waves,
      { moveX: mv.x, moveZ: mv.z, jump: mv.jump, sprint: mv.sprint, slash, kick },
      onFoot,
    );

    // pin the captain to the wheel while steering
    if (atWheel && character.player) {
      const rot2 = sloop.body.rotation();
      const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(
        new THREE.Quaternion(rot2.x, rot2.y, rot2.z, rot2.w),
      );
      const stand = wheelWorld.clone();
      stand.x -= fwd.x * 0.45; // close enough to put both hands on the rim
      stand.z -= fwd.z * 0.45;
      stand.y -= 0.2; // feet on the deck, not levitating at hub height
      character.player.pin(stand, Math.atan2(fwd.z, fwd.x), sailing.rudder);
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

    cannons.update(dt, t, waves, fleet.enemies);
    // ship-vs-ship destruction now runs inside world.step (world.contact.stepAll), not here.
    debris.update(dt, t, waves);
    charSpike?.update(dt, controls.cameraYaw());

    // enemy sunk → plunder + unlock that class for the shipyard (proving your guns
    // against a tier is what lets you buy one).
    for (const e of fleet.enemies) {
      if (isSunk(e) && !salvaged.has(e)) {
        salvaged.add(e);
        port.plunder(e); // loot → economy → mirrors gs.wallet + toast
        const tid = enemyTier.get(e);
        if (tid && !unlockedClasses.includes(tid)) {
          unlockedClasses.push(tid);
          gs.msg.post(`You've bested a ${tierById(tid).name} — the shipyard will sell you one now.`);
        }
      }
    }

    // player sunk → respawn. Career: lose the cargo + a quarter of the gold; the ship
    // tier, upgrades, unlocks and banked notoriety survive. Sandbox: a free fresh hull.
    if (isSunk(sloop) && !respawning) {
      respawning = true;
      if (gs.mode === "career") {
        economy.state.cargo = {};
        economy.state.doubloons = Math.floor(economy.state.doubloons * 0.75);
        gs.msg.post("YOUR SHIP IS LOST — you wash ashore at port; the hold and a quarter of your gold are gone.");
      } else {
        gs.msg.post("scuttled — a fresh hull awaits.");
      }
      respawnPlayerAtPort();
      saveCurrent();
      respawning = false;
    }
  };

  // character-on-deck spike (plan Task 13): ?spike=char, IJKL walk, U jump.
  // Spawns once the ship has settled from its splash-down.
  let charSpike: CharacterSpike | null = null;
  if (new URLSearchParams(location.search).get("spike") === "char") {
    const trySpawn = setInterval(() => {
      if (world.simTime > 6) {
        charSpike = new CharacterSpike(physics, scene, sloop);
        charSpike.respawn();
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
    post.setSize(w, h); // keep the composer's targets in lockstep with the canvas
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
      gs.msg.post("fullscreen not supported by this browser");
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
          gs.msg.post(`fullscreen refused: ${err.message} (already in F11?)`);
          console.warn("[fullscreen]", err);
        });
      }
    } catch (err) {
      gs.msg.post(`fullscreen error: ${(err as Error).message}`);
      console.warn("[fullscreen]", err);
    }
  };
  document.getElementById("fs-btn")?.addEventListener("click", toggleFullscreen);

  window.addEventListener("keydown", (e) => {
    if (e.repeat) return; // holding X must not strobe the cutaway (playtest)
    if (e.code === "Escape") {
      // Esc pauses mid-voyage and resumes from the pause screen. Ignored at the
      // title screen and while the port is open (close the port with its own button).
      if (gs.phase === "playing") {
        gs.pause();
        menu.showPause();
      } else if (gs.phase === "paused") {
        gs.resume();
        menu.hide();
      }
    }
    if (e.code === "KeyV" && character.player) {
      camMode = ((camMode + 1) % 3) as 0 | 1 | 2;
      firstPerson = camMode === 1;
      character.player.setFirstPerson(firstPerson);
      controls.syncFirstPerson(firstPerson);
      controls.charFollow = camMode === 0; // wheel zoom works the follow-cam in char 3rd-person
    }
    if (e.code === "KeyF") toggleFullscreen();
    if (e.code === "KeyX") {
      cutaway = !cutaway;
      for (const s of [sloop, ...fleet.enemies]) s.visual.setCutaway(cutaway ? cutPlane : null);
      ocean.setCutaway(cutaway);
      abyss.visible = cutaway;
    }
  });

  // dev console handle (also used by Playwright-driven verification)
  (window as unknown as Record<string, unknown>).DEBUG = {
    // getter: the player ship is reassigned on a hull swap, so expose it live
    get sloop() {
      return sloop;
    },
    get currentTier() {
      return currentTier;
    },
    fleet,
    world,
    cannons,
    character, // the on-foot captain (PlayerCharacter)
    gs, // game-shell state (mode/phase, wallet, msg)
    saves, // SaveManager (career/sandbox slots)
    controls,
    camera,
    sailing,
    contact: world.contact,
    debris,
    ocean, // ocean surface (setFogColor / setWaterDepth / setReflStrength) — live shader tuning
    sky: skySetup, // gradient dome (sky.material.uniforms uZenith/uHorizon/uSunColor) — live sky tuning
    oceanField,
    dynWaves,
    spray,
    islands,
    economy,
    port,
    perf, // PerfMonitor — DEBUG.perf.gpuInfo tells you GPU name + software flag
    TUN, // live tunables (also lets Playwright tune crush/flood knobs during verification)
    get spike() {
      return charSpike;
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
    infamy: $("infamy"),
    tier: $("tier"),
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
    if (primaryEnemy) {
      const et = primaryEnemy.body.translation();
      const enemyBearing = Math.atan2(et.z - tr.z, et.x - tr.x) - heading;
      hudEls.enemyMarker.style.opacity = "1";
      hudEls.enemyMarker.style.transform = `rotate(${(enemyBearing * 180) / Math.PI}deg)`;
    } else {
      hudEls.enemyMarker.style.opacity = "0";
    }
    const windBearing = Math.atan2(-wind.dirZ, -wind.dirX) - heading;
    hudEls.windMarker.style.transform = `rotate(${(windBearing * 180) / Math.PI}deg)`;

    const readiness = cannons.sideReadiness(sloop, aimBearing(), world.simTime);
    hudEls.gunBar.style.width = `${readiness * 100}%`;
    // helm indicator: where the rudder is SET (it holds until changed)
    hudEls.rudderInd.style.left = `${50 - sailing.rudder * 42}%`;

    // toast lifecycle
    if (gs.msg.current && gs.msg.current !== lastToast) {
      lastToast = gs.msg.current;
      hudEls.toast.textContent = gs.msg.current;
      hudEls.toast.style.opacity = "1";
      toastTimer = 3.2;
    }
    if (toastTimer > 0) {
      toastTimer -= dt;
      if (toastTimer <= 0) {
        hudEls.toast.style.opacity = "0";
        gs.msg.clear();
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
    hudEls.gold.textContent = String(gs.wallet.gold);
    hudEls.infamy.textContent = String(economy.state.notoriety);
    hudEls.tier.textContent = currentTier.charAt(0).toUpperCase() + currentTier.slice(1);

    hudEls.hpRow.style.display = onFoot ? "flex" : "none";
    if (onFoot) hudEls.hpBar.style.width = `${(character.playerHp / 5) * 100}%`;
    hudEls.stamRow.style.display = onFoot ? "flex" : "none";
    if (onFoot && character.player) hudEls.stamBar.style.width = `${character.player.stamina * 100}%`;

    const lockHint = controls.locked ? "" : "CLICK to capture mouse · ";
    const sandboxHint = gs.isSandbox() ? " · SANDBOX (` panel for enemies/sea)" : "";
    hudEls.hints.textContent = onFoot
      ? `${lockHint}WASD move · Shift sprint · Space jump · C kick · hold RMB aim + LMB fire · E take wheel · V view · Esc menu${sandboxHint}`
      : `${lockHint}W/S sails · A/D helm · hold RMB aim + LMB fire · E leave wheel · V view · Q spyglass · R plank · P pump · Esc menu · foes ${fleet.enemies.length}${sandboxHint}`;
  }

  // broadside trajectory preview while aiming (RMB): one arc PER CANNON on
  // the aiming side (playtest: "all four cannons … should show their
  // trajectory as well and articulate")
  const ARC_PTS = 64; // vertices in the preview polyline
  // integrate the preview at the ball's exact step; record 1 vertex per this
  // many sim steps → ARC_PTS·ARC_SUB·FIXED_DT ≈ 6.4 s of flight covered. r18: bumped
  // 4→6 because the faster r18 muzzle (TUN.gun) flies longer, so 4.3 s clipped the arc
  // short of its splash at normal combat elevations; the flatter shot stays smooth coarser.
  const ARC_SUB = 6;
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
  const _aimInv = new THREE.Quaternion(); // reused — aimBearing() runs several times/frame
  const _camFollow = new THREE.Vector3(); // reused — char third-person follow target each frame
  type Bearing = 1 | -1 | "fore" | "aft";
  function aimBearing(): Bearing {
    const rot2 = sloop.body.rotation();
    const inv = _aimInv.set(rot2.x, rot2.y, rot2.z, rot2.w).invert();
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
      // read the SAME live ballistics the ball uses (TUN.gun) so the preview
      // tracks the dev-panel sliders in lock-step with the real shot.
      const drag = TUN.gun.drag;
      const v = arcMuzzle.dir.clone().multiplyScalar(TUN.gun.muzzleSpeed);
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
        v.x += -drag * sp * v.x * FIXED_DT;
        v.y += (-G - drag * sp * v.y) * FIXED_DT;
        v.z += -drag * sp * v.z * FIXED_DT;
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
  // P4 pose temporaries (avoid per-frame allocation)
  const _poseQuat = new THREE.Quaternion();
  const _poseM4 = new THREE.Matrix4();
  const _poseInvRot = new THREE.Matrix3();
  const _poseTrans = new THREE.Vector3();
  const feedWake = (slot: number, ship: Ship) => {
    const v = ship.body.linvel();
    const speed = ship.submergedFrac < 0.05 ? 0 : Math.hypot(v.x, v.z);
    const rot = ship.body.rotation();
    _poseQuat.set(rot.x, rot.y, rot.z, rot.w); // reused below for the pose matrix too
    wakeF.set(1, 0, 0).applyQuaternion(_poseQuat);
    wakeF.y = 0;
    wakeF.normalize();
    const fp = ship.build.footprint;
    ship.localToWorld([(fp.minX + fp.maxX) / 2, 2.5, fp.zC], wakeV);
    const tr = ship.body.translation();
    const span = hullSpan(ship); // each ship's own keel/deck (was a shared 2-entry table)
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
    // (_poseQuat already set from rot at the top of feedWake)
    _poseM4.makeRotationFromQuaternion(_poseQuat);
    _poseInvRot.setFromMatrix4(_poseM4).transpose(); // R⁻¹ = Rᵀ for a rotation
    _poseTrans.set(tr.x, tr.y, tr.z);
    ocean.updateHullPose(slot, _poseInvRot, _poseTrans);
  };

  // Every visible enemy now gets the SAME voxel-accurate cut as the player (same class of object):
  // stamp its own hull profile into its atlas band on assignment, then feed pose + wake. The profile
  // build is O(cells), so it's cached per ship and re-stamped only when a slot's occupant changes.
  const shipProfile = (ship: Ship) => {
    let p = profileCache.get(ship);
    if (!p) { p = buildHullProfile(ship.build.grid); profileCache.set(ship, p); }
    return p;
  };
  const feedProfiled = (slot: number, ship: Ship) => {
    if (slotShip[slot] !== ship) {
      const p = shipProfile(ship);
      ocean.setHullProfile(slot, p.data, p.nx, p.nz, p.sizeX, p.sizeZ);
      slotShip[slot] = ship;
    }
    feedWake(slot, ship); // wake ribbon (slots <2) + live voxel pose (updateHullPose)
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
    const ships = [sloop, fleet.premiumEnemy].filter(Boolean) as Ship[];
    for (let i = 0; i < ships.length; i++) {
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
    return _dynShips.slice(0, ships.length);
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
  // DEV: T-bone ram test. Place the enemy stationary + perpendicular (flank toward
  // the player) at the player's float height, then charge the player bow-first into
  // it. The charge is re-imposed each frame ONLY until first contact (a voxel comes
  // off either hull), then released so the REAL impact physics play out. Exposed on
  // window.ramTest for scripted checks; wired to the dev-panel button below.
  const ramTest = () => {
    const VS = 0.25;
    // rotate a vector by a quaternion (v + 2w(q×v) + 2 q×(q×v))
    const rotV = (qq: { x: number; y: number; z: number; w: number }, vx: number, vy: number, vz: number) => {
      const tx = 2 * (qq.y * vz - qq.z * vy);
      const ty = 2 * (qq.z * vx - qq.x * vz);
      const tz = 2 * (qq.x * vy - qq.y * vx);
      return {
        x: vx + qq.w * tx + (qq.y * tz - qq.z * ty),
        y: vy + qq.w * ty + (qq.z * tx - qq.x * tz),
        z: vz + qq.w * tz + (qq.x * ty - qq.y * tx),
      };
    };
    const enemy = fleet.enemies[0];
    if (!enemy) {
      gs.msg.post("no enemy to ram");
      return;
    }
    const p = sloop.body.translation();
    const q = sloop.body.rotation();
    // horizontal bow heading on the water plane
    let fx = 1 - 2 * (q.y * q.y + q.z * q.z);
    let fz = 2 * (q.x * q.z - q.y * q.w);
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const DIST = 45;
    const SPEED = 18;
    // enemy rotation = player heading turned 90° about world-up → flank faces the bow
    const s = Math.SQRT1_2;
    const yw = { x: 0, y: s, z: 0, w: s };
    const tq = {
      x: yw.w * q.x + yw.x * q.w + yw.y * q.z - yw.z * q.y,
      y: yw.w * q.y - yw.x * q.z + yw.y * q.w + yw.z * q.x,
      z: yw.w * q.z + yw.x * q.y - yw.y * q.x + yw.z * q.w,
      w: yw.w * q.w - yw.x * q.x - yw.y * q.y - yw.z * q.z,
    };
    // bodies are positioned by their grid-CORNER origin; aim by CENTERS instead.
    // player center (on the water plane) — the charge line runs through it:
    const pd = sloop.build.grid.dims;
    const pc = rotV(q, (pd[0] * VS) / 2, (pd[1] * VS) / 2, (pd[2] * VS) / 2);
    const lineX = p.x + pc.x;
    const lineZ = p.z + pc.z;
    // desired enemy center: DIST ahead along the bow heading
    const tcx = lineX + fx * DIST;
    const tcz = lineZ + fz * DIST;
    // place the enemy ORIGIN so its CENTER lands there; keel y = player keel (same float)
    const ed = enemy.build.grid.dims;
    const ec = rotV(tq, (ed[0] * VS) / 2, (ed[1] * VS) / 2, (ed[2] * VS) / 2);
    enemy.body.setTranslation({ x: tcx - ec.x, y: p.y, z: tcz - ec.z }, true);
    enemy.body.setRotation(tq, true);
    enemy.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    enemy.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    let frames = 0;
    // Drive up to ram speed ONLY until the bows actually touch, then RELEASE — so the real,
    // anchored contact physics play out (a sail-driven ram that SLOWS as it carves in), not an
    // infinite-momentum push held at constant speed through the hull (that bulldozes straight
    // through and is not representative of play).
    const drive = () => {
      frames++;
      if (world.contact.debug.overlapCount > 0) return; // contact made → let go, real physics from here
      const v = sloop.body.linvel();
      sloop.body.setLinvel({ x: fx * SPEED, y: v.y, z: fz * SPEED }, true);
      if (frames < 240) requestAnimationFrame(drive);
    };
    requestAnimationFrame(drive);
  };
  (window as unknown as Record<string, unknown>).ramTest = ramTest;

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
      title: "Sailing",
      controls: [
        // player-only thrust multiplier (the AI captain owns a separate controller),
        // so you can crawl or zip about while testing without touching the enemy.
        { type: "slider", label: "sail power", obj: sailing as unknown as Record<string, number | boolean>, key: "boost", min: 0.25, max: 4, step: 0.25 },
      ],
    },
    {
      title: "Fleet",
      controls: [
        // how many hostile ships to keep sailing against you (0..MAXVIS). Sunk
        // enemies are auto-replaced. Drag live — they spawn/despawn one per step.
        { type: "slider", label: "enemies", obj: TUN.fleet, key: "enemyCount", min: 0, max: MAXVIS, step: 1 },
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
    {
      title: "✨ Graphics (visual pass)",
      controls: [
        { type: "toggle", label: "post FX", obj: TUN.gfx.post, key: "enabled" },
        { type: "slider", label: "post res", obj: TUN.gfx.post, key: "scale", min: 0.4, max: 1.5, step: 0.05 },
        { type: "slider", label: "post maxDPR", obj: TUN.gfx.post, key: "maxPixelRatio", min: 0.5, max: 2, step: 0.25 },
        { type: "toggle", label: "auto quality", obj: TUN.gfx.auto, key: "enabled" },
        { type: "slider", label: "fps target", obj: TUN.gfx.auto, key: "targetFps", min: 30, max: 60, step: 5 },
        { type: "toggle", label: "fps HUD", obj: TUN.gfx.auto, key: "hud" },
        { type: "slider", label: "exposure", obj: TUN.gfx.tone, key: "exposure", min: 0.5, max: 1.3, step: 0.02 },
        { type: "toggle", label: "bloom", obj: TUN.gfx.bloom, key: "enabled" },
        { type: "slider", label: "bloom str", obj: TUN.gfx.bloom, key: "strength", min: 0, max: 1, step: 0.02 },
        { type: "slider", label: "bloom thr", obj: TUN.gfx.bloom, key: "threshold", min: 0, max: 4, step: 0.1 },
        { type: "slider", label: "bloom clamp", obj: TUN.gfx.bloom, key: "clamp", min: 2, max: 30, step: 1 },
        { type: "toggle", label: "god rays", obj: TUN.gfx.godrays, key: "enabled" },
        { type: "slider", label: "rays str", obj: TUN.gfx.godrays, key: "strength", min: 0, max: 2, step: 0.05 },
        { type: "slider", label: "rays thr", obj: TUN.gfx.godrays, key: "threshold", min: 0, max: 16, step: 0.5 },
        { type: "slider", label: "reflect", obj: TUN.gfx.reflection, key: "strength", min: 0, max: 1.5, step: 0.05 },
        { type: "slider", label: "refl clamp", obj: TUN.gfx.reflection, key: "clamp", min: 0.5, max: 6, step: 0.1 },
        { type: "slider", label: "see-depth", obj: TUN.gfx.water, key: "visibility", min: 0, max: 8, step: 0.25 },
        { type: "slider", label: "water clarity", obj: TUN.gfx.water, key: "clarity", min: 0, max: 1, step: 0.05 },
        { type: "slider", label: "cloud cov", obj: TUN.gfx.clouds, key: "coverage", min: 0, max: 1, step: 0.02 },
        { type: "slider", label: "cloud dens", obj: TUN.gfx.clouds, key: "density", min: 0, max: 1, step: 0.02 },
        { type: "slider", label: "cloud spd", obj: TUN.gfx.clouds, key: "speed", min: 0, max: 2, step: 0.05 },
        { type: "slider", label: "isle grit", obj: TUN.gfx.islandGrit, key: "strength", min: 0, max: 1.5, step: 0.05 },
        { type: "slider", label: "sail glow", obj: TUN.gfx.sail, key: "glow", min: 0, max: 1.5, step: 0.05 },
        { type: "slider", label: "contrast", obj: TUN.gfx.grade, key: "contrast", min: 0.8, max: 1.4, step: 0.01 },
        { type: "slider", label: "saturate", obj: TUN.gfx.grade, key: "saturation", min: 0.5, max: 1.6, step: 0.02 },
        { type: "slider", label: "vignette", obj: TUN.gfx.grade, key: "vignette", min: 0, max: 0.6, step: 0.02 },
      ],
    },
    {
      title: "Port (dev)",
      controls: [{ type: "button", label: "Open Port screen", onClick: () => port.openPort() }],
    },
    {
      title: "Cannons",
      controls: [
        // muzzle speed + drag drive BOTH the ball and the aim-arc preview (TUN.gun),
        // so dragging these re-shapes the visible trajectory live. Sweep the speed up
        // toward ~440 (real 6-pdr) to feel it flatten into hitscan; mass = the hull-shove.
        { type: "slider", label: "muzzle m/s", obj: TUN.gun, key: "muzzleSpeed", min: 40, max: 500, step: 5 },
        { type: "slider", label: "air drag", obj: TUN.gun, key: "drag", min: 0.0005, max: 0.008, step: 0.0005 },
        { type: "slider", label: "shove kg", obj: TUN.gun, key: "mass", min: 1, max: 12, step: 0.5 },
        // "semi-auto": removes the reload wait on YOUR battery (the AI keeps its own).
        { type: "toggle", label: "no reload", obj: cannons as unknown as Record<string, number | boolean>, key: "noReload" },
      ],
    },
    {
      title: "🔧 Crunch (ship-vs-ship)",
      controls: [
        { type: "button", label: "⚔ Ram Test (T-bone)", onClick: ramTest },
        { type: "toggle", label: "deformable crush", obj: TUN.crush, key: "enabled" },
        // closing speed (m/s) under which nothing breaks — the wood's "give". ~2 ≈ 4 kn. The single
        // velocity gate: above it the contact face crushes, below it a slow bump just settles.
        { type: "slider", label: "break speed m/s", obj: TUN.crush, key: "vBreak", min: 0, max: 8, step: 0.25 },
        // ×break-energy = wood hardness. Higher → a ram bites fewer voxels AND slows more per layer
        // (penetrates less); lower → softer hulls that rip deep. The main "rip into each other" feel.
        { type: "slider", label: "toughness ×", obj: TUN.crush, key: "toughness", min: 0.1, max: 3, step: 0.05 },
        // contact tolerance in VOXELS: how close two voxels count as touching/eligible to break.
        { type: "slider", label: "buffer (vox)", obj: TUN.crush, key: "buffer", min: 0, max: 1, step: 0.05 },
        // REST separation: fraction of overlap depth eased apart per step when too slow to break.
        { type: "slider", label: "de-pen (0..1)", obj: TUN.crush, key: "depen", min: 0, max: 1, step: 0.05 },
        // hard cap (m/s) on REST positional separation — the anti-fling safety net.
        { type: "slider", label: "de-pen cap m/s", obj: TUN.crush, key: "maxDepenSpeed", min: 0.5, max: 8, step: 0.5 },
        // per-step cap (m/s) on the BREAK bite's closing-Δv. ALSO the crash-DURATION knob: lower =
        // the impact bleeds over more frames = a slower, heavier crash.
        { type: "slider", label: "bite Δv/step", obj: TUN.crush, key: "biteDvCap", min: 1, max: 12, step: 0.5 },
        // how much of a hit transfers to the struck ship (0 = victim not shoved, 1 = old "steals all").
        { type: "slider", label: "vel transfer", obj: TUN.crush, key: "transferFrac", min: 0, max: 1, step: 0.05 },
        // anti-vaporize ceiling on the per-step break budget (GEOMETRY caps the real rate). Lower
        // only to tame an extreme teleport-deep gouge. See tunables.ts.
        { type: "slider", label: "break ceil J (×1e5)", obj: TUN.crush as unknown as Record<string, number>, key: "maxStepEnergy", min: 5e5, max: 120e5, step: 5e5 },
        { type: "slider", label: "min depth m", obj: TUN.crush, key: "minDepth", min: 0, max: 0.5, step: 0.01 },
        // cannons share the crush core; this scales their ½mv² into the same joule budget.
        { type: "slider", label: "cannon crush ×", obj: TUN.gun, key: "crushEfficiency", min: 1, max: 120, step: 1 },
        { type: "slider", label: "ball bore radius", obj: TUN.gun, key: "boreRadiusVox", min: 0, max: 3, step: 1 },
        // how fast the sea pours through a breach (0.15 ≈ "reduce flood ~85%"); 1 = raw rate.
        { type: "slider", label: "flood inflow ×", obj: TUN.flood, key: "inflowScale", min: 0, max: 1, step: 0.05 },
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
    const c = world.contact.debug;
    devPanel.setReadout(
      `pitch ${pitchDeg >= 0 ? "+" : ""}${pitchDeg.toFixed(1)}°  heel ${heelDeg >= 0 ? "+" : ""}${heelDeg.toFixed(1)}°\n` +
        `submerged ${(sloop.submergedFrac * 100).toFixed(0)}%  waterlog ${(sloop.waterlog * 100).toFixed(0)}%\n` +
        `speed ${kn.toFixed(1)} kn\n` +
        `crunch: ovlp ${c.overlapCount}  depth ${c.depth.toFixed(2)}m  F ${(c.force / 1000).toFixed(0)}kN\n` +
        `  vClose ${c.vClose.toFixed(1)}  carved A${c.removedA}/B${c.removedB}  E ${(c.energy / 1000).toFixed(0)}kJ`,
    );
  };

  // ---- per-system CPU timing HUD (top-left, beneath the fps line) ----------------------------
  // Replaces guessing about WHERE the frame goes with hard numbers on the real machine: total sim
  // time + render time + the substep count, then the per-system split. Pure diagnostics; toggles
  // with the fps HUD (TUN.gfx.auto.hud). DEBUG.world.timing carries the same numbers for the console.
  const timingHud = document.createElement("div");
  Object.assign(timingHud.style, {
    position: "fixed", top: "46px", left: "8px", zIndex: "10005",
    font: '11px/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace',
    color: "#bcd6e8", background: "rgba(6,10,14,0.5)", padding: "3px 7px",
    borderRadius: "4px", border: "1px solid rgba(150,180,200,0.18)",
    pointerEvents: "none", whiteSpace: "pre", textShadow: "0 1px 2px #000", display: "none",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(timingHud);
  let renderMs = 0;
  const updateTimingHud = (): void => {
    if (!TUN.gfx.auto.hud) {
      if (timingHud.style.display !== "none") timingHud.style.display = "none";
      return;
    }
    if (timingHud.style.display === "none") timingHud.style.display = "block";
    const t = world.timing;
    timingHud.textContent =
      `sim ${t.total.toFixed(1)}ms · render ${renderMs.toFixed(1)}ms · ×${t.substeps} substeps\n` +
      `buoy ${t.buoy.toFixed(1)} · rapier ${t.rapier.toFixed(1)} · mesh ${t.visual.toFixed(1)}\n` +
      `flood ${t.flood.toFixed(1)} · contact ${t.contact.toFixed(1)} · ai/sail ${t.fixed.toFixed(1)} · flush ${t.flush.toFixed(1)}`;
  };

  // Applies a menu choice to the (built) world and starts the sim. Runs once after the
  // initial build and again for every later Start after a Quit-to-Menu (world is reused).
  function applyChoice(choice: StartChoice): void {
    if (choice.kind === "career") {
      forcedEnemyTier = null; // Career always uses the notoriety-scaled spawn spread
      if (choice.fresh) {
        saves.wipe("career");
        applySave(defaultSave("career"));
      } else {
        applySave(saves.load("career"));
      }
      gs.startGame("career");
    } else {
      applySave(saves.load("sandbox"));
      // free play: top up to a deep purse so every hull + upgrade is buyable
      if (economy.state.doubloons < 50000) {
        economy.state.doubloons = 50000;
        gs.wallet.set(50000);
      }
      const cfg = choice.cfg;
      forcedEnemyTier = cfg.enemyTier === "mixed" ? null : (cfg.enemyTier as ShipTierId);
      TUN.fleet.enemyCount = Math.max(0, Math.min(MAXVIS, Math.round(cfg.enemyCount)));
      if (cfg.shipTier !== currentTier) swapPlayerShip(cfg.shipTier as ShipTierId);
      gs.startGame("sandbox");
    }
    menu.hide();
    document.body.classList.remove("menu-active"); // reveal the game HUD now that we're sailing
  }

  worldReady = true; // later Starts now re-apply directly instead of resolving the gate
  applyChoice(startChoice); // apply the choice that opened the gate
  loadingEl.remove();

  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    perf.tick(dt); // measure real frame time → HUD + adaptive-quality governor
    // Quit-to-Menu returns here with the world still built — show a clean screen instead
    // of drawing the frozen world behind the menu. (Pause/port still render the freeze.)
    if (gs.phase === "menu") {
      renderer.setRenderTarget(null);
      renderer.setClearColor(0x05080a, 1);
      renderer.clear();
      return;
    }
    // the sim only advances while PLAYING — pause and port screens freeze the world
    // (the render loop still draws, so overlays composite over a still frame).
    if (gs.isSimRunning()) world.step(dt);
    // ---- per-frame fleet LOD ----
    fleet.rankLOD(camera.position);
    const premium = fleet.premiumEnemy;
    primaryEnemy = premium;
    if (premium !== premiumSlot1) {
      ocean.resetTrail(1); // premium enemy swapped — don't lace the ribbon across the jump
      premiumSlot1 = premium;
    }
    feedProfiled(0, sloop); // slot 0: player (voxel cut + ribbon + pose)
    checkBowSpray(0, sloop, dt);
    if (premium) {
      feedProfiled(1, premium); // slot 1: nearest enemy (premium — voxel cut + stern ribbon)
      checkBowSpray(1, premium, dt);
    } else {
      ocean.clearSlot(1);
      slotShip[1] = null;
    }
    // slots 2..: the remaining visible enemies — now the SAME per-ship voxel cut, not the ellipse.
    let cheapSlot = 2;
    for (const e of fleet.enemies) {
      if (e === premium) continue;
      if (cheapSlot >= MAXVIS) break;
      feedProfiled(cheapSlot, e);
      cheapSlot++;
    }
    for (; cheapSlot < MAXVIS; cheapSlot++) { ocean.clearSlot(cheapSlot); slotShip[cheapSlot] = null; }
    effects.update(dt, world.simTime);
    // helm pose rides on top of the final mixer state, once per frame —
    // re-posing per fixed step stacked offsets ("arm absolutely spasming")
    character.player?.postPose();
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
    for (const u of fleet.units) {
      u.ship.visual.animate(world.simTime, u.captain.sailing.rudder, u.captain.sailing.sailSet);
    }

    const tr = sloop.body.translation();
    const sd = skySetup.sunDir;
    if (firstPerson && character.player) {
      // eye-level camera — at the model's eye line, not its collar
      // (playtest round 5: "really only shows the inside of the uniform")
      const pt = character.player.body.translation();
      // r18.1: seat the eye at the true eye line (the old 0.95 sat at the crown, which pushed the
      // body-attached arm + cutlass off the bottom of the frame). Lower brings the weapon into the
      // forward view; the head bone is collapsed in FP so the camera isn't inside any mesh.
      // the eye sits higher on the taller Universal base mesh than on the stocky
      // Quaternius captain — otherwise FP frames his collarbone.
      const eyeY =
        pt.y + (character.player.rig ? (character.player.rig.kind === "universal" ? 1.05 : 0.74) : 0.95);
      const yaw = controls.cameraYaw();
      const pitch = controls.lookPitch();
      character.player.fpLookPitch = pitch; // carry pose lifts with the view (stays in frame)
      // r18.1: feed the look yaw — crew.syncMesh faces the body to THIS (not the run direction) in
      // FP, so the arm/cutlass hold their screen spot when you strafe instead of clipping in.
      character.player.fpLookYaw = yaw;
      const lookX = Math.cos(yaw) * Math.cos(pitch);
      const lookZ = Math.sin(yaw) * Math.cos(pitch);
      // r18.1: with the REAL arm shown, seat the eye slightly BEHIND the shoulder so the right
      // arm extends FORWARD into frame (the shoulder sits ~at the capsule centre; without the
      // pull-back the short arm hangs beside the lens and never reaches the view). The head is
      // collapsed in FP so there's no mesh to clip into back here.
      // pull back behind the shoulder ONLY when there's a real FP arm to frame
      // (Quaternius). The Universal mesh has no FP arm yet, so sit right at the eye.
      const back = character.player.rig && character.player.rig.kind !== "universal" ? 0.42 : 0;
      camera.position.set(pt.x - lookX * back, eyeY, pt.z - lookZ * back);
      camera.lookAt(camera.position.x + lookX, eyeY + Math.sin(pitch), camera.position.z + lookZ);
      // viewmodel: the procedural stand-in arm shows ONLY when there's no rigged model — the
      // rigged pirate now carries its REAL right arm + cutlass in first person (r18.1).
      viewModel.visible = !character.player.rig;
      const swingT = character.player.attackTimer ?? 0;
      const swingP = swingT > 0 ? Math.sin((1 - swingT / 0.7) * Math.PI) : 0;
      vmBob += dt * 3.2;
      const bob = Math.sin(vmBob) * 0.01;
      vmOffset.set(0.28, -0.4 + bob, -0.62).applyQuaternion(camera.quaternion);
      viewModel.position.copy(camera.position).add(vmOffset);
      viewModel.quaternion.copy(camera.quaternion);
      // a diagonal cutlass slash: the blade sweeps down-and-across the view (more roll +
      // yaw than the old straight chop) with a little follow-through, then recovers.
      vmArm.rotation.set(-0.12 - swingP * 1.7, 0.28 + swingP * 0.55, 0.78 - swingP * 0.95);
    } else if (camMode === 0 && character.player) {
      // character third-person: a short follow-cam orbiting the player himself
      // (V's default view) instead of the whole ship.
      viewModel.visible = false;
      const pp = character.player.body.translation();
      controls.updateFollowCamera(camera, _camFollow.set(pp.x, pp.y, pp.z));
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
    // refresh the (autoUpdate-off) shadow map at ~15 Hz instead of every frame — see sky.ts.
    shadowAccum += dt;
    if (shadowAccum >= 1 / 15) {
      skySetup.sunLight.shadow.needsUpdate = true;
      shadowAccum = 0;
    }

    // advance the FFT-ocean spectral sim at ~30 Hz (every ~2nd frame). The surface samples the
    // persisted displacement/normal RTs continuously, so the chop detail evolving at 30 Hz is
    // imperceptible while halving the ~45 full-screen DFT passes this call costs.
    if (lastOceanFftUpdate < 0 || world.simTime - lastOceanFftUpdate >= 1 / 30) {
      oceanField.update(world.simTime);
      lastOceanFftUpdate = world.simTime;
    }
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
    ocean.setReflStrength(TUN.gfx.reflection.strength, TUN.gfx.reflection.clamp);
    ocean.setWaterDepth(TUN.gfx.water.visibility, TUN.gfx.water.clarity);
    renderer.toneMappingExposure = TUN.gfx.tone.exposure; // live exposure knob
    islandGritUniforms.uGritStrength.value = TUN.gfx.islandGrit.strength;
    ocean.update(world.simTime, camera.position);

    // the sky dome + drifting clouds follow the camera (camera always at the dome centre);
    // then re-bake the sky+cloud reflection cube at TUN.gfx.reflection.rebakeHz.
    skySetup.follow(camera.position);
    clouds.update(world.simTime, camera.position);
    const bakeInterval = 1 / Math.max(0.1, TUN.gfx.reflection.rebakeHz);
    if (lastEnvBake < 0 || world.simTime - lastEnvBake >= bakeInterval) {
      skySetup.updateEnv(renderer, bgScene, camera.position);
      lastEnvBake = world.simTime;
    }

    // project the sun to screen space for the god-ray pass; gate on it being in
    // front of the camera AND above the horizon (no shafts from a sun behind us).
    _sunWorld.copy(camera.position).addScaledVector(skySetup.sunDir, 1000);
    _sunView.copy(_sunWorld).applyMatrix4(camera.matrixWorldInverse);
    const sunOnScreen = _sunView.z < 0 && skySetup.sunDir.y > 0;
    _sunWorld.project(camera); // → NDC in place
    post.setSun(_sunWorld.x * 0.5 + 0.5, _sunWorld.y * 0.5 + 0.5, sunOnScreen);

    seam.setHulls([sloop.visual.group, ...fleet.enemies.map((e) => e.visual.group), ...islandHulls]);
    const _r0 = performance.now();
    if (TUN.gfx.post.enabled) {
      // the composer's ScenePass runs the same clear → seam-write → scene-render
      // stencil dance, then bloom (+ god rays/grade in later tasks), then tonemaps
      // to the screen via OutputPass.
      post.render();
    } else {
      // legacy direct path — perf floor / safety valve. Same bg→clearDepth→main
      // sequence as the composer's ScenePass, just straight to the screen.
      renderer.setRenderTarget(null);
      renderer.autoClear = false;
      renderer.clear(true, true, true);
      renderer.render(bgScene, camera); // sky + clouds backdrop
      renderer.clearDepth();
      seam.write(renderer, scene, camera); // hull+island → stencil (no color/depth)
      renderer.render(scene, camera); // full scene incl. ocean, stencil-tested
      renderer.autoClear = true;
    }
    renderMs = performance.now() - _r0;

    updateHud(dt, tr);
    updateDevReadout();
    updateTimingHud();
  });
}

main();
