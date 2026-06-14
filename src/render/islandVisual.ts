import * as THREE from "three";
import { meshGrid } from "./voxelMesher";
import type { VoxelGrid } from "../sim/voxelGrid";

/**
 * Static voxel terrain: one merged greedy mesh under a scaled THREE.Group at a
 * world position. The island analogue of ShipVisual, but built ONCE and never
 * remeshed (islands don't move or take damage in this pass). Uses a plain
 * vertex-color material — no plank-texture pass, so rock/sand/greens read true.
 *
 * Also exposes the (scaled) merged vertices/indices so the IslandField can hand
 * them straight to a Rapier static trimesh collider.
 */
export class IslandVisual {
  readonly group = new THREE.Group();
  readonly colliderVerts: Float32Array; // local metres, already × scale
  readonly colliderIndices: Uint32Array;

  constructor(grid: VoxelGrid, world: { x: number; y: number; z: number }, scale: number) {
    const mesh = meshGrid(grid);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0.0,
    });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
    this.group.position.set(world.x, world.y, world.z);
    this.group.scale.setScalar(scale);

    // collider geometry: same verts pre-scaled (the Rapier body carries the translation)
    this.colliderVerts = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i++) this.colliderVerts[i] = mesh.positions[i] * scale;
    this.colliderIndices = mesh.indices;
  }
}
