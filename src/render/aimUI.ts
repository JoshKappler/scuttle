import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { muzzleWorld, type MuzzleOut } from "../game/gunnery";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { FIXED_DT, G } from "../core/constants";
import { TUN } from "../core/tunables";
import type { Ship } from "../game/ship";

/** Broadside trajectory preview + battery-bearing logic, extracted from main.ts (round 12,
 *  pure move). INVARIANT (CLAUDE.md `gun`): the preview reads the SAME live ballistics the
 *  ball uses — TUN.gun.muzzleSpeed/drag at draw time, integrated at the ball's own
 *  FIXED_DT/G step — so the rendered trajectory ≡ the real shot, dev-panel sliders included. */

export type Bearing = 1 | -1 | "fore" | "aft";

// broadside trajectory preview while aiming (RMB): one arc PER CANNON on
// the aiming side (playtest: "all four cannons … should show their
// trajectory as well and articulate")
export const ARC_PTS = 64; // vertices in the preview polyline
// integrate the preview at the ball's exact step; record 1 vertex per this
// many sim steps → ARC_PTS·ARC_SUB·FIXED_DT ≈ 6.4 s of flight covered. r18: bumped
// 4→6 because the faster r18 muzzle (TUN.gun) flies longer, so 4.3 s clipped the arc
// short of its splash at normal combat elevations; the flatter shot stays smooth coarser.
export const ARC_SUB = 6;

/** Pure battery pick from the camera look direction expressed in SHIP-LOCAL axes:
 *  more along the keel than across it lays the bow/stern CHASERS; across lays the broadside. */
export function classifyBearing(lookLocalX: number, lookLocalZ: number): Bearing {
  if (Math.abs(lookLocalX) > Math.abs(lookLocalZ)) return lookLocalX >= 0 ? "fore" : "aft";
  return lookLocalZ >= 0 ? 1 : -1;
}

export function gunBears(p: { side: 1 | -1; facing?: "fore" | "aft" }, b: Bearing): boolean {
  return typeof b === "number" ? !p.facing && p.side === b : p.facing === b;
}

/** Pure preview integration — the exact loop moved from main.ts updateAimArc:
 *  muzzle velocity along the barrel, NO ship carry, Euler at FIXED_DT with quadratic drag,
 *  1 vertex per ARC_SUB steps, tail clamped to the splash point where the arc meets the sea. */
export function integrateAimArc(
  out: Float32Array,
  muzzlePos: THREE.Vector3,
  muzzleDir: THREE.Vector3,
  muzzleSpeed: number,
  drag: number,
  seaHeight: (x: number, z: number) => number,
): void {
  const v = muzzleDir.clone().multiplyScalar(muzzleSpeed);
  const p = muzzlePos.clone();
  let vi = 0;
  for (let stepN = 0; vi < ARC_PTS; stepN++) {
    if (stepN % ARC_SUB === 0) {
      out[vi * 3] = p.x;
      out[vi * 3 + 1] = p.y;
      out[vi * 3 + 2] = p.z;
      vi++;
    }
    const sp = v.length();
    v.x += -drag * sp * v.x * FIXED_DT;
    v.y += (-G - drag * sp * v.y) * FIXED_DT;
    v.z += -drag * sp * v.z * FIXED_DT;
    p.addScaledVector(v, FIXED_DT);
    if (p.y < seaHeight(p.x, p.z)) {
      for (let j = vi; j < ARC_PTS; j++) {
        out[j * 3] = p.x;
        out[j * 3 + 1] = p.y;
        out[j * 3 + 2] = p.z;
      }
      break;
    }
  }
}

export interface AimUIDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls: { aiming: boolean; elevationDeg: number; traverseDeg: number };
  cannons: {
    portReload(ship: Ship, portIndex: number, simTime: number): number;
    portReloadFrac(ship: Ship, portIndex: number, simTime: number): number;
  };
  waves: Wave[];
  getShip(): Ship;
  getSimTime(): number;
}

export class AimUI {
  private readonly lines: { line: Line2; geo: LineGeometry; mat: LineMaterial; pos: Float32Array }[] = [];
  private readonly lookV = new THREE.Vector3();
  private readonly _aimInv = new THREE.Quaternion(); // reused — aimBearing() runs several times/frame
  private readonly arcMuzzle: MuzzleOut = { pos: new THREE.Vector3(), dir: new THREE.Vector3() };

  constructor(private readonly d: AimUIDeps) {
    this.rebuildAimLines(); // mirrors the old top-level rebuildAimLines() call in main.ts
  }

  // (Re)build one preview polyline per gun on the larger broadside of the CURRENT hull. MUST run on
  // every hull swap: the Cutter has ~4 guns/side but the Man-o'-War ~24, and a pool sized once for the
  // starting Cutter left a Man-o'-War showing only 4 arcs (playtest).
  // FAT lines (Line2): a plain THREE.Line is locked to 1px on every desktop GL driver and read as
  // "too faint" — Line2 draws a real screen-space-thick ribbon (linewidth in px, needs resolution).
  rebuildAimLines(): void {
    for (const a of this.lines) {
      this.d.scene.remove(a.line);
      a.geo.dispose();
      a.mat.dispose();
    }
    this.lines.length = 0;
    const build = this.d.getShip().build;
    const gunsPerSide = Math.max(
      build.cannonPorts.filter((p) => p.side === 1).length,
      build.cannonPorts.filter((p) => p.side === -1).length,
    );
    for (let i = 0; i < gunsPerSide; i++) {
      const pos = new Float32Array(ARC_PTS * 3);
      const geo = new LineGeometry();
      geo.setPositions(pos); // seed the attribute; updateAimArc refills it each frame
      // bold red-orange dashes: still reads as a gunner's PREDICTION (round 6.5), now thick + bright
      // enough to stand out against the sea. linewidth is in PIXELS, so resolution must track the canvas.
      const mat = new LineMaterial({
        color: 0xff3a22,
        linewidth: 3.6,
        transparent: true,
        opacity: 0.98,
        dashed: true,
        dashSize: 1.4,
        gapSize: 0.9,
        depthTest: true,
      });
      mat.resolution.set(window.innerWidth, window.innerHeight);
      const line = new Line2(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      this.d.scene.add(line);
      this.lines.push({ line, geo, mat, pos });
    }
  }

  // which battery the camera bears toward — from the camera's look direction (works
  // identically first-person or orbit). Looking more along the keel than across it lays
  // the bow/stern CHASERS; looking across it lays the broadside you're facing.
  aimBearing(): Bearing {
    const rot2 = this.d.getShip().body.rotation();
    const inv = this._aimInv.set(rot2.x, rot2.y, rot2.z, rot2.w).invert();
    this.d.camera.getWorldDirection(this.lookV).applyQuaternion(inv);
    return classifyBearing(this.lookV.x, this.lookV.z);
  }

  /**
   * Reload readout for the bottom-right meter. While AIMING (RMB) it reports the battery you're
   * actually pointing at — what the next shot fires. Otherwise it reports the WHOLE ship's loaded
   * fraction, so the meter visibly drops and refills after any broadside. (The old meter was keyed
   * to the camera-look battery even when not aiming, so it read the fore chasers as "ready" while
   * your broadsides were reloading — i.e. flat-out wrong the moment you weren't looking down a side.)
   */
  gunReadout(): { frac: number; ready: number; total: number } {
    const ship = this.d.getShip();
    const simTime = this.d.getSimTime();
    const aiming = this.d.controls.aiming;
    const key = this.aimBearing();
    let total = 0;
    let ready = 0;
    let fracSum = 0; // sum of each gun's CONTINUOUS readiness (0 just-fired → 1 loaded)
    for (let i = 0; i < ship.build.cannonPorts.length; i++) {
      if (!ship.cannonAlive[i]) continue;
      if (aiming && !gunBears(ship.build.cannonPorts[i], key)) continue;
      total++;
      if (this.d.cannons.portReload(ship, i, simTime) <= 0) ready++;
      fracSum += this.d.cannons.portReloadFrac(ship, i, simTime);
    }
    return { frac: total > 0 ? fracSum / total : 0, ready, total };
  }

  updateAimArc(): void {
    // the WHOLE broadside, wherever you stand — looking across a side while
    // holding RMB lays every gun on it (playtest round 6: "regardless of
    // where you are standing on the ship, it should enter aiming mode for
    // all cannons and then fire all simultaneously")
    const ship = this.d.getShip();
    const portIdxs: number[] = [];
    if (this.d.controls.aiming) {
      const bearing = this.aimBearing();
      ship.build.cannonPorts.forEach((p, i) => {
        if (ship.cannonAlive[i] && gunBears(p, bearing)) portIdxs.push(i);
      });
    }
    const simTime = this.d.getSimTime();
    const seaAt = (x: number, z: number) => surfaceHeight(this.d.waves, x, z, simTime);
    for (let pi = 0; pi < this.lines.length; pi++) {
      const arc = this.lines[pi];
      if (pi >= portIdxs.length) {
        arc.line.visible = false;
        continue;
      }
      arc.line.visible = true;
      // PURE-bore trajectory — muzzle velocity along the barrel, NO ship carry
      // (round 8). The line is redrawn every frame from the MOVING muzzle, so
      // it lives in the ship's frame; a pure curve co-moving with the ship has
      // the ball ride along it as both translate together, and it stays aligned
      // with the visible barrel so you can aim. Folding the ship's velocity in
      // bent the line off the barrel and away from the ball you actually watch
      // fly ("30° off, worse with speed"). The carry belongs to the projectile
      // alone — its launch point is already moving at ship speed. Integrated
      // with the ball's OWN step (FIXED_DT)/G/drag, sub-sampled 1 vertex per
      // ARC_SUB steps, so the curve's SHAPE and range match the shot exactly.
      muzzleWorld(ship, portIdxs[pi], this.d.controls.elevationDeg, this.d.controls.traverseDeg, this.arcMuzzle);
      // read the SAME live ballistics the ball uses (TUN.gun) so the preview
      // tracks the dev-panel sliders in lock-step with the real shot.
      integrateAimArc(arc.pos, this.arcMuzzle.pos, this.arcMuzzle.dir, TUN.gun.muzzleSpeed, TUN.gun.drag, seaAt);
      arc.geo.setPositions(arc.pos); // push the fresh curve into the fat-line instanced buffers
      arc.line.computeLineDistances(); // dashes need fresh arc lengths
    }
  }

  /** Fat aim lines size their width in px — track the canvas (was the fitViewport loop). */
  setResolution(w: number, h: number): void {
    for (const a of this.lines) a.mat.resolution.set(w, h);
  }
}
