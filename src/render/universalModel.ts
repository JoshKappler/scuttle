import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { ClipKey, PirateRig } from "./pirateModel";

/**
 * Quaternius "Universal" character — the rugged `Superhero_Male` base mesh (CC0)
 * driven by the CC0 "Universal Animation Library 2" clips. The base characters
 * and the animation library share ONE skeleton (Head / neck_01 / clavicle_l /
 * upperarm_l / hand_l / …), so the clips bind straight onto the body through a
 * shared `AnimationMixer` — NO retargeting. This is the interchangeable,
 * web-native foundation: any other Universal-rig mesh (or a Mixamo character
 * auto-rigged onto matching bone names) is a pure mesh swap onto this clip set.
 *
 * The free "Standard" library is 43 curated clips — strong on sword combat and
 * idles, thin on plain locomotion (only `Walk_Carry_Loop`, no clean run/death),
 * so run/death reuse the closest clip until the full set is added.
 *
 * GLTFLoader binds the body textures itself (unlike the Bugrimov path), so this
 * loader just clones, normalizes, and binds clips.
 */
export type UniversalName = "superhero_male";

const CHAR_URL = "/assets/characters/universal/web/Superhero_Male_FullBody.gltf";
const CLIPS_URL = "/assets/characters/universal/web/clips.glb";

/** ClipKey → Universal Animation Library 2 clip name. */
const CLIP_NAMES: Record<ClipKey, string> = {
  idle: "Idle_No_Loop",
  walk: "Walk_Carry_Loop",
  run: "Walk_Carry_Loop", // free set has no run — reuse walk for now
  attack: "Sword_Regular_A",
  punch: "Melee_Hook",
  hit: "Hit_Knockback",
  death: "Hit_Knockback", // free set has no death — reuse for now
  jump: "NinjaJump_Start",
};

/** Head-region meshes hidden in first person (a real FP viewmodel is a later task). */
const FP_HIDE = /(face|eye|hair|brow)/i;

let charScene: THREE.Group | null = null;
let clips: THREE.AnimationClip[] = [];
let loadAttempted = false;
let loadOk = false;

/** Fetch + parse the character mesh and the clip library once, up front. */
export async function loadUniversalLibrary(): Promise<boolean> {
  if (loadAttempted) return loadOk;
  loadAttempted = true;
  const loader = new GLTFLoader();
  try {
    const [char, lib] = await Promise.all([loader.loadAsync(CHAR_URL), loader.loadAsync(CLIPS_URL)]);
    charScene = char.scene;
    clips = lib.animations;
    loadOk = clips.length > 0;
  } catch (err) {
    console.warn("universal character failed to load — falling back to Quaternius", err);
    loadOk = false;
  }
  return loadOk;
}

export function universalReady(): boolean {
  return loadOk;
}

function findClip(key: ClipKey): THREE.AnimationClip | null {
  const want = CLIP_NAMES[key].toLowerCase();
  let fallback: THREE.AnimationClip | null = null;
  for (const c of clips) {
    const n = c.name.toLowerCase();
    if (n === want) return c;
    if (!fallback && n.includes(want)) fallback = c;
  }
  return fallback;
}

export function createUniversalRig(_name: UniversalName = "superhero_male", heightM = 2.0): PirateRig | null {
  if (!charScene) return null;

  const inner = cloneSkeleton(charScene) as THREE.Group;
  const bodyHideMeshes: THREE.Object3D[] = [];
  inner.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.frustumCulled = false; // skinned bounds lag the animation
    if (FP_HIDE.test(o.name)) bodyHideMeshes.push(o);
  });

  // normalize: feet on y=0, target height, centered, facing +x (game forward)
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
  inner.position.x = -((box.min.x + box.max.x) / 2) * s;
  inner.position.z = -((box.min.z + box.max.z) / 2) * s;
  const root = new THREE.Group();
  root.rotation.y = Math.PI / 2; // glTF faces +z; the game uses +x (tune if wrong)
  root.add(inner);

  // bind the shared-rig clips onto this body. Root translation is stripped from
  // every clip — the capsule owns world position, the clips only rotate bones.
  const mixer = new THREE.AnimationMixer(inner);
  const actions = new Map<ClipKey, THREE.AnimationAction>();
  const oneShot = new Set<ClipKey>(["attack", "punch", "hit", "death", "jump"]);
  for (const key of Object.keys(CLIP_NAMES) as ClipKey[]) {
    const clip = findClip(key);
    if (!clip) continue;
    const useClip = clip.clone();
    useClip.tracks = useClip.tracks.filter((t) => !t.name.endsWith(".position"));
    const action = mixer.clipAction(useClip);
    if (oneShot.has(key)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions.set(key, action);
  }

  let head: THREE.Object3D | null = null;
  inner.traverse((o) => {
    if (!head && o.name === "Head") head = o;
  });

  let current: THREE.AnimationAction | null = null;
  return {
    kind: "universal",
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
        next.reset().play();
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
    setFirstPerson(fp) {
      for (const m of bodyHideMeshes) m.visible = !fp;
    },
  };
}
