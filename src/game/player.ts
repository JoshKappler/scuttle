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
  /** True while RMB is held — the mouse works the guns, not the camera. */
  aiming = false;
  /** Broadside elevation in degrees. */
  elevationDeg = 4;
  /** Gun traverse in degrees (+ = muzzles swing toward the bow). */
  traverseDeg = 0;
  /** Pointer-lock state — when locked, the camera follows the bare mouse. */
  locked = false;
  /** First-person look state: own yaw/pitch, FPS sign convention, full
   *  vertical authority (the orbit mapping inverted left-right and clamped
   *  pitch hard — playtest round 5). Third-person orbit is untouched. */
  private firstPersonMode = false;
  private fpYaw = Math.PI;
  private fpPitch = 0;
  /** True while Q is held — spyglass zoom. */
  get spyglass(): boolean {
    return this.keys.has("KeyQ");
  }

  /** Switch look model when the view toggles; carries the view direction
   *  across so the camera doesn't snap. */
  syncFirstPerson(on: boolean): void {
    if (on === this.firstPersonMode) return;
    if (on) {
      this.fpYaw = this.orbitYaw + Math.PI;
      this.fpPitch = -this.orbitPitch + 0.45;
    } else {
      this.orbitYaw = this.fpYaw - Math.PI;
    }
    this.firstPersonMode = on;
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

    // pointer lock: the camera answers the bare mouse, no click-dragging
    // (playtest round 4). Esc releases; clicking the sea captures again.
    dom.addEventListener("click", () => {
      if (!this.locked) dom.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === dom;
    });

    dom.addEventListener("mousedown", (e) => {
      if (e.button === 2) this.aiming = true;
      else if (!this.locked) this.dragging = true; // drag fallback when unlocked
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) this.aiming = false;
      else this.dragging = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (this.aiming) {
        // RMB held: mouse Y lays the guns, mouse X swings them
        this.elevationDeg = Math.min(Math.max(this.elevationDeg - e.movementY * 0.05, 0), 14);
        this.traverseDeg = Math.min(Math.max(this.traverseDeg + e.movementX * 0.06, -12), 12);
        return;
      }
      if (!this.locked && !this.dragging) return;
      const k = this.locked ? 0.0026 : 0.005;
      if (this.firstPersonMode) {
        // FPS convention: mouse right looks right, mouse up looks up,
        // near-vertical authority both ways
        this.fpYaw += e.movementX * k;
        this.fpPitch = Math.min(Math.max(this.fpPitch - e.movementY * k, -1.5), 1.5);
      } else {
        this.orbitYaw -= e.movementX * k;
        this.orbitPitch = Math.min(Math.max(this.orbitPitch + e.movementY * (k * 0.8), 0.05), 1.25);
      }
    });
    dom.addEventListener("wheel", (e) => {
      this.dist = Math.min(Math.max(this.dist * (1 + Math.sign(e.deltaY) * 0.12), 7), 85);
    });
  }

  /** Apply held keys to the sailing controller. Call once per fixed step.
   *  The helm is SET-AND-HOLD, like a real wheel: A/D walk the rudder over
   *  and it STAYS where you leave it — no auto-centering "like a car"
   *  (playtest round 5). The HUD shows the live rudder angle. */
  updateSailing(sail: SailingController, dt: number): void {
    if (this.keys.has("KeyW")) sail.sailSet = Math.min(sail.sailSet + dt * 0.6, 1);
    if (this.keys.has("KeyS")) sail.sailSet = Math.max(sail.sailSet - dt * 0.6, 0);
    const steer = (this.keys.has("KeyA") ? 1 : 0) + (this.keys.has("KeyD") ? -1 : 0);
    if (steer !== 0) {
      sail.rudder = Math.min(Math.max(sail.rudder + steer * dt * 1.6, -1), 1);
    }
  }

  /** Horizontal camera angle, for camera-relative character movement. */
  cameraYaw(): number {
    if (this.firstPersonMode) return this.fpYaw;
    return this.orbitYaw + Math.PI; // orbit offset points FROM target TO camera
  }

  /** Vertical look angle for first person. */
  lookPitch(): number {
    return this.firstPersonMode ? this.fpPitch : -this.orbitPitch + 0.45;
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
