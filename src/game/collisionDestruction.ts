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
  private com = new THREE.Vector3();
  private q = new THREE.Quaternion();
  constructor(private physics: Physics, private effects: Effects) {}

  update(ships: Ship[]): void {
    if (!TUN.ram.enabled) return;
    const { world } = this.physics;
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        const a = ships[i], b = ships[j];
        world.contactPair(a.hull.collider, b.hull.collider, (m, flipped) => {
          const nc = m.numContacts();
          if (nc === 0) return;
          let impulse = 0;
          for (let k = 0; k < nc; k++) impulse += Math.abs(m.contactImpulse(k));
          // THE GATE (Teardown's capped contact): only the impulse ABOVE the crush
          // threshold gives way. At/below it the contact is SOLID — a weight a hull can
          // bear, a gentle fender, two hulls rafted side by side → zero destruction. This
          // runs in onFixedStep, BEFORE this step's solver, so carving the contact voxels
          // RELIEVES the contact: the struck hull is barely shoved and the rammer digs into
          // the void it just opened. (Perching is impossible the same way: your own weight
          // on a few deck voxels clears the threshold → they crush → you fall through.)
          const excess = impulse - TUN.ram.minImpulse;
          if (excess <= 0) return;
          const cp = m.solverContactPoint(0);
          if (!cp) return;
          const n = m.normal();
          const energy = TUN.ram.impulseToJoules * excess;
          this.contact.set(cp.x, cp.y, cp.z);
          this.nrm.set(n.x, n.y, n.z);
          // unit contact normal a→b (sign-corrected); carve each hull INWARD from the contact
          const s = flipped ? -1 : 1;
          const dx = n.x * s, dy = n.y * s, dz = n.z * s;
          const aLost = this.carveInto(a, energy, this.dir.set(-dx, -dy, -dz));
          const bLost = this.carveInto(b, energy, this.dir.set(dx, dy, dz));
          const voxels = aLost + bLost;
          if (voxels > 0) {
            // the touched zone becomes DUST (flying motes, no rigid body); the momentum of
            // whichever hull is driving in bleeds into that destruction — it slows, the
            // other is not shoved (energy into the wreck, not a rigid hand-off).
            this.effects.impactDebris(this.contact, this.nrm, voxels);
            this.brake(a, dx, dy, dz, voxels);
            this.brake(b, -dx, -dy, -dz, voxels);
          }
          if (window.__ramDebug) {
            // eslint-disable-next-line no-console
            console.log(`[ram] J=${impulse | 0} exc=${excess | 0} E=${energy | 0} aLost=${aLost} bLost=${bLost}`);
          }
        });
      }
    }
  }

  /** Carve `ship` at the shared contact point along `worldDirInto` (rotated into the hull's
   *  grid frame), capped per-step. planCarve's material cost makes a strong RAM bow shrug off
   *  the same energy that caves an oak side — the bow-wins asymmetry is emergent, not coded. */
  private carveInto(ship: Ship, energy: number, worldDirInto: THREE.Vector3): number {
    ship.worldToLocal(this.contact, this.cell);
    const cx = Math.floor(this.cell.x / VOXEL_SIZE);
    const cy = Math.floor(this.cell.y / VOXEL_SIZE);
    const cz = Math.floor(this.cell.z / VOXEL_SIZE);
    const r = ship.body.rotation();
    this.q.set(r.x, r.y, r.z, r.w).conjugate(); // world → local rotation
    const ld = worldDirInto.applyQuaternion(this.q);
    const len = ld.length() || 1;
    return ship.carve([cx, cy, cz], energy, [ld.x / len, ld.y / len, ld.z / len], TUN.ram.maxCellsPerHit);
  }

  /** Bleed momentum from `ship` IF it is driving into the contact — its velocity at the
   *  contact point has a positive component along (intoX,intoY,intoZ), the unit direction
   *  toward the other hull. The bled momentum is the energy spent pulverizing voxels; it
   *  goes "into the dust", not into the other ship, so the rammer decelerates as it digs in
   *  while the struck hull is barely moved. Clamped so it can never reverse the hull. */
  private brake(ship: Ship, intoX: number, intoY: number, intoZ: number, voxels: number): void {
    if (TUN.ram.drag <= 0) return;
    const body = ship.body;
    const lv = body.linvel();
    const av = body.angvel();
    ship.localToWorld(ship.comLocal, this.com); // world centre of mass
    const rx = this.contact.x - this.com.x;
    const ry = this.contact.y - this.com.y;
    const rz = this.contact.z - this.com.z;
    // velocity at the contact point: v + ω × r
    const vx = lv.x + (av.y * rz - av.z * ry);
    const vy = lv.y + (av.z * rx - av.x * rz);
    const vz = lv.z + (av.x * ry - av.y * rx);
    const vIn = vx * intoX + vy * intoY + vz * intoZ; // closing speed of THIS hull into the contact
    if (vIn <= 0) return; // not the one charging in — leave its motion to the solver
    const mag = Math.min(voxels * TUN.ram.drag, body.mass() * vIn); // clamp: never reverse
    body.applyImpulse({ x: -intoX * mag, y: -intoY * mag, z: -intoZ * mag }, true);
  }
}
