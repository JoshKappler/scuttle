import * as THREE from "three";
import { CHUNK_SIZE, VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import {
  barrelDirLocal,
  BARREL_INBOARD,
  BARREL_PIVOT_UP,
  BORE_UP_B,
  CHASER_INBOARD,
  GUN_INBOARD_M,
  GUN_SCALE,
  TIP_FROM_TRUNNION_B,
  TRUNNION_OUT_B,
  type GunFacing,
} from "../game/gunnery";
import { meshChunk } from "./voxelMesher";
import { CompartmentFluid } from "./compartmentFluid";
import type { Compartment } from "../sim/compartments";
import type { ShipBuild } from "../sim/shipwright";

/**
 * Binds a ship's voxel grid to renderable chunk meshes under one Group, plus
 * the non-voxel dressing that is STILL a mesh: the stern rudder blade, the helm
 * wheel, the cannons + gunports, and the stern ladder. The masts / yards / sails
 * / bowsprit are now real voxels in the grid (drawn by the chunk mesher + carved
 * by the unified crush), so they are no longer built here. Group origin = grid
 * (0,0,0) corner.
 */
export class ShipVisual {
  readonly group = new THREE.Group();
  private chunkMeshes = new Map<string, THREE.Mesh>();
  private hullMaterial: THREE.MeshStandardMaterial;
  /** OPAQUE iron used for the IRON/ballast face group (voxelMesher tags those faces). Distributed
   *  bilge iron shared the DoubleSide wood `hullMaterial` and read as a hollow translucent liner in
   *  the X cutaway; its own solid, dark, metallic material (with a self-lit floor so the cut-open
   *  interior doesn't crush it to black) reads as an unambiguous block of iron. */
  private ironMaterial: THREE.MeshStandardMaterial;
  /** Captured hull shader uniforms (set in onBeforeCompile) so animate() can drive the
   *  live shade-floor knob (TUN.gfx.hull.shadeFloor) without recompiling the material. */
  private hullUniforms: { [k: string]: THREE.IUniform } | null = null;
  /** True while the static half-cut is active: lifts the hull's self-lit shade floor so the
   *  cross-section interior (lower deck, compartments, flood water) reads as clearly-lit
   *  timber instead of crushing to a dark void on the faces turned away from the sun. */
  private cutawayOn = false;
  /** The active cutaway clip plane (null = off), stored so cannon meshes built (or rebuilt on a
   *  hull swap) AFTER setCutaway() still pick up the current clip state. */
  private cutawayPlane: THREE.Plane | null = null;
  /** Ship-LOCAL cull predicate while cut away (null = off): the hull mesher treats a cell as empty
   *  where this returns false, so the surviving far half's now-exposed inner faces emit a SOLID
   *  capped cross-section (no hollow shell / sliced-mid-voxel holes a clip plane gave). The cut is the
   *  ship's longitudinal centerline; the culled half is whichever side faces the camera (re-derived
   *  from the clip-plane normal each frame; we re-mesh only when that side FLIPS). */
  private cutawayPredicate: ((x: number, y: number, z: number) => boolean) | null = null;
  /** Ship-local beam-axis (Z) coordinate (cells) of the centerline cut, and the current cull sign
   *  (which half is hidden). Recomputed in setCutaway from the hull footprint; the sign is flipped
   *  per-frame by updateCutawayCull when the camera crosses the centerline. */
  private cutZCenterLocal = 0;
  private cutCullSign = 1;
  // scratch for the per-frame local-normal derivation (no per-frame allocation).
  private static tmpQuatInv = new THREE.Quaternion();
  private static tmpNormalLocal = new THREE.Vector3();
  /** Materials owned by the cannon meshes (barrel/trunnion/axle iron, carriage wood, gunport
   *  recess). They are clipped in lock-step with the hull so a gun on the cut-away half is sliced
   *  off too, instead of floating in the opened interior. All are per-ShipVisual-instance — the
   *  carriage wood is a CLONE of the shared rig woodMat so masts/wheel/rudder stay un-clipped, and
   *  setCutaway() is only ever called on the PLAYER ship, so enemy cannons are never touched. */
  private cannonMaterials: THREE.Material[] = [];
  private build: ShipBuild;

  /** Real clipped, world-leveled, sloshing flood fluid (round 14): replaced the
   *  emissive blue compartment cubes. */
  private fluid: CompartmentFluid;

  /** Real CC0 plank photos (ambientCG), shared by every ship. */
  private static deckTex: THREE.Texture | null = null;
  private static hullTex: THREE.Texture | null = null;
  private static loadWood(): { deck: THREE.Texture; hull: THREE.Texture } {
    if (!ShipVisual.deckTex) {
      const loader = new THREE.TextureLoader();
      const setup = (t: THREE.Texture) => {
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
      };
      // relative paths so they load under file:// in the packaged EXE — see universalModel.ts
      ShipVisual.deckTex = loader.load("assets/textures/deck.jpg", setup);
      ShipVisual.hullTex = loader.load("assets/textures/hull.jpg", setup);
      setup(ShipVisual.deckTex);
      setup(ShipVisual.hullTex);
    }
    return { deck: ShipVisual.deckTex, hull: ShipVisual.hullTex! };
  }

  constructor(build: ShipBuild) {
    this.build = build;
    this.hullMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.02,
      side: THREE.DoubleSide, // cutaway shows hull interior, not see-through walls
    });
    // real tileable plank textures, planar-mapped in SHIP-LOCAL space by the
    // face's dominant axis (greedy-mesh quads carry no UVs). Vertex color
    // still supplies material tint + baked AO; the photo supplies the wood.
    // Replaces the procedural sine grain (playtest: "static-like" shimmer).
    const wood = ShipVisual.loadWood();
    this.hullMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uDeckTex = { value: wood.deck };
      shader.uniforms.uHullTex = { value: wood.hull };
      shader.uniforms.uShadeFloor = { value: TUN.gfx.hull.shadeFloor };
      this.hullUniforms = shader.uniforms; // animate() drives uShadeFloor live
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vShipLocal;\nvarying vec3 vShipNormal;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvShipLocal = position;\nvShipNormal = normal;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          varying vec3 vShipLocal;
          varying vec3 vShipNormal;
          uniform sampler2D uDeckTex;
          uniform sampler2D uHullTex;
          uniform float uShadeFloor;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          {
            vec3 an = abs(vShipNormal);
            vec3 tex;
            if (an.y > 0.6) {
              tex = texture2D(uDeckTex, vShipLocal.zx * 0.22).rgb; // planks run fore-aft
            } else if (an.z >= an.x) {
              tex = texture2D(uHullTex, vShipLocal.xy * 0.22).rgb; // broadside strakes
            } else {
              tex = texture2D(uHullTex, vShipLocal.zy * 0.22).rgb; // bow/stern
            }
            // modulate AROUND the tint so the photo adds plank GRAIN without
            // lifting the overall tone. The bright plank photo × strong sun
            // kept reading as honey-tan even on a dark base, so the lift is now
            // small (round 9 v2: "still a very light color … darker wood of a
            // real pirate ship").
            diffuseColor.rgb *= 0.26 + tex * 0.62;
          }`,
        )
        .replace(
          "#include <emissivemap_fragment>",
          // SHADE FLOOR: the oak albedo is so low that a face out of the sun (fill-only)
          // reflected ~nothing and crushed to a black void. Add a minimum self-lit term
          // PROPORTIONAL to the wood's own diffuseColor (carries the plank grain + warm
          // tint, so it reads as dim wood, not a flat grey card). It lifts the dark/shaded
          // side hard while barely touching the already-bright sunlit side (same absolute
          // add over a much larger lit value). Fed BEFORE tonemap, well under bloom thr.
          `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * uShadeFloor;`,
        );
    };
    // ballast iron: a SOLID, opaque, dark-metal material for the IRON face group. vertexColors
    // carries the baked iron tint × AO (white base × that = the iron colour); higher metalness /
    // lower roughness reads as iron, not timber. transparent:false + depthWrite so it's never
    // translucent. DoubleSide (like the hull) so the centerline clip's cross-section through the
    // iron block stays FILLED (back faces render) instead of seeing through a hollow shell — the
    // distributed bilge iron used to read as a see-through liner because it SHARED the dark wood
    // material, not because of any transparency. A constant emissive keyed to the iron colour keeps
    // the revealed ballast from crushing to black in the cut-open interior (lifted while cut away).
    // CHARCOAL cast iron — matte, dark, NEUTRAL grey. Two earlier misses: metalness 0.85/roughness 0.34
    // caught the interior fill light as a blown-WHITE hotspot; then metalness 0.45 still reflected the cool
    // SKY as a "light BLUE" tint. Fix: drop metalness to near-nonmetal (no env mirror = no blue) + high
    // roughness (no spec hotspot), and a NEUTRAL self-lit grey floor so it reads as a solid charcoal iron
    // casting under any light. Lifted a touch while cut away (animate()) so the revealed block isn't a void.
    this.ironMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      color: 0x8a8a8a, // darken the neutral 0.09 iron vertex tint so it reads charcoal once lit (was 0xffffff)
      roughness: 0.9,
      metalness: 0.1,
      // Why the ballast read LIGHT GREY for ~10 rounds and NOTHING fixed it: TWO stacked, additive lifts,
      // both independent of the knobs everyone kept turning:
      //  1) the bright sky environment map lit the iron's DIFFUSE via IBL — independent of metalness, so
      //     the 0.85->0.45->0.1 metalness tweaks never touched it. envMapIntensity 0 kills that.
      //  2) THE one that survived even (1): a grey EMISSIVE self-glow (was 0.06 grey, boosted x1.5 in the
      //     cutaway below). Emissive is light the surface EMITS — added on top, independent of albedo,
      //     metalness AND env, so no lighting/reflection change could ever move it. Cut ~3x to a dark floor
      //     that still keeps the cut-open interior off pure black, but reads as dark iron, not a grey card.
      envMapIntensity: 0,
      transparent: false,
      depthWrite: true,
      side: THREE.DoubleSide,
      emissive: new THREE.Color(0.02, 0.02, 0.024),
      emissiveIntensity: 0.9,
    });
    this.remeshAll();
    this.addRig();
    // per-voxel flood fluid: water fills the compartment's interior cells (lowest world-Y
    // first), parented under the ship group. Replaces the round-14 clipped plane the player
    // saw as "blue rectangles not bound to the inside" — and the older deck-parallel cubes.
    this.fluid = new CompartmentFluid(this.build.compartments, this.build.grid.dims, this.build.deckY);
    // seed the fluid with the CURRENT cutaway clip (mirrors the cannon-material seed above): on a
    // hull swap setCutaway(cutPlane) is also re-applied by main.ts, but seeding here covers any
    // ordering and keeps the fresh hull's water sliced from birth if the cut is already on.
    this.fluid.setClipPlane(this.cutawayPlane);
    this.group.add(this.fluid.group);
    // NOTE: the old "interior shell" black box that used to hide the ocean
    // inside the hull during cutaway is gone — the ocean itself now gets a
    // hole punched around the ship (ocean.setCutawayHole), so the interior
    // shows real timber and real flood water only.
  }

  /** Per-frame mesh animation: the rudder + wheel answer the helm (smoothed, correct
   *  sense: port turn → trailing edge to port), and the cannon barrels track the aim
   *  (elevation AND traverse) on the aiming side. The masts/yards/sails are voxels now,
   *  so there is no more sail flutter/fill here — `_sailSet` is kept only so the call
   *  signature is unchanged for callers (it no longer drives anything). */
  animate(
    time: number,
    rudderNorm: number,
    _sailSet: number,
    aim?: { bearing: 1 | -1 | GunFacing; elevationDeg: number; traverseDeg: number } | null,
  ): void {
    const dt = Math.min(Math.max(time - this.lastAnimT, 0), 0.1);
    this.lastAnimT = time;
    this.dispRudder += (rudderNorm - this.dispRudder) * Math.min(dt * 6, 1);

    // live shade-floor knob; while cut away, lift it hard so the exposed interior reads
    // (the cut faces point INTO the hull, away from sun + sky, so without this they go black).
    if (this.hullUniforms) {
      this.hullUniforms.uShadeFloor.value = this.cutawayOn
        ? Math.max(TUN.gfx.hull.shadeFloor, 2.2)
        : TUN.gfx.hull.shadeFloor;
    }
    // lift the solid ballast's self-lit floor while cut away so the revealed iron reads as a solid charcoal
    // block, not a dark void on the faces turned away from the sun (matches the hull lift). Kept modest +
    // NEUTRAL so it never washes back to the old pale-white/blue — it's a grey floor against black, not a glow.
    // Boost cut WAY back (was 1.5): with emissive base 0.06 that ×1.5 = 0.09 linear of constant grey glow —
    // THE thing that read as "light grey ballast" no matter what (independent of albedo/metalness/env). Now a
    // dark floor (0.02 base × 1.0 = 0.02 linear) that lifts off pure black without washing it pale.
    this.ironMaterial.emissiveIntensity = this.cutawayOn ? 1.0 : 0.7;
    // rudder convention: sailing.rudder + = port turn → trailing edge swings
    // to PORT (−z). Blade extends aft (−x); rotation about +y of −0.55·r
    // puts the trailing edge at −z for +r. Wheel turns the same sense as a
    // real helm (left turn = counterclockwise from the helmsman).
    if (this.rudderPivot) this.rudderPivot.rotation.y = -this.dispRudder * 0.55;
    if (this.wheelSpin) this.wheelSpin.rotation.z = -this.dispRudder * 2.6;

    // (Masts/yards/sails/bowsprit are real grid voxels now — drawn by the chunk mesher and
    //  carved/severed in place by the unified crush, so there is no rig animation here.)

    // barrels share the gunnery module's direction math, so what you see is
    // exactly where the ball will go. Yaw-then-pitch keeps carriages upright
    // (a quaternion shortest-arc flip turned port cannons upside down).
    // Dissected guns: TRAVERSE slews the whole carriage, ELEVATION pitches
    // only the barrel about its trunnions (counter-rotated for baked tilt).
    for (const b of this.barrels) {
      // active when the aimed battery matches this gun: a chaser matches its facing,
      // a broadside gun matches its side.
      const active = !!aim && (b.facing ? aim.bearing === b.facing : aim.bearing === b.side);
      const d = barrelDirLocal(
        b.side,
        active ? aim.elevationDeg : 2,
        active ? aim.traverseDeg : 0,
        ShipVisual.tmpDir,
        b.facing,
      );
      const pitch = Math.asin(Math.min(Math.max(d.y, -1), 1));
      const yaw = Math.atan2(d.x, d.z);
      if (b.elev) {
        b.mesh.rotation.set(0, yaw, 0);
        b.elev.rotation.x = (b.tilt ?? 0) - pitch;
      } else {
        b.mesh.rotation.set(-pitch, yaw, 0);
      }
    }
  }

  private static tmpDir = new THREE.Vector3();

  /** Cutaway: a SOLID centerline half-cut of the hull (null disables). Instead of a GPU clip plane
   *  (which slices hollow boundary shells mid-voxel → hollow ballast + holes in the keel), we re-mesh
   *  the hull with a ship-LOCAL cull PREDICATE: the camera-near half of the longitudinal centerline
   *  reads as EMPTY, so the surviving far half's now-exposed inner faces emit a SOLID, capped cross-
   *  section of whole voxels (ballast = a solid iron block). The clip plane is STILL forwarded to the
   *  cannon meshes (smooth non-voxel geometry — clip them normally) and to the flood WATER (its custom
   *  shader honours the same plane), so guns + water on the cut-away half are sliced flush with the
   *  hull cross-section. The cull half follows the camera; see updateCutawayCull (re-meshes on flip). */
  setCutaway(plane: THREE.Plane | null): void {
    this.cutawayPlane = plane;
    const planes = plane ? [plane] : null;
    // NOTE: the hull + ballast iron are NO LONGER clip-plane clipped — the predicate cuts them as a
    // solid cross-section (a clip plane would double-cut and re-open the hollow-shell / holes bug).
    this.hullMaterial.clippingPlanes = null;
    this.hullMaterial.needsUpdate = true;
    this.ironMaterial.clippingPlanes = null;
    this.ironMaterial.needsUpdate = true;
    // cannons are smooth meshes (not voxels) → clip them with the plane as before.
    for (const m of this.cannonMaterials) {
      m.clippingPlanes = planes;
      m.needsUpdate = true;
    }
    // clip the interior FLOOD WATER in lock-step with the hull, with the SAME shared plane reference
    // (main.ts mutates it in place each frame). Without this the whole cut-away half's water floats
    // in the opened hull; CompartmentFluid's custom shader was given clipping:true + the clip includes
    // so the plane actually bites instead of silently no-opping.
    this.fluid.setClipPlane(plane);
    this.cutawayOn = !!plane; // animate() lifts the shade floor while cut away

    if (plane) {
      // the centerline in CELL coords is the grid's z-midpoint (footprint.zC === nz/2 · VOXEL_SIZE).
      this.cutZCenterLocal = this.build.grid.dims[2] / 2;
      // derive the initial cull side from the current (already camera-flipped) world plane normal.
      this.cutCullSign = this.cullSignFromPlane(plane);
      const zc = this.cutZCenterLocal;
      // a cell is VISIBLE (kept) when its beam-axis center sits on the kept side: with cullSign +1
      // we keep the −Z half, with −1 the +Z half. (z + 0.5) is the cell-center in cell units.
      this.cutawayPredicate = (_x: number, _y: number, z: number) =>
        (z + 0.5 - zc) * this.cutCullSign <= 0;
    } else {
      this.cutawayPredicate = null;
    }
    this.remeshAll(); // one-time re-mesh of every chunk with (or without) the cut applied
  }

  /** Which half to CULL, from the live (camera-flipped) world clip-plane normal mapped into ship-local
   *  space. main.ts points the normal at the half FACING AWAY from the camera (THREE keeps that side),
   *  so the kept half is the one the local normal's beam-axis (Z) component points toward; we cull the
   *  other. Returns +1 (cull +Z half, keep −Z) or −1 (cull −Z, keep +Z). */
  private cullSignFromPlane(plane: THREE.Plane): number {
    const qInv = ShipVisual.tmpQuatInv.copy(this.group.quaternion).invert();
    const nLocal = ShipVisual.tmpNormalLocal.copy(plane.normal).applyQuaternion(qInv);
    // local +Z normal → keep +Z → cull +Z must be FALSE → cullSign −1; local −Z → cullSign +1.
    return nLocal.z >= 0 ? -1 : 1;
  }

  /** If the camera has crossed the ship's centerline the kept half must swap so the open interior keeps
   *  facing the viewer. Cheap — a normal map + a sign compare — and only RE-MESHES on an actual flip
   *  (single-digit ms, like the initial mesh), never every frame. PUBLIC + called every frame from main.ts
   *  while cut away (refresh() also calls it on the damage path): refresh() is NOT run per-frame, so without
   *  this the hull half never re-culled as the camera orbited — only the cannons' clip plane followed. */
  updateCutawayCull(): void {
    if (!this.cutawayPlane || !this.cutawayPredicate) return;
    const sign = this.cullSignFromPlane(this.cutawayPlane);
    if (sign === this.cutCullSign) return; // same side → nothing to do
    this.cutCullSign = sign;
    this.remeshAll(); // re-mesh the whole hull with the cut now on the other half
  }

  /** Reflect current flooding levels. Call once per frame, AFTER syncVisual()
   *  so the ship group's transform is current (the fluid reads it to hold the
   *  surfaces world-level and to clip them to the heeled hull). Water shows
   *  whenever a compartment holds water — through hatches and shot holes, not
   *  only in cutaway (round 7: "the only time there should be water in the boat
   *  is when it is flooding … proportionate to how far along in the sinking
   *  process it is"). `cameraPos` shades the surface; `dt` advances the slosh. */
  updateWater(compartments: Compartment[], cameraPos: THREE.Vector3 | undefined, dt: number): void {
    this.fluid.update(compartments, cameraPos, dt);
  }

  /** A cannon loses its mount: HIDE the static gun mesh (the live physical fall is a falling
   *  body spawned by game/rig.ts) and report its current WORLD pose so the caller can spawn the
   *  toppling cannon exactly where it sat. Returns null if that port has no mesh (e.g. headless). */
  hideCannon(portIndex: number): { pos: THREE.Vector3; quat: THREE.Quaternion } | null {
    const rec = this.barrels.find((b) => b.portIndex === portIndex);
    if (!rec) return null;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    rec.mesh.getWorldPosition(pos);
    rec.mesh.getWorldQuaternion(quat);
    rec.mesh.visible = false;
    // drop the empty gunport frame + dark recess too, so the WHOLE gun goes — barrel, carriage AND
    // the framed port — instead of leaving the port surround floating where the gun used to sit.
    for (const m of this.gunportMeshes.get(portIndex) ?? []) m.visible = false;
    return { pos, quat };
  }

  /** Shrink the rudder blade as it's shot away (1 = whole, 0 = stump). */
  chipRudder(hpFrac: number): void {
    if (this.rudderBlade) this.rudderBlade.scale.y = 0.3 + 0.7 * hpFrac;
  }

  /** Chunks marked dirty by the grid that still owe a re-mesh, accumulated across frames so a wide
   *  hit (4–12 chunks) AMORTIZES over several frames at REMESH_BUDGET/frame instead of one 5–12 ms
   *  stall the instant wood comes off (the "massive lag when hitting ships" spike). The grid + collider
   *  stay synchronous (gameplay correct); only the visible mesh trails by a frame or two. A chunk re-
   *  dirtied while still queued stays a single entry (Set), so nothing is re-meshed twice or dropped. */
  private pendingRemesh = new Set<string>();
  /** Max chunks re-meshed per render frame on the damage path. Each meshChunk is a full 16³ greedy
   *  sweep (~0.3–1 ms); 3 keeps the per-frame mesh cost well under a frame while draining a typical
   *  ram's dirty set in 2–4 frames. The EXPLICIT remeshAll() (cutaway toggle / construction) ignores
   *  this — it is a deliberate one-time op and must finish the whole hull in the frame it runs. */
  private static REMESH_BUDGET = 3;

  /** Rebuild dirty chunks, BUDGETED to REMESH_BUDGET per frame so a wide hit doesn't fold a 12 ms
   *  stall into one frame. Also (while cut away) swaps the cull half if the camera has crossed the
   *  centerline — so the open cross-section keeps facing the viewer, and a chunk carved by a cannon
   *  DURING cutaway re-meshes with the cut still applied (remeshChunk reads this.cutawayPredicate
   *  live), making cutaway + live damage compose for free. */
  refresh(): void {
    this.updateCutawayCull(); // may remeshAll on a camera-side flip (drains pendingRemesh below)
    // Fold every newly-dirty chunk into the pending queue (dedups against any still-owed re-mesh),
    // then clear the grid's flag set — the queue, not dirtyChunks, now owns the outstanding work.
    const dirty = this.build.grid.dirtyChunks;
    if (dirty.size > 0) {
      for (const key of dirty) this.pendingRemesh.add(key);
      dirty.clear();
    }
    if (this.pendingRemesh.size === 0) return;
    // Drain up to the budget this frame; the rest carry to subsequent frames (each frame stays smooth).
    let done = 0;
    for (const key of this.pendingRemesh) {
      this.remeshChunk(key);
      this.pendingRemesh.delete(key);
      if (++done >= ShipVisual.REMESH_BUDGET) break;
    }
  }

  remeshAll(): void {
    const [nx, ny, nz] = this.build.grid.dims;
    for (let cx = 0; cx <= Math.floor((nx - 1) / CHUNK_SIZE); cx++) {
      for (let cy = 0; cy <= Math.floor((ny - 1) / CHUNK_SIZE); cy++) {
        for (let cz = 0; cz <= Math.floor((nz - 1) / CHUNK_SIZE); cz++) {
          this.remeshChunk(`${cx},${cy},${cz}`);
        }
      }
    }
    // a deliberate whole-hull pass (construction / cutaway toggle): every chunk is now freshly meshed,
    // so clear BOTH the grid's dirty flags AND any budgeted backlog — otherwise a queued pre-toggle
    // chunk would later re-mesh WITHOUT honoring the (now-changed) cut and reopen the half-cut bug.
    this.build.grid.dirtyChunks.clear();
    this.pendingRemesh.clear();
  }

  private remeshChunk(key: string): void {
    const [cx, cy, cz] = key.split(",").map(Number);
    const old = this.chunkMeshes.get(key);
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.chunkMeshes.delete(key);
    }
    // read the cutaway predicate LIVE each call (incl. the damage-driven refresh() path) so a chunk
    // carved during cutaway re-meshes with the cut still applied — cutaway + live damage for free.
    const data = meshChunk(this.build.grid, cx, cy, cz, this.cutawayPredicate ?? undefined);
    if (!data) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    // split into a WOOD group (hull material) + an IRON group (solid ballast material). The mesher
    // packs iron indices at the tail, so wood = [0, woodCount), iron = [woodCount, total). Only when
    // the chunk actually holds iron do we use the two-material array (else a plain single material).
    let mesh: THREE.Mesh;
    const total = data.indices.length;
    const ironCount = data.ironIndexCount;
    if (ironCount > 0) {
      const woodCount = total - ironCount;
      if (woodCount > 0) geo.addGroup(0, woodCount, 0);
      geo.addGroup(woodCount, ironCount, 1);
      mesh = new THREE.Mesh(geo, [this.hullMaterial, this.ironMaterial]);
    } else {
      mesh = new THREE.Mesh(geo, this.hullMaterial);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.chunkMeshes.set(key, mesh);
  }

  private rudderPivot: THREE.Group | null = null;
  private rudderBlade: THREE.Mesh | null = null;
  private wheelSpin: THREE.Group | null = null;
  /** Per gun: the yaw pivot, plus (once the GLB is dissected) the trunnion
   *  group that takes elevation and the sculpt's baked tilt to counter. */
  private barrels: { mesh: THREE.Object3D; portIndex: number; side: 1 | -1; elev?: THREE.Object3D; tilt?: number; facing?: GunFacing }[] = [];
  /** Per port: its decorative gunport frame + dark recess meshes, so when the gun is shot off its
   *  mount they're hidden ALONG WITH the carriage (else the empty frame floats where the gun sat —
   *  the "base of the cannon stays" bug). Keyed by portIndex; absent for guns with no framed port. */
  private gunportMeshes = new Map<number, THREE.Object3D[]>();
  private dispRudder = 0;
  private lastAnimT = 0;
  /** Local position of the ship's wheel — gameplay anchors helm control here. */
  wheelLocal: [number, number, number] = [0, 0, 0];
  /** Local position of the stern ladder — swimmers climb aboard here. */
  ladderLocal: [number, number, number] = [0, 0, 0];

  /** Shared procedural gun geometries (lathe barrel + carriage), built once. */
  private static gunGeo: {
    barrel: THREE.BufferGeometry;
    trun: THREE.CylinderGeometry;
    cheekF: THREE.BoxGeometry;
    cheekR: THREE.BoxGeometry;
    bed: THREE.BoxGeometry;
    axle: THREE.CylinderGeometry;
    wheelF: THREE.CylinderGeometry;
    wheelR: THREE.CylinderGeometry;
  } | null = null;

  /** Stern rudder, helm wheel, guns, stern ladder. The masts / yards / sails / bowsprit
   *  are now real voxels in the grid (drawn by the chunk mesher + carved by the unified
   *  crush), so they are no longer built or animated here. */
  private addRig(): void {
    // real wood photos on the still-mesh dressing (playtest round 5: "the … wooden
    // features have no wooden texture")
    const wood = ShipVisual.loadWood();
    const rigTex = wood.hull.clone();
    rigTex.repeat.set(1, 4);
    rigTex.needsUpdate = true;
    // dark weathered oak for the carriage, rudder, ladder and wheel —
    // 0xb89878 was a pale tan that read birch next to the hull (round 9)
    const woodMat = new THREE.MeshStandardMaterial({ map: rigTex, color: 0x5a4128, roughness: 0.85 });

    // stern rudder: hinged blade reaching below the keel for clear flow, and
    // UP the transom toward the deck so you can actually watch it answer the
    // helm (round 6: "the rudder should extend further upwards so that you
    // can actually see it turning when maneuvering")
    const sternX = 4 * VOXEL_SIZE;
    // SHIP-FEEL pass (Task 4): drop the blade ~1.2 m FARTHER DOWN so it clearly pokes BELOW the keel,
    // like a real stern rudder hung off the sternpost (the heel of a rudder hangs below the keel line
    // for clean flow). The blade is grown by this much and its centre dropped by half of it, so the
    // TOP stays where it was (still visible answering the helm) and only the BOTTOM reaches lower.
    const belowKeel = 1.2;
    const bladeH = this.build.deckY * VOXEL_SIZE * 0.95 + belowKeel;
    const bladeW = 0.9 + this.build.lengthM * 0.022; // chord grows with the ship
    this.rudderPivot = new THREE.Group();
    this.rudderPivot.position.set(sternX + 0.1, 1.8, (this.build.grid.dims[2] / 2) * VOXEL_SIZE);
    // a real blade, not a plank: rounded-rectangle profile extruded across the
    // thickness, corners arced and edges beveled (round 9: "the rudder should
    // have slightly curved corners and edges, not just a big plank of wood")
    const makeBlade = (w: number, h: number, thick: number): THREE.BufferGeometry => {
      const r = Math.min(w, h) * 0.24; // corner radius
      const x = -w / 2;
      const y = -h / 2;
      const sh = new THREE.Shape();
      sh.moveTo(x + r, y);
      sh.lineTo(x + w - r, y);
      sh.quadraticCurveTo(x + w, y, x + w, y + r);
      sh.lineTo(x + w, y + h - r);
      sh.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      sh.lineTo(x + r, y + h);
      sh.quadraticCurveTo(x, y + h, x, y + h - r);
      sh.lineTo(x, y + r);
      sh.quadraticCurveTo(x, y, x + r, y);
      const g = new THREE.ExtrudeGeometry(sh, {
        depth: thick,
        bevelEnabled: true,
        bevelThickness: 0.04,
        bevelSize: 0.04,
        bevelSegments: 2,
        steps: 1,
        curveSegments: 8,
      });
      g.translate(0, 0, -thick / 2); // center the slab on z
      return g;
    };
    const blade = new THREE.Mesh(makeBlade(bladeW, bladeH, 0.17), woodMat);
    // centre dropped by belowKeel/2 vs the old (bladeH/2 − 2.4) so the bottom reaches `belowKeel`
    // lower while the top is unchanged (bladeH also grew by belowKeel → top net-unchanged).
    blade.position.set(-bladeW / 2 - 0.05, bladeH / 2 - 2.4 - belowKeel, 0);
    // the heel (the bottom gudgeon block) follows the blade's new lower foot, hung below the keel line.
    const heel = new THREE.Mesh(makeBlade(bladeW + 0.6, 1.25, 0.17), woodMat);
    heel.position.set(-bladeW / 2 - 0.28, -1.7 - belowKeel, 0);
    this.rudderPivot.add(blade, heel);
    this.rudderBlade = blade;
    this.group.add(this.rudderPivot);

    // the wheel: classic spoked helm where the build says the helm stands
    // (the brig's quarterdeck — round 6: "the wheel being on that deck")
    const helm = new THREE.Group();
    const wx = this.build.wheelM.x;
    const wz = this.build.wheelM.z;
    const deckTopY = (this.build.deckYAt(Math.round(wx / VOXEL_SIZE)) + 1) * VOXEL_SIZE;
    helm.position.set(wx, deckTopY + 1.0, wz);
    this.wheelLocal = [wx, deckTopY + 1.0, wz];
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 1.0, 8), woodMat);
    post.position.y = -0.5;
    helm.add(post);
    this.wheelSpin = new THREE.Group();
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.05, 8, 18), woodMat);
    this.wheelSpin.add(rim);
    for (let s = 0; s < 6; s++) {
      const spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.25, 6), woodMat);
      spoke.rotation.z = (s * Math.PI) / 3;
      this.wheelSpin.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), woodMat);
    this.wheelSpin.add(hub);
    const axle = new THREE.Group();
    axle.rotation.y = Math.PI / 2; // wheel faces fore-aft
    axle.add(this.wheelSpin);
    helm.add(axle);
    this.group.add(helm);

    // cannons: procedural naval guns BUILT FROM the gunnery constants — a
    // lathe-profile barrel pitching about real trunnions while the stepped
    // oak carriage stays on its trucks. Round 6 retired the CC0 prop: it was
    // one merged mesh with ~37° of elevation baked into the sculpt, so it
    // could never point where the ball went.
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.45, metalness: 0.7 });
    // the carriage wood: a CLONE of the shared rig woodMat so the cutaway can clip the gun
    // carriage WITHOUT also slicing the masts/yards/rudder/helm/ladder/bowsprit that share woodMat.
    const gunWoodMat = woodMat.clone();
    if (!ShipVisual.gunGeo) {
      // classic gun profile, lathe axis +y, trunnion at y=0: cascabel ball,
      // breech ring, first reinforce, tapering chase, muzzle swell, bore face
      const prof = [
        [0.001, -0.62], [0.05, -0.6], [0.085, -0.52], [0.062, -0.45],
        [0.108, -0.43], [0.108, -0.3], [0.095, -0.28],
        [0.09, 0.42], [0.08, 0.46],
        [0.072, 1.18], [0.088, 1.24], [0.094, 1.28], [0.07, TIP_FROM_TRUNNION_B - 0.01],
        [0.045, TIP_FROM_TRUNNION_B], [0.001, TIP_FROM_TRUNNION_B],
      ].map(([r, y]) => new THREE.Vector2(r, y));
      const barrel = new THREE.LatheGeometry(prof, 14);
      barrel.rotateX(Math.PI / 2); // lathe axis → +z (muzzle outboard)
      ShipVisual.gunGeo = {
        barrel,
        trun: new THREE.CylinderGeometry(0.042, 0.042, 0.36, 8),
        cheekF: new THREE.BoxGeometry(0.07, 0.44, 0.62),
        cheekR: new THREE.BoxGeometry(0.07, 0.28, 0.4),
        bed: new THREE.BoxGeometry(0.3, 0.07, 1.0),
        axle: new THREE.CylinderGeometry(0.045, 0.045, 0.64, 8),
        wheelF: new THREE.CylinderGeometry(0.17, 0.17, 0.09, 12),
        wheelR: new THREE.CylinderGeometry(0.15, 0.15, 0.09, 12),
      };
    }
    const gg = ShipVisual.gunGeo;
    // r17: a dark, framed "gunport" window for the below-deck guns — the barrel pokes
    // through it; purely decorative, the hull voxels stay intact (built once per ship).
    const gunportFrameGeo = new THREE.BoxGeometry(0.84, 0.74, 0.1);
    const gunportHoleGeo = new THREE.BoxGeometry(0.66, 0.56, 0.18);
    const gunportMat = new THREE.MeshStandardMaterial({ color: 0x07070a, roughness: 1, metalness: 0 });
    // register the gun materials so setCutaway() clips them with the hull, and seed them with the
    // CURRENT clip state — covers a hull swap where setCutaway() ran before these were (re)built.
    this.cannonMaterials = [ironMat, gunWoodMat, gunportMat];
    if (this.cutawayPlane) {
      for (const m of this.cannonMaterials) m.clippingPlanes = [this.cutawayPlane];
    }
    const deckInPivot = -0.62; // the pivot origin floats 0.62 above the deck (model space)
    for (let portIndex = 0; portIndex < this.build.cannonPorts.length; portIndex++) {
      const port = this.build.cannonPorts[portIndex];
      const px = (port.x + 0.5) * VOXEL_SIZE;
      // r17: the gun's own height — deck guns store y = deckY+1 (unchanged), below-deck
      // chase guns a lower y. Mirrors pivotLocal() in gunnery exactly.
      const py = port.y * VOXEL_SIZE;
      const cyP = py + BARREL_PIVOT_UP;
      const pivot = new THREE.Group();
      pivot.rotation.order = "YXZ"; // yaw to bear, then elevate — never rolls
      pivot.scale.setScalar(GUN_SCALE);
      // pivot height + inboard offset mirror pivotLocal() in gunnery EXACTLY — the visible barrel
      // and the firing solution must seat at the same place (the "bore ≡ ballistics" invariant). A
      // chaser seats its carriage inboard along ±x (behind the bow / forward of the stern); a
      // broadside gun inboard along ±z by BARREL_INBOARD (WP2 2026-06-17: this was a hard-coded
      // 3.4 that drifted 0.2 m from gunnery's 2.6 — now both read the one constant, raised to 7.5
      // so the carriage nests inside the bulwark and only the muzzle clears the port).
      if (port.facing === "fore") {
        pivot.position.set((port.x + 0.5 - CHASER_INBOARD) * VOXEL_SIZE, cyP, (port.z + 0.5) * VOXEL_SIZE);
      } else if (port.facing === "aft") {
        pivot.position.set((port.x + 0.5 + CHASER_INBOARD) * VOXEL_SIZE, cyP, (port.z + 0.5) * VOXEL_SIZE);
      } else {
        const pz = (port.z + 0.5 - port.side * BARREL_INBOARD) * VOXEL_SIZE;
        pivot.position.set(px, cyP, pz - port.side * GUN_INBOARD_M);
      }
      // gun space: +z outboard for both sides (animate()'s yaw flips port)
      const elev = new THREE.Group();
      elev.position.set(0, BORE_UP_B, TRUNNION_OUT_B);
      const barrelMesh = new THREE.Mesh(gg.barrel, ironMat);
      barrelMesh.castShadow = true;
      const trun = new THREE.Mesh(gg.trun, ironMat);
      trun.rotation.z = Math.PI / 2; // trunnion axle crosses beam-wise
      elev.add(barrelMesh, trun);
      pivot.add(elev);
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, wheel = false) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z + TRUNNION_OUT_B);
        if (wheel) m.rotation.z = Math.PI / 2;
        m.castShadow = true;
        pivot.add(m);
      };
      // r18: a CHASER shows ONLY its barrel, run out through a hull window — NO wooden carriage.
      // Below the thick bow/stern the truck has no open deck to stand on and its cheeks + trucks
      // jut out the narrowing hull ("just the full cannon body poking straight through"). The
      // open-deck broadside guns keep their full carriage. The barrel still elevates/traverses.
      if (!port.facing) {
        for (const s of [-1, 1]) {
          add(gg.cheekF, gunWoodMat, s * 0.15, BORE_UP_B - 0.22, -0.02);
          add(gg.cheekR, gunWoodMat, s * 0.15, BORE_UP_B - 0.38, -0.45);
          add(gg.wheelF, gunWoodMat, s * 0.26, deckInPivot + 0.17, 0.18, true);
          add(gg.wheelR, gunWoodMat, s * 0.26, deckInPivot + 0.15, -0.55, true);
        }
        add(gg.bed, gunWoodMat, 0, deckInPivot + 0.09, -0.18);
        add(gg.axle, ironMat, 0, deckInPivot + 0.17, 0.18, true);
        add(gg.axle, ironMat, 0, deckInPivot + 0.15, -0.55, true);
      }
      this.group.add(pivot);
      this.barrels.push({ mesh: pivot, portIndex, side: port.side, elev, tilt: 0, facing: port.facing });

      // a framed gunport "window" where the barrel exits the hull skin: a wood surround with a
      // dark recess proud of the planking, the barrel running out through it. (The hull voxels
      // stay solid — carving a real hole would breach the watertight compartments the flooding
      // model relies on — so this painted-on port is what reads as the opening, exactly like the
      // broadside ports the player already accepts.)
      const wy = cyP - 0.12; // about the bore line
      if (port.facing === "fore" || port.facing === "aft") {
        // scan the bow/stern skin AT THE BORE LINE (~3 voxels above the carriage seat) so the
        // frame sits where the barrel actually pierces the hull, not floating off the curved stem.
        const dir = port.facing === "fore" ? 1 : -1;
        const [gnx] = this.build.grid.dims;
        const boreVox = port.y + 3;
        let sk = port.x;
        if (dir > 0) {
          for (let xx = gnx - 1; xx >= port.x; xx--) if (this.build.grid.isSolid(xx, boreVox, port.z)) { sk = xx; break; }
        } else {
          for (let xx = 0; xx <= port.x; xx++) if (this.build.grid.isSolid(xx, boreVox, port.z)) { sk = xx; break; }
        }
        const wx = (sk + (dir > 0 ? 1 : 0)) * VOXEL_SIZE; // outer face of the skin voxel
        const wz = (port.z + 0.5) * VOXEL_SIZE;
        const frame = new THREE.Mesh(gunportFrameGeo, gunWoodMat);
        frame.position.set(wx, wy, wz);
        frame.rotation.y = Math.PI / 2;
        const hole = new THREE.Mesh(gunportHoleGeo, gunportMat);
        hole.position.set(wx + dir * 0.05, wy, wz); // PROUD of the skin so the dark opening shows
        hole.rotation.y = Math.PI / 2;
        this.group.add(frame, hole);
        this.gunportMeshes.set(portIndex, [frame, hole]); // hidden with the gun when its mount is shot away
      } else if (port.y < this.build.deckY) {
        // a below-deck broadside gunport on the hull side
        const wz = (port.z + 0.5) * VOXEL_SIZE;
        const frame = new THREE.Mesh(gunportFrameGeo, gunWoodMat);
        frame.position.set(px, wy, wz);
        const hole = new THREE.Mesh(gunportHoleGeo, gunportMat);
        hole.position.set(px, wy, wz + port.side * 0.05);
        this.group.add(frame, hole);
        this.gunportMeshes.set(portIndex, [frame, hole]); // hidden with the gun when its mount is shot away
      }
    }

    // stern ladder: rungs down the transom to the waterline, so going
    // overboard is recoverable (playtest round 4: "no way to get back on").
    // On the brig the transom carries the quarterdeck, so it climbs higher.
    const ladder = new THREE.Group();
    const ladderTop = (this.build.deckYAt(4) + 5) * VOXEL_SIZE; // stern cap-rail height
    const ladderBot = 1.0; // dips under the waterline
    // OFFSET to port of the centerline: dead astern the rungs ran straight
    // through the rudder blade (round 9: "the ladder goes right through the
    // rudder, and should be moved to the left"). 1.1 m clears it cleanly.
    const lz = (this.build.grid.dims[2] / 2 - 4.4) * VOXEL_SIZE;
    const railGeo = new THREE.CylinderGeometry(0.035, 0.035, ladderTop - ladderBot, 6);
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(railGeo, woodMat);
      rail.position.set(0, (ladderTop + ladderBot) / 2, lz + s * 0.28);
      ladder.add(rail);
    }
    const rungGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.56, 6);
    rungGeo.rotateX(Math.PI / 2);
    for (let ry = ladderBot + 0.15; ry < ladderTop; ry += 0.42) {
      const rung = new THREE.Mesh(rungGeo, woodMat);
      rung.position.set(0, ry, lz);
      ladder.add(rung);
    }
    ladder.position.x = 0.88; // proud of the transom
    this.group.add(ladder);
    this.ladderLocal = [0.88, 2.0, lz];
    // NOTE: the bowsprit (like the masts/yards/sails) is real grid voxels now — it's
    // drawn by the chunk mesher + bored/snapped by the unified crush, not a mesh here.
  }
}
