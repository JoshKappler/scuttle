import type RAPIER from "@dimforge/rapier3d-compat";
import { VOXEL_SIZE } from "../core/constants";
import type { VoxelGrid } from "../sim/voxelGrid";
import type { Physics } from "./physics";

/**
 * A ship hull's physics shape: a native Rapier voxel collider (ColliderDesc.voxels)
 * built from the ship's voxel grid and mutated IN PLACE as voxels are destroyed
 * (setVoxel is O(1) — no collider rebuild). Group 0x0002ffff keeps it in the
 * ship/debris world and OUT of the character controller's (the KCC filters ~0x0002
 * and walks the deck trimesh instead). Replaces the old coarse cuboid.
 *
 * Voxels sit at their grid coords * VOXEL_SIZE in the collider's local frame, so the
 * collider aligns with the grid/mesh with NO extra translation (the body origin is
 * the grid corner — same convention the greedy mesh and buoyancy already use).
 *
 * Two separate hulls collide voxel-vs-voxel through Rapier's narrowphase directly;
 * the combineVoxelStates/propagateVoxelChange "pairing" API is NOT needed (it handles
 * seams between tiles of one continuous surface) — confirmed by the Task 0 spike.
 */
export class HullCollider {
  readonly collider: RAPIER.Collider;
  constructor(private physics: Physics, body: RAPIER.RigidBody, grid: VoxelGrid) {
    const { world, RAPIER: R } = physics;
    const coords: number[] = [];
    grid.forEachSolid((x, y, z) => { coords.push(x, y, z); });
    const desc = R.ColliderDesc.voxels(new Int32Array(coords), { x: VOXEL_SIZE, y: VOXEL_SIZE, z: VOXEL_SIZE })
      .setDensity(0)
      .setCollisionGroups(0x0002ffff);
    this.collider = world.createCollider(desc, body);
  }
  /** Destroy one voxel in the collision shape (O(1), no rebuild). */
  removeVoxel(x: number, y: number, z: number): void {
    try { this.collider.setVoxel(x, y, z, false); } catch { /* collider mid-teardown — skip */ }
  }
  dispose(): void {
    try { this.physics.world.removeCollider(this.collider, false); } catch { /* already gone */ }
  }
}
