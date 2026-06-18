import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { G, VOXEL_SIZE, VOXEL_VOLUME, WATER_DENSITY } from "../core/constants";
import { TUN } from "../core/tunables";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { MATERIALS, SPAR } from "../sim/materials";
import { createGrid } from "../sim/voxelGrid";
import { meshChunk } from "../render/voxelMesher";
import { CHUNK_SIZE } from "../core/constants";
import type { Island } from "../sim/connectivity";
import type { Effects } from "../render/effects";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

/**
 * Severed hull islands become dynamic bodies with their own voxel meshes.
 * Small pieces are short-lived flotsam (single-probe Archimedes). BIG pieces
 * — a bow rammed clean off, half a ship (round 7: "if a ship is rammed hard
 * enough, it can actually split in half") — become WRECKS: corner buoyancy
 * probes so they trim and list like a hull, floating at first on entrained
 * air, then waterlogging and foundering over the next minute.
 */
interface DebrisPiece {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  volume: number; // m³
  halfHeight: number;
  age: number;
  /** Local-frame buoyancy probe points (wrecks get four corners). */
  probes: [number, number, number][];
  wreck: boolean;
  /** A felled MAST: a SPAR island routed to a persistent floating body (NOT dust) regardless of
   *  cell count, with a SOLID (non-sensor, default-group) collider the on-foot captain can stand on.
   *  Floats/settles then slowly waterlogs under (its own bobless float in update()). */
  mast?: boolean;
  /** Mast-only: buoyancy lift multiplier, decays from afloat toward fallSinkFloor as it waterlogs. */
  liftMul?: number;
  /** Mast-only: the cloned YARD+SAIL group (shipVisual.cloneMastRig) re-parented under `mesh` in the
   *  body's local frame, so the canvas (with its shot-holes) tumbles WITH the falling spar instead of
   *  vanishing. Tracked so despawn can dispose its cloned materials. */
  rig?: THREE.Group;
  /** Mast-only: seconds remaining before this falling section can deal landing damage — a brief arm
   *  delay so it never craters its OWN deck on the spawn frame (it spawns AT the mast foot, overlapping
   *  the hull). Counts down in update(); damage probing starts once it reaches 0. */
  impactArm?: number;
}

// Defensive clamp for ONE inherited velocity component: spawned debris copies the source ship's
// linvel/angvel, so if the ship was momentarily corrupt (the "launches into the air" bug) the debris
// would inherit it. Non-finite → 0; |v| beyond the sane cap → clamped. A no-op on every healthy frame
// (real ship speeds are tiny vs these caps). Caps mirror world.ts's post-step sanitizer.
const DEBRIS_SANE_LIN = 120; // m/s
const DEBRIS_SANE_ANG = 30;  // rad/s
function clampComp(v: number, cap: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < -cap ? -cap : v > cap ? cap : v;
}

const LIFETIME = 35; // s — small flotsam
const WRECK_LIFETIME = 150; // s — or until it founders below 40 m
/** A severed island at least this many voxels is a wreck, not flotsam. */
export const WRECK_CELLS = 250;
/** Only a GENUINELY large disconnected piece — a ship torn in half — becomes a free
 *  rigid body. Anything smaller is pulverized to DUST, never a "floating beam": the
 *  player's rule is destroyed material is loose voxels/dust, not regrouped rigid chunks. */
export const BIG_SEVER = 1200;

/** Wreck lift multiplier vs age: fresh wreckage rides high on entrained air,
 *  then waterlogs. Wood alone needs ≈×0.5 lift to float — dropping well
 *  below that by a minute in guarantees she founders. */
export function wreckLift(age: number): number {
  return Math.max(1.45 - (age / 45) * 1.05, 0.32);
}

/** Does a severed island contain any SPAR (mast) voxels? A felled mast is a few-hundred-cell
 *  island — far below BIG_SEVER — so cell COUNT alone would route it to dust(). We instead detect
 *  SPAR CONTENT and force the persistent floating-body path for those, while leaving small NON-mast
 *  hull fragments to dust as before (the "destroyed material = loose voxels/dust" design). Keying on
 *  the material — not a lowered global threshold — is what keeps small hull chips from floating. */
export function islandHasSpar(island: Island): boolean {
  for (const c of island.cells) if (c.mat === SPAR) return true;
  return false;
}

/**
 * Routing decision for a severed island (pure, unit-tested): a BIG piece (≥ BIG_SEVER, a hull torn
 * in half) becomes a free-floating "wreck" body; ANY piece carrying SPAR (a felled mast) becomes a
 * persistent floating "mast" body regardless of count; everything else is pulverized to "dust".
 */
export type DebrisRoute = "wreck" | "mast" | "dust";
export function routeIsland(island: Island): DebrisRoute {
  if (island.cells.length >= BIG_SEVER) return "wreck";
  if (islandHasSpar(island)) return "mast";
  return "dust";
}

export class DebrisManager {
  private pieces: DebrisPiece[] = [];

  constructor(
    private physics: Physics,
    private scene: THREE.Scene,
    // optional so a 2-arg `new DebrisManager(physics, scene)` (e.g. mid-refactor) still
    // compiles — dust just no-ops without it. Pass it to get pulverization motes.
    private effects?: Effects,
  ) {}

  /** Spawn one debris body from a severed island, in the source ship's frame. `mastRig` (optional) is
   *  a pre-cloned YARD+SAIL group from shipVisual.cloneMastRig: when the severed island is a felled
   *  MAST it's attached to the floating spar body so the canvas falls WITH it (the fix for "the sails
   *  just disappear"); ignored for non-mast routes. Optional so existing 2-arg callers still compile. */
  spawn(island: Island, ship: Ship, mastRig?: THREE.Group | null): void {
    if (island.cells.length === 0) return;
    // Route by content, not raw count: a hull torn clean in half (≥ BIG_SEVER) → free-floating
    // WRECK; a felled MAST (any SPAR-bearing island, typ. a few hundred cells) → a persistent
    // floating walkable body; everything else → DUST (loose voxels, never a "floating beam").
    const route = routeIsland(island);
    if (route === "dust") { this.dust(island, ship); return; }
    if (route === "mast") { this.spawnMast(island, ship, mastRig ?? undefined); return; }
    const { world, RAPIER: R } = this.physics;

    // island bounds
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let mass = 0;
    for (const c of island.cells) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
      mass += MATERIALS[c.mat].density * VOXEL_VOLUME;
    }

    // re-grid the island at its bbox origin and greedy-mesh it
    const gnx = maxX - minX + 1;
    const gny = maxY - minY + 1;
    const gnz = maxZ - minZ + 1;
    const grid = createGrid(gnx, gny, gnz);
    for (const c of island.cells) grid.set(c.x - minX, c.y - minY, c.z - minZ, c.mat);

    const group = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
    for (let cx = 0; cx <= Math.floor((gnx - 1) / CHUNK_SIZE); cx++) {
      for (let cy = 0; cy <= Math.floor((gny - 1) / CHUNK_SIZE); cy++) {
        for (let cz = 0; cz <= Math.floor((gnz - 1) / CHUNK_SIZE); cz++) {
          const data = meshChunk(grid, cx, cy, cz);
          if (!data) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
          geo.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
          geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
          const m = new THREE.Mesh(geo, mat);
          m.castShadow = true;
          group.add(m);
        }
      }
    }
    this.scene.add(group);

    // body at the island origin, inheriting the ship's frame + velocity
    const origin = ship.localToWorld(
      [minX * VOXEL_SIZE, minY * VOXEL_SIZE, minZ * VOXEL_SIZE],
      new THREE.Vector3(),
    );
    const rot = ship.body.rotation();
    const vel = ship.body.linvel(); // clamped per-component below before it's inherited
    const hx = (gnx * VOXEL_SIZE) / 2;
    const hy = (gny * VOXEL_SIZE) / 2;
    const hz = (gnz * VOXEL_SIZE) / 2;

    const wreck = island.cells.length >= WRECK_CELLS;
    const wav = ship.body.angvel();
    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinvel(
        clampComp(vel.x, DEBRIS_SANE_LIN) + (Math.random() - 0.5),
        clampComp(vel.y, DEBRIS_SANE_LIN) + (wreck ? 0 : 0.5),
        clampComp(vel.z, DEBRIS_SANE_LIN) + (Math.random() - 0.5),
      )
      .setAngvel(
        wreck
          ? { x: clampComp(wav.x, DEBRIS_SANE_ANG), y: clampComp(wav.y, DEBRIS_SANE_ANG), z: clampComp(wav.z, DEBRIS_SANE_ANG) }
          : { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5), z: (Math.random() - 0.5) * 2 },
      )
      .setLinearDamping(wreck ? 0.55 : 0.3)
      .setAngularDamping(wreck ? 1.6 : 1.0);
    const body = world.createRigidBody(desc);
    const collider = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(hx, hy, hz).setDensity(0);
    world.createCollider(collider, body);
    body.setAdditionalMassProperties(
      Math.max(mass, 5),
      { x: hx, y: hy, z: hz },
      { x: (mass / 12) * (hy * hy + hz * hz) * 4 + 1, y: (mass / 12) * (hx * hx + hz * hz) * 4 + 1, z: (mass / 12) * (hx * hx + hy * hy) * 4 + 1 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    // wrecks float on four corner probes (trim + list like a hull);
    // flotsam needs only its center
    const probes: [number, number, number][] = wreck
      ? [
          [hx * 0.35, 0, hz * 0.5],
          [hx * 1.65, 0, hz * 0.5],
          [hx * 0.35, 0, hz * 1.5],
          [hx * 1.65, 0, hz * 1.5],
        ]
      : [[hx, hy, hz]];

    this.pieces.push({
      body,
      mesh: group,
      volume: island.cells.length * VOXEL_VOLUME * 1.6, // entrained air bumps wood buoyancy
      halfHeight: hy,
      age: 0,
      probes,
      wreck,
    });
  }

  /**
   * A felled MAST: a severed SPAR island becomes a PERSISTENT, FLOATING physical body — the fix for
   * "masts just disappear when I hit them." Re-grids the island at its bbox, greedy-meshes it (the
   * real spar look), and builds a DYNAMIC body that topples off the side, then SETTLES and floats
   * awash (no bounce) and slowly waterlogs under — mirroring the rig.ts mast-float feel
   * (fallFloatBuoy / fallVertDamp / fallSinkFloor / waterlog in update()).
   *
   * WALKABLE: unlike the hull collider (group 0x0002ffff, hidden from the KCC) and the deck trimesh
   * (a SENSOR-adjacent FILTER_CONTACT_PAIRS body out of the character world), the mast collider is a
   * SOLID, default-collision-group cuboid — so the captain's KinematicCharacterController sweeps
   * against it and can STAND on the fallen spar (same path that lets him walk the static dock
   * trimesh). A long thin cuboid hull around the spar (not a trimesh) keeps the resting contact rock
   * solid so he doesn't jitter.
   *
   * MASS (THE LAW): the body's mass comes from its OWN re-gridded SPAR cells; the hull already
   * dropped these voxels and re-derived its inertia (ship.recomputeMassProperties), so this never
   * double-counts the mast's weight on the ship.
   */
  private spawnMast(island: Island, ship: Ship, mastRig?: THREE.Group): void {
    const { world, RAPIER: R } = this.physics;

    // island bounds + true mass from its own cells (SPAR is light — density 120).
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let mass = 0;
    for (const c of island.cells) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x);
      minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
      minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
      mass += MATERIALS[c.mat].density * VOXEL_VOLUME;
    }

    // re-grid at the bbox origin and greedy-mesh it (the felled spar's real voxels).
    const gnx = maxX - minX + 1;
    const gny = maxY - minY + 1;
    const gnz = maxZ - minZ + 1;
    const grid = createGrid(gnx, gny, gnz);
    for (const c of island.cells) grid.set(c.x - minX, c.y - minY, c.z - minZ, c.mat);

    const group = new THREE.Group();
    const meshMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    for (let cx = 0; cx <= Math.floor((gnx - 1) / CHUNK_SIZE); cx++) {
      for (let cy = 0; cy <= Math.floor((gny - 1) / CHUNK_SIZE); cy++) {
        for (let cz = 0; cz <= Math.floor((gnz - 1) / CHUNK_SIZE); cz++) {
          const data = meshChunk(grid, cx, cy, cz);
          if (!data) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
          geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
          geo.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
          geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
          const m = new THREE.Mesh(geo, meshMat);
          m.castShadow = true;
          group.add(m);
        }
      }
    }
    this.scene.add(group);

    // body at the island origin, inheriting the ship's frame + velocity, plus a sideways TOPPLE kick
    // so a standing mast goes "by the board" over the rail instead of dropping straight down.
    const origin = ship.localToWorld(
      [minX * VOXEL_SIZE, minY * VOXEL_SIZE, minZ * VOXEL_SIZE],
      new THREE.Vector3(),
    );
    const rot = ship.body.rotation();
    const vel = ship.body.linvel();
    const hx = (gnx * VOXEL_SIZE) / 2;
    const hy = (gny * VOXEL_SIZE) / 2;
    const hz = (gnz * VOXEL_SIZE) / 2;
    // topple OUTBOARD: the mast is on the centreline, so kick it toward the nearer side (±z) in the
    // ship's frame. A small kick + roll seeds the "goes by the board" lean (TUN.rig.toppleKick).
    const kick = TUN.rig.toppleKick;
    const sq = this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    const sideLocal = this.tmpP.set(0, 0, Math.random() < 0.5 ? 1 : -1);
    const side = sideLocal.applyQuaternion(sq).normalize();

    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(origin.x, origin.y, origin.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      // clamp the inherited ship velocity per-component before the topple kick is added.
      .setLinvel(clampComp(vel.x, DEBRIS_SANE_LIN) + side.x * kick, clampComp(vel.y, DEBRIS_SANE_LIN), clampComp(vel.z, DEBRIS_SANE_LIN) + side.z * kick)
      .setAngvel({ x: side.z * 1.2, y: (Math.random() - 0.5) * 0.6, z: -side.x * 1.2 })
      .setLinearDamping(0.4)
      .setAngularDamping(1.2);
    const body = world.createRigidBody(desc);
    // exclude this body from Rapier's rigid solver against any SHIP (see physics.debrisBodies): the
    // spar spawns DEEP inside the hull it tore off, and the solver's penetration recovery on that
    // overlap launched the unclamped debris hundreds of metres skyward. Landing damage is a manual
    // voxel-crush probe (mastLandingDamage), so the rigid contact is unnecessary anyway.
    this.physics.debrisBodies.add(body.handle);

    // SOLID, DEFAULT-GROUP collider (NOT a sensor, NOT group 0x0002, NOT FILTER_CONTACT_PAIRS): this
    // is what makes the fallen spar walkable — the captain's KCC query (filter 0xfffffffd) collides
    // with default-membership colliders, and a solid (non-sensor) shape stops his capsule.
    const collider = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(hx, hy, hz).setDensity(0);
    world.createCollider(collider, body);
    body.setAdditionalMassProperties(
      Math.max(mass, 5),
      { x: hx, y: hy, z: hz },
      { x: (mass / 12) * (hy * hy + hz * hz) * 4 + 1, y: (mass / 12) * (hx * hx + hz * hz) * 4 + 1, z: (mass / 12) * (hx * hx + hy * hy) * 4 + 1 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    // float probes spread along the spar's LONG axis (so it lies flat awash and trims like a log,
    // not a bobbing point). The trunk is longest in Y in its own pre-fall frame, but it can land in
    // any orientation — probes at the cuboid's two ends along each axis give a stable raft.
    const probes: [number, number, number][] = [
      [hx, hy * 0.4, hz],
      [hx, hy * 1.6, hz],
      [hx * 0.4, hy, hz],
      [hx * 1.6, hy, hz],
      [hx, hy, hz * 0.4],
      [hx, hy, hz * 1.6],
    ];

    // CARRY THE SAILS DOWN: re-parent the pre-cloned yard/sail group (at WORLD transforms) under the
    // spar body's visual group, converting each clone world→body-local so it tumbles rigidly with the
    // spar. The body starts at origin/rot, and `group` tracks the body each step (update() sets
    // group.position/quaternion = body), so local = (body world)⁻¹ · (clone world).
    // Capture BEFORE the loop — re-parenting (group.add) empties mastRig.children, so a post-loop
    // length check would always read 0 and leave p.rig undefined (→ disposeRig leaks the clones).
    const carriedRig = !!(mastRig && mastRig.children.length > 0);
    if (carriedRig) {
      const bodyMat = new THREE.Matrix4().compose(
        origin, this.tmpQ.set(rot.x, rot.y, rot.z, rot.w), this.tmpP.set(1, 1, 1),
      );
      const bodyInv = bodyMat.clone().invert();
      const childMat = new THREE.Matrix4();
      // snapshot children first — reparenting mutates mastRig.children mid-iteration.
      for (const child of [...mastRig.children]) {
        child.updateMatrix(); // its pos/quat/scale are baked world transforms
        childMat.multiplyMatrices(bodyInv, child.matrix);
        childMat.decompose(child.position, child.quaternion, child.scale);
        child.matrixAutoUpdate = true;
        group.add(child); // now expressed in the body's local frame
      }
    }

    this.pieces.push({
      body,
      mesh: group,
      // entrained air + light spar wood ⇒ it rides awash; tuned together with fallFloatBuoy.
      volume: island.cells.length * VOXEL_VOLUME * 1.6,
      // span for the submerged-fraction reads off the spar's THICKNESS (its small cross-section), not
      // the long axis — a felled mast lies FLAT on the water, so only its ~0.3 m girth is the
      // float-depth scale. Using the tall pre-fall Y half-extent would make `sub` tiny and it would
      // sink instead of riding awash.
      halfHeight: Math.max(Math.min(hx, hz), 0.18),
      age: 0,
      probes,
      wreck: false,
      mast: true,
      liftMul: TUN.rig.fallFloatBuoy,
      rig: carriedRig ? mastRig : undefined,
      impactArm: 0.25, // brief delay so it can't crater its own deck on the spawn frame
    });
  }

  /** Shared falling-cannon barrel geometry/material (one ~2 m iron tube), built once. */
  private static cannonGeo: THREE.BufferGeometry | null = null;
  private static cannonMat: THREE.Material | null = null;

  /**
   * A cannon whose hull mount has been carved away (ship.loseCannon → onCannonLost): HIDE the static
   * gun mesh and drop a falling cast-iron barrel at its exact world pose, inheriting the ship's
   * velocity plus an OUTBOARD kick so it tips over the rail. It's a low-buoyancy flotsam piece — iron
   * is heavy, so it splashes alongside and sinks (the existing update() Archimedes + lifetime own it).
   * Headless / no-mesh ships no-op (hideCannon returns null).
   */
  spawnFallingCannon(ship: Ship, portIndex: number): void {
    const pose = ship.visual.hideCannon(portIndex);
    if (!pose) return;
    const { world, RAPIER: R } = this.physics;
    const port = ship.build.cannonPorts[portIndex];

    // shared mesh: a stubby iron tube, oriented along its length (x) like the real barrel.
    if (!DebrisManager.cannonGeo) {
      const g = new THREE.CylinderGeometry(0.13, 0.16, 2.0, 10);
      g.rotateZ(Math.PI / 2); // lie the tube along x
      DebrisManager.cannonGeo = g;
      DebrisManager.cannonMat = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.5, metalness: 0.7 });
    }
    const mesh = new THREE.Mesh(DebrisManager.cannonGeo, DebrisManager.cannonMat!);
    mesh.castShadow = true;
    mesh.position.copy(pose.pos);
    mesh.quaternion.copy(pose.quat);
    this.scene.add(mesh);

    // outboard world direction: a broadside gun tips out ±z (its side); a chaser tips out ±x.
    const rot = ship.body.rotation();
    const sq = this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    const outLocal = port.facing
      ? this.tmpP.set(port.facing === "fore" ? 1 : -1, 0, 0)
      : this.tmpP.set(0, 0, port.side);
    const out = outLocal.applyQuaternion(sq).normalize();
    const sv = ship.body.linvel();
    const kick = TUN.gun.fallKick;

    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(pose.pos.x, pose.pos.y, pose.pos.z)
      .setRotation({ x: pose.quat.x, y: pose.quat.y, z: pose.quat.z, w: pose.quat.w })
      // clamp the inherited ship velocity per-component before the outboard kick is added.
      .setLinvel(clampComp(sv.x, DEBRIS_SANE_LIN) + out.x * kick, clampComp(sv.y, DEBRIS_SANE_LIN) + 0.4, clampComp(sv.z, DEBRIS_SANE_LIN) + out.z * kick)
      .setAngvel({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 2 })
      .setLinearDamping(0.4)
      .setAngularDamping(0.9);
    const body = world.createRigidBody(desc);
    // a slim capsule-ish cuboid around the barrel; density 0 (mass set explicitly below).
    const col = R.ColliderDesc.cuboid(1.0, 0.16, 0.16).setDensity(0);
    world.createCollider(col, body);
    body.setAdditionalMassProperties(
      320, // a real iron 6-pounder barrel is heavy — it pulls itself under
      { x: 0, y: 0, z: 0 },
      { x: 4, y: 40, z: 40 },
      { x: 0, y: 0, z: 0, w: 1 },
      true,
    );

    this.pieces.push({
      body,
      mesh,
      // small displacing volume so iron rides LOW and founders fast (a splash, then under).
      volume: 0.22,
      halfHeight: 0.16,
      age: 0,
      probes: [[0, 0, 0]],
      wreck: false,
    });
  }

  private dustTmp = new THREE.Vector3();
  private dustUp = new THREE.Vector3();
  /** A small/medium disconnected chunk does NOT become a rigid body. Its cells were already
   *  removed from the hull by flushDamage; here we just throw a burst of dust motes where it
   *  broke free, so it reads as pulverized (loose voxels), not a detached floating beam. */
  private dust(island: Island, ship: Ship): void {
    let sx = 0, sy = 0, sz = 0;
    for (const c of island.cells) { sx += c.x; sy += c.y; sz += c.z; }
    const n = island.cells.length;
    ship.localToWorld(
      [(sx / n + 0.5) * VOXEL_SIZE, (sy / n + 0.5) * VOXEL_SIZE, (sz / n + 0.5) * VOXEL_SIZE],
      this.dustTmp,
    );
    this.effects?.impactDebris(this.dustTmp, this.dustUp.set(0, 1, 0), Math.min(n, 40));
  }

  private tmpQ = new THREE.Quaternion();
  private tmpP = new THREE.Vector3();
  // landing-damage scratch (kept off tmpQ/tmpP, which the buoyancy loop uses).
  private ldQ = new THREE.Quaternion();
  private ldWp = new THREE.Vector3();
  private ldWl = new THREE.Vector3();
  private ldCells: [number, number, number][] = [];

  /** Free the cloned yard/sail materials a felled mast carried down (geometries are SHARED with the
   *  live ship and must NOT be disposed; only the per-clone debris materials, tagged debrisRig). */
  private disposeRig(p: DebrisPiece): void {
    if (!p.rig) return;
    p.mesh.traverse((o) => {
      const m = o as THREE.Mesh;
      if ((m as THREE.Object3D).userData?.debrisRig && m.material) {
        (m.material as THREE.Material).dispose();
      }
    });
  }

  /**
   * A falling MAST section staves in whatever it lands on (its own deck once toppled, OR another
   * ship), via the ONE destruction rule: probe the spar body's volume against each ship grid and, at a
   * real closing speed, crush the cells beneath the contact on the ½·fallMass·v² energy budget (no
   * preset damage — THE LAW #4). Mirrors the rig.ts deck-penetration probe; uses the body's per-point
   * velocity (linvel + ω×r) so a tumbling spar's fast end hits harder than its pivot.
   */
  private mastLandingDamage(p: DebrisPiece, targets: Ship[]): void {
    const col = p.body.collider(0);
    if (!col) return;
    const he = (col as { halfExtents?: () => { x: number; y: number; z: number } }).halfExtents?.();
    if (!he) return;
    const inv = 1 / VOXEL_SIZE;
    const rot = p.body.rotation();
    this.ldQ.set(rot.x, rot.y, rot.z, rot.w);
    const tr = p.body.translation();
    const lin = p.body.linvel();
    const ang = p.body.angvel();
    const com = p.body.worldCom(); // world centre of mass (the cuboid centre we set)
    // sample a 3×3×3 lattice across the cuboid (centre at local (hx,hy,hz) = he); the body's local
    // origin is one corner, so the lattice spans [0,2he] = the whole spar.
    for (let ix = 0; ix <= 2; ix++) for (let iy = 0; iy <= 2; iy++) for (let iz = 0; iz <= 2; iz++) {
      const lx = he.x * ix, ly = he.y * iy, lz = he.z * iz; // body-local sample point
      this.ldWp.set(lx, ly, lz).applyQuaternion(this.ldQ);
      const wx = this.ldWp.x + tr.x, wy = this.ldWp.y + tr.y, wz = this.ldWp.z + tr.z;
      // velocity of this material point: v = linvel + ω × (p − com)
      const rx = wx - com.x, ry = wy - com.y, rz = wz - com.z;
      const vx = lin.x + (ang.y * rz - ang.z * ry);
      const vy = lin.y + (ang.z * rx - ang.x * rz);
      const vz = lin.z + (ang.x * ry - ang.y * rx);
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (speed < TUN.crush.vBreak) continue; // a slow rest must not keep eating the deck
      for (const S of targets) {
        const g = S.build.grid; const [bx, by, bz] = g.dims;
        S.worldToLocal(this.ldWl.set(wx, wy, wz), this.ldWl);
        const cvx = Math.floor(this.ldWl.x * inv), cvy = Math.floor(this.ldWl.y * inv), cvz = Math.floor(this.ldWl.z * inv);
        if (cvx < 0 || cvy < 0 || cvz < 0 || cvx >= bx || cvy >= by || cvz >= bz) continue;
        if (!g.isSolid(cvx, cvy, cvz)) continue;
        const cells = this.ldCells; cells.length = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const yy = cvy + dy, zz = cvz + dz;
          if (yy < 0 || zz < 0 || yy >= by || zz >= bz) continue;
          if (g.isSolid(cvx, yy, zz)) cells.push([cvx, yy, zz]);
        }
        const { removed } = S.crush(cells, 0.5 * TUN.rig.fallMass * speed * speed);
        if (removed > 0) this.effects?.crunch(this.ldWp.set(wx, wy, wz), removed);
        break; // one hull per sample point per step
      }
    }
  }

  /** Buoyancy + lifetime for every piece. Call each fixed step. `targets` (optional) are the live
   *  ship hulls a FALLING MAST can stave in as it lands (deck / another ship) — voxel-crush via
   *  ship.crush on the ½·fallMass·v² budget (THE LAW #4: energy-budgeted breaking, no preset damage).
   *  Omitted (or empty) ⇒ masts just float, no landing damage (back-compat for any 3-arg caller). */
  update(dt: number, simTime: number, waves: Wave[], targets: Ship[] = []): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      p.age += dt;
      const tr = p.body.translation();
      const lifetime = p.mast ? TUN.rig.fallLifetime : p.wreck ? WRECK_LIFETIME : LIFETIME;
      const sinkFloorY = p.mast ? -30 : p.wreck ? -40 : -60;
      if (p.age > lifetime || tr.y < sinkFloorY) {
        this.scene.remove(p.mesh);
        this.disposeRig(p); // free the cloned yard/sail materials a felled mast carried down
        this.physics.debrisBodies.delete(p.body.handle); // drop the stale handle (recycled by Rapier)
        this.physics.world.removeRigidBody(p.body);
        this.pieces.splice(i, 1);
        continue;
      }

      // LANDING DAMAGE: a heavy felled mast section staves in whatever it falls onto. Probe its body
      // points against the supplied ship grids; on a real-speed contact, crush the cells under it.
      if (p.mast && targets.length > 0) {
        if (p.impactArm && p.impactArm > 0) p.impactArm -= dt;
        else this.mastLandingDamage(p, targets);
      }

      p.body.resetForces(true);
      const rot = p.body.rotation();
      this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
      // A felled mast floats awash on its own decaying buoyancy: liftMul starts ≈neutral
      // (fallFloatBuoy) and waterlogs DOWN over ~tens of seconds. SPAR is FAR lighter than water
      // (density 120 vs 1025 → it floats at ~7% of `volume`'s lift), so to actually let it SLOWLY GO
      // UNDER by the end of its life the floor here is a small LOCAL value below that neutral point
      // (not TUN.rig.fallSinkFloor, which is tuned for the rig.ts lattice spar's heavier nodes); a
      // grace-period scale keeps it riding high for most of fallLifetime, then it slips beneath.
      if (p.mast) {
        const MAST_SINK_FLOOR = 0.04; // < the ~0.07 neutral ratio → eventually founders
        p.liftMul = Math.max((p.liftMul ?? 1) - TUN.rig.waterlog * dt, MAST_SINK_FLOOR);
      }
      const lift = p.mast ? (p.liftMul ?? 1) : p.wreck ? wreckLift(p.age) : 1;
      let wet = 0;
      for (const pr of p.probes) {
        this.tmpP.set(pr[0], pr[1], pr[2]).applyQuaternion(this.tmpQ);
        const wx = this.tmpP.x + tr.x;
        const wy = this.tmpP.y + tr.y;
        const wz = this.tmpP.z + tr.z;
        const surf = surfaceHeight(waves, wx, wz, simTime);
        const span = Math.max(p.halfHeight * 2, 0.1);
        const sub = Math.min(Math.max((surf - wy) / span, 0), 1);
        if (sub <= 0) continue;
        wet = Math.max(wet, sub);
        const f = ((WATER_DENSITY * G * p.volume * lift) / p.probes.length) * sub;
        p.body.addForceAtPoint({ x: 0, y: f, z: 0 }, { x: wx, y: wy, z: wz }, true);
      }
      if (wet > 0) {
        const v = p.body.linvel();
        const m = p.body.mass();
        // The vertical buoyancy spring was only ~0.18 of critically damped, so chunks
        // bobbed instead of settling. Raise VERTICAL damping near-critical to kill the
        // bob; keep HORIZONTAL light so wreckage still drifts calmly rather than freezing.
        // A felled mast uses the dev-tuned fallVertDamp so its float matches the rig.ts feel
        // (settles awash, no trampoline) and a touch of angular drag so the spar lies still.
        const kv = m * (p.mast ? TUN.rig.fallVertDamp : 6) * wet;
        const kh = m * 0.8 * wet;
        p.body.addForce({ x: -v.x * kh, y: -v.y * kv, z: -v.z * kh }, true);
        if (p.mast) {
          const av = p.body.angvel();
          const ka = m * 0.5 * wet;
          p.body.addTorque({ x: -av.x * ka, y: -av.y * ka, z: -av.z * ka }, true);
        }
      }

      // sync visual
      p.mesh.position.set(tr.x, tr.y, tr.z);
      p.mesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
    }
  }
}
