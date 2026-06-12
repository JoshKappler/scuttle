import * as THREE from "three";
import { CHUNK_SIZE, VOXEL_SIZE } from "../core/constants";
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

  private interiorShell: THREE.Mesh;

  constructor(build: ShipBuild) {
    this.build = build;
    this.hullMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.02,
      side: THREE.DoubleSide, // cutaway shows hull interior, not see-through walls
    });
    // wood grain: per-plank value variation + fine along-grain striping,
    // computed from ship-local position (playtest: "solid colored blocks")
    this.hullMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vShipLocal;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvShipLocal = position;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vShipLocal;")
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
          {
            // plank id: one strake per voxel row, ~2m plank lengths
            float plankId = floor(vShipLocal.y / 0.25) * 13.0
                          + floor((vShipLocal.x + floor(vShipLocal.y / 0.25) * 0.7) / 2.0) * 7.0
                          + floor(vShipLocal.z / 0.25) * 3.0;
            float h = fract(sin(plankId * 127.1) * 43758.5453);
            // low-frequency, low-contrast: high-freq stripes aliased into
            // static-like shimmer at distance (playtest)
            float grain = 0.93 + 0.10 * h;
            grain *= 0.985 + 0.015 * sin(vShipLocal.x * 7.0 + h * 41.0);
            diffuseColor.rgb *= grain;
          }`,
        );
    };
    this.remeshAll();
    this.addRig();
    this.addWaterPlanes();

    // dark bilge backdrop: occludes the world ocean inside the hull during
    // cutaway (otherwise the open sea shows through the cut and reads as
    // "the whole ship is full of water" — playtest bug)
    const [nx, ny, nz] = build.grid.dims;
    const shellGeo = new THREE.BoxGeometry(nx * VOXEL_SIZE * 0.92, build.deckY * VOXEL_SIZE * 0.85, nz * VOXEL_SIZE * 0.7);
    this.interiorShell = new THREE.Mesh(
      shellGeo,
      new THREE.MeshStandardMaterial({ color: 0x0b0f12, roughness: 1, side: THREE.BackSide }),
    );
    this.interiorShell.position.set(
      (nx * VOXEL_SIZE) / 2,
      (build.deckY * VOXEL_SIZE * 0.85) / 2 + VOXEL_SIZE,
      (nz * VOXEL_SIZE) / 2,
    );
    this.interiorShell.visible = false;
    this.group.add(this.interiorShell);
    void ny;
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
   *  cannon barrels track the aiming elevation on the aiming side. */
  animate(time: number, rudderNorm: number, sailSet: number, aim?: { side: 1 | -1; elevationDeg: number } | null): void {
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

    const elRad = ((aim?.elevationDeg ?? 2) * Math.PI) / 180;
    for (const b of this.barrels) {
      const active = aim && b.side === aim.side;
      const el = active ? elRad : (2 * Math.PI) / 180;
      b.mesh.rotation.x = b.side === 1 ? -el : Math.PI + el;
      if (b.side === -1) b.mesh.rotation.y = 0; // rotation.x = π already flips the muzzle to −z
    }
  }

  /** Cutaway: clip the hull against a world-space plane (null disables).
   *  Water boxes stay unclipped so flooding reads through the cut. */
  setCutaway(plane: THREE.Plane | null): void {
    this.hullMaterial.clippingPlanes = plane ? [plane] : null;
    this.hullMaterial.needsUpdate = true;
    this.interiorShell.visible = plane !== null;
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
    const sailMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: ShipVisual.clothTexture(),
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
            // uv.y: 0 at the lower yard → 1 at the upper yard (both pinned);
            // uv.x: 0..1 across the width (edges nearly pinned by sheets)
            float belly = sin(uv.y * 3.14159) * (0.35 + 0.65 * sin(uv.x * 3.14159)) * 1.1 * uFill;
            float flutter = sin(uTime * 4.6 + uv.x * 8.0 + uv.y * 5.0) * 0.05 * uFill;
            transformed.z += belly + flutter;
          }`,
        );
    };

    for (const m of this.build.masts) {
      const mastH = 12;
      const deckTop = (this.build.deckY + 1) * VOXEL_SIZE;
      const mx = (m.x + 0.5) * VOXEL_SIZE;
      const mz = (m.z + 0.5) * VOXEL_SIZE;

      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.17, mastH, 8), woodMat);
      mast.position.set(mx, deckTop + mastH / 2 - 0.5, mz);
      mast.castShadow = true;
      this.group.add(mast);

      // two yards CENTERED on the mast, running beam-wise (port↔starboard),
      // suspending the sail between them
      const yardLow = deckTop + 3.4;
      const yardHigh = deckTop + 8.6;
      const yardGeoLong = new THREE.CylinderGeometry(0.06, 0.06, 8.0, 6);
      yardGeoLong.rotateX(Math.PI / 2); // axis along z (beam-wise)
      const yardGeoShort = new THREE.CylinderGeometry(0.05, 0.05, 6.8, 6);
      yardGeoShort.rotateX(Math.PI / 2);
      const lowYard = new THREE.Mesh(yardGeoLong, woodMat);
      lowYard.position.set(mx, yardLow, mz);
      lowYard.castShadow = true;
      const highYard = new THREE.Mesh(yardGeoShort, woodMat);
      highYard.position.set(mx, yardHigh, mz);
      highYard.castShadow = true;
      this.group.add(lowYard, highYard);

      // square sail hanging between the yards, centered on the mast
      const sailW = 7.4;
      const sailH = yardHigh - yardLow - 0.15;
      const sailGeo = new THREE.PlaneGeometry(sailW, sailH, 12, 12);
      const sail = new THREE.Mesh(sailGeo, sailMat);
      sail.rotation.y = Math.PI / 2; // spans beam-wise; normal fore-aft, belly forward
      sail.position.set(mx - 0.25, (yardLow + yardHigh) / 2, mz);
      sail.castShadow = true;
      this.group.add(sail);
    }

    // stern rudder: hinged blade below the waterline that visibly answers the helm
    const sternX = 4 * VOXEL_SIZE;
    this.rudderPivot = new THREE.Group();
    this.rudderPivot.position.set(sternX + 0.1, 1.8, (this.build.grid.dims[2] / 2) * VOXEL_SIZE);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.4, 0.14), woodMat);
    blade.position.set(-0.6, -0.2, 0);
    this.rudderPivot.add(blade);
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
      if (port.side < 0) barrel.rotation.y = Math.PI;
      barrel.castShadow = true;
      this.group.add(barrel);
      this.barrels.push({ mesh: barrel, side: port.side });
    }

    // bowsprit at the bow (max-x end), angled slightly upward
    const [nx] = this.build.grid.dims;
    const spritLen = 3.2;
    const sprit = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, spritLen, 6), woodMat);
    sprit.rotation.z = -Math.PI / 2 + 0.22;
    sprit.position.set(nx * VOXEL_SIZE - 1.2 + spritLen / 2 - 0.4, (this.build.deckY + 2) * VOXEL_SIZE, (this.build.grid.dims[2] / 2) * VOXEL_SIZE);
    this.group.add(sprit);
  }
}
