import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { ClipKey, PirateRig } from "./pirateModel";

/**
 * KayKit "Adventurers" characters (CC0 — public/assets/characters/kaykit/LICENSE.txt).
 *
 * Why a second loader next to pirateModel.ts: the Quaternius kit is ONE skinned
 * mesh with ~8 NLA-mangled clips, which forced the procedural FP/helm posing in
 * crew.ts. Each KayKit GLB instead carries 76 cleanly-named clips AND splits the
 * body into separate limb meshes (Rogue_ArmRight, Rogue_Body, Rogue_Head_Hooded,
 * …). That buys two things for free:
 *   1. a real melee set — stab / slice / chop / block / dodge / hit / death;
 *   2. a clean first person — just hide every limb mesh except the right arm
 *      (it still animates off the shared skeleton), no bone-scaling tricks.
 *
 * Clip names survive import verbatim, so they're matched by exact name (with a
 * substring fallback). Bone names are sanitized by three.js (the GLB's
 * "handslot.r" arrives as "handslotr"), so the weapon-slot lookup is fuzzy.
 */
export type KayKitName = "Rogue_Hooded" | "Rogue" | "Knight" | "Barbarian" | "Mage";

const MODEL_URLS: Record<KayKitName, string> = {
  // relative paths so they load under file:// in the packaged EXE — see universalModel.ts
  Rogue_Hooded: "assets/characters/kaykit/Rogue_Hooded.glb",
  Rogue: "assets/characters/kaykit/Rogue.glb",
  Knight: "assets/characters/kaykit/Knight.glb",
  Barbarian: "assets/characters/kaykit/Barbarian.glb",
  Mage: "assets/characters/kaykit/Mage.glb",
};

/** A 1-handed sword stands in for a cutlass, parented to the right hand slot. */
const SWORD_URL = "assets/characters/kaykit/weapons/sword_1handed.gltf";

/** ClipKey → exact KayKit clip name. */
const CLIP_NAMES: Record<ClipKey, string> = {
  idle: "Idle",
  walk: "Walking_C",
  run: "Running_A",
  attack: "1H_Melee_Attack_Slice_Diagonal",
  punch: "Unarmed_Melee_Attack_Punch_A",
  hit: "Hit_A",
  death: "Death_A",
  jump: "Jump_Full_Long",
};

/** Limb meshes hidden in first person (everything but the right arm + weapon). */
const FP_HIDE = /(_body|_head|_legleft|_legright|_armleft|_cape)/i;
/** The one limb mesh first person keeps. */
const FP_KEEP_ARM = /_armright/i;
/** Embedded kit weapons a cutlass-pirate shouldn't be holding. */
const HIDE_WEAPON = /(crossbow|throwable|knife)/i;

const library = new Map<KayKitName, GLTF>();
let swordScene: THREE.Object3D | null = null;
let loadAttempted = false;
let loadOk = false;

/** Fetch + parse the requested characters (and the cutlass) once, up front. */
export async function loadKayKitLibrary(only: KayKitName[] = ["Rogue_Hooded"]): Promise<boolean> {
  if (loadAttempted) return loadOk;
  loadAttempted = true;
  const loader = new GLTFLoader();
  try {
    await Promise.all(
      only.map(async (name) => library.set(name, await loader.loadAsync(MODEL_URLS[name]))),
    );
    try {
      swordScene = (await loader.loadAsync(SWORD_URL)).scene;
    } catch (e) {
      console.warn("kaykit cutlass failed to load — bare-handed", e);
    }
    loadOk = library.size > 0;
  } catch (err) {
    console.warn("kaykit models failed to load — falling back to Quaternius", err);
    loadOk = false;
  }
  return loadOk;
}

/** True once at least one KayKit character is parsed and ready to clone. */
export function kaykitReady(): boolean {
  return loadOk;
}

function pickClip(clips: THREE.AnimationClip[], key: ClipKey): THREE.AnimationClip | null {
  const want = CLIP_NAMES[key].toLowerCase();
  let fallback: THREE.AnimationClip | null = null;
  for (const c of clips) {
    const n = c.name.toLowerCase();
    if (n === want) return c;
    if (!fallback && n.includes(want)) fallback = c;
  }
  return fallback;
}

/** Find the right-hand weapon slot (sanitized "handslot.r" → "handslotr"). */
function findHandSlot(rigRoot: THREE.Object3D): THREE.Object3D | null {
  let slot: THREE.Object3D | null = null;
  const clean = (n: string): string => n.toLowerCase().replace(/[^a-z0-9]/g, "");
  rigRoot.traverse((o) => {
    if (slot) return;
    const nn = clean(o.name);
    if (nn === "handslotr" || nn === "handr") slot = o;
  });
  if (!slot) {
    rigRoot.traverse((o) => {
      if (slot) return;
      const nn = clean(o.name);
      if (nn.startsWith("hand") && nn.endsWith("r")) slot = o;
    });
  }
  return slot;
}

/**
 * Clone a KayKit character, normalized to feet-on-y=0 / target height / facing
 * +x (the game's forward), with the legacy procedural posing disabled (the 76
 * clips do everything). Implements the same PirateRig contract as the Quaternius
 * loader, plus `kind` and `setFirstPerson` so crew.ts can branch.
 */
export function createKayKitRig(name: KayKitName = "Rogue_Hooded", heightM = 1.72): PirateRig | null {
  const gltf = library.get(name);
  if (!gltf) return null;

  const inner = cloneSkeleton(gltf.scene) as THREE.Group;

  // hide the embedded kit weapons (knife/crossbows/throwable) — a cutlass gets
  // parented to the hand below
  inner.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (HIDE_WEAPON.test(o.name)) o.visible = false;
    mesh.castShadow = true;
    mesh.frustumCulled = false; // skinned bounds lag the animation
  });

  // normalize over the visible BODY only (do this before attaching the long
  // blade, which would otherwise skew the height/centroid)
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
  root.rotation.y = Math.PI / 2; // GLTF faces +z; the game uses +x
  root.add(inner);

  // cutlass into the right hand (kit weapons are authored to the slot origin,
  // so identity-parenting fits the grip the way the embedded knife did)
  if (swordScene) {
    const slot = findHandSlot(inner);
    if (slot) {
      const blade = swordScene.clone(true);
      blade.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.castShadow = true;
          mesh.frustumCulled = false;
        }
      });
      slot.add(blade);
    }
  }

  // mixer + clip actions
  const mixer = new THREE.AnimationMixer(inner);
  const actions = new Map<ClipKey, THREE.AnimationAction>();
  const oneShot = new Set<ClipKey>(["attack", "punch", "hit", "death", "jump"]);
  // strip baked root translation from the one-shots: the capsule owns position,
  // so a lunging stab or a full jump arc must not slide the mesh off it
  const inPlace = new Set<ClipKey>(["attack", "punch", "hit", "jump", "death"]);
  for (const key of Object.keys(CLIP_NAMES) as ClipKey[]) {
    const clip = pickClip(gltf.animations, key);
    if (!clip) continue;
    let useClip = clip;
    if (inPlace.has(key)) {
      useClip = clip.clone();
      useClip.tracks = useClip.tracks.filter((t) => !t.name.endsWith(".position"));
    }
    const action = mixer.clipAction(useClip);
    if (oneShot.has(key)) {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    actions.set(key, action);
  }

  // head + the limb meshes first person hides
  let head: THREE.Object3D | null = null;
  const bodyMeshes: THREE.Object3D[] = [];
  inner.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    if (!head && /head/i.test(o.name)) head = o;
    if (FP_HIDE.test(o.name) && !FP_KEEP_ARM.test(o.name)) bodyMeshes.push(o);
  });

  let current: THREE.AnimationAction | null = null;
  return {
    kind: "kaykit",
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
    setFirstPerson(fp) {
      // modular win: hide the body/head/legs/left-arm meshes; the right arm and
      // its parented cutlass stay, still driven by whatever clip is playing
      for (const m of bodyMeshes) m.visible = !fp;
    },
  };
}
