import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { VoxelContact, type ContactTarget } from "../src/game/voxelContact";
import { createGrid, type VoxelGrid } from "../src/sim/voxelGrid";
import { computeSurface, unpackCell } from "../src/sim/surfaceSet";
import { breakEnergy, OAK, RAM, ROCK } from "../src/sim/materials";
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

/** A bow: the outermost +x layer is RAM armor laid over an OAK body (like shipwright's armorBow).
 *  Cheapest-first carving pulls the softer OAK from BEHIND the armor, scattering removal — exactly
 *  the mixed-material case that produced the player's "front of my ship is a checkerboard". */
function bowBlock(n: number): VoxelGrid {
  const g = createGrid(n, n, n);
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) g.set(x, y, z, x >= n - 1 ? RAM : OAK);
  return g;
}

/** A test ContactTarget backed by a grid + explicit pose/velocity/mass. Records carve, impulse,
 *  and translation calls so a test can assert what the contact rule did to each side. */
class FakeTarget implements ContactTarget {
  removed: [number, number, number][] = [];
  impulses: { imp: THREE.Vector3; pt: { x: number; y: number; z: number } }[] = [];
  moved: { x: number; y: number; z: number }[] = [];
  hullToughness = 1;
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

describe("VoxelContact.resolveContact — contiguous carve (no checkerboard)", () => {
  // BUG 1: an energy-limited ram into a UNIFORM-toughness hull must remove a CONNECTED front from the
  // contact face, not a raster-scattered subset of the overlap (the "checkerboard"). With a budget that
  // covers only part of the flagged layer, the removed cells must form ONE face+edge-connected region.

  /** Are these cells one 18-connected (face+edge) blob? Mirrors the connectivity prune's rule. */
  function isOneConnectedBlob(cells: [number, number, number][]): boolean {
    if (cells.length <= 1) return true;
    const key = (c: [number, number, number]) => `${c[0]},${c[1]},${c[2]}`;
    const present = new Set(cells.map(key));
    const seen = new Set<string>();
    const stack: [number, number, number][] = [cells[0]];
    seen.add(key(cells[0]));
    while (stack.length) {
      const [x, y, z] = stack.pop()!;
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (m !== 1 && m !== 2) continue; // face or flat-edge only (18-connectivity)
        const nk = `${x + dx},${y + dy},${z + dz}`;
        if (present.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push([x + dx, y + dy, z + dz]); }
      }
    }
    return seen.size === cells.length;
  }

  it("an energy-limited ram into a RAM-armored bow bores a COMPACT cavity, not a scatter behind the armor", () => {
    const contact = new VoxelContact();
    // ship A: an 8³ block whose +x face is RAM armor over OAK, driving +x into B. The closing energy
    // can't pay for the whole flagged overlap, so the carve is partial. Cheapest-first (the old rule)
    // pulls the soft OAK from BEHIND the armor first, leaving the tough RAM cells standing — a hollow,
    // scattered removal (the player's "checkerboard"). The fix carves from the contact front outward,
    // so the bite is a compact cavity at the impact, armor included as the budget reaches it.
    const ship = new FakeTarget(bowBlock(8), { x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, 2e5, true, 1);
    const wall = new FakeTarget(solidBlock(8, OAK), { x: 6, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 2e5, true, 1);
    const d = contact.resolveContact(ship, wall, 1 / 60);
    expect(d).not.toBeNull();
    // partial carve: SOME but not the whole overlap came off this step (energy-limited bite).
    expect(ship.removed.length).toBeGreaterThanOrEqual(6);
    // COMPACT — the removed cells fill a tight bounding box (a bored cavity), not a thin scatter spread
    // through a large box (the checkerboard, whose box is ~2-3× its cell count, full of standing armor).
    const xs = ship.removed.map((c) => c[0]), ys = ship.removed.map((c) => c[1]), zs = ship.removed.map((c) => c[2]);
    const bbox = (Math.max(...xs) - Math.min(...xs) + 1) * (Math.max(...ys) - Math.min(...ys) + 1) * (Math.max(...zs) - Math.min(...zs) + 1);
    expect(bbox).toBeLessThanOrEqual(Math.ceil(ship.removed.length * 1.5)); // compact, not hollow/scattered
    // and ONE face+edge-connected blob (sanity — a compact cavity is trivially connected).
    expect(isOneConnectedBlob(ship.removed)).toBe(true);
  });

  it("a partial carve into UNIFORM oak removes a connected front (no raster scatter)", () => {
    const contact = new VoxelContact();
    // pure oak, deep overlap so the candidate set spans several x-layers; energy-limited partial carve.
    const ship = new FakeTarget(solidBlock(8, OAK), { x: 0, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }, 2e5, true, 1);
    const wall = new FakeTarget(solidBlock(8, OAK), { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 2e5, true, 1);
    const d = contact.resolveContact(ship, wall, 1 / 60);
    expect(d).not.toBeNull();
    expect(ship.removed.length).toBeGreaterThanOrEqual(6);
    expect(isOneConnectedBlob(ship.removed)).toBe(true);
  });
});
