import * as THREE from "three";
import { FIXED_DT } from "../core/constants";
import { physicsWaves, type Wave } from "../sim/gerstner";
import type { Physics } from "./physics";
import { Ship } from "./ship";
import { VoxelContact, type ContactTarget } from "./voxelContact";
import { RigManager } from "./rig";

/**
 * Game orchestration: owns ships, runs the fixed-step physics loop with an
 * accumulator, and keeps a deterministic simulation clock (simTime) that the
 * ocean shader and wave sampling share so render and physics never disagree.
 *
 * Hull forces and flooding sample the LONG-WAVELENGTH subset of the sea
 * (physicsWaves): the ship rides the swell while the visual chop slides
 * under her — that's the round-8 "substantial" feel. Anything answering
 * "where is the VISIBLE surface" (swimmers, splashes, the camera) keeps
 * using the full set.
 */
export class GameWorld {
  readonly ships: Ship[] = [];
  /** The deformable ship-vs-ship contact: lets the hulls interpenetrate, carves the real voxel
   *  overlap, then resolves non-penetration + inelastic momentum itself (ship-ship is out of
   *  Rapier's solver, see physics.ts). main.ts may attach `.effects` for dust + read `.debug`. */
  readonly contact = new VoxelContact();
  /** Voxel-rig runtime (game/rig.ts): the bowsprit/ram spar borings + (later) mast/sail physics.
   *  Feeds the SAME crush rule as the hull contact. main.ts may attach `.effects`. */
  readonly rig = new RigManager();
  /** Static terrain (islands, cliffs, sea stacks) as crush hull-B; populated by main.ts after the
   *  IslandField is built. Empty in headless tests (ship-vs-ship still runs). */
  terrain: ContactTarget[] = [];
  simTime = 0;
  /** Buoyancy wave-sampling LOD focus — set to the player ship. Ships far from it sample the (smooth)
   *  swell more coarsely in applyForces; null → no LOD (tests/headless sample every column exactly). */
  focus: Ship | null = null;
  /** Per-frame CPU timing breakdown in ms — pure diagnostics (perf HUD + DEBUG.world.timing),
   *  never read by physics or the vitest oracle. `substeps` = fixed steps run this frame (1 at
   *  60 fps, up to 2 when the frame is slow and the accumulator saturates → the work multiplier). */
  readonly timing = { flood: 0, buoy: 0, fixed: 0, contact: 0, flush: 0, rapier: 0, visual: 0, total: 0, substeps: 0 };
  /** Called every fixed step after buoyancy, before the physics step —
   *  sailing forces, AI, projectiles hook in here. */
  onFixedStep?: (simTime: number, dt: number) => void;
  private accumulator = 0;
  private readonly physWaves: Wave[];

  constructor(
    private physics: Physics,
    readonly waves: Wave[],
    readonly scene: THREE.Scene,
  ) {
    this.physWaves = physicsWaves(waves);
  }

  addShip(ship: Ship): void {
    this.ships.push(ship);
    this.scene.add(ship.visual.group);
  }

  /** Remove a ship: drop it from the sim list, the scene (disposing its visual
   *  geometry/materials), and the Rapier world (which also frees its colliders).
   *  Used by the FleetManager for despawn + sunk-wreck cleanup. No-op if absent. */
  removeShip(ship: Ship): void {
    const i = this.ships.indexOf(ship);
    if (i === -1) return;
    this.ships.splice(i, 1);
    this.scene.remove(ship.visual.group);
    ship.visual.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) mat.dispose();
    });
    this.physics.shipBodies.delete(ship.body.handle); // handles are recycled — drop the stale one
    this.physics.world.removeRigidBody(ship.body);
  }

  /** Advance simulation by real dt (seconds), in fixed steps (max 2/frame). */
  step(dt: number): void {
    // Per-frame CPU timing (pure diagnostics): reset, then accumulate each phase across however
    // many fixed substeps run this frame. performance.now() is sub-µs; ~70 calls/frame is noise.
    const tm = this.timing;
    tm.flood = tm.buoy = tm.fixed = tm.contact = tm.flush = tm.rapier = tm.visual = tm.substeps = 0;
    const tStart = performance.now();
    // Cap catch-up at 2 substeps (was 5): a slow frame must NOT be allowed to run 5× the physics,
    // which only makes the next frame slower — a positive-feedback spiral that pinned the fleet at
    // ~10 fps. Capping at 2 trades a touch of slow-motion under extreme load for a stable frame.
    this.accumulator = Math.min(this.accumulator + dt, FIXED_DT * 2);
    // buoyancy LOD focus (the player ship), sampled once per frame — distant ships sample the swell coarsely
    let focusX: number | undefined, focusZ: number | undefined;
    if (this.focus) {
      const ft = this.focus.body.translation();
      focusX = ft.x;
      focusZ = ft.z;
    }
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this.simTime += FIXED_DT;
      tm.substeps++;
      for (const ship of this.ships) {
        const a = performance.now();
        ship.updateFlooding(FIXED_DT, this.physWaves, this.simTime);
        const b = performance.now();
        ship.applyForces(this.physWaves, this.simTime, focusX, focusZ);
        tm.flood += b - a;
        tm.buoy += performance.now() - b;
      }
      let a = performance.now();
      this.onFixedStep?.(this.simTime, FIXED_DT);
      tm.fixed += performance.now() - a;
      // deformable ship-vs-ship crunch: reads the real voxel overlap, carves both hulls, cancels the
      // closing velocity (inelastic) and de-penetrates by POSITION so they can't phase through. Runs
      // BEFORE the Rapier step so its velocity + position fixes integrate this step. Sets damageDirty.
      a = performance.now();
      this.contact.stepAll(this.ships, this.terrain, FIXED_DT);
      // rig contributions (Phase 2: bowsprit boring) feed the SAME crush; run right after the
      // hull contact and before the Rapier step so their impulses + carves land this step.
      this.rig.stepAll(this.ships, FIXED_DT);
      tm.contact += performance.now() - a;
      a = performance.now();
      for (const ship of this.ships) ship.flushDamage(); // throttled heavy damage recompute
      tm.flush += performance.now() - a;
      // hooks: filterContactPair pulls ship-vs-ship pairs out of the rigid solver (physics.ts).
      // The EventQueue is REQUIRED for the hooks to fire in this Rapier build (see Physics.events).
      a = performance.now();
      this.physics.world.step(this.physics.events, this.physics.hooks);
      tm.rapier += performance.now() - a;
    }
    const v = performance.now();
    for (const ship of this.ships) {
      ship.visual.refresh();
      // syncVisual FIRST: the flood fluid reads the ship group's world
      // transform to hold its surfaces world-level and clip them to the heeled
      // hull, so the group must carry the fresh body transform before
      // updateWater runs. (No camera is available at this seam — the fluid
      // shades from straight above when none is passed.)
      ship.syncVisual();
      ship.visual.updateWater(ship.build.compartments, undefined, dt);
    }
    tm.visual = performance.now() - v;
    tm.total = performance.now() - tStart;
  }
}
