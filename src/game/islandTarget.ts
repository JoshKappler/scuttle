import * as THREE from "three";
import type { VoxelGrid } from "../sim/voxelGrid";
import type { HullView } from "../sim/voxelOverlap";
import type { ContactTarget } from "./voxelContact";

/** Effectively-infinite mass so terrain is immovable in the crush — huge but FINITE, so the
 *  reduced-mass / impulse arithmetic stays away from Infinity·0 = NaN. Ships are ~1e4–1e6 kg. */
const TERRAIN_MASS = 1e12;
const ZERO = { x: 0, y: 0, z: 0 } as const;
const EMPTY_SURFACE = new Int32Array(0);

/**
 * A piece of static voxel terrain (island, cliff, sea stack) presented to the deformable crush
 * (game/voxelContact.ts) as hull B: occupancy only, infinite mass, zero velocity, NEVER carved.
 * The crush then erodes the SHIP against it and leaves the rock untouched — "an infinitely heavy,
 * infinitely durable hull" (THE LAW invariant #4: one destruction rule for everything).
 *
 * Pure data + grid (no Rapier dependency): terrain is always hull B, so its surface is never
 * walked and its body is never touched by the contact response.
 */
export class IslandTarget implements ContactTarget {
  readonly canCarve = false;
  private readonly cx: number;
  private readonly cy: number;
  private readonly cz: number;

  constructor(
    private readonly grid: VoxelGrid,
    /** World position of the grid's local (0,0,0) corner. */
    private readonly pos: { x: number; y: number; z: number },
    readonly voxelSize: number,
  ) {
    const [nx, ny, nz] = grid.dims;
    this.cx = pos.x + (nx * voxelSize) / 2;
    this.cy = pos.y + (ny * voxelSize) / 2;
    this.cz = pos.z + (nz * voxelSize) / 2;
  }

  fillHullView(hv: HullView): void {
    hv.surface = EMPTY_SURFACE; // terrain is only ever hull B → its surface is never walked
    const grid = this.grid;
    hv.isSolid = (x, y, z) => grid.isSolid(x, y, z);
    hv.dims = grid.dims;
    hv.pos[0] = this.pos.x; hv.pos[1] = this.pos.y; hv.pos[2] = this.pos.z;
    hv.quat[0] = 0; hv.quat[1] = 0; hv.quat[2] = 0; hv.quat[3] = 1; // islands never rotate
  }

  aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }): void {
    const [nx, ny, nz] = this.grid.dims;
    const vs = this.voxelSize;
    out.min.set(this.pos.x, this.pos.y, this.pos.z);
    out.max.set(this.pos.x + nx * vs, this.pos.y + ny * vs, this.pos.z + nz * vs);
  }

  comWorld(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.cx, this.cy, this.cz);
  }

  linvel() { return ZERO; }
  angvel() { return ZERO; }
  mass() { return TERRAIN_MASS; }
  cellBreakEnergy(_x: number, _y: number, _z: number): number { return 0; } // never called (canCarve === false)
  carveCells(_cells: [number, number, number][]): number { return 0; }      // indestructible — no-op
  applyImpulseAtPoint(_impulse: THREE.Vector3, _point: { x: number; y: number; z: number }): void { /* immovable — no-op */ }
  translation() { return this.pos; }
  setTranslation(_t: { x: number; y: number; z: number }): void { /* immovable — no-op */ }
}
