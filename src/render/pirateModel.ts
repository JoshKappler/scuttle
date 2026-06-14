import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";

/**
 * Quaternius "Pirate Kit" characters (CC0 — see public/assets/CREDITS.md):
 * rigged, animated GLBs with embedded texture atlases. Loaded once, cloned
 * per pirate via SkeletonUtils. Clip names in this pack are NLA-mangled
 * ("CharacterArmature|CharacterArmature|…|Idle"), so clips are matched by
 * substring, never by equality.
 */
export type ClipKey = "idle" | "walk" | "run" | "attack" | "punch" | "hit" | "death" | "jump";

export type ModelName = "captain" | "anne" | "henry" | "mako" | "sharky" | "skeleton";

const MODEL_URLS: Record<ModelName, string> = {
  captain: "/assets/characters/captain.glb",
  anne: "/assets/characters/anne.glb",
  henry: "/assets/characters/henry.glb",
  mako: "/assets/characters/mako.glb",
  sharky: "/assets/characters/sharky.glb",
  skeleton: "/assets/characters/skeleton.glb",
};

/** captain.glb ships two characters in one file; hide the spare. */
const HIDE_IN_FILE: Partial<Record<ModelName, string[]>> = {
  captain: ["ernest"],
};

/** Props that read wrong on a boarding party (Henry ships with a lute). */
const WEAPON_ALLOW = ["cutlass", "sword", "sabre", "hook", "axe", "dagger", "pistol", "gun", "blunder"];

const CLIP_PATTERNS: Record<ClipKey, { include: string; exclude?: string[] }> = {
  idle: { include: "idle", exclude: ["jump", "sword", "punch"] },
  walk: { include: "walk" },
  run: { include: "run" },
  attack: { include: "sword" },
  punch: { include: "punch" },
  hit: { include: "hitreact" },
  death: { include: "death" },
  jump: { include: "jump", exclude: ["idle", "land"] },
};

const library = new Map<ModelName, GLTF>();
let loadAttempted = false;
let loadOk = false;

/** Fetch + parse every character once, up front. Safe to call repeatedly. */
export async function loadPirateLibrary(): Promise<boolean> {
  if (loadAttempted) return loadOk;
  loadAttempted = true;
  const loader = new GLTFLoader();
  try {
    const entries = Object.entries(MODEL_URLS) as [ModelName, string][];
    const loaded = await Promise.all(entries.map(([, url]) => loader.loadAsync(url)));
    entries.forEach(([name], i) => library.set(name, loaded[i]));
    loadOk = true;
  } catch (err) {
    console.warn("pirate models failed to load — procedural bodies will stand in", err);
    loadOk = false;
  }
  return loadOk;
}

export interface PirateRig {
  /** Asset family. Lets crew.ts skip the Quaternius-only procedural posing
   *  (helm grip, FP carry pose, bone-scale cull) for self-posed kits. */
  kind: "quaternius" | "kaykit";
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  head: THREE.Object3D | null;
  play(key: ClipKey, fadeS?: number): void;
  /** Restart a one-shot from frame 0 even if it's already the current
   *  action (a second sword swing must not hold the clamped last frame). */
  playFresh(key: ClipKey): void;
  update(dt: number): void;
  /** Modular rigs (KayKit) present first person by hiding non-arm limb
   *  meshes; the single-mesh Quaternius rig leaves this undefined and uses
   *  crew.ts's bone-scale cull instead. */
  setFirstPerson?(fp: boolean): void;
}

function pickClip(clips: THREE.AnimationClip[], key: ClipKey): THREE.AnimationClip | null {
  const pat = CLIP_PATTERNS[key];
  for (const c of clips) {
    const n = c.name.toLowerCase();
    if (!n.includes(pat.include)) continue;
    if (pat.exclude?.some((x) => n.includes(x))) continue;
    return c;
  }
  return null;
}

/**
 * Clone a character, normalized to a given height with feet at local y=0,
 * facing local +x (the game's forward convention).
 */
export function createPirateRig(name: ModelName, heightM = 1.72): PirateRig | null {
  const gltf = library.get(name);
  if (!gltf) return null;

  const inner = cloneSkeleton(gltf.scene) as THREE.Group;

  // multi-character files: HIDE the spare character (removing nodes breaks
  // animation bindings — round-1 attempt pruned the captain to nothing).
  // Also hide non-weapon hand props (a boarder strumming a lute reads wrong).
  const hide = HIDE_IN_FILE[name] ?? [];
  inner.traverse((o) => {
    const n = o.name.toLowerCase();
    if (hide.some((h) => n.includes(h))) o.visible = false;
    if (n.startsWith("weapon_") && !WEAPON_ALLOW.some((w) => n.includes(w))) o.visible = false;
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds lag the animation
    }
  });

  // normalize: feet on y=0, standard height, facing +x — measured over the
  // VISIBLE meshes only (the hidden sibling would skew the bounds)
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  const expand = (o: THREE.Object3D): void => {
    if (!o.visible) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      meshBox.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
      box.union(meshBox);
    }
    for (const c of o.children) expand(c);
  };
  expand(inner);
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = size.y > 0.01 ? heightM / size.y : 1;
  inner.scale.setScalar(s);
  inner.position.y = -box.min.y * s;
  inner.position.x = -((box.min.x + box.max.x) / 2) * s; // sibling chars sit off-center
  inner.position.z = -((box.min.z + box.max.z) / 2) * s;
  const root = new THREE.Group();
  root.rotation.y = Math.PI / 2; // GLTF convention faces +z; the game uses +x
  root.add(inner);

  const mixer = new THREE.AnimationMixer(inner);
  const actions = new Map<ClipKey, THREE.AnimationAction>();
  const oneShot: ClipKey[] = ["attack", "punch", "hit", "death", "jump"];
  // combat clips must animate IN PLACE: the kit bakes root translation into
  // some swings, which displaced the mesh off the capsule mid-attack
  // ("it actually clips you towards the back of the vessel", round 6).
  // The capsule owns position; rotation tracks carry the whole swing.
  const inPlace: ClipKey[] = ["attack", "punch", "hit"];
  for (const key of Object.keys(CLIP_PATTERNS) as ClipKey[]) {
    const clip = pickClip(gltf.animations, key);
    if (!clip) continue;
    let useClip = clip;
    if (inPlace.includes(key)) {
      useClip = clip.clone();
      useClip.tracks = useClip.tracks.filter((t) => !t.name.endsWith(".position"));
    }
    const action = mixer.clipAction(useClip);
    if (oneShot.includes(key)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions.set(key, action);
  }

  let head: THREE.Object3D | null = null;
  inner.traverse((o) => {
    if (!head && o.name.toLowerCase().includes("head")) head = o;
  });

  let current: THREE.AnimationAction | null = null;
  return {
    kind: "quaternius",
    root,
    mixer,
    head,
    play(key, fadeS = 0.16) {
      const next = actions.get(key);
      if (!next || next === current) return;
      next.reset();
      next.fadeIn(fadeS).play();
      current?.fadeOut(fadeS);
      current = next;
    },
    playFresh(key) {
      const next = actions.get(key);
      if (!next) return;
      if (next === current) {
        next.reset().play(); // re-trigger from the top, no fade
        return;
      }
      next.reset();
      next.fadeIn(0.07).play();
      current?.fadeOut(0.07);
      current = next;
    },
    update(dt) {
      mixer.update(dt);
    },
  };
}
