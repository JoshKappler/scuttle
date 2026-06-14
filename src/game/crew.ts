import * as THREE from "three";
import type RAPIER from "@dimforge/rapier3d-compat";
import { G } from "../core/constants";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import type { Effects } from "../render/effects";
import { createPirateRig, type ModelName, type PirateRig, type ClipKey } from "../render/pirateModel";
import { createKayKitRig, kaykitReady } from "../render/kaykitModel";
import { createBugrimovRig, bugrimovReady } from "../render/bugrimovModel";
import { characterPack } from "./characterPack";
import type { Physics } from "./physics";
import type { Ship } from "./ship";

/**
 * Pirates. Kinematic capsules driven by rapier character controllers.
 *
 * Deck riding is TRANSFORM-FOLLOWING: while a pirate stands on a ship, their
 * position is anchored in the SHIP's frame, and each step begins by carrying
 * them wherever the ship carried that anchor — heave, surge, pitch, roll,
 * all of it. Velocity-based carry (the old model) lagged the deck by a frame
 * and let it rise through your boots in a seaway (playtest round 4: "clips
 * directly through the deck when it bobs … eventually falls out the back").
 *
 * Combat: slash (cone, damage) and kick (shove burst resolved through the
 * character controller). Death = ragdoll-lite: the capsule goes dynamic.
 */
const WALK_SPEED = 3.4;
const SPRINT_MULT = 1.62;
const STAMINA_DRAIN = 0.3; // per second sprinting
const STAMINA_REGEN = 0.17; // per second, after a short breather
const REGEN_DELAY = 0.9; // s

/** The character capsule must ignore group-0x0002 colliders (the coarse
 *  ship-ship hull boxes) — their tops float above the real deck. */
const KCC_FILTER_GROUPS = 0xfffffffd;

const tmpCarry = new THREE.Vector3();
const tmpAnchor = new THREE.Vector3();
const _fpEuler = new THREE.Euler();

export type Faction = "player" | "enemy";

export class Pirate {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController | null;
  readonly mesh: THREE.Group;
  hp = 3;
  alive = true;
  /** Seconds until this pirate may slash again. */
  slashCd = 0;
  kickCd = 0;
  facing = 0; // world yaw
  /** Sprint wind 0..1 (round 7: shift to sprint, with a stamina bar). */
  stamina = 1;
  private regenCd = 0;
  private vy = 0;
  private ragdollAge = 0;
  swimming = false;

  /** Ship whose frame we're anchored in (null = free fall / swimming). */
  private attachShip: Ship | null = null;
  /** Anchor position in that ship's local frame (meters). */
  private attachLocal = new THREE.Vector3();
  private airTime = 0;
  /** Kick burst (m/s), consumed through the controller so walls still block. */
  private pendingShove = new THREE.Vector3();

  constructor(
    private phys: Physics,
    scene: THREE.Scene,
    public ship: Ship,
    public faction: Faction,
    deckLocal: [number, number, number],
    bodyColor: number,
    sashColor: number,
    model?: ModelName,
  ) {
    const { world, RAPIER: R } = phys;
    const spawn = ship.localToWorld(deckLocal, new THREE.Vector3());
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y + 1.2, spawn.z),
    );
    // anchored to the deck from the very first frame — spawning during the
    // ship's splash-down settle is safe now, we just ride it out
    this.attachShip = ship;
    this.attachLocal.set(deckLocal[0], deckLocal[1] + 1.2, deckLocal[2]);
    // SENSOR: a kinematic capsule with a solid collider has infinite
    // effective mass and will physically shove (and capsize!) the dynamic
    // ship it stands on. Sensors generate no contact forces; the character
    // controller still sweeps the capsule SHAPE against the world, so
    // walking/standing is unaffected. (Playtest: "standing in the center,
    // the boat has completely capsized.")
    this.collider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.28).setSensor(true), this.body);
    this.controller = world.createCharacterController(0.05);
    this.controller.enableAutostep(0.35, 0.2, true);
    this.controller.enableSnapToGround(0.6); // generous: decks drop with the swell
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);

    // visual body: a real rigged CC0 pirate (Quaternius) when the library
    // loaded; the old hand-built figure stands in if we're offline
    this.mesh = new THREE.Group();
    // KayKit (modular limbs + 76 melee clips) when selected and loaded; else the
    // legacy Quaternius pirate. Both satisfy the PirateRig contract.
    const pack = characterPack();
    this.rig =
      pack === "bugrimov" && bugrimovReady()
        ? createBugrimovRig("captain")
        : pack === "kaykit" && kaykitReady()
          ? createKayKitRig(faction === "player" ? "Rogue_Hooded" : "Rogue")
          : createPirateRig(model ?? (faction === "player" ? "captain" : "henry"));
    if (this.rig) {
      this.mesh.add(this.rig.root);
      this.rig.play("idle");
      scene.add(this.mesh);
      return;
    }
    const skin = new THREE.MeshStandardMaterial({ color: 0xc8a07a, roughness: 0.7 });
    const cloth = new THREE.MeshStandardMaterial({ color: bodyColor, roughness: 0.85 });
    const accent = new THREE.MeshStandardMaterial({ color: sashColor, roughness: 0.8 });

    const legGeo = new THREE.CapsuleGeometry(0.085, 0.42, 3, 8);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, cloth);
      leg.position.set(0, 0.33, s * 0.12);
      leg.castShadow = true;
      this.mesh.add(leg);
    }
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.5, 4, 10), cloth);
    torso.position.y = 0.95;
    torso.castShadow = true;
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.1, 10), accent);
    belt.position.y = 0.72;
    const armGeo = new THREE.CapsuleGeometry(0.07, 0.42, 3, 8);
    this.swordArm = new THREE.Group();
    const armR = new THREE.Mesh(armGeo, cloth);
    armR.position.y = -0.22;
    armR.castShadow = true;
    this.swordArm.add(armR);
    // held OUT to the right and a touch forward — the old (0,1.28,0.32) sat on
    // the centreline, so the arm + blade speared straight down through the
    // torso ("holds the saber within his body … arm poking through the front").
    // z=0.40 clears the torso capsule (r≈0.24) + arm (r≈0.07); the z-splay
    // cants the cutlass forward/up and out, away from the chest.
    this.swordArm.position.set(0.14, 1.3, 0.4);
    this.swordArm.rotation.z = 0.5; // cant the blade forward/up & out of the chest
    this.swordArm.rotation.x = 0.18; // swing base (syncMesh drives the chop on x)
    const armL = new THREE.Mesh(armGeo, cloth);
    armL.position.set(0, 1.05, -0.32);
    armL.rotation.x = -0.15;
    armL.castShadow = true;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), skin);
    head.position.y = 1.62;
    head.castShadow = true;

    let headgear: THREE.Object3D;
    if (faction === "player") {
      // captain's hat: squashed cone + brim
      const hat = new THREE.Group();
      const crown = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.26, 10), accent);
      crown.position.y = 1.88;
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.035, 12), accent);
      brim.position.y = 1.77;
      hat.add(crown, brim);
      headgear = hat;
    } else {
      const bandana = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.215, 0.12, 10), accent);
      bandana.position.y = 1.74;
      headgear = bandana;
    }

    const sword = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.85, 0.05),
      new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.3, metalness: 0.8 }),
    );
    sword.position.y = -0.75;
    this.swordArm.add(sword);

    this.headParts = [head, headgear];
    this.mesh.add(torso, belt, this.swordArm, armL, head, headgear);
    scene.add(this.mesh);
  }

  private swordArm: THREE.Group | null = null;
  private headParts: THREE.Object3D[] = [];
  /** Rigged GLB character (null → procedural fallback body). */
  rig: PirateRig | null = null;
  private animKey: ClipKey | "" = "";
  private fpHide = false;
  // r18.1: first person shows the REAL right arm + cutlass. The body is ONE skinned mesh, so we
  // can't hide sub-meshes — instead we collapse the non-arm BONES (head/neck/left arm/legs) and
  // hold the right-arm chain in a fixed "carry" pose so the real blade sits in frame. fpArmPose
  // is local-euler per bone, tunable live via DEBUG.boarding.player.fpArmPose then baked here.
  private fpCullBones: THREE.Object3D[] = [];
  private rArm: { shoulder?: THREE.Object3D; upper?: THREE.Object3D; lower?: THREE.Object3D } = {};
  private fpBonesFound = false;
  fpArmPose = {
    shoulder: [-0.4, 0, 0] as [number, number, number],
    // lower[1] (the forearm long axis) is a WRIST ROLL: r18.1 the blade sat 90° clockwise (lying
    // flat to the right); +π/2 stands it upright. Flip the sign if it ever rolls the wrong way.
    upper: [0.8, 0, 0.15] as [number, number, number],
    lower: [0.5, Math.PI / 2, 0] as [number, number, number],
  };
  /** Current first-person look pitch (rad), fed from the camera each frame so the carry pose
   *  lifts with the view — the cutlass stays in frame whether you look up or down. */
  fpLookPitch = 0;
  /** Current first-person look YAW (rad), fed from the camera. In FP the body faces the LOOK,
   *  not the run direction — without this, strafing turned the body (and the body-attached arm)
   *  away from the camera and the viewmodel clipped into itself (the movement-facing in step()
   *  was trumping the look). Applied in syncMesh so it wins in every path, even standing still. */
  fpLookYaw = 0;
  /** Set by combat when this pirate swings; drives the chop animation. */
  attackTimer = 0;
  /** Set by combat on kick; drives the lunge animation. */
  kickTimer = 0;

  private setAnim(key: ClipKey): void {
    if (!this.rig || this.animKey === key) return;
    this.animKey = key;
    this.rig.play(key);
  }

  /** One full sword swing (round 7: the 0.28 s timer cut the clip off right
   *  after the wind-up — "missing that slash animation that we had"). */
  swingAnim(): void {
    this.attackTimer = 0.7;
    if (this.rig) {
      this.animKey = "attack";
      this.rig.playFresh("attack");
    }
  }

  /** One full kick/punch. */
  kickAnim(): void {
    this.kickTimer = 0.6;
    if (this.rig) {
      this.animKey = "punch";
      this.rig.playFresh("punch");
    }
  }

  worldPos(out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    return out.set(t.x, t.y, t.z);
  }

  /** First person (r18.1): show the REAL body but collapse the non-arm BONES so only the right
   *  arm + cutlass remain in view (the old code hid the whole rig and drew a procedural arm the
   *  player hated). The camera sits at the eyes; head/neck collapse so it isn't inside them, the
   *  left arm + legs collapse out of frame, and postPose() holds the right arm in a carry pose.
   *  Leaving FP restores every bone to full scale and lets the mixer drive the arm again. */
  setFirstPerson(fp: boolean): void {
    this.fpHide = fp;
    if (this.rig) {
      this.rig.root.visible = true;
      // KayKit hides its non-arm limb MESHES (clean, modular); the single-mesh
      // Quaternius rig falls back to crew.ts's per-bone scale cull.
      if (this.rig.kind !== "quaternius") this.rig.setFirstPerson?.(fp);
      else this.applyFpCull();
    }
    for (const part of this.headParts) part.visible = !fp; // procedural fallback body only
  }

  private findFpBones(): void {
    if (this.fpBonesFound || !this.rig) return;
    this.fpBonesFound = true;
    this.rig.root.traverse((o) => {
      switch (o.name) {
        case "Head":
        case "Neck":
        case "ShoulderL":
        case "UpperLegL":
        case "UpperLegR":
          this.fpCullBones.push(o);
          break;
        case "ShoulderR":
          this.rArm.shoulder = o;
          break;
        case "UpperArmR":
          this.rArm.upper = o;
          break;
        case "LowerArmR":
          this.rArm.lower = o;
          break;
      }
    });
  }

  /** Shrink the non-arm bones to nothing in FP (restore to full scale in third person). Cheap,
   *  re-applied each frame since a skeleton clone can otherwise reset the scales. */
  private applyFpCull(): void {
    // KayKit handles FP by mesh visibility (setFirstPerson) — its bones aren't
    // named like the Quaternius rig, so the per-bone cull is a no-op for it.
    if (!this.rig || this.rig.kind !== "quaternius") return;
    this.findFpBones();
    const k = this.fpHide ? 0.0001 : 1;
    for (const b of this.fpCullBones) b.scale.setScalar(k);
  }

  /** Pin to a world position with a fixed facing (used while at the wheel).
   *  `helmRudder` drives the steering pose: hands on the rim, working it. */
  pin(pos: THREE.Vector3, facing: number, helmRudder = 0): void {
    this.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
    // keep the anchor current so stepping away from the wheel doesn't yank
    // us back to where we first grabbed it
    this.attachShip = this.ship;
    this.ship.worldToLocal(tmpAnchor.copy(pos), this.attachLocal);
    this.facing = facing;
    this.atHelm = true;
    this.helmRudder = helmRudder;
    const t = this.body.translation();
    this.mesh.position.set(t.x, t.y - 0.74, t.z);
    this.mesh.rotation.set(0, -facing, 0);
  }

  private atHelm = false;
  private helmRudder = 0;
  private armBones: Record<string, THREE.Object3D> | null = null;
  /** Arm-bone orientations FROZEN when the wheel was taken (snapshotted after
   *  one mixer update). Round 7 overrode only rotation.x against a per-frame
   *  base — the idle clip kept playing the other two axes underneath, so the
   *  arm gesticulated right through the grip ("the total right arm spasm …
   *  really all the time", round 8). At the helm the mixer now has NO say
   *  over the arms: frozen grip + rudder lean, nothing else moves them. */
  private helmGrip: Map<string, THREE.Quaternion> | null = null;

  private findArmBones(): Record<string, THREE.Object3D> {
    if (!this.armBones) {
      this.armBones = {};
      this.rig!.root.traverse((o) => {
        if (/^(Upper|Lower)Arm[LR]$/.test(o.name)) this.armBones![o.name] = o;
      });
    }
    return this.armBones;
  }

  /** Helmsman pose: both arms reach forward to the wheel rim and lean with
   *  the set rudder (round 6). Applied ONCE per render frame, after all
   *  fixed steps, from the frozen grip — the playing idle clip cannot move
   *  the arms through it. */
  postPose(): void {
    if (!this.rig) return;
    // KayKit is fully clip-driven: the real right arm carries the cutlass in FP
    // and plays the swing itself, so none of the Quaternius procedural posing
    // (helm grip / FP carry pose) applies — and its bones aren't named for it.
    if (this.rig.kind !== "quaternius") return;
    // FIRST PERSON takes priority: always carry the real right arm + cutlass in frame (even
    // while steering — the old procedural viewmodel did the same), applied AFTER the mixer.
    // Skipped mid-swing so the Sword clip plays through the view unaltered.
    if (this.fpHide) {
      if (this.attackTimer <= 0) {
        this.findFpBones();
        const p = this.fpArmPose;
        // the shoulder lift tracks the look pitch (gain ~1) so the blade holds its screen spot
        // as you pan up/down — the body-attached arm would otherwise sink when you look up.
        this.rArm.shoulder?.quaternion.setFromEuler(_fpEuler.set(p.shoulder[0] - this.fpLookPitch, p.shoulder[1], p.shoulder[2]));
        this.rArm.upper?.quaternion.setFromEuler(_fpEuler.set(p.upper[0], p.upper[1], p.upper[2]));
        this.rArm.lower?.quaternion.setFromEuler(_fpEuler.set(p.lower[0], p.lower[1], p.lower[2]));
      }
      return;
    }
    // third person at the helm: both hands frozen on the wheel rim + rudder lean
    if (this.atHelm && this.helmGrip) {
      const b = this.findArmBones();
      const r = this.helmRudder;
      const lean: Record<string, number> = {
        UpperArmL: -(1.05 - r * 0.3),
        UpperArmR: -(1.05 + r * 0.3),
        LowerArmL: -0.38,
        LowerArmR: -0.38,
      };
      for (const name of Object.keys(b)) {
        const frozen = this.helmGrip.get(name);
        if (!frozen) continue;
        b[name].quaternion.copy(frozen);
        b[name].rotateX(lean[name] ?? 0);
      }
    }
  }

  /** Move one fixed step. moveX/moveZ are a world-space direction (≤1). */
  step(
    dt: number,
    moveX: number,
    moveZ: number,
    jump: boolean,
    waves: Wave[],
    simTime: number,
    sprint = false,
  ): void {
    this.atHelm = false;
    this.helmGrip = null; // next helm session snapshots a fresh grip
    this.attackTimer = Math.max(this.attackTimer - dt, 0);
    this.kickTimer = Math.max(this.kickTimer - dt, 0);
    this.rig?.update(dt);
    // FP hides the head (camera sits inside it); 3rd person keeps it full size.
    // Re-applied every frame and two-sided so the head can never stay shrunk
    // after returning from first-person.
    this.applyFpCull();
    if (!this.alive) {
      this.syncMesh();
      this.ragdollAge += dt;
      return;
    }
    const tr = this.body.translation();
    const surf = surfaceHeight(waves, tr.x, tr.z, simTime);

    // chest-deep before swim mode kicks in — an awash deck is still walkable
    // (playtest: bow dipped, walking/jumping died because swim engaged early)
    this.swimming = tr.y < surf - 0.45;
    if (this.swimming) {
      this.tickStamina(dt, false);
      this.attachShip = null; // the sea owns you now
      // damped spring to the surface — undamped buoyancy made swimmers
      // oscillate into 50-foot breaches (playtest bug)
      this.vy += ((surf - 0.45 - tr.y) * 5 - this.vy * 3.2) * dt;
      this.vy = Math.min(Math.max(this.vy, -3), 3);
      const k = 0.55;
      this.body.setNextKinematicTranslation({
        x: tr.x + (moveX * WALK_SPEED * k + this.pendingShove.x) * dt,
        y: tr.y + this.vy * dt,
        z: tr.z + (moveZ * WALK_SPEED * k + this.pendingShove.z) * dt,
      });
      this.decayShove(dt);
      if (moveX * moveX + moveZ * moveZ > 0.01) this.facing = Math.atan2(moveZ, moveX);
      this.setAnim(this.attackTimer > 0 ? "attack" : "walk"); // doggy paddle
      this.syncMesh();
      return;
    }

    // platform carry: wherever the ship moved our anchor since last step,
    // we move too — full 6-DOF, so a heaving deck can never rise through us
    let carryX = 0;
    let carryY = 0;
    let carryZ = 0;
    if (this.attachShip === this.ship) {
      this.ship.localToWorld(
        [this.attachLocal.x, this.attachLocal.y, this.attachLocal.z],
        tmpCarry,
      );
      carryX = tmpCarry.x - tr.x;
      carryY = tmpCarry.y - tr.y;
      carryZ = tmpCarry.z - tr.z;
    }

    const grounded = this.controller!.computedGrounded();
    if (grounded) {
      // 4.6 m/s ≈ a 1.1 m hop — boots and a cutlass, not a moon launch
      // (round 7: "the character jumps much too high")
      this.vy = jump ? 4.6 : Math.max(this.vy, -0.5);
      this.airTime = 0;
    } else {
      this.vy = Math.max(this.vy - G * dt, -18);
      this.airTime += dt;
    }

    // standing still on your own deck: ride the anchor EXACTLY. Feeding the
    // carry through collide-and-slide let hard turns shave a few centimeters
    // off every step — the captain slowly skated across the deck (round 6:
    // "still seeing some issues with the character … sliding around the
    // boat when under heavy turning")
    const wantsMove = moveX * moveX + moveZ * moveZ > 0.01 || jump;
    const shoved = this.pendingShove.lengthSq() > 0.05;
    if (grounded && !wantsMove && !shoved && this.attachShip === this.ship) {
      this.tickStamina(dt, false);
      this.body.setNextKinematicTranslation({ x: tr.x + carryX, y: tr.y + carryY, z: tr.z + carryZ });
      this.setAnim(this.attackTimer > 0 ? "attack" : this.kickTimer > 0 ? "punch" : "idle");
      this.syncMesh();
      return;
    }

    // sprint: shift pours stamina into a longer stride. No grounded gate on
    // the drain — computedGrounded flickers on a heaving deck and quietly
    // quartered the cost
    const moving = moveX * moveX + moveZ * moveZ > 0.01;
    const sprinting = sprint && moving && this.stamina > 0.02;
    this.tickStamina(dt, sprinting);
    const speed = WALK_SPEED * (sprinting ? SPRINT_MULT : 1);

    const desired = {
      x: carryX + (moveX * speed + this.pendingShove.x) * dt,
      y: carryY + this.vy * dt,
      z: carryZ + (moveZ * speed + this.pendingShove.z) * dt,
    };
    this.decayShove(dt);
    this.controller!.computeColliderMovement(this.collider, desired, undefined, KCC_FILTER_GROUPS);
    const m = this.controller!.computedMovement();
    const nx = tr.x + m.x;
    const ny = tr.y + m.y;
    const nz = tr.z + m.z;
    this.body.setNextKinematicTranslation({ x: nx, y: ny, z: nz });

    // re-anchor against the deck we're on. The anchor HOLDS through the
    // whole jump arc — the old 0.5 s timeout expired mid-jump, dropped the
    // ship's velocity, and "launched me off the back of the ship"
    // (playtest round 5). Only genuinely leaving the hull breaks it.
    tmpAnchor.set(nx, ny, nz);
    this.ship.worldToLocal(tmpAnchor, this.attachLocal);
    const fp = this.ship.build.footprint;
    const overboard =
      this.attachLocal.x < fp.minX ||
      this.attachLocal.x > fp.maxX ||
      Math.abs(this.attachLocal.z - fp.zC) > fp.halfZ;
    if (!overboard && (grounded || this.airTime < 2.5)) {
      this.attachShip = this.ship;
    } else {
      this.attachShip = null; // overboard or a very long fall — world frame
    }

    if (moveX * moveX + moveZ * moveZ > 0.01) this.facing = Math.atan2(moveZ, moveX);

    // animation: combat one-shots win, then airtime, then locomotion
    if (this.attackTimer > 0) this.setAnim("attack");
    else if (this.kickTimer > 0) this.setAnim("punch");
    else if (!grounded && this.airTime > 0.18) this.setAnim("jump");
    else if (moveX * moveX + moveZ * moveZ > 0.01) this.setAnim("run");
    else this.setAnim("idle");

    this.syncMesh();
  }

  /** Mixer-only tick for frames when the body is externally pinned (wheel). */
  idleTick(dt: number): void {
    this.attackTimer = Math.max(this.attackTimer - dt, 0);
    this.kickTimer = Math.max(this.kickTimer - dt, 0);
    this.tickStamina(dt, false);
    this.setAnim("idle");
    this.rig?.update(dt);
    // first tick at the wheel: freeze the grip from the just-written mixer
    // pose, once — postPose owns the arms entirely from here
    if (this.atHelm && !this.helmGrip && this.rig) {
      const bones = this.findArmBones();
      this.helmGrip = new Map();
      for (const name of Object.keys(bones)) this.helmGrip.set(name, bones[name].quaternion.clone());
    }
    this.applyFpCull();
  }

  private tickStamina(dt: number, draining: boolean): void {
    if (draining) {
      this.stamina = Math.max(this.stamina - STAMINA_DRAIN * dt, 0);
      this.regenCd = REGEN_DELAY;
    } else {
      this.regenCd = Math.max(this.regenCd - dt, 0);
      if (this.regenCd <= 0) this.stamina = Math.min(this.stamina + STAMINA_REGEN * dt, 1);
    }
  }

  private decayShove(dt: number): void {
    const f = Math.max(1 - dt * 4, 0);
    this.pendingShove.x *= f;
    this.pendingShove.z *= f;
  }

  /** Hard relocation (respawn, ladder climb): move AND re-anchor, so the
   *  carry doesn't yank us back to the stale anchor next step. */
  teleport(pos: THREE.Vector3): void {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.attachShip = this.ship;
    this.ship.worldToLocal(pos, this.attachLocal);
    this.vy = 0;
  }

  private syncMesh(): void {
    const t = this.body.translation();
    // -0.74, not the exact capsule half-height: a few cm of lift keeps the
    // feet from visually sinking into the deck planks
    this.mesh.position.set(t.x, t.y - 0.74, t.z);
    // r18.1: in first person the body faces the LOOK, applied HERE (the last word before the mesh
    // rotates) so the movement-facing set in step() can never trump it and twist the viewmodel.
    if (this.fpHide) this.facing = this.fpLookYaw;
    if (this.alive) {
      // kick: brief forward lunge of the whole body (procedural body only —
      // the rigged model has a real Punch clip)
      const kickP = this.kickTimer > 0 && !this.rig ? Math.sin((1 - this.kickTimer / 0.6) * Math.PI) : 0;
      this.mesh.rotation.set(0, -this.facing, kickP * 0.28);
      // slash: overhead chop of the stand-in's sword arm
      if (this.swordArm) {
        const swingP = this.attackTimer > 0 ? Math.sin((1 - this.attackTimer / 0.7) * Math.PI) : 0;
        this.swordArm.rotation.x = 0.18 - swingP * 1.9;
      }
    } else {
      const r = this.body.rotation();
      this.mesh.position.set(t.x, t.y, t.z);
      this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  /** Take damage; returns true if this killed them. */
  hurt(dmg: number, effects: Effects): boolean {
    if (!this.alive) return false;
    this.hp -= dmg;
    const t = this.body.translation();
    effects.blood(t.x, t.y + 0.9, t.z);
    if (this.hp <= 0) {
      this.die();
      return true;
    }
    return false;
  }

  /** Physics shove: a decaying burst consumed through the character
   *  controller (the old instant-teleport version was silently overwritten
   *  by the same step's own movement — kicks did nothing). The hop lets a
   *  hard kick carry someone over a low rail. */
  shove(dirX: number, dirZ: number): void {
    if (!this.alive) return;
    this.pendingShove.x += dirX * 5.5;
    this.pendingShove.z += dirZ * 5.5;
    this.vy = Math.max(this.vy, 3.6);
  }

  /** Ragdoll-lite: swap the kinematic capsule for a tumbling dynamic one. */
  die(): void {
    if (!this.alive) return;
    this.alive = false;
    const { world, RAPIER: R } = this.phys;
    const tr = this.body.translation();
    const fx = Math.cos(this.facing);
    const fz = Math.sin(this.facing);
    world.removeRigidBody(this.body);
    this.body = world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(tr.x, tr.y, tr.z)
        .setLinvel(-fx * 1.5, 1.2, -fz * 1.5)
        .setAngvel({ x: (Math.random() - 0.5) * 6, y: 0, z: (Math.random() - 0.5) * 6 })
        .setLinearDamping(0.4)
        .setAngularDamping(1.2),
    );
    this.collider = world.createCollider(R.ColliderDesc.capsule(0.5, 0.28).setDensity(985), this.body);
    this.controller = null;
    this.rig?.play("death");
  }

  /** True once a corpse can be cleaned up (sunk or 8 s old). */
  doneFor(waves: Wave[], simTime: number): boolean {
    if (this.alive) return false;
    const t = this.body.translation();
    return this.ragdollAge > 8 || t.y < surfaceHeight(waves, t.x, t.z, simTime) - 2.5;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.phys.world.removeRigidBody(this.body);
  }
}
