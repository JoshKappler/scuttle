import * as THREE from "three";
import { TUN } from "../core/tunables";
import { buildRig, type RigSpec } from "../sim/rigBuild";
import { type Rig, NodeFlag, dist } from "../sim/rigLattice";
import { breakImpulse, splitClosingImpulse } from "../sim/crush";
import { VOXEL_SIZE } from "../core/constants";
import type { Ship } from "./ship";
import type { Effects } from "../render/effects";

/**
 * RigManager — the GAME-side runtime for the voxel rig (sim/rigLattice + sim/rigBuild).
 *
 * Phase 2: the BOWSPRIT (the forward ram spar) stops phasing through. Each fixed step,
 * every ship's bowsprit nodes are tested against every OTHER ship's hull grid; where a
 * node is buried in enemy wood AND the two ships are closing faster than vBreak, it BORES —
 * fed straight into the existing ½·μ·v² crush rule (ship.crush), exactly like a hull-hull
 * ram, just sourced from the spar's forward reach instead of the hull surface. So the ram
 * bites a hole and sheds the aggressor's speed (crush.breakImpulse / splitClosingImpulse),
 * and NO new destruction system is introduced — THE LAW #4, one rule.
 *
 * The bowsprit follows its ship rigidly here (rest node positions transformed by the body);
 * the lattice's own physics (topple / snap / flap) arrives in later phases. Rigs are built
 * lazily per ship and cached in a WeakMap (no edit to Ship required).
 */
interface ShipRig {
  rig: Rig;
  sprit: number[]; // node indices flagged SPRIT (the bowsprit chain)
  reach: number;   // bowsprit length (m), the broad-phase AABB margin
}

export class RigManager {
  /** main.ts attaches this for bore dust/crunch FX; optional so headless tests no-op. */
  effects?: Effects;

  private rigs = new WeakMap<Ship, ShipRig>();
  private aabbA = { min: new THREE.Vector3(), max: new THREE.Vector3() };
  private aabbB = { min: new THREE.Vector3(), max: new THREE.Vector3() };
  private wp = new THREE.Vector3(); // node world pos
  private wl = new THREE.Vector3(); // node in B-local
  private comA = new THREE.Vector3();
  private comB = new THREE.Vector3();
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private imp = new THREE.Vector3();
  private cells: [number, number, number][] = [];
  private cellPool: [number, number, number][] = [];
  private seen = new Set<number>(); // cell dedup across dense samples within one bore

  /** Build (once) and cache the rig for a ship, deriving the bowsprit from the SAME geometry
   *  render/shipVisual draws it from, so the spar lines up with the hull. */
  private rigFor(ship: Ship): ShipRig {
    let sr = this.rigs.get(ship);
    if (sr) return sr;
    const b = ship.build;
    const spritLen = b.lengthM * 0.28;
    const steeve = 0.3; // radians above horizontal — matches shipVisual
    const zMid = (b.grid.dims[2] / 2) * VOXEL_SIZE;
    const bowDeckTop = (b.deckY + 2) * VOXEL_SIZE;
    const heelX = b.footprint.maxX - 1.5 - 2.0; // stem (maxX-1.5) then heel 2 m inboard
    const heelY = bowDeckTop - 0.15;
    const heel = { x: heelX, y: heelY, z: zMid };
    const tip = { x: heelX + Math.cos(steeve) * spritLen, y: heelY + Math.sin(steeve) * spritLen, z: zMid };
    const spec: RigSpec = {
      voxelSize: VOXEL_SIZE,
      deckTopY: (xv) => (b.deckYAt(xv) + 1) * VOXEL_SIZE,
      masts: b.masts,
      bowsprit: { heel, tip },
    };
    const rig = buildRig(spec);
    const sprit: number[] = [];
    rig.nodes.forEach((n, i) => { if (n.flags & NodeFlag.SPRIT) sprit.push(i); });
    sr = { rig, sprit, reach: spritLen };
    this.rigs.set(ship, sr);
    return sr;
  }

  /** Run the rig's contributions to this fixed step. Phase 2: bowsprit boring. Call AFTER the
   *  hull-hull VoxelContact and BEFORE the Rapier step (impulses integrate this step). */
  stepAll(ships: Ship[], _dt: number): void {
    if (!TUN.crush.enabled || !TUN.rig.enabled || !TUN.rig.bowsprit) return;
    for (const A of ships) {
      const sr = this.rigFor(A);
      if (sr.sprit.length === 0) continue;
      A.aabbWorld(this.aabbA);
      const m = sr.reach; // inflate so the broad cull keeps pairs where only the spar overlaps
      this.aabbA.min.x -= m; this.aabbA.min.y -= m; this.aabbA.min.z -= m;
      this.aabbA.max.x += m; this.aabbA.max.y += m; this.aabbA.max.z += m;
      for (const B of ships) {
        if (B === A) continue;
        B.aabbWorld(this.aabbB);
        if (!aabbIntersect(this.aabbA, this.aabbB)) continue;
        this.bore(A, sr, B);
      }
    }
  }

  /** Bowsprit of A boring into hull B: the hull-crush rule, fed the spar's penetrating cells. */
  private bore(A: Ship, sr: ShipRig, B: Ship): void {
    const grid = B.build.grid;
    const [bx, by, bz] = grid.dims;
    const inv = 1 / VOXEL_SIZE;

    // Walk the bowsprit polyline densely (the spar is continuous, not 7 points) and collect
    // every solid B cell it occupies, widened by a bore radius perpendicular to its length so a
    // hit punches a real gash, not a needle hole. Deduped across samples. This is what makes the
    // ram bore a tunnel like a cannonball instead of pricking a single voxel.
    const cells = this.cells; cells.length = 0;
    const seen = this.seen; seen.clear();
    const rad = TUN.rig.boreRadiusVox;
    const stepM = Math.max(TUN.rig.boreStep, 0.1) * VOXEL_SIZE;
    let cx = 0, cy = 0, cz = 0, hit = 0;
    for (let s = 0; s + 1 < sr.sprit.length; s++) {
      const n0 = sr.rig.nodes[sr.sprit[s]].pos, n1 = sr.rig.nodes[sr.sprit[s + 1]].pos;
      const samples = Math.max(1, Math.ceil(dist(n0, n1) / stepM));
      for (let k = 0; k <= samples; k++) {
        const f = k / samples;
        A.localToWorld([n0.x + (n1.x - n0.x) * f, n0.y + (n1.y - n0.y) * f, n0.z + (n1.z - n0.z) * f], this.wp);
        B.worldToLocal(this.wp, this.wl);
        const cvx = Math.floor(this.wl.x * inv), cvy = Math.floor(this.wl.y * inv), cvz = Math.floor(this.wl.z * inv);
        for (let dy = -rad; dy <= rad; dy++) {
          for (let dz = -rad; dz <= rad; dz++) {
            const vx = cvx, vy = cvy + dy, vz = cvz + dz;
            if (vx < 0 || vy < 0 || vz < 0 || vx >= bx || vy >= by || vz >= bz) continue;
            if (!grid.isSolid(vx, vy, vz)) continue;
            const key = (vx * by + vy) * bz + vz;
            if (seen.has(key)) continue;
            seen.add(key);
            this.pushCell(cells, vx, vy, vz);
            cx += this.wp.x; cy += this.wp.y; cz += this.wp.z; hit++;
          }
        }
      }
    }
    if (hit === 0) return; // the spar isn't buried in B's wood → nothing to bore (it overrides/misses)
    cx /= hit; cy /= hit; cz /= hit;

    // horizontal closing speed at the contact centroid (same convention as the hull-crush rule:
    // horizontal so wave heave never reads as closing, and the impulse at COM height yaws not rolls).
    A.comWorld(this.comA); B.comWorld(this.comB);
    velAt(this.comA, A.linvel(), A.angvel(), cx, cy, cz, this.vA);
    velAt(this.comB, B.linvel(), B.angvel(), cx, cy, cz, this.vB);
    let dhx = this.vA.x - this.vB.x, dhz = this.vA.z - this.vB.z;
    const dlen = Math.hypot(dhx, dhz);
    if (dlen < 1e-4) return;
    dhx /= dlen; dhz /= dlen;
    const sA = this.vA.x * dhx + this.vA.z * dhz;
    const sB = this.vB.x * dhx + this.vB.z * dhz;
    const vClose = sA - sB;
    if (vClose <= TUN.crush.vBreak) return; // a slow nudge does no damage (same gate as hull crush)

    const mA = Math.max(A.mass(), 1), mB = Math.max(B.mass(), 1);
    const mu = (mA * mB) / (mA + mB);
    const budget = Math.min(0.5 * mu * vClose * vClose, TUN.crush.maxStepEnergy);
    const { removed, leftover } = B.crush(cells, budget); // the universal energy→voxels primitive
    if (removed === 0) return;
    const energy = budget - leftover;

    // shed the fracture energy off the closing motion: drag the aggressor + a tunable transfer
    // to the struck hull — identical to the hull-hull bite (crush.splitClosingImpulse).
    const dvClose = breakImpulse(mu, vClose, energy, TUN.crush.biteDvCap) / mu;
    const { jA, jB } = splitClosingImpulse(mA, mB, mu, sA, sB, dvClose, TUN.crush.transferFrac);
    this.imp.set(-dhx * jA, 0, -dhz * jA); A.applyImpulseAtPoint(this.imp, { x: cx, y: this.comA.y, z: cz });
    this.imp.set(dhx * jB, 0, dhz * jB); B.applyImpulseAtPoint(this.imp, { x: cx, y: this.comB.y, z: cz });

    if (this.effects) {
      this.imp.set(cx, cy, cz);
      this.effects.crunch(this.imp, removed);
    }
  }

  /** Store a cell in `list`, reusing a pooled tuple so a sustained bore allocates nothing. */
  private pushCell(list: [number, number, number][], x: number, y: number, z: number): void {
    const i = list.length;
    let t = this.cellPool[i];
    if (t) { t[0] = x; t[1] = y; t[2] = z; } else { t = [x, y, z]; this.cellPool[i] = t; }
    list.push(t);
  }
}

/** World velocity of a body (com, linvel lv, angvel av) at world point (px,py,pz). */
function velAt(
  com: THREE.Vector3,
  lv: { x: number; y: number; z: number }, av: { x: number; y: number; z: number },
  px: number, py: number, pz: number, out: THREE.Vector3,
): void {
  const rx = px - com.x, ry = py - com.y, rz = pz - com.z;
  out.set(lv.x + (av.y * rz - av.z * ry), lv.y + (av.z * rx - av.x * rz), lv.z + (av.x * ry - av.y * rx));
}

function aabbIntersect(a: { min: THREE.Vector3; max: THREE.Vector3 }, b: { min: THREE.Vector3; max: THREE.Vector3 }): boolean {
  return a.max.x >= b.min.x && a.min.x <= b.max.x &&
    a.max.y >= b.min.y && a.min.y <= b.max.y &&
    a.max.z >= b.min.z && a.min.z <= b.max.z;
}
