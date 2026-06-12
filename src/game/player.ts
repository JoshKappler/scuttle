import * as THREE from "three";
import type { SailingController } from "./sailing";

/**
 * Input + follow-orbit camera. W/S trims the sails, A/D steers (rudder ramps
 * while held, recenters when released), mouse-drag orbits, wheel zooms.
 */
export class PlayerControls {
  private keys = new Set<string>();
  private orbitYaw = 2.6;
  private orbitPitch = 0.32; // radians above horizon
  private dist = 30;
  private dragging = false;

  /** Set on KeyF keydown; cleared by whoever consumes the shot. */
  firePressed = false;
  /** Set on KeyR keydown; cleared by the repair handler. */
  plugPressed = false;
  /** Set on KeyP keydown; cleared by the pump handler. */
  pumpPressed = false;
  /** Set on KeyC keydown (kick, on foot). */
  kickPressed = false;
  /** Set on KeyE keydown (interact, on foot). */
  interactPressed = false;
  /** Set on KeyG keydown (grapple toggle). */
  grapplePressed = false;
  /** Set on KeyT keydown (helm/foot toggle). */
  modePressed = false;
  /** True while RMB is held — mouse Y trims broadside elevation. */
  aiming = false;
  /** Broadside elevation in degrees. */
  elevationDeg = 4;
  /** True while Q is held — spyglass zoom. */
  get spyglass(): boolean {
    return this.keys.has("KeyQ");
  }

  constructor(dom: HTMLElement) {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (e.repeat) return; // OS key auto-repeat must not re-trigger actions
      if (e.code === "KeyF") this.firePressed = true;
      if (e.code === "KeyR") this.plugPressed = true;
      if (e.code === "KeyP") this.pumpPressed = true;
      if (e.code === "KeyC") this.kickPressed = true;
      if (e.code === "KeyE") this.interactPressed = true;
      if (e.code === "KeyG") this.grapplePressed = true;
      if (e.code === "KeyT") this.modePressed = true;
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    dom.addEventListener("mousedown", (e) => {
      if (e.button === 2) this.aiming = true;
      else this.dragging = true;
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) this.aiming = false;
      else this.dragging = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (this.aiming) {
        this.elevationDeg = Math.min(Math.max(this.elevationDeg - e.movementY * 0.05, 0), 14);
        return;
      }
      if (!this.dragging) return;
      this.orbitYaw -= e.movementX * 0.005;
      this.orbitPitch = Math.min(Math.max(this.orbitPitch + e.movementY * 0.004, 0.05), 1.25);
    });
    dom.addEventListener("wheel", (e) => {
      this.dist = Math.min(Math.max(this.dist * (1 + Math.sign(e.deltaY) * 0.12), 7), 85);
    });
  }

  /** Apply held keys to the sailing controller. Call once per fixed step. */
  updateSailing(sail: SailingController, dt: number): void {
    if (this.keys.has("KeyW")) sail.sailSet = Math.min(sail.sailSet + dt * 0.6, 1);
    if (this.keys.has("KeyS")) sail.sailSet = Math.max(sail.sailSet - dt * 0.6, 0);
    const steer = (this.keys.has("KeyA") ? 1 : 0) + (this.keys.has("KeyD") ? -1 : 0);
    if (steer !== 0) {
      sail.rudder = Math.min(Math.max(sail.rudder + steer * dt * 2.2, -1), 1);
    } else {
      sail.rudder *= Math.max(1 - dt * 3, 0);
      if (Math.abs(sail.rudder) < 0.02) sail.rudder = 0;
    }
  }

  /** Horizontal camera angle, for camera-relative character movement. */
  cameraYaw(): number {
    return this.orbitYaw + Math.PI; // orbit offset points FROM target TO camera
  }

  /** Vertical look angle for first person (inverted orbit pitch). */
  lookPitch(): number {
    return -this.orbitPitch + 0.45;
  }

  /** On-foot movement from WASD, camera-relative. */
  footMove(): { x: number; z: number; jump: boolean } {
    let fwd = 0;
    let strafe = 0;
    if (this.keys.has("KeyW")) fwd += 1;
    if (this.keys.has("KeyS")) fwd -= 1;
    if (this.keys.has("KeyA")) strafe -= 1;
    if (this.keys.has("KeyD")) strafe += 1;
    const len = Math.hypot(fwd, strafe) || 1;
    fwd /= len;
    strafe /= len;
    const yaw = this.cameraYaw();
    return {
      x: Math.cos(yaw) * fwd - Math.sin(yaw) * strafe,
      z: Math.sin(yaw) * fwd + Math.cos(yaw) * strafe,
      jump: this.keys.has("Space"),
    };
  }

  /** Position the camera around the followed point. Call once per frame. */
  updateCamera(camera: THREE.PerspectiveCamera, target: THREE.Vector3): void {
    const cy = Math.cos(this.orbitPitch);
    const offset = new THREE.Vector3(
      Math.cos(this.orbitYaw) * cy,
      Math.sin(this.orbitPitch),
      Math.sin(this.orbitYaw) * cy,
    ).multiplyScalar(this.dist);
    camera.position.copy(target).add(offset);
    camera.lookAt(target.x, target.y + 2, target.z);
  }
}
