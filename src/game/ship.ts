import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { VOXEL_SIZE, WATER_DENSITY } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { makeProbes, probeForce, submergedFraction, type Probe } from "../sim/buoyancy";
import type { ShipBuild } from "../sim/shipwright";
import type { ShipVisual } from "../render/shipVisual";
import type { Physics } from "./physics";

/**
 * A ship: ONE dynamic rigid body + voxel grid + compartments + visual.
 * Buoyancy/flood/drag forces are applied at probe points every fixed step;
 * listing, trim, and sinking are emergent — nothing here scripts motion.
 */
export class Ship {
  readonly body: RAPIER.RigidBody;
  readonly build: ShipBuild;
  readonly visual: ShipVisual;
  probes: Probe[];

  /** Diagnostic: 0..1 share of envelope currently below the surface. */
  submergedFrac = 0;

  private inertia: [number, number, number];
  private tmpV = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(phys: Physics, build: ShipBuild, visual: ShipVisual, spawn: { x: number; y: number; z: number }) {
    this.build = build;
    this.visual = visual;
    this.probes = makeProbes(build.grid, build.compartments);

    const { world, RAPIER: R } = phys;
    const mass = build.grid.totalMass();
    const com = build.grid.centerOfMass();
    const [nx, ny, nz] = build.grid.dims;
    const l = nx * VOXEL_SIZE;
    const h = ny * VOXEL_SIZE;
    const w = nz * VOXEL_SIZE;

    // box-approximated principal inertia about the COM
    const ixx = (mass / 12) * (w * w + h * h);
    const iyy = (mass / 12) * (l * l + w * w);
    const izz = (mass / 12) * (l * l + h * h);
    this.inertia = [ixx, iyy, izz];

    const desc = R.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(0.02)
      .setAngularDamping(0.15)
      .setAdditionalMassProperties(
        mass,
        { x: com[0], y: com[1], z: com[2] },
        { x: ixx, y: iyy, z: izz },
        { x: 0, y: 0, z: 0, w: 1 },
      );
    this.body = world.createRigidBody(desc);

    // coarse hull collider (cannonballs & ship contact); zero density —
    // mass comes from the voxel grid above
    const collider = R.ColliderDesc.cuboid(l / 2, (h * 0.7) / 2, w / 2)
      .setTranslation(l / 2, (h * 0.7) / 2, w / 2)
      .setDensity(0);
    world.createCollider(collider, this.body);
  }

  /** Apply buoyancy + water drag for one fixed step. Call before world.step(). */
  applyForces(waves: Wave[], t: number, floodFrac: (compartmentId: number) => number): void {
    const body = this.body;
    body.resetForces(true);
    body.resetTorques(true);

    const tr = body.translation();
    const rot = body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);

    let submergedVolume = 0;
    let totalVolume = 0;

    for (const p of this.probes) {
      const wp = this.tmpV.set(p.local[0], p.local[1], p.local[2]).applyQuaternion(this.tmpQ);
      const wx = wp.x + tr.x;
      const wy = wp.y + tr.y;
      const wz = wp.z + tr.z;
      const surfaceY = surfaceHeight(waves, wx, wz, t);
      const flood = p.compartmentId >= 0 ? floodFrac(p.compartmentId) : 0;
      const f = probeForce(p, wy, surfaceY, flood);
      totalVolume += p.volume;
      if (f > 0) {
        const sub = submergedFraction(p, wy, surfaceY);
        // apply at the submerged-segment centroid (ship-local), else the ship
        // is hydrostatically unstable — see buoyancy.ts and stability.test.ts
        const ap = this.tmpV
          .set(p.local[0], p.local[1] + (sub * p.height) / 2, p.local[2])
          .applyQuaternion(this.tmpQ);
        body.addForceAtPoint(
          { x: 0, y: f, z: 0 },
          { x: ap.x + tr.x, y: ap.y + tr.y, z: ap.z + tr.z },
          true,
        );
        submergedVolume += p.volume * sub;
      }
    }
    this.submergedFrac = totalVolume > 0 ? submergedVolume / totalVolume : 0;

    // water drag: linear + quadratic on velocity, strong angular damping —
    // all scaled by how much of the hull is actually in the water
    const sub = this.submergedFrac;
    if (sub > 0.001) {
      const mass = this.body.mass();
      const v = body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const k = mass * (0.35 + 0.18 * speed) * sub;
      body.addForce({ x: -v.x * k, y: -v.y * k * 1.6, z: -v.z * k }, true);

      const om = body.angvel();
      const ka = sub * 1.1;
      const [ix, iy, iz] = this.inertia;
      body.addTorque({ x: -om.x * ka * ix, y: -om.y * ka * iy * 0.6, z: -om.z * ka * iz }, true);
    }
  }

  /** Copy body transform to the visual group. */
  syncVisual(): void {
    const tr = this.body.translation();
    const rot = this.body.rotation();
    this.visual.group.position.set(tr.x, tr.y, tr.z);
    this.visual.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);
  }

  /** World-space position of the ship-local point (meters). */
  localToWorld(local: [number, number, number], out: THREE.Vector3): THREE.Vector3 {
    const tr = this.body.translation();
    const rot = this.body.rotation();
    this.tmpQ.set(rot.x, rot.y, rot.z, rot.w);
    return out.set(local[0], local[1], local[2]).applyQuaternion(this.tmpQ).add(this.tmpV.set(tr.x, tr.y, tr.z));
  }

  /** Density-ratio draft estimate (diagnostics): expected submerged fraction at rest. */
  expectedSubmergedFrac(): number {
    return this.build.grid.totalMass() / (WATER_DENSITY * this.build.envelopeVolume);
  }
}
