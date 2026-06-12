import * as THREE from "three";
import { CHUNK_SIZE, VOXEL_SIZE } from "../core/constants";
import { barrelDirLocal } from "../game/gunnery";
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
            // normalize the photo around its mean so vertex tint + AO stay in charge
            diffuseColor.rgb *= tex * 2.2;
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
    const mat = new THREE.MeshStandardMaterial({
      color: 0x16424c,
      transparent: true,
      opacity: 0.82,
      roughness: 0.25,
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
    // exactly where the ball will go
    for (const b of this.barrels) {
      const active = aim && b.side === aim.side;
      barrelDirLocal(b.side, active ? aim.elevationDeg : 2, active ? aim.traverseDeg : 0, ShipVisual.tmpDir);
      b.mesh.quaternion.setFromUnitVectors(ShipVisual.Z_AXIS, ShipVisual.tmpDir);
    }
  }

  private static tmpDir = new THREE.Vector3();
  private static Z_AXIS = new THREE.Vector3(0, 0, 1);

  /** Cutaway: clip the hull against a world-space plane (null disables).
   *  Water boxes stay unclipped so flooding reads through the cut. */
  setCutaway(plane: THREE.Plane | null): void {
    this.hullMaterial.clippingPlanes = plane ? [plane] : null;
    this.hullMaterial.needsUpdate = true;
  }

  /** Reflect current flooding levels. Call once per frame. */
  updateWater(compartments: Compartment[]): void {
    for (const c of compartments) {
      const mesh = this.waterMeshes.get(c.id);
      if (!mesh) continue;
      const fill = c.waterVolume / c.volume;
      if (fill < 0.01) {
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
  private barrels: { mesh: THREE.Mesh; side: 1 | -1 }[] = [];
  private dispRudder = 0;
  private lastAnimT = 0;
  /** Local position of the ship's wheel — gameplay anchors helm control here. */
  wheelLocal: [number, number, number] = [0, 0, 0];
  /** Local position of the stern ladder — swimmers climb aboard here. */
  ladderLocal: [number, number, number] = [0, 0, 0];

  /** Procedural canvas-cloth texture: seams + thread noise. */
  private static clothTexture(): THREE.CanvasTexture {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 256;
    const g = c.getContext("2d")!;
    g.fillStyle = "#e9e1cd";
    g.fillRect(0, 0, 256, 256);
    for (let y = 0; y < 256; y += 34) {
      g.fillStyle = "rgba(120,105,80,0.28)";
      g.fillRect(0, y, 256, 2);
    }
    for (let i = 0; i < 5200; i++) {
      const v = 200 + Math.floor(Math.random() * 45);
      g.fillStyle = `rgba(${v},${v - 8},${v - 26},0.10)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }

  /** Mast + gaff rig (sail laced to the mast, spars top and bottom),
   *  bowsprit, stern rudder, and the helm wheel. */
  private addRig(): void {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3520, roughness: 0.8 });
    const cloth = ShipVisual.clothTexture();
    cloth.repeat.set(4, 3); // the canvas is big now — keep the weave fine
    const sailMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: cloth,
      roughness: 0.92,
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
      const mastH = 15;
      const deckTop = (this.build.deckY + 1) * VOXEL_SIZE;
      const mx = (m.x + 0.5) * VOXEL_SIZE;
      const mz = (m.z + 0.5) * VOXEL_SIZE;

      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.18, mastH, 8), woodMat);
      mast.position.set(mx, deckTop + mastH / 2 - 0.5, mz);
      mast.castShadow = true;
      this.group.add(mast);

      // square rig, canvas up to the masthead (playtest round 4): three
      // yards crossing the FORE side of the mast, two tapered sails laced
      // tight between consecutive yards. The whole cloth hangs forward of
      // the mast so the mast never cuts through it, and each yard's span
      // matches its sail edge (tiny symmetric yardarm overhang only).
      const yardOff = 0.3; // fore of the mast centerline
      const levels = [
        { y: deckTop + 2.6, w: 10.6 }, // course yard
        { y: deckTop + 8.4, w: 8.6 }, // topsail yard
        { y: deckTop + 13.2, w: 6.4 }, // topgallant yard
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

    // stern rudder: hinged blade reaching below the keel line so its area is
    // in clear flow (playtest: "blocked by the ship — it wouldn't be able to
    // turn in reality"), broader at the bottom like a real barn-door rudder
    const sternX = 4 * VOXEL_SIZE;
    this.rudderPivot = new THREE.Group();
    this.rudderPivot.position.set(sternX + 0.1, 1.8, (this.build.grid.dims[2] / 2) * VOXEL_SIZE);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.0, 3.1, 0.14), woodMat);
    blade.position.set(-0.55, -0.6, 0);
    const heel = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 0.14), woodMat);
    heel.position.set(-0.78, -1.55, 0);
    this.rudderPivot.add(blade, heel);
    this.group.add(this.rudderPivot);

    // the wheel: classic spoked helm on the quarterdeck, clear of the rig
    const helm = new THREE.Group();
    const deckTopY = (this.build.deckY + 1) * VOXEL_SIZE;
    const wz = (this.build.grid.dims[2] / 2) * VOXEL_SIZE;
    helm.position.set(3.4, deckTopY + 1.0, wz);
    this.wheelLocal = [3.4, deckTopY + 1.0, wz];
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

    // cannons: proper-sized barrel + carriage at every port; barrels are
    // stored so they articulate with the aiming elevation
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.45, metalness: 0.7 });
    const carriageMat = new THREE.MeshStandardMaterial({ color: 0x2e2014, roughness: 0.9 });
    const barrelGeo = new THREE.CylinderGeometry(0.11, 0.17, 2.1, 10);
    barrelGeo.rotateX(Math.PI / 2); // muzzle toward +z (outboard for side +1)
    barrelGeo.translate(0, 0, 0.55); // breech pivot: rotate about the carriage
    const carriageGeo = new THREE.BoxGeometry(0.85, 0.5, 1.05);
    for (const port of this.build.cannonPorts) {
      const px = (port.x + 0.5) * VOXEL_SIZE;
      const py = (this.build.deckY + 1) * VOXEL_SIZE;
      const pz = (port.z + 0.5 - port.side * 2.6) * VOXEL_SIZE;
      const carriage = new THREE.Mesh(carriageGeo, carriageMat);
      carriage.position.set(px, py + 0.25, pz);
      carriage.castShadow = true;
      this.group.add(carriage);
      const barrel = new THREE.Mesh(barrelGeo, ironMat);
      barrel.position.set(px, py + 0.62, pz + port.side * 0.2);
      barrel.castShadow = true;
      this.group.add(barrel);
      this.barrels.push({ mesh: barrel, side: port.side });
    }

    // stern ladder: rungs down the transom to the waterline, so going
    // overboard is recoverable (playtest round 4: "no way to get back on")
    const ladder = new THREE.Group();
    const ladderTop = (this.build.deckY + 5) * VOXEL_SIZE; // cap-rail height
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

    // bowsprit at the bow (max-x end), angled slightly upward
    const [nx] = this.build.grid.dims;
    const spritLen = 3.2;
    const sprit = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, spritLen, 6), woodMat);
    sprit.rotation.z = -Math.PI / 2 + 0.22;
    sprit.position.set(nx * VOXEL_SIZE - 1.2 + spritLen / 2 - 0.4, (this.build.deckY + 2) * VOXEL_SIZE, (this.build.grid.dims[2] / 2) * VOXEL_SIZE);
    this.group.add(sprit);
  }
}
