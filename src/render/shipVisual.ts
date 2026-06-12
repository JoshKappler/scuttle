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
            float grain = 0.90 + 0.14 * h;
            grain *= 0.965 + 0.035 * sin(vShipLocal.x * 36.0 + h * 41.0 + vShipLocal.y * 4.0);
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

  /** Per-frame rig animation: sail flutter/fill, rudder + wheel answer the helm. */
  animate(time: number, rudderNorm: number, sailSet: number): void {
    if (this.sailUniforms) {
      this.sailUniforms.uTime.value = time;
      this.sailUniforms.uFill.value = 0.35 + 0.65 * sailSet;
    }
    if (this.rudderPivot) this.rudderPivot.rotation.y = rudderNorm * 0.55;
    if (this.wheelSpin) this.wheelSpin.rotation.z = rudderNorm * 2.6;
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

    // billow + flutter in the vertex stage; uFill scales the belly with sail set
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
            // uv.x: 0 at mast (luff) → 1 at leech; uv.y: 0 foot → 1 head
            float belly = sin(uv.x * 3.14159) * (0.55 - 0.22 * uv.y) * uFill;
            float flutter = sin(uTime * 5.2 + uv.x * 9.0 + uv.y * 3.0) * 0.045 * (0.3 + uv.x);
            transformed.z += belly + flutter;
          }`,
        );
    };

    for (const m of this.build.masts) {
      const mastH = 9.5;
      const deckTop = (this.build.deckY + 1) * VOXEL_SIZE;
      const mx = (m.x + 0.5) * VOXEL_SIZE;
      const mz = (m.z + 0.5) * VOXEL_SIZE;

      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, mastH, 8), woodMat);
      mast.position.set(mx, deckTop + mastH / 2 - 0.5, mz);
      mast.castShadow = true;
      this.group.add(mast);

      // gaff rig: boom (foot spar) and gaff (head spar) both hinged AT the
      // mast, sail laced between them with its luff against the mast
      const boomLen = 5.6;
      const footY = deckTop + 1.45;
      const headY = footY + 4.6;

      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, boomLen, 6), woodMat);
      boom.rotation.z = Math.PI / 2;
      boom.position.set(mx - boomLen / 2, footY, mz);
      boom.castShadow = true;
      this.group.add(boom);

      const gaffLen = boomLen * 0.78;
      const gaff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, gaffLen, 6), woodMat);
      gaff.rotation.z = Math.PI / 2 - 0.22; // peaked up like a proper gaff
      gaff.position.set(mx - (gaffLen / 2) * Math.cos(0.22), headY + (gaffLen / 2) * Math.sin(0.22) - 0.3, mz);
      gaff.castShadow = true;
      this.group.add(gaff);

      // sail: luff edge exactly at the mast, foot along the boom, head along
      // the gaff (trapezoid via vertex shaping), facing fore-aft
      const sailW = boomLen - 0.3;
      const sailH = headY - footY;
      const sailGeo = new THREE.PlaneGeometry(sailW, sailH, 10, 10);
      const pos = sailGeo.attributes.position;
      const uv = sailGeo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const u = uv.getX(i); // 0..1 across width
        const v = uv.getY(i); // 0..1 up height
        // shorten the head to the gaff length and peak it up slightly
        pos.setX(i, -u * (sailW * (1 - 0.22 * v)));
        pos.setY(i, v * sailH + v * (1 - u) * 0.0 + v * u * 0.0 + v * 0.0);
      }
      sailGeo.computeVertexNormals();
      const sail = new THREE.Mesh(sailGeo, sailMat);
      sail.rotation.y = Math.PI / 2; // plane spans fore-aft (x), normal to z
      sail.position.set(mx, footY, mz);
      sail.castShadow = true;
      this.group.add(sail);
    }

    // stern rudder: hinged blade below the waterline that visibly answers the helm
    const sternX = 4 * VOXEL_SIZE;
    this.rudderPivot = new THREE.Group();
    this.rudderPivot.position.set(sternX + 0.1, 1.6, (this.build.grid.dims[2] / 2) * VOXEL_SIZE);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.9, 2.1, 0.12), woodMat);
    blade.position.set(-0.5, -0.2, 0);
    this.rudderPivot.add(blade);
    this.group.add(this.rudderPivot);

    // the wheel: classic spoked helm on the quarterdeck
    const helm = new THREE.Group();
    const deckTopY = (this.build.deckY + 1) * VOXEL_SIZE;
    const wz = (this.build.grid.dims[2] / 2) * VOXEL_SIZE;
    helm.position.set(5.4, deckTopY + 0.95, wz);
    this.wheelLocal = [5.4, deckTopY + 0.95, wz];
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

    // cannons: barrel + carriage at every port, pointing outboard
    const ironMat = new THREE.MeshStandardMaterial({ color: 0x14151a, roughness: 0.45, metalness: 0.7 });
    const carriageMat = new THREE.MeshStandardMaterial({ color: 0x2e2014, roughness: 0.9 });
    const barrelGeo = new THREE.CylinderGeometry(0.07, 0.11, 1.25, 10);
    barrelGeo.rotateX(Math.PI / 2); // along z (outboard axis)
    const carriageGeo = new THREE.BoxGeometry(0.5, 0.32, 0.7);
    for (const port of this.build.cannonPorts) {
      const px = (port.x + 0.5) * VOXEL_SIZE;
      const py = (this.build.deckY + 1) * VOXEL_SIZE;
      const pz = (port.z + 0.5 - port.side * 1.6) * VOXEL_SIZE;
      const carriage = new THREE.Mesh(carriageGeo, carriageMat);
      carriage.position.set(px, py + 0.16, pz);
      carriage.castShadow = true;
      this.group.add(carriage);
      const barrel = new THREE.Mesh(barrelGeo, ironMat);
      barrel.position.set(px, py + 0.38, pz + port.side * 0.35);
      if (port.side < 0) barrel.rotation.y = Math.PI;
      barrel.castShadow = true;
      this.group.add(barrel);
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
