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

  /** Mast, boom, gaff sail, bowsprit — smooth low-poly dressing. */
  private addRig(): void {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x4a3520, roughness: 0.8 });
    const sailMat = new THREE.MeshStandardMaterial({
      color: 0xe8e0cc,
      roughness: 0.95,
      side: THREE.DoubleSide,
    });

    for (const m of this.build.masts) {
      const mastH = 9;
      const deckTop = (this.build.deckY + 1) * VOXEL_SIZE;
      const mx = (m.x + 0.5) * VOXEL_SIZE;
      const mz = (m.z + 0.5) * VOXEL_SIZE;

      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, mastH, 8), woodMat);
      mast.position.set(mx, deckTop + mastH / 2 - 0.5, mz);
      mast.castShadow = true;
      this.group.add(mast);

      // boom swung slightly to port for silhouette
      const boomLen = 5.5;
      const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, boomLen, 6), woodMat);
      boom.rotation.z = Math.PI / 2;
      boom.rotation.y = 0.18;
      boom.position.set(mx - boomLen / 2 + 0.3, deckTop + 1.6, mz + 0.35);
      this.group.add(boom);

      // gaff mainsail: a curved plane between mast and boom
      const sailGeo = new THREE.PlaneGeometry(boomLen - 0.6, mastH - 3.2, 8, 8);
      const pos = sailGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        // belly: bulge outward, more at the foot, plus taper toward the gaff
        pos.setZ(i, Math.sin(((x / (boomLen - 0.6)) + 0.5) * Math.PI) * 0.45 * (1 - (y / (mastH - 3.2) + 0.5) * 0.5));
        pos.setX(i, x * (1 - Math.max(0, y / (mastH - 3.2) + 0.5) * 0.35)); // gaff shorter than boom
      }
      sailGeo.computeVertexNormals();
      const sail = new THREE.Mesh(sailGeo, sailMat);
      sail.rotation.y = Math.PI / 2 + 0.18;
      sail.position.set(mx - 0.3 - (boomLen - 0.6) / 2 + 1.2, deckTop + 1.7 + (mastH - 3.2) / 2, mz + 0.4);
      sail.castShadow = true;
      this.group.add(sail);
    }

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
