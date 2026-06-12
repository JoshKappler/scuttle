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

/** captain.glb ships two characters in one file; keep only Barbarossa. */
const KEEP_IN_FILE: Partial<Record<ModelName, string>> = {
  captain: "barbarossa",
};

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
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  head: THREE.Object3D | null;
  play(key: ClipKey, fadeS?: number): void;
  update(dt: number): void;
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

  // multi-character files: prune every sibling character we don't want
  const keep = KEEP_IN_FILE[name];
  if (keep) {
    const doomed: THREE.Object3D[] = [];
    for (const child of inner.children) {
      const hasSkin = (() => {
        let found = false;
        child.traverse((o) => {
          if ((o as THREE.SkinnedMesh).isSkinnedMesh) found = true;
        });
        return found;
      })();
      if (hasSkin && !child.name.toLowerCase().includes(keep)) doomed.push(child);
    }
    for (const d of doomed) inner.remove(d);
  }

  inner.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.frustumCulled = false; // skinned bounds lag the animation
    }
  });

  // normalize: feet on y=0, standard height, facing +x
  const box = new THREE.Box3().setFromObject(inner);
  const size = new THREE.Vector3();
  box.getSize(size);
  const s = size.y > 0.01 ? heightM / size.y : 1;
  inner.scale.setScalar(s);
  inner.position.y = -box.min.y * s;
  const root = new THREE.Group();
  root.rotation.y = Math.PI / 2; // GLTF convention faces +z; the game uses +x
  root.add(inner);

  const mixer = new THREE.AnimationMixer(inner);
  const actions = new Map<ClipKey, THREE.AnimationAction>();
  const oneShot: ClipKey[] = ["attack", "punch", "hit", "death", "jump"];
  for (const key of Object.keys(CLIP_PATTERNS) as ClipKey[]) {
    // tracks may reference pruned siblings; keep only resolvable tracks
    const clip = pickClip(gltf.animations, key);
    if (!clip) continue;
    const usable = keep
      ? new THREE.AnimationClip(
          clip.name,
          clip.duration,
          clip.tracks.filter((t) => inner.getObjectByName(t.name.split(".")[0]) !== undefined),
        )
      : clip;
    const action = mixer.clipAction(usable);
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
    update(dt) {
      mixer.update(dt);
    },
  };
}
