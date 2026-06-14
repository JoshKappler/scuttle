import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { TUN } from "../core/tunables";
import type { Effects } from "../render/effects";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

// Set window.__ramDebug = true in the console to log impulse + carve counts.
declare global { interface Window { __ramDebug?: boolean } }

/**
 * Ship-vs-ship destruction. Each fixed step, poll Rapier's contact manifold for
 * every ship pair and carve BOTH hulls at the contact. Energy is driven by the
 * actual CONTACT IMPULSE Rapier applied to resolve the collision — this stays large
 * through a hard ram/grind, unlike instantaneous relative velocity, which drops to
 * ~0 the moment two inelastic hulls move together (that bug made rams just shove,
 * never destroy). Embedding / tearing / the bow-wins asymmetry all EMERGE from
 * carve()'s material-cost model. Strength is live-tunable via TUN.ram. Replaces the
 * coarse-box ramming hack.
 */
export class CollisionDestruction {
  private contact = new THREE.Vector3();
  private cell = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private nrm = new THREE.Vector3();
  private q = new THREE.Quaternion();
  constructor(private physics: Physics, private effects: Effects) {}

  update(ships: Ship[]): void {
    const { world } = this.physics;
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        const a = ships[i], b = ships[j];
        world.contactPair(a.hull.collider, b.hull.collider, (m, flipped) => {
          const nc = m.numContacts();
          if (nc === 0) return;
          let impulse = 0;
          for (let k = 0; k < nc; k++) impulse += Math.abs(m.contactImpulse(k));
          // Only the impulse ABOVE the crush threshold destroys. A hull resting its
          // weight on another, a gentle wave-driven fender, two hulls floating side by
          // side — all sit at/below minImpulse and carve NOTHING (this is what stops the
          // "anything that touches a voxel melts" + the side-by-side grind). The excess
          // (a real hit: closing-speed × reduced-mass) is what tears voxels out, so
          // destruction scales with how hard she actually strikes, never with mere weight.
          const excess = impulse - TUN.ram.minImpulse;
          if (excess <= 0) return;
          const cp = m.solverContactPoint(0);
          if (!cp) return;
          const n = m.normal();
          const energy = TUN.ram.impulseToJoules * excess;
          this.contact.set(cp.x, cp.y, cp.z);
          this.nrm.set(n.x, n.y, n.z);
          // normal points collider1(a)→collider2(b) unless flipped; carve each hull inboard
          const s = flipped ? -1 : 1;
          const aLost = this.carveInto(a, energy, this.dir.set(-n.x * s, -n.y * s, -n.z * s));
          const bLost = this.carveInto(b, energy, this.dir.set(n.x * s, n.y * s, n.z * s));
          if (aLost + bLost > 0) {
            this.effects.splinters(this.contact, this.nrm);
            this.effects.splash(this.contact.x, this.contact.y - 1, this.contact.z, 1.5);
          }
          if (window.__ramDebug) {
            // eslint-disable-next-line no-console
            console.log(`[ram] impulse=${impulse | 0} E=${energy | 0} aLost=${aLost} bLost=${bLost}`);
          }
        });
      }
    }
  }

  /** Carve `ship` at the shared contact point along `worldDirInto` (rotated into the
   *  hull's grid frame). Returns the number of voxels destroyed. */
  private carveInto(ship: Ship, energy: number, worldDirInto: THREE.Vector3): number {
    ship.worldToLocal(this.contact, this.cell);
    const cx = Math.floor(this.cell.x / VOXEL_SIZE);
    const cy = Math.floor(this.cell.y / VOXEL_SIZE);
    const cz = Math.floor(this.cell.z / VOXEL_SIZE);
    const r = ship.body.rotation();
    this.q.set(r.x, r.y, r.z, r.w).conjugate(); // world → local rotation
    const ld = worldDirInto.applyQuaternion(this.q);
    const len = ld.length() || 1;
    // small per-step cap → each contact-step takes a small cluster, never a whole row;
    // a deep gash emerges over the many steps a sustained ram stays in contact.
    return ship.carve([cx, cy, cz], energy, [ld.x / len, ld.y / len, ld.z / len], TUN.ram.maxCellsPerHit);
  }
}
