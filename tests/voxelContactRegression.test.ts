import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { VoxelContact, type ContactTarget } from "../src/game/voxelContact";
import { createGrid, type VoxelGrid } from "../src/sim/voxelGrid";
import { computeSurface, unpackCell } from "../src/sim/surfaceSet";
import { breakEnergy, OAK } from "../src/sim/materials";
import type { HullView } from "../src/sim/voxelOverlap";

// Round-12 SP2 collision-correctness regression suite.
//
// Task 1 CHARACTERIZES the behavior that must SURVIVE the local-normal classification fix
// (head-on ram numbers, slow-press separation); Tasks 3/4 append the new-behavior tests
// (45° ram parity, parallel-scrape no-carve, tangential friction, degenerate-axis escape).
//
// ⚠ These are GAME-layer tests: they run against the LIVE TUN.crush knobs (vBreak 4.0,
// toughness 2.5, transferFrac 0.35, biteDvCap 3.5, buffer 0.4, depen 0.8, maxDepenSpeed 30,
// minDepth 0.04). If a future round retunes those, the literals below shift WITH the knobs.

const DT = 1 / 60;

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

/** tests/voxelContact.test.ts's FakeTarget, PLUS impulse integration (Δv = J/m, linear only —
 *  these axis-aligned block rigs carry no angular velocity), so multi-step scrape-friction and
 *  separation behavior is observable. Records carves, impulses, and translations like the original. */
class SimTarget implements ContactTarget {
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
    this.vel = { x: this.vel.x + imp.x / this.m, y: this.vel.y + imp.y / this.m, z: this.vel.z + imp.z / this.m };
  }
  translation() { return this.pos; }
  setTranslation(t: { x: number; y: number; z: number }): void { this.moved.push({ ...t }); this.pos = t; }
}

/** One fixed step the way game/world.ts wraps the contact: integrate positions from the
 *  (impulse-updated) velocities, then resolve the pair. Returns the debug or null (separated). */
function step(contact: VoxelContact, a: SimTarget, b: SimTarget) {
  a.pos = { x: a.pos.x + a.vel.x * DT, y: a.pos.y + a.vel.y * DT, z: a.pos.z + a.vel.z * DT };
  b.pos = { x: b.pos.x + b.vel.x * DT, y: b.pos.y + b.vel.y * DT, z: b.pos.z + b.vel.z * DT };
  return contact.resolveContact(a, b, DT);
}

/** Two 8³ oak hulls, A at the origin, B at x=bx (7 → one-voxel overlap; 7.5 → half-voxel press). */
function mkPair(
  vA: { x: number; y: number; z: number },
  vB: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
  bx = 7,
) {
  const A = new SimTarget(solidBlock(8, OAK), { x: 0, y: 0, z: 0 }, { ...vA }, 2e5, true, 1);
  const B = new SimTarget(solidBlock(8, OAK), { x: bx, y: 0, z: 0 }, { ...vB }, 2e5, true, 1);
  return { A, B };
}

describe("characterization — head-on ram (must survive the round-12 classification fix)", () => {
  // 8³ oak vs 8³ oak, 1-voxel overlap, A drives +x at 6 m/s (> vBreak 4), B dead in the water.
  // Derivation vs HEAD: 64 contacts; 37.5 kJ/cell (oak 15 kJ × toughness 2.5); μ = 1e5.
  // Aggregate rule: budget ½·μ·6² = 1.8e6 → 48 cells. Per-contact RMS rule (post-fix): edge
  // contacts read 6/√2 → vEff ≈ 5.61, budget ≈ 1.575e6 → 41–42 cells. The band brackets BOTH.
  // The bite impulse is biteDvCap-bound (3.5 m/s) in BOTH worlds → jA = 577,500, jB = 122,500
  // EXACTLY, purely along ∓x — these must not move at all.
  it("carves inside the energy band and applies the exact cap-bound bite impulses", () => {
    const contact = new VoxelContact();
    const { A, B } = mkPair({ x: 6, y: 0, z: 0 });
    const d = contact.resolveContact(A, B, DT);
    expect(d).not.toBeNull();
    expect(d!.overlapCount).toBe(64);
    expect(d!.vClose).toBeGreaterThan(5.0);   // 6.0 aggregate today; ~5.61 RMS after the fix
    expect(d!.vClose).toBeLessThan(6.5);
    const removed = d!.removedA + d!.removedB;
    expect(removed).toBeGreaterThanOrEqual(40);
    expect(removed).toBeLessThanOrEqual(50);
    expect(d!.energy).toBeGreaterThan(1.45e6);
    expect(d!.energy).toBeLessThan(1.85e6);
    // ONE bite impulse per hull, horizontal, along ∓x (edge-normal z-shares cancel by symmetry).
    expect(A.impulses).toHaveLength(1);
    expect(B.impulses).toHaveLength(1);
    expect(A.impulses[0].imp.x).toBeCloseTo(-577500, 0);
    expect(A.impulses[0].imp.y).toBeCloseTo(0, 6);
    expect(Math.abs(A.impulses[0].imp.z)).toBeLessThan(1);
    expect(B.impulses[0].imp.x).toBeCloseTo(122500, 0);
    expect(Math.abs(B.impulses[0].imp.z)).toBeLessThan(1);
    // BREAK regime: the carve clears the way — NO positional shove while breaking (anti-jar law).
    expect(A.moved).toHaveLength(0);
    expect(B.moved).toHaveLength(0);
  });

  it("slow-drift press (vRel = 0): REST de-penetration separates, breaks nothing, flings nothing", () => {
    // The audit claimed near-zero relative velocity deadlocks; the CODE already de-penetrates
    // along the COM→COM line here (the true deadlock needs a degenerate COM line too — Task 4).
    // This locks the working behavior so the Task 3/4 rewrites cannot regress it.
    const contact = new VoxelContact();
    const { A, B } = mkPair({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 7.5); // 0.5 m pressed overlap
    let sep = -1;
    for (let i = 0; i < 10; i++) { if (!step(contact, A, B)) { sep = i; break; } }
    expect(sep).toBeGreaterThanOrEqual(0);   // separated within 10 steps
    expect(A.removed).toHaveLength(0);
    expect(B.removed).toHaveLength(0);
    expect(A.impulses).toHaveLength(0);      // position-only: zero velocity stays EXACTLY zero
    expect(B.impulses).toHaveLength(0);
    expect(A.vel).toEqual({ x: 0, y: 0, z: 0 });
    expect(A.pos.y).toBeCloseTo(0, 9);       // de-pen never touches the vertical (horizontal-only law)
  });
});
