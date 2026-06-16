import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { VoxelContact, type ContactTarget } from "../src/game/voxelContact";
import { createGrid, type VoxelGrid } from "../src/sim/voxelGrid";
import { computeSurface, unpackCell } from "../src/sim/surfaceSet";
import { breakEnergy, OAK, ROCK } from "../src/sim/materials";
import type { HullView } from "../src/sim/voxelOverlap";

function surfaceArray(grid: VoxelGrid): Int32Array {
  const set = computeSurface(grid);
  const [nx, ny] = grid.dims;
  const out = new Int32Array(set.size * 3);
  let i = 0;
  for (const k of set) { const [x, y, z] = unpackCell(k, nx, ny); out[i++] = x; out[i++] = y; out[i++] = z; }
  return out;
}

function solidBlock(n: number, mat: number): VoxelGrid {
  const g = createGrid(n, n, n);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g.set(x, y, z, mat);
  return g;
}

/** A test ContactTarget backed by a grid + explicit pose/velocity/mass. Records carve, impulse,
 *  and translation calls so a test can assert what the contact rule did to each side. */
class FakeTarget implements ContactTarget {
  removed: [number, number, number][] = [];
  impulses: { imp: THREE.Vector3; pt: { x: number; y: number; z: number } }[] = [];
  moved: { x: number; y: number; z: number }[] = [];
  constructor(
    public grid: VoxelGrid,
    public pos: { x: number; y: number; z: number },
    public vel: { x: number; y: number; z: number },
    public m: number,
    public canCarve: boolean,
    public voxelSize = 1,
  ) {}
  fillHullView(hv: HullView): void {
    hv.surface = surfaceArray(this.grid);
    const g = this.grid;
    hv.isSolid = (x, y, z) => g.isSolid(x, y, z);
    hv.dims = g.dims;
    hv.pos[0] = this.pos.x; hv.pos[1] = this.pos.y; hv.pos[2] = this.pos.z;
    hv.quat[0] = 0; hv.quat[1] = 0; hv.quat[2] = 0; hv.quat[3] = 1;
  }
  aabbWorld(out: { min: THREE.Vector3; max: THREE.Vector3 }): void {
    const [nx, ny, nz] = this.grid.dims;
    out.min.set(this.pos.x, this.pos.y, this.pos.z);
    out.max.set(this.pos.x + nx * this.voxelSize, this.pos.y + ny * this.voxelSize, this.pos.z + nz * this.voxelSize);
  }
  comWorld(out: THREE.Vector3): THREE.Vector3 {
    const [nx, ny, nz] = this.grid.dims;
    return out.set(
      this.pos.x + (nx * this.voxelSize) / 2,
      this.pos.y + (ny * this.voxelSize) / 2,
      this.pos.z + (nz * this.voxelSize) / 2,
    );
  }
  linvel() { return this.vel; }
  angvel() { return { x: 0, y: 0, z: 0 }; }
  mass() { return this.m; }
  cellBreakEnergy(x: number, y: number, z: number): number { return breakEnergy(this.grid.get(x, y, z)); }
  carveCells(cells: [number, number, number][]): number {
    let n = 0;
    for (const [x, y, z] of cells) if (this.grid.remove(x, y, z)) { this.removed.push([x, y, z]); n++; }
    return n;
  }
  applyImpulseAtPoint(imp: THREE.Vector3, pt: { x: number; y: number; z: number }): void {
    this.impulses.push({ imp: imp.clone(), pt: { ...pt } });
  }
  translation() { return this.pos; }
  setTranslation(t: { x: number; y: number; z: number }): void { this.moved.push({ ...t }); this.pos = t; }
}

describe("VoxelContact.resolveContact — ship vs immovable, indestructible terrain", () => {
  it("a fast ram breaks the SHIP's voxels and leaves the terrain intact", () => {
    const contact = new VoxelContact();
    // ship A: oak block driving +x into the wall at 6 m/s (> vBreak 2)
    const ship = new FakeTarget(solidBlock(4, OAK), { x: 0, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }, 1e4, true, 1);
    // terrain B: rock wall overlapping A's +x face, immovable (huge mass) + indestructible (canCarve false)
    const wall = new FakeTarget(solidBlock(4, ROCK), { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1e12, false, 1);
    const d = contact.resolveContact(ship, wall, 1 / 60);
    expect(d).not.toBeNull();
    expect(ship.removed.length).toBeGreaterThan(0);  // the ship erodes
    expect(wall.removed.length).toBe(0);             // the rock never breaks
    expect(ship.impulses.length).toBeGreaterThan(0); // drag slows the ship
  });

  it("a slow drift (< vBreak) breaks nothing and de-penetrates the ship", () => {
    const contact = new VoxelContact();
    const ship = new FakeTarget(solidBlock(4, OAK), { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 1e4, true, 1); // 1 m/s < 2
    const wall = new FakeTarget(solidBlock(4, ROCK), { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 1e12, false, 1);
    const d = contact.resolveContact(ship, wall, 1 / 60);
    expect(d).not.toBeNull();
    expect(ship.removed.length).toBe(0); // nothing breaks below vBreak
    expect(wall.removed.length).toBe(0);
    expect(ship.moved.length).toBeGreaterThan(0); // the ship is pushed out
  });
});
