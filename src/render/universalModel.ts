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
const OUTFIT_URL = "/assets/characters/outfits/web/Male_Ranger.gltf";

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

let charScene: THREE.Group | null = null;
let clips: THREE.AnimationClip[] = [];
let outfitScene: THREE.Group | null = null;
let loadAttempted = false;
let loadOk = false;

/** Fetch + parse the character mesh and the clip library once, up front. */
export async function loadUniversalLibrary(): Promise<boolean> {
  if (loadAttempted) return loadOk;
  loadAttempted = true;
  const loader = new GLTFLoader();
  try {
    const [char, lib, outfit] = await Promise.all([
      loader.loadAsync(CHAR_URL),
      loader.loadAsync(CLIPS_URL),
      loader.loadAsync(OUTFIT_URL).catch(() => null), // outfit is optional dressing
    ]);
    charScene = char.scene;
    clips = lib.animations;
    outfitScene = outfit ? (outfit.scene as THREE.Group) : null;
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

/** The free Standard library has no plain walk — only `Walk_Carry_Loop`, whose
 *  arms are locked forward around an invisible barrel. Synthesize a natural walk:
 *  keep the legs / hips / spine stepping but freeze the arm + neck/head chain to
 *  the relaxed idle pose so the hands fall to the sides. (A real walk/run WITH arm
 *  swing needs the paid UAL locomotion set or a retarget — a later upgrade.) */
const FROZEN_IN_WALK = /(clavicle|upperarm|lowerarm|hand|thumb|index|middle|ring|pinky|finger|neck|head)/i;
function buildNaturalWalk(walk: THREE.AnimationClip, idle: THREE.AnimationClip): THREE.AnimationClip {
  const out = walk.clone();
  out.tracks = out.tracks.filter((t) => !t.name.endsWith(".position"));
  const idlePose = new Map<string, THREE.Quaternion>();
  for (const t of idle.tracks) {
    const p = THREE.PropertyBinding.parseTrackName(t.name);
    if (p.propertyName === "quaternion") {
      idlePose.set(p.nodeName, new THREE.Quaternion(t.values[0], t.values[1], t.values[2], t.values[3]));
    }
  }
  out.tracks = out.tracks.map((t) => {
    const p = THREE.PropertyBinding.parseTrackName(t.name);
    if (p.propertyName !== "quaternion" || !FROZEN_IN_WALK.test(p.nodeName)) return t;
    const q = idlePose.get(p.nodeName);
    if (!q) return t;
    return new THREE.QuaternionKeyframeTrack(t.name, [0, out.duration], [q.x, q.y, q.z, q.w, q.x, q.y, q.z, q.w]);
  });
  return out;
}

/** Push every vertex out along its normal — "puffs up" a garment so a slightly
 *  larger body underneath stops poking through it (our buff Superhero base vs the
 *  regular-fit cloth the outfit was modelled for). */
function inflateAlongNormals(geo: THREE.BufferGeometry, amount: number): void {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute | undefined;
  if (!nor) return;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + nor.getX(i) * amount,
      pos.getY(i) + nor.getY(i) * amount,
      pos.getZ(i) + nor.getZ(i) * amount,
    );
  }
  pos.needsUpdate = true;
}
const OUTFIT_INFLATE = 0.03; // bind-pose puff on the soft garments (tune vs poke-through)
const NO_INFLATE = /(pauldron|bracer|boots|feet)/i; // rigid armour already fits

/** Bind a Quaternius outfit's skinned garments onto an already-cloned base rig.
 *  The outfit shares the 65-bone Universal skeleton, so we rebuild each garment's
 *  skeleton from the BASE's bones (matched by name) and parent it alongside the
 *  body — it then deforms with the same animation clips, no retargeting. `hideHood`
 *  drops the Head_Hood so his face shows. Returns the garments added (for FP cull). */
function attachOutfit(inner: THREE.Group, scene: THREE.Group, hideHood: boolean): THREE.Object3D[] {
  let found: THREE.SkinnedMesh | undefined;
  inner.traverse((o) => {
    if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh;
  });
  if (!found) return [];
  const base = found;
  const boneByName = new Map<string, THREE.Bone>();
  for (const b of base.skeleton.bones) boneByName.set(b.name, b);
  const parent = base.parent ?? inner;
  const added: THREE.Object3D[] = [];
  const clone = cloneSkeleton(scene) as THREE.Group;
  const garments: THREE.SkinnedMesh[] = [];
  clone.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) garments.push(o as THREE.SkinnedMesh);
  });
  for (const sm of garments) {
    if (hideHood && /hood/i.test(sm.name)) continue;
    const remapped = sm.skeleton.bones.map((b) => boneByName.get(b.name) ?? b);
    sm.bind(new THREE.Skeleton(remapped, sm.skeleton.boneInverses), sm.bindMatrix);
    if (!NO_INFLATE.test(sm.name)) {
      sm.geometry = sm.geometry.clone(); // own copy — don't puff the shared source
      inflateAlongNormals(sm.geometry, OUTFIT_INFLATE);
    }
    sm.position.copy(base.position);
    sm.quaternion.copy(base.quaternion);
    sm.scale.copy(base.scale);
    sm.castShadow = true;
    sm.frustumCulled = false;
    parent.add(sm);
    added.push(sm);
  }
  return added;
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
    bodyHideMeshes.push(o); // first person hides the whole body for now (arm viewmodel TBD)
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

  // dress him: bind the Ranger outfit's garments onto this body's skeleton (same
  // Quaternius rig → they animate with the same clips). Hood off so his face shows.
  if (outfitScene) {
    for (const m of attachOutfit(inner, outfitScene, true)) bodyHideMeshes.push(m);
  }

  // bind the shared-rig clips onto this body. Root translation is stripped from
  // every clip — the capsule owns world position, the clips only rotate bones.
  const mixer = new THREE.AnimationMixer(inner);
  const actions = new Map<ClipKey, THREE.AnimationAction>();
  const oneShot = new Set<ClipKey>(["attack", "punch", "hit", "death", "jump"]);
  const idleClip = findClip("idle");
  for (const key of Object.keys(CLIP_NAMES) as ClipKey[]) {
    const clip = findClip(key);
    if (!clip) continue;
    let useClip: THREE.AnimationClip;
    if ((key === "walk" || key === "run") && idleClip) {
      // turn the barrel-carry walk into a natural one: walking legs, relaxed arms
      useClip = buildNaturalWalk(clip, idleClip);
    } else {
      useClip = clip.clone();
      useClip.tracks = useClip.tracks.filter((t) => !t.name.endsWith(".position"));
    }
    const action = mixer.clipAction(useClip);
    if (oneShot.has(key)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    if (key === "run") action.timeScale = 1.45; // no real run clip — jog the walk faster
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
