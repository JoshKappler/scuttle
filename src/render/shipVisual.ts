import * as THREE from "three";
import { CHUNK_SIZE, VOXEL_SIZE } from "../core/constants";
import { barrelDirLocal, BORE_UP, TIP_FROM_TRUNNION, TRUNNION_OUT } from "../game/gunnery";
import { meshChunk } from "./voxelMesher";
import type { Compartment } from "../sim/compartments";
import type { ShipBuild } from "../sim/shipwright";

/**
 * Binds a ship's voxel grid to renderable chunk meshes under one Group, plus
 * the non-voxel dressing: mast, boom, gaff sail, bowsprit (spec: sails and
 * spars are smooth geometry, not voxels). Group origin = grid (0,0,0) corner.
 */
export class ShipVisual {
  readonly group = new THREE.Group();
  private chunkMeshes = new Map<string, THREE.Mesh>();
  private hullMaterial: THREE.MeshStandardMaterial;
  private build: ShipBuild;

  private waterMeshes = new Map<number, THREE.Mesh>();

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
      ShipVisual.deckTex = loader.load("/assets/textures/deck.jpg", setup);
      ShipVisual.hullTex = loader.load("/assets/textures/hull.jpg", setup);
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
          uniform sampler2D uHullTex;`,
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
            // modulate AROUND 1 so the photo adds plank detail without
            // crushing the base tint to black (first attempt did exactly that)
            diffuseColor.rgb *= 0.55 + tex * 1.5;
          }`,
        );
    };
    this.remeshAll();
    this.addRig();
    this.addWaterPlanes();
    // NOTE: the old "interior shell" black box that used to hide the ocean
    // inside the hull during cutaway is gone — the ocean itself now gets a
    // hole punched around the ship (ocean.setCutawayHole), so the interior
    // shows real timber and real flood water only.
  }

  /** One translucent box per compartment, scaled to its fill level. */
  private addWaterPlanes(): void {
    // self-lit: the hull interior is in deep shadow during cutaway, and an
    // unlit water box read as just more darkness (playtest round 4)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2e8aa0,
      emissive: 0x1a5a6a,
      emissiveIntensity: 0.85,
      transparent: true,
      opacity: 0.85,
      roughness: 0.2,
      depthWrite: false,
    });
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0); // origin at the bottom face
    for (const c of this.build.compartments) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.waterMeshes.set(c.id, mesh);
    }
  }

  /** Per-frame rig animation: sail flutter/fill, rudder + wheel answer the
   *  helm (smoothed, correct sense: port turn → trailing edge to port),
   *  cannon barrels track the aim (elevation AND traverse) on the aiming side. */
  animate(
    time: number,
    rudderNorm: number,
    sailSet: number,
    aim?: { side: 1 | -1; elevationDeg: number; traverseDeg: number } | null,
  ): void {
    const dt = Math.min(Math.max(time - this.lastAnimT, 0), 0.1);
    this.lastAnimT = time;
    this.dispRudder += (rudderNorm - this.dispRudder) * Math.min(dt * 6, 1);

    if (this.sailUniforms) {
      this.sailUniforms.uTime.value = time;
      this.sailUniforms.uFill.value = 0.35 + 0.65 * sailSet;
    }
    // rudder convention: sailing.rudder + = port turn → trailing edge swings
    // to PORT (−z). Blade extends aft (−x); rotation about +y of −0.55·r
    // puts the trailing edge at −z for +r. Wheel turns the same sense as a
    // real helm (left turn = counterclockwise from the helmsman).
    if (this.rudderPivot) this.rudderPivot.rotation.y = -this.dispRudder * 0.55;
    if (this.wheelSpin) this.wheelSpin.rotation.z = -this.dispRudder * 2.6;

    // barrels share the gunnery module's direction math, so what you see is
    // exactly where the ball will go. Yaw-then-pitch keeps carriages upright
    // (a quaternion shortest-arc flip turned port cannons upside down).
    // Dissected guns: TRAVERSE slews the whole carriage, ELEVATION pitches
    // only the barrel about its trunnions (counter-rotated for baked tilt).
    for (const b of this.barrels) {
      const active = aim && b.side === aim.side;
      const d = barrelDirLocal(
        b.side,
        active ? aim.elevationDeg : 2,
        active ? aim.traverseDeg : 0,
        ShipVisual.tmpDir,
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

  private cutawayActive = false;

  /** Cutaway: clip the hull against a world-space plane (null disables).
   *  Water boxes render ONLY during cutaway — always-on, they could bleed
   *  through the hull from outside ("blue cubic rectangle on the bottom of
   *  the ship", playtest round 5). */
  setCutaway(plane: THREE.Plane | null): void {
    this.cutawayActive = plane !== null;
    this.hullMaterial.clippingPlanes = plane ? [plane] : null;
    this.hullMaterial.needsUpdate = true;
  }

  /** Reflect current flooding levels. Call once per frame. */
  updateWater(compartments: Compartment[]): void {
    for (const c of compartments) {
      const mesh = this.waterMeshes.get(c.id);
      if (!mesh) continue;
      const fill = c.waterVolume / c.volume;
      if (fill < 0.01 || !this.cutawayActive) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      const w = (c.bboxMax[0] + 1 - c.bboxMin[0]) * VOXEL_SIZE;
      const h = (c.bboxMax[1] + 1 - c.bboxMin[1]) * VOXEL_SIZE;
      const d = (c.bboxMax[2] + 1 - c.bboxMin[2]) * VOXEL_SIZE;
      mesh.position.set(
        ((c.bboxMin[0] + c.bboxMax[0] + 1) / 2) * VOXEL_SIZE,
        c.bboxMin[1] * VOXEL_SIZE,
        ((c.bboxMin[2] + c.bboxMax[2] + 1) / 2) * VOXEL_SIZE,
      );
      mesh.scale.set(w * 0.98, Math.max(h * fill, 0.02), d * 0.98);
    }
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

  private sailUniforms: { uTime: { value: number }; uFill: { value: number } } | null = null;
  private rudderPivot: THREE.Group | null = null;
  private wheelSpin: THREE.Group | null = null;
  /** Per gun: the yaw pivot, plus (once the GLB is dissected) the trunnion
   *  group that takes elevation and the sculpt's baked tilt to counter. */
  private barrels: { mesh: THREE.Object3D; side: 1 | -1; elev?: THREE.Object3D; tilt?: number }[] = [];
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
    const woodMat = new THREE.MeshStandardMaterial({ map: rigTex, color: 0xb89878, roughness: 0.85 });
    const sailTex = new THREE.TextureLoader().load("/assets/textures/sail.jpg", (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.repeat.set(3, 2.2);
    });
    const sailMat = new THREE.MeshStandardMaterial({
      color: 0xe8dfc8,
      map: sailTex,
      roughness: 0.95,
      side: THREE.DoubleSide,
    });

    // billow + flutter in the vertex stage; uFill scales the belly with sail
    // set. SQUARE RIG: the sail hangs between two yards (top/bottom pinned by
    // sin(πv)) and bellies FORWARD along its normal — a vertical bulge, per
    // playtest ("billow out vertically, not in a horizontal curve")
    this.sailUniforms = { uTime: { value: 0 }, uFill: { value: 1 } };
    const su = this.sailUniforms;
    sailMat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = su.uTime;
      shader.uniforms.uFill = su.uFill;
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform float uTime;\nuniform float uFill;",
        )
        .replace(
          "#include <begin_vertex>",
          `#include <begin_vertex>
          {
            // uv.y: 0 at one yard → 1 at the other (both pinned, vertical
            // bulge between); uv.x: edges nearly pinned by the sheets.
            // Geometry is pre-rotated: +x is FORWARD, away from the mast.
            float belly = sin(uv.y * 3.14159) * (0.35 + 0.65 * sin(uv.x * 3.14159)) * 1.0 * uFill;
            float flutter = sin(uTime * 4.6 + uv.x * 8.0 + uv.y * 5.0) * 0.05 * uFill;
            transformed.x += belly + flutter;
          }`,
        );
    };

    for (const m of this.build.masts) {
      const mastH = m.h;
      const deckTop = (this.build.deckYAt(m.x) + 1) * VOXEL_SIZE;
      const mx = (m.x + 0.5) * VOXEL_SIZE;
      const mz = (m.z + 0.5) * VOXEL_SIZE;

      const mast = new THREE.Mesh(
        new THREE.CylinderGeometry(mastH * 0.006, mastH * 0.012, mastH, 8),
        woodMat,
      );
      mast.position.set(mx, deckTop + mastH / 2 - 0.5, mz);
      mast.castShadow = true;
      this.group.add(mast);

      // square rig, canvas up to the masthead (playtest round 4): three
      // yards crossing the FORE side of the mast, two tapered sails laced
      // tight between consecutive yards. The whole cloth hangs forward of
      // the mast so the mast never cuts through it, and each yard's span
      // matches its sail edge (tiny symmetric yardarm overhang only).
      // Everything scales with the mast's own height — the brig flies two.
      const yardOff = 0.3; // fore of the mast centerline
      const levels = [
        { y: deckTop + mastH * 0.17, w: mastH * 0.71 }, // course yard
        { y: deckTop + mastH * 0.56, w: mastH * 0.57 }, // topsail yard
        { y: deckTop + mastH * 0.88, w: mastH * 0.43 }, // topgallant yard
      ];
      for (const lv of levels) {
        const yardGeo = new THREE.CylinderGeometry(0.07, 0.07, lv.w + 0.3, 6);
        yardGeo.rotateX(Math.PI / 2); // axis beam-wise
        const yard = new THREE.Mesh(yardGeo, woodMat);
        yard.position.set(mx + yardOff, lv.y, mz);
        yard.castShadow = true;
        this.group.add(yard);
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
        const sail = new THREE.Mesh(geo, sailMat);
        sail.position.set(mx + yardOff + 0.16, (foot.y + head.y) / 2, mz);
        sail.castShadow = true;
        this.group.add(sail);
      }
    }

    // stern rudder: hinged blade reaching below the keel for clear flow, and
    // UP the transom toward the deck so you can actually watch it answer the
    // helm (round 6: "the rudder should extend further upwards so that you
    // can actually see it turning when maneuvering")
    const sternX = 4 * VOXEL_SIZE;
    const bladeH = this.build.deckY * VOXEL_SIZE * 0.78;
    this.rudderPivot = new THREE.Group();
    this.rudderPivot.position.set(sternX + 0.1, 1.8, (this.build.grid.dims[2] / 2) * VOXEL_SIZE);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.0, bladeH, 0.14), woodMat);
    blade.position.set(-0.55, bladeH / 2 - 2.3, 0);
    const heel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 0.14), woodMat);
    heel.position.set(-0.78, -1.55, 0);
    this.rudderPivot.add(blade, heel);
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
        [0.072, 1.18], [0.088, 1.24], [0.094, 1.28], [0.07, TIP_FROM_TRUNNION - 0.01],
        [0.045, TIP_FROM_TRUNNION], [0.001, TIP_FROM_TRUNNION],
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
    const deckInPivot = -0.62; // the pivot origin floats 0.62 above the deck
    for (const port of this.build.cannonPorts) {
      const px = (port.x + 0.5) * VOXEL_SIZE;
      const py = (this.build.deckY + 1) * VOXEL_SIZE;
      const pz = (port.z + 0.5 - port.side * 2.6) * VOXEL_SIZE;
      const pivot = new THREE.Group();
      pivot.rotation.order = "YXZ"; // yaw to the side, then elevate — never rolls
      pivot.position.set(px, py + 0.62, pz + port.side * 0.2);
      // gun space: +z outboard for both sides (animate()'s yaw flips port)
      const elev = new THREE.Group();
      elev.position.set(0, BORE_UP, TRUNNION_OUT);
      const barrelMesh = new THREE.Mesh(gg.barrel, ironMat);
      barrelMesh.castShadow = true;
      const trun = new THREE.Mesh(gg.trun, ironMat);
      trun.rotation.z = Math.PI / 2; // trunnion axle crosses beam-wise
      elev.add(barrelMesh, trun);
      pivot.add(elev);
      const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, wheel = false) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(x, y, z + TRUNNION_OUT);
        if (wheel) m.rotation.z = Math.PI / 2;
        m.castShadow = true;
        pivot.add(m);
      };
      for (const s of [-1, 1]) {
        add(gg.cheekF, woodMat, s * 0.15, BORE_UP - 0.22, -0.02);
        add(gg.cheekR, woodMat, s * 0.15, BORE_UP - 0.38, -0.45);
        add(gg.wheelF, woodMat, s * 0.26, deckInPivot + 0.17, 0.18, true);
        add(gg.wheelR, woodMat, s * 0.26, deckInPivot + 0.15, -0.55, true);
      }
      add(gg.bed, woodMat, 0, deckInPivot + 0.09, -0.18);
      add(gg.axle, ironMat, 0, deckInPivot + 0.17, 0.18, true);
      add(gg.axle, ironMat, 0, deckInPivot + 0.15, -0.55, true);
      this.group.add(pivot);
      this.barrels.push({ mesh: pivot, side: port.side, elev, tilt: 0 });
    }

    // stern ladder: rungs down the transom to the waterline, so going
    // overboard is recoverable (playtest round 4: "no way to get back on").
    // On the brig the transom carries the quarterdeck, so it climbs higher.
    const ladder = new THREE.Group();
    const ladderTop = (this.build.deckYAt(4) + 5) * VOXEL_SIZE; // stern cap-rail height
    const ladderBot = 1.0; // dips under the waterline
    const lz = (this.build.grid.dims[2] / 2) * VOXEL_SIZE;
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

    // bowsprit at the bow (max-x end): a real spar now, scaled to the hull
    // and steeved upward (round 6: "the front stick coming out … is now too
    // low and too small for the new ship")
    const [nx] = this.build.grid.dims;
    const spritLen = this.build.lengthM * 0.28;
    const steeve = 0.3; // radians above horizontal
    const sprit = new THREE.Mesh(
      new THREE.CylinderGeometry(spritLen * 0.014, spritLen * 0.028, spritLen, 8),
      woodMat,
    );
    sprit.rotation.z = -Math.PI / 2 + steeve;
    const bowX = nx * VOXEL_SIZE - 1.0;
    const bowDeckTop = (this.build.deckY + 2) * VOXEL_SIZE;
    sprit.position.set(
      bowX + Math.cos(steeve) * (spritLen / 2 - 1.6),
      bowDeckTop + Math.sin(steeve) * (spritLen / 2 - 1.6),
      (this.build.grid.dims[2] / 2) * VOXEL_SIZE,
    );
    sprit.castShadow = true;
    this.group.add(sprit);
  }
}
