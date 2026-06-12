import * as THREE from "three";
import { CHUNK_SIZE, VOXEL_SIZE } from "../core/constants";
import { meshChunk } from "./voxelMesher";
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

  constructor(build: ShipBuild) {
    this.build = build;
    this.hullMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.88,
      metalness: 0.02,
    });
    this.remeshAll();
    this.addRig();
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

    // bowsprit at the bow (max-x end), angled slightly upward
    const [nx] = this.build.grid.dims;
    const spritLen = 3.2;
    const sprit = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, spritLen, 6), woodMat);
    sprit.rotation.z = -Math.PI / 2 + 0.22;
    sprit.position.set(nx * VOXEL_SIZE - 1.2 + spritLen / 2 - 0.4, (this.build.deckY + 2) * VOXEL_SIZE, (this.build.grid.dims[2] / 2) * VOXEL_SIZE);
    this.group.add(sprit);
  }
}
