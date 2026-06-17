import * as THREE from "three";
import { CHUNK_SIZE, VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import { SUN_DIR } from "./sky";
import {
  barrelDirLocal,
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
 * the non-voxel dressing: mast, boom, gaff sail, bowsprit (spec: sails and
 * spars are smooth geometry, not voxels). Group origin = grid (0,0,0) corner.
 */
/** One sail's hit rectangle (ship-local meters) + its puncture canvas. */
export interface SailRecord {
  mesh: THREE.Mesh;
  mastIdx: number;
  planeX: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
}

export class ShipVisual {
  readonly group = new THREE.Group();
  private chunkMeshes = new Map<string, THREE.Mesh>();
  private hullMaterial: THREE.MeshStandardMaterial;
  /** Captured hull shader uniforms (set in onBeforeCompile) so animate() can drive the
   *  live shade-floor knob (TUN.gfx.hull.shadeFloor) without recompiling the material. */
  private hullUniforms: { [k: string]: THREE.IUniform } | null = null;
  private build: ShipBuild;

  /** Real clipped, world-leveled, sloshing flood fluid (round 14): replaced the
   *  emissive blue compartment cubes. */
  private fluid: CompartmentFluid;
  /** Sails by mast, for ball-vs-cloth tests and hole decals. */
  readonly sails: SailRecord[] = [];
  /** the bowsprit spar mesh — detachBowsprit() hands a clone to game/rig.ts when it snaps off. */
  private spritMesh: THREE.Mesh | null = null;
  private mastRigs: {
    group: THREE.Group; fallT: number; fallAxis: THREE.Vector3;
    /** the trunk pole mesh — clipped (scaled down) to the stub on a mid-hit. */
    pole: THREE.Mesh;
    /** each spar/sail part with its mast-local foot height (m above the foot), so a
     *  detach can split the rig at the hit height: parts above the cut fall, below stay. */
    parts: { mesh: THREE.Mesh; yLocal: number }[];
    mastH: number;
    /** the FULL pole height (m) — restore target if the mast is repaired/reset. */
    poleH: number;
  }[] = [];

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
    this.remeshAll();
    this.addRig();
    // per-voxel flood fluid: water fills the compartment's interior cells (lowest world-Y
    // first), parented under the ship group. Replaces the round-14 clipped plane the player
    // saw as "blue rectangles not bound to the inside" — and the older deck-parallel cubes.
    this.fluid = new CompartmentFluid(this.build.compartments, this.build.grid.dims);
    this.group.add(this.fluid.group);
    // NOTE: the old "interior shell" black box that used to hide the ocean
    // inside the hull during cutaway is gone — the ocean itself now gets a
    // hole punched around the ship (ocean.setCutawayHole), so the interior
    // shows real timber and real flood water only.
  }

  /** Per-frame rig animation: sail flutter/fill, rudder + wheel answer the
   *  helm (smoothed, correct sense: port turn → trailing edge to port),
   *  cannon barrels track the aim (elevation AND traverse) on the aiming side. */
  animate(
    time: number,
    rudderNorm: number,
    sailSet: number,
    aim?: { bearing: 1 | -1 | GunFacing; elevationDeg: number; traverseDeg: number } | null,
  ): void {
    const dt = Math.min(Math.max(time - this.lastAnimT, 0), 0.1);
    this.lastAnimT = time;
    this.dispRudder += (rudderNorm - this.dispRudder) * Math.min(dt * 6, 1);

    if (this.sailUniforms) {
      this.sailUniforms.uTime.value = time;
      this.sailUniforms.uFill.value = 0.35 + 0.65 * sailSet;
      this.sailUniforms.uSailTrans.value = TUN.gfx.sail.glow; // live glow strength (sail stays opaque)
    }
    if (this.hullUniforms) this.hullUniforms.uShadeFloor.value = TUN.gfx.hull.shadeFloor; // live shade-floor knob
    // rudder convention: sailing.rudder + = port turn → trailing edge swings
    // to PORT (−z). Blade extends aft (−x); rotation about +y of −0.55·r
    // puts the trailing edge at −z for +r. Wheel turns the same sense as a
    // real helm (left turn = counterclockwise from the helmsman).
    if (this.rudderPivot) this.rudderPivot.rotation.y = -this.dispRudder * 0.55;
    if (this.wheelSpin) this.wheelSpin.rotation.z = -this.dispRudder * 2.6;

    // felled masts topple over their foot, hang, then slip into the sea
    for (const rig of this.mastRigs) {
      if (rig.fallT < 0) continue;
      rig.fallT += dt;
      const ang = Math.min(rig.fallT * rig.fallT * 1.1, 1.62);
      rig.group.quaternion.setFromAxisAngle(rig.fallAxis, ang);
      if (rig.fallT > 3) rig.group.position.y -= dt * 0.55;
      if (rig.fallT > 14) rig.group.visible = false;
    }

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

  /** Cutaway: clip the hull against a world-space plane (null disables). */
  setCutaway(plane: THREE.Plane | null): void {
    this.hullMaterial.clippingPlanes = plane ? [plane] : null;
    this.hullMaterial.needsUpdate = true;
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

  /** Tear a ragged shot hole in a sail at the ship-local crossing point. */
  puncture(rec: SailRecord, yLocal: number, zLocal: number): void {
    const ctx = rec.canvas.getContext("2d")!;
    const u = (rec.zMax - zLocal) / (rec.zMax - rec.zMin); // geometry is Y-rotated: +z maps to u=0
    const v = (yLocal - rec.yMin) / (rec.yMax - rec.yMin);
    const px = u * rec.canvas.width;
    const py = (1 - v) * rec.canvas.height;
    const rPx = ((0.4 + Math.random() * 0.35) / (rec.zMax - rec.zMin)) * rec.canvas.width;
    ctx.fillStyle = "#000";
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * rPx * 0.5;
      ctx.beginPath();
      ctx.arc(px + Math.cos(a) * d, py + Math.sin(a) * d, Math.max(rPx * (0.55 + Math.random() * 0.45), 1.5), 0, Math.PI * 2);
      ctx.fill();
    }
    rec.tex.needsUpdate = true;
  }

  /** A mast goes by the board. Build the REAL falling section as CLONES of the standing spars +
   *  sails (so the wreck looks like an actual mast WITH its canvas, not voxel confetti), HIDE /
   *  CLIP the corresponding static parts, and return the clone group + the pivot/centroid frame
   *  game/rig.ts drives rigidly each step. `cutLocalY` is the ship-local world-Y of the felling
   *  hit; parts whose foot sits above it fall, the rest stay as a standing stub. cutLocalY < the
   *  foot (or a foot/low hit) → the WHOLE mast falls (nothing left standing).
   *
   *  The clones are placed at their SPAWN WORLD transforms and the returned group is left at the
   *  scene's identity; game/rig.ts applies the rigid delta about `pivot` each frame. Returns null
   *  for an out-of-range / already-felled mast (or headless with no parts). */
  detachMast(mi: number, cutLocalY: number): {
    group: THREE.Group; pivot: THREE.Vector3;
  } | null {
    const rig = this.mastRigs[mi];
    if (!rig) return null;
    const deckTopWorldLocalY = rig.group.position.y; // mast group sits at (mx, deckTop, mz)
    // a part FALLS if its foot height clears the cut; on a foot/low hit cutLocalY is below the
    // foot so EVERY part falls and the whole static group is hidden.
    const cutAboveFoot = cutLocalY - deckTopWorldLocalY; // cut height measured from the mast foot
    const wholeMast = cutAboveFoot <= 0.5; // hit at/below the foot → topple the lot
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;

    const tmpP = new THREE.Vector3();
    const tmpQ = new THREE.Quaternion();
    const tmpS = new THREE.Vector3();
    const cloneInto = (mesh: THREE.Mesh) => {
      // a debris clone: plain opaque material (the billow shader doesn't survive Material.clone()
      // and a felled spar/sail doesn't billow). Keep the sail's alphaMap so shot holes still read.
      mesh.getWorldPosition(tmpP);
      mesh.getWorldQuaternion(tmpQ);
      mesh.getWorldScale(tmpS);
      const src = mesh.material as THREE.MeshStandardMaterial;
      const mat = new THREE.MeshStandardMaterial({
        color: src.color.clone(), map: src.map ?? null, roughness: src.roughness,
        side: THREE.DoubleSide,
      });
      if (src.alphaMap) { mat.alphaMap = src.alphaMap; mat.alphaTest = src.alphaTest; }
      const c = new THREE.Mesh(mesh.geometry, mat);
      c.position.copy(tmpP); c.quaternion.copy(tmpQ); c.scale.copy(tmpS);
      c.castShadow = true;
      holder.add(c);
    };

    // --- the trunk pole: clone the section ABOVE the cut, clip the static pole to the stub below ---
    // the pole spans local y∈[-0.5, mastH-0.5]; world-local foot = deckTop-0.5, top = deckTop+mastH-0.5.
    if (wholeMast) {
      cloneInto(rig.pole);
      rig.pole.visible = false;
    } else {
      // split the pole at cutAboveFoot: clone a top cylinder, shrink the standing one to the stub.
      const fullH = rig.poleH;
      const cutA = Math.min(Math.max(cutAboveFoot + 0.5, 0.5), fullH - 0.5); // pole-local distance from its base
      const topH = fullH - cutA;
      if (topH > 0.4) {
        const topGeo = new THREE.CylinderGeometry(rig.mastH * 0.006, rig.mastH * 0.009, topH, 8);
        topGeo.userData.ownDispose = true; // unique to this clone → game/rig.ts disposes it on despawn
        const topMesh = new THREE.Mesh(topGeo, (rig.pole.material as THREE.Material));
        // place it where the upper pole section sits, in mast-local then to world
        topMesh.position.set(0, (cutA - 0.5) + topH / 2, 0);
        rig.group.add(topMesh); // momentarily, to read its world transform
        topMesh.updateWorldMatrix(true, false);
        cloneInto(topMesh);
        rig.group.remove(topMesh);
        // NOTE: topGeo is now owned by the clone — do NOT dispose here.
      }
      // shrink the standing pole down to the stub (scale a centered cylinder so its base stays put)
      const stubH = cutA;
      rig.pole.scale.y = stubH / fullH;
      rig.pole.position.y = stubH / 2 - 0.5;
    }

    // --- yards + sails: each falls if its foot clears the cut; else it stays on the stub ----------
    for (const part of rig.parts) {
      const aboveCut = wholeMast || part.yLocal > cutAboveFoot;
      if (!aboveCut) continue;
      cloneInto(part.mesh);
      part.mesh.visible = false;
    }

    // pivot = the mast FOOT world point (the standing stub's break face) — game/rig.ts rotates the
    // falling section about a point near here; the exact value is refined to the chunk centroid there.
    const pivot = new THREE.Vector3();
    rig.group.getWorldPosition(pivot);
    return { group: holder, pivot };
  }

  /** The bowsprit snaps off (Task 9): clone the real spar as a falling-debris mesh and HIDE the
   *  static one. Returns the clone group at the scene identity (game/rig.ts drives it rigidly) +
   *  its spawn-world centroid as the pivot. Null if there's no spar mesh (headless / already gone). */
  detachBowsprit(): { group: THREE.Group; pivot: THREE.Vector3 } | null {
    const sprit = this.spritMesh;
    if (!sprit || !sprit.visible) return null;
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    sprit.getWorldPosition(pos);
    sprit.getWorldQuaternion(quat);
    sprit.getWorldScale(scl);
    // a FRESH debris material (its map texture is shared, which is fine) so game/rig.ts can dispose
    // the falling clone's material on despawn without touching the live ship's shared woodMat.
    const src = sprit.material as THREE.MeshStandardMaterial;
    const mat = new THREE.MeshStandardMaterial({ color: src.color.clone(), map: src.map ?? null, roughness: src.roughness });
    const c = new THREE.Mesh(sprit.geometry, mat);
    c.position.copy(pos); c.quaternion.copy(quat); c.scale.copy(scl);
    c.castShadow = true;
    holder.add(c);
    sprit.visible = false;
    return { group: holder, pivot: pos.clone() };
  }

  /** True while the bowsprit spar mesh is still standing (game/rig.ts gates its detach on this). */
  get bowspritStanding(): boolean { return !!this.spritMesh && this.spritMesh.visible; }

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
    return { pos, quat };
  }

  /** Shrink the rudder blade as it's shot away (1 = whole, 0 = stump). */
  chipRudder(hpFrac: number): void {
    if (this.rudderBlade) this.rudderBlade.scale.y = 0.3 + 0.7 * hpFrac;
  }

  /** Rebuild every chunk that the grid has marked dirty. */
  refresh(): void {
    const dirty = this.build.grid.dirtyChunks;
    if (dirty.size === 0) return;
    for (const key of dirty) this.remeshChunk(key);
    dirty.clear();
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
    this.build.grid.dirtyChunks.clear();
  }

  private remeshChunk(key: string): void {
    const [cx, cy, cz] = key.split(",").map(Number);
    const old = this.chunkMeshes.get(key);
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
      this.chunkMeshes.delete(key);
    }
    const data = meshChunk(this.build.grid, cx, cy, cz);
    if (!data) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(data.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(data.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const mesh = new THREE.Mesh(geo, this.hullMaterial);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.chunkMeshes.set(key, mesh);
  }

  private sailUniforms: { uTime: { value: number }; uFill: { value: number }; uSailTrans: { value: number } } | null = null;
  private rudderPivot: THREE.Group | null = null;
  private rudderBlade: THREE.Mesh | null = null;
  private wheelSpin: THREE.Group | null = null;
  /** Per gun: the yaw pivot, plus (once the GLB is dissected) the trunnion
   *  group that takes elevation and the sculpt's baked tilt to counter. */
  private barrels: { mesh: THREE.Object3D; portIndex: number; side: 1 | -1; elev?: THREE.Object3D; tilt?: number; facing?: GunFacing }[] = [];
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

  /** Square rig + bowsprit, stern rudder, helm wheel, guns, stern ladder. */
  private addRig(): void {
    // real wood + fabric photos on the rig (playtest round 5: "the mast and
    // other wooden features have no wooden texture"; the canvas sail looked
    // "like a piece of lined notebook paper")
    const wood = ShipVisual.loadWood();
    const rigTex = wood.hull.clone();
    rigTex.repeat.set(1, 4);
    rigTex.needsUpdate = true;
    // dark weathered oak for every spar, carriage, rudder, ladder and wheel —
    // 0xb89878 was a pale tan that read birch next to the hull (round 9)
    const woodMat = new THREE.MeshStandardMaterial({ map: rigTex, color: 0x5a4128, roughness: 0.85 });
    const sailTex = new THREE.TextureLoader().load("assets/textures/sail.jpg", (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.repeat.set(3, 2.2);
    });

    // billow + flutter in the vertex stage; uFill scales the belly with sail
    // set. SQUARE RIG: the sail hangs between two yards (top/bottom pinned by
    // sin(πv)) and bellies FORWARD along its normal — a vertical bulge, per
    // playtest ("billow out vertically, not in a horizontal curve")
    this.sailUniforms = { uTime: { value: 0 }, uFill: { value: 1 }, uSailTrans: { value: TUN.gfx.sail.glow } };
    const su = this.sailUniforms;
    // shared constants for the sail back-light: the world sun direction + a warm tint
    // for the light transmitted through the canvas (consumed in the fragment inject below).
    const uSunDirW = { value: SUN_DIR.clone() };
    const uSailSun = { value: new THREE.Color(1.0, 0.84, 0.62) };
    const injectBillow = (shader: { uniforms: Record<string, unknown>; vertexShader: string; fragmentShader: string }) => {
      shader.uniforms.uTime = su.uTime;
      shader.uniforms.uFill = su.uFill;
      shader.uniforms.uSailTrans = su.uSailTrans;
      shader.uniforms.uSunDirW = uSunDirW;
      shader.uniforms.uSailSun = uSailSun;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float uTime;\nuniform float uFill;\nattribute float aBelly;\nvarying vec3 vSailWN;",
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          {
            // uv.y: 0 at one yard → 1 at the other (both pinned, vertical
            // bulge between); uv.x: edges nearly pinned by the sheets.
            // Geometry is pre-rotated: +x is FORWARD, away from the mast.
            // aBelly carries each sail's own depth (∝ its width) — a flat
            // 1 m bulge on a 15 m course read as paper (round 6.5)
            // sin(uv.y·π) is 0 at each yard: BOTH the belly and the flutter
            // vanish where the cloth is laced to the spar, so the head and
            // foot stay welded to the wood while the body breathes. Round 8's
            // flutter had no such envelope — the laced edges floated off the
            // yards and snapped back ("warbles … parts that are supposed to be
            // attached to the wood float away and then return", round 9).
            float yardPin = sin(uv.y * 3.14159);
            float belly = yardPin * (0.35 + 0.65 * sin(uv.x * 3.14159)) * aBelly * uFill;
            float flutter = sin(uTime * 4.6 + uv.x * 8.0 + uv.y * 5.0) * (0.04 + aBelly * 0.03) * uFill * yardPin;
            transformed.x += belly + flutter;
          }
          // world-space cloth normal, for the back-light term in the fragment
          vSailWN = normalize(mat3(modelMatrix) * normal);`,
        );
      // back-lit translucency: when the sun lights the FAR side of the thin canvas, that
      // light "leaks" through to the side we're viewing — a sail shaded from the front
      // glows warmly instead of going flat-dark. gl_FrontFacing picks the viewed side
      // (DoubleSide); the amount ∝ how squarely the sun strikes the far face, tinted warm
      // and modulated by the cloth texture so the weave still reads through the glow.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vSailWN;\nuniform vec3 uSunDirW;\nuniform vec3 uSailSun;\nuniform float uSailTrans;",
        )
        .replace(
          "#include <opaque_fragment>",
          `{
            vec3 wnf = normalize(vSailWN);
            if (!gl_FrontFacing) wnf = -wnf;                      // normal facing the viewer
            float backlit = max(dot(-wnf, normalize(uSunDirW)), 0.0); // sun lighting the far side
            // pow 0.8 (was 1.5): real backlit cloth scatters light BROADLY, so the glow
            // should fall off gently — a tight specular lobe only lit the sail at the exact
            // sun-dead-behind angle and read as "not there". A broad lobe glows across a
            // wide arc of headings, so it actually shows on every ship as it sails.
            backlit = pow(backlit, 0.8);
            float texL = dot(diffuseColor.rgb, vec3(0.3333));
            // ADD warm light only — the cloth itself stays fully opaque (same texture)
            totalEmissiveRadiance += uSailSun * (uSailTrans * backlit * (0.45 + 0.55 * texL));
          }
          #include <opaque_fragment>`,
        );
    };
    // every sail needs its OWN material (its own puncture alphaMap), and
    // Material.clone() does NOT carry onBeforeCompile — round 7's first cut
    // cloned the base and every sail went paper-flat. Build each from scratch.
    const newSailMaterial = () => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xe8dfc8,
        map: sailTex,
        roughness: 0.95,
        side: THREE.DoubleSide,
      });
      m.onBeforeCompile = injectBillow;
      return m;
    };

    this.build.masts.forEach((m, mi) => {
      const mastH = m.h;
      const deckTop = (this.build.deckYAt(m.x) + 1) * VOXEL_SIZE;
      const mx = (m.x + 0.5) * VOXEL_SIZE;
      const mz = (m.z + 0.5) * VOXEL_SIZE;

      // every spar and sail of one mast lives under ONE group pivoted at its
      // FOOT, so shooting the foot out drops the whole rig as a unit
      // (round 7: "taking out a ship's mast at the bottom will cause the
      // entire thing to fall down")
      const mastGroup = new THREE.Group();
      mastGroup.position.set(mx, deckTop, mz);
      this.group.add(mastGroup);
      // tip abeam (alternating side per mast) and a touch aft
      const df = new THREE.Vector3(-0.4, 0, mi % 2 === 0 ? 1 : -1).normalize();
      // parts list (yards + sails) with each part's local foot-height, filled below — lets
      // detachMast(mi, cutY) split the rig at the hit height (above = falls, below = stub).
      const parts: { mesh: THREE.Mesh; yLocal: number }[] = [];

      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(mastH * 0.006, mastH * 0.012, mastH, 8),
        woodMat,
      );
      mast.position.set(0, mastH / 2 - 0.5, 0);
      mast.castShadow = true;
      mastGroup.add(mast);

      this.mastRigs.push({
        group: mastGroup,
        fallT: -1,
        fallAxis: new THREE.Vector3(df.z, 0, -df.x), // up × df
        pole: mast,
        parts,
        mastH,
        poleH: mastH,
      });

      // square rig, canvas up to the masthead (playtest round 4): three
      // yards crossing the FORE side of the mast, two tapered sails laced
      // tight between consecutive yards. Round 10: the yards and the sail used
      // to float just in front of the mast (and each other) — now the yard is
      // slung ONTO the mast (its after side buried in the trunk) and the sail
      // is laced to the yard's fore face, so mast↔yard↔sail all intersect as if
      // really attached. Yards thickened so they read as real spars.
      const mastR = mastH * 0.009; // ~trunk radius at the yards
      const yardR = 0.12; // thicker than the old 0.07
      const yardOff = mastR + yardR * 0.4; // yard buried into the mast front
      const sailOff = yardOff + yardR; // sail laced to the yard's fore face
      const levels = [
        { y: mastH * 0.17, w: mastH * 0.71 }, // course yard
        { y: mastH * 0.56, w: mastH * 0.57 }, // topsail yard
        { y: mastH * 0.88, w: mastH * 0.43 }, // topgallant yard
      ];
      for (const lv of levels) {
        const yardGeo = new THREE.CylinderGeometry(yardR, yardR, lv.w + 0.3, 8);
        yardGeo.rotateX(Math.PI / 2); // axis beam-wise
        const yard = new THREE.Mesh(yardGeo, woodMat);
        yard.position.set(yardOff, lv.y, 0);
        yard.castShadow = true;
        mastGroup.add(yard);
        parts.push({ mesh: yard, yLocal: lv.y });
      }
      for (let i = 0; i < levels.length - 1; i++) {
        const foot = levels[i];
        const head = levels[i + 1];
        const h = head.y - foot.y - 0.12; // laced to both yards, no air gap
        const geo = new THREE.PlaneGeometry(foot.w, h, 14, 10);
        // taper the head to the upper yard's span (trapezoid, like real canvas)
        const pos = geo.attributes.position as THREE.BufferAttribute;
        for (let vi = 0; vi < pos.count; vi++) {
          const f = (pos.getY(vi) + h / 2) / h; // 0 at foot → 1 at head
          pos.setX(vi, pos.getX(vi) * (1 - f + (f * head.w) / foot.w));
        }
        geo.rotateY(Math.PI / 2); // width spans the beam; normal points forward
        const bellyArr = new Float32Array(pos.count).fill(foot.w * 0.17);
        geo.setAttribute("aBelly", new THREE.BufferAttribute(bellyArr, 1));

        // every sail carries its own puncture canvas (white = cloth, black =
        // shot holes) wired as an alphaMap from birth so the shader program
        // never changes — balls tear it instead of passing through (round 7)
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const cctx = canvas.getContext("2d")!;
        cctx.fillStyle = "#fff";
        cctx.fillRect(0, 0, 128, 128);
        const tex = new THREE.CanvasTexture(canvas);
        const mat = newSailMaterial();
        mat.alphaMap = tex;
        mat.alphaTest = 0.45;

        const sail = new THREE.Mesh(geo, mat);
        sail.position.set(sailOff, (foot.y + head.y) / 2, 0);
        sail.castShadow = true;
        mastGroup.add(sail);
        parts.push({ mesh: sail, yLocal: (foot.y + head.y) / 2 });

        this.sails.push({
          mesh: sail,
          mastIdx: mi,
          planeX: mx + sailOff,
          yMin: deckTop + foot.y,
          yMax: deckTop + head.y,
          zMin: mz - foot.w / 2,
          zMax: mz + foot.w / 2,
          canvas,
          tex,
        });
      }
    });

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
      // pivot height + inboard offset mirror pivotLocal() in gunnery. A chaser seats its
      // carriage inboard along ±x (behind the bow / forward of the stern); a broadside
      // gun inboard along ±z (3.4 plants all four trucks on deck, round 9).
      if (port.facing === "fore") {
        pivot.position.set((port.x + 0.5 - CHASER_INBOARD) * VOXEL_SIZE, cyP, (port.z + 0.5) * VOXEL_SIZE);
      } else if (port.facing === "aft") {
        pivot.position.set((port.x + 0.5 + CHASER_INBOARD) * VOXEL_SIZE, cyP, (port.z + 0.5) * VOXEL_SIZE);
      } else {
        const pz = (port.z + 0.5 - port.side * 3.4) * VOXEL_SIZE;
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
          add(gg.cheekF, woodMat, s * 0.15, BORE_UP_B - 0.22, -0.02);
          add(gg.cheekR, woodMat, s * 0.15, BORE_UP_B - 0.38, -0.45);
          add(gg.wheelF, woodMat, s * 0.26, deckInPivot + 0.17, 0.18, true);
          add(gg.wheelR, woodMat, s * 0.26, deckInPivot + 0.15, -0.55, true);
        }
        add(gg.bed, woodMat, 0, deckInPivot + 0.09, -0.18);
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
        const frame = new THREE.Mesh(gunportFrameGeo, woodMat);
        frame.position.set(wx, wy, wz);
        frame.rotation.y = Math.PI / 2;
        const hole = new THREE.Mesh(gunportHoleGeo, gunportMat);
        hole.position.set(wx + dir * 0.05, wy, wz); // PROUD of the skin so the dark opening shows
        hole.rotation.y = Math.PI / 2;
        this.group.add(frame, hole);
      } else if (port.y < this.build.deckY) {
        // a below-deck broadside gunport on the hull side
        const wz = (port.z + 0.5) * VOXEL_SIZE;
        const frame = new THREE.Mesh(gunportFrameGeo, woodMat);
        frame.position.set(px, wy, wz);
        const hole = new THREE.Mesh(gunportHoleGeo, gunportMat);
        hole.position.set(px, wy, wz + port.side * 0.05);
        this.group.add(frame, hole);
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

    // bowsprit: a real spar scaled to the hull, ROOTED on the foredeck — its
    // heel sits 2 m inboard of the stem so it visibly belongs to the ship
    // (round 6.5: "the front mast … is floating slightly ahead of the ship")
    const spritLen = this.build.lengthM * 0.28;
    const steeve = 0.3; // radians above horizontal
    const sprit = new THREE.Mesh(
      new THREE.CylinderGeometry(spritLen * 0.014, spritLen * 0.028, spritLen, 8),
      woodMat,
    );
    sprit.rotation.z = -Math.PI / 2 + steeve;
    const stemX = this.build.footprint.maxX - 1.5; // true bow tip (margin off)
    const heelX = stemX - 2.0;
    const bowDeckTop = (this.build.deckY + 2) * VOXEL_SIZE;
    sprit.position.set(
      heelX + (Math.cos(steeve) * spritLen) / 2,
      bowDeckTop + (Math.sin(steeve) * spritLen) / 2 - 0.15,
      (this.build.grid.dims[2] / 2) * VOXEL_SIZE,
    );
    sprit.castShadow = true;
    this.group.add(sprit);
    this.spritMesh = sprit;
  }
}
