import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { velocityAtPoint } from "./gunnery";
import { impactEnergy, KAPPA } from "../sim/impact";
import type { Effects } from "../render/effects";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

const MIN_CLOSING = 1.5; // m/s — gentler contact is fenders, not carnage

/**
 * Ship-vs-ship destruction. Each fixed step, poll Rapier's contact manifold for
 * every ship pair (world.contactPair — robust; force events are too sparse).
 * Where two hulls touch with way on, carve BOTH at the contact along the closing
 * direction, energy = impactEnergy(mA, mB, vRelNormal, KAPPA). Embedding, tearing,
 * and the bow-wins asymmetry all EMERGE from carve()'s material-cost model.
 * Replaces the coarse-box perimeter hack in ramming.ts.
 */
export class CollisionDestruction {
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
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
        world.contactPair(a.hull.collider, b.hull.collider, (m) => {
          if (m.numContacts() === 0) return;
          const cp = m.solverContactPoint(0);
          if (!cp) return;
          const n = m.normal();
          this.contact.set(cp.x, cp.y, cp.z);
          velocityAtPoint(a, this.contact, this.vA);
          velocityAtPoint(b, this.contact, this.vB);
          const vRelN = Math.abs((this.vA.x - this.vB.x) * n.x + (this.vA.y - this.vB.y) * n.y + (this.vA.z - this.vB.z) * n.z);
          if (vRelN < MIN_CLOSING) return;
          const E = impactEnergy(a.body.mass(), b.body.mass(), vRelN, KAPPA);
          if (E <= 0) return;
          // carve each hull along the OTHER hull's motion relative to it (the closing dir)
          this.carveInto(a, E, this.dir.set(this.vB.x - this.vA.x, this.vB.y - this.vA.y, this.vB.z - this.vA.z));
          this.carveInto(b, E, this.dir.set(this.vA.x - this.vB.x, this.vA.y - this.vB.y, this.vA.z - this.vB.z));
          this.nrm.set(n.x, n.y, n.z);
          this.effects.splinters(this.contact, this.nrm);
          this.effects.splash(this.contact.x, this.contact.y - 1, this.contact.z, 1.5);
        });
      }
    }
  }

  // contact (world) is in this.contact; worldDirInto is a fresh direction in this.dir
  private carveInto(ship: Ship, energy: number, worldDirInto: THREE.Vector3): void {
    ship.worldToLocal(this.contact, this.cell); // local meters (worldToLocal is alias-safe; here in/out differ anyway)
    const cx = Math.floor(this.cell.x / VOXEL_SIZE);
    const cy = Math.floor(this.cell.y / VOXEL_SIZE);
    const cz = Math.floor(this.cell.z / VOXEL_SIZE);
    const r = ship.body.rotation();
    this.q.set(r.x, r.y, r.z, r.w).conjugate();         // world → local rotation
    const ld = worldDirInto.applyQuaternion(this.q);    // rotate the impact dir into the grid frame
    const len = ld.length() || 1;
    ship.carve([cx, cy, cz], energy, [ld.x / len, ld.y / len, ld.z / len]);
  }
}
