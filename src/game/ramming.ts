import * as THREE from "three";
import { VOXEL_SIZE } from "../core/constants";
import { velocityAtPoint } from "./gunnery";
import type { Effects } from "../render/effects";
import type { Ship } from "./ship";

/**
 * Ramming (round 7: "ideally ramming someone would brutally damage both
 * ships"). Rapier's coarse hull boxes already stop ships interpenetrating;
 * this watches for the moment they meet WITH WAY ON and carves voxels out
 * of both hulls at the point of contact, scaled by the closing speed —
 * breaches, flooding, and (hard enough, through the connectivity check)
 * an outright split all follow from the ordinary damage path.
 */
const MIN_CLOSING = 4; // m/s — slower than this is fenders, not carnage
const COOLDOWN = 1.2; // s between bites for a grinding pair
const SAMPLES = 20; // perimeter points tested per hull

export class Ramming {
  /** Called on impact with the closing speed (m/s) — for toasts/sounds. */
  onRam?: (speed: number) => void;

  private cooldown = 0;
  private tmpW = new THREE.Vector3();
  private tmpL = new THREE.Vector3();
  private tmpVa = new THREE.Vector3();
  private tmpVb = new THREE.Vector3();
  private tmpCell = new THREE.Vector3();

  constructor(private effects: Effects) {}

  update(dt: number, ships: Ship[]): void {
    this.cooldown = Math.max(this.cooldown - dt, 0);
    if (this.cooldown > 0) return;
    for (let i = 0; i < ships.length; i++) {
      for (let j = i + 1; j < ships.length; j++) {
        if (this.checkPair(ships[i], ships[j])) {
          this.cooldown = COOLDOWN;
          return;
        }
      }
    }
  }

  private checkPair(a: Ship, b: Ship): boolean {
    const [anx, , anz] = a.build.grid.dims;
    const [bnx, , bnz] = b.build.grid.dims;
    const reachA = (Math.max(anx, anz) * VOXEL_SIZE) / 2 + 2;
    const reachB = (Math.max(bnx, bnz) * VOXEL_SIZE) / 2 + 2;
    // the body origin is the grid corner; centers sit half a grid away
    a.localToWorld([(anx * VOXEL_SIZE) / 2, 0, (anz * VOXEL_SIZE) / 2], this.tmpW);
    const cax = this.tmpW.x;
    const caz = this.tmpW.z;
    b.localToWorld([(bnx * VOXEL_SIZE) / 2, 0, (bnz * VOXEL_SIZE) / 2], this.tmpW);
    if (Math.hypot(this.tmpW.x - cax, this.tmpW.z - caz) > reachA + reachB) return false;

    // the collision boxes ARE the grid rectangles — when rapier stops the
    // hulls, these rects are touching. Find a perimeter point of one inside
    // the (slightly inflated) rect of the other.
    const contact = this.findContact(a, b) ?? this.findContact(b, a);
    if (!contact) return false;

    velocityAtPoint(a, contact, this.tmpVa);
    velocityAtPoint(b, contact, this.tmpVb);
    const closing = Math.hypot(this.tmpVa.x - this.tmpVb.x, this.tmpVa.z - this.tmpVb.z);
    if (closing < MIN_CLOSING) return false;

    // bite radius in VOXELS: a 10-knot ram tears a ~1.2 m-radius hole in
    // each hull, right at the waterline
    const radiusVox = Math.min(2 + closing * 0.45, 7);
    this.bite(a, contact, radiusVox);
    this.bite(b, contact, radiusVox);
    const n = this.tmpL.set(this.tmpVa.x - this.tmpVb.x, 0.4, this.tmpVa.z - this.tmpVb.z).normalize();
    this.effects.splinters(contact, n);
    this.effects.splinters(contact, n.negate());
    this.effects.splash(contact.x, contact.y - 1, contact.z, 1.5);
    this.onRam?.(closing);
    return true;
  }

  /** First perimeter point of `probe`'s waterline rectangle that lies inside
   *  `target`'s grid rectangle (world space, returned as a fresh use of the
   *  shared temp — consume before the next call). */
  private findContact(probe: Ship, target: Ship): THREE.Vector3 | null {
    const [pnx, , pnz] = probe.build.grid.dims;
    const [tnx, , tnz] = target.build.grid.dims;
    const px = pnx * VOXEL_SIZE;
    const pz = pnz * VOXEL_SIZE;
    const yP = probe.comLocal[1] * 0.8;
    const perim = 2 * (px + pz);
    for (let s = 0; s < SAMPLES; s++) {
      let d = (s / SAMPLES) * perim;
      let lx: number;
      let lz: number;
      if (d < px) {
        lx = d;
        lz = 0;
      } else if ((d -= px) < pz) {
        lx = px;
        lz = d;
      } else if ((d -= pz) < px) {
        lx = px - d;
        lz = pz;
      } else {
        lx = 0;
        lz = pz - (d - px);
      }
      probe.localToWorld([lx, yP, lz], this.tmpW);
      target.worldToLocal(this.tmpW, this.tmpL);
      const m = 0.35; // inflate: boxes touch, samples land a hair outside
      if (
        this.tmpL.x > -m &&
        this.tmpL.x < tnx * VOXEL_SIZE + m &&
        this.tmpL.z > -m &&
        this.tmpL.z < tnz * VOXEL_SIZE + m
      ) {
        return this.tmpW;
      }
    }
    return null;
  }

  /** Carve a sphere out of the ship nearest the world contact point — the
   *  point is clamped into the hull's real footprint so the bite always
   *  lands on timber, not the grid's empty padding. */
  private bite(ship: Ship, contactW: THREE.Vector3, radiusVox: number): void {
    ship.worldToLocal(this.tmpCell.copy(contactW), this.tmpCell);
    const fp = ship.build.footprint;
    const lx = Math.min(Math.max(this.tmpCell.x, fp.minX + 0.4), fp.maxX - 0.4);
    const lz = Math.min(Math.max(this.tmpCell.z, fp.zC - fp.halfZ + 0.3), fp.zC + fp.halfZ - 0.3);
    const ly = ship.comLocal[1] * 0.8; // near the waterline: rams flood
    ship.applyDamage(
      [Math.floor(lx / VOXEL_SIZE), Math.floor(ly / VOXEL_SIZE), Math.floor(lz / VOXEL_SIZE)],
      radiusVox,
    );
  }
}
