import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { PirateRig } from "./pirateModel";

/**
 * Maksim Bugrimov "Pirate Character Captain" — a free, semi-realistic PBR pirate
 * (RenderHub, commercial license; see public/assets/CREDITS.md).
 *
 * Pipeline (the raw drop is ~2GB and gitignored): the FBX was converted to a
 * mesh-only GLB with `fbx2gltf`, and the uncompressed 4K .tga textures were
 * transcoded + downscaled to 1K PNG with Pillow. fbx2gltf can't find the
 * far-away textures, so it left every material on a 1×1 placeholder — this
 * loader rebinds the real maps by MATERIAL NAME at load.
 *
 * No animations ship with this model (combat comes from Mixamo later), so the
 * rig stands in bind pose for now: play()/playFresh() are no-ops. First person
 * isn't isolated yet (the arms are part of the cloth body mesh, not a separate
 * limb like KayKit) — setFirstPerson just hides the head cluster so the camera
 * isn't inside his skull.
 */
export type BugrimovName = "captain";

const MESH_URL = "/assets/characters/bugrimov/web/pirate.glb";
const TEX_DIR = "/assets/characters/bugrimov/web/";

/** Texture set → the 1K PNG basenames produced by the Pillow transcode. */
interface TexSet {
  albedo: string;
  normal?: string;
  metallic?: string;
  alpha?: string;
}
const TEX_SETS: Record<string, TexSet> = {
  Body: {
    albedo: "T_Pirate_Body_Albedo_01.png",
    normal: "T_Pirate_Body_Normals.png",
    metallic: "T_Pirate_Body_Metallic.png",
  },
  Cloth: {
    albedo: "T_Pirate_Cloth_Albedo.png",
    normal: "T_Pirate_Cloth_Normals.png",
    metallic: "T_Pirate_Cloth_Metallic.png",
  },
  Details: {
    albedo: "T_Pirate_Details_Weapons_Albedo.png",
    normal: "T_Pirate_Details_Weapons_Normals.png",
    metallic: "T_Pirate_Details_Weapons_Metallic.png",
  },
  Hair: {
    albedo: "T_Pirate_Hair_Albedo_01.png",
    normal: "T_Pirate_Hair_Hair_Normals.png",
    metallic: "T_Pirate_Hair_Hair_Metallic.png",
    alpha: "T_Pirate_Hair_Alpha.png",
  },
};

/** glTF material name → texture set. (fbx2gltf carried the FBX material names.) */
function setForMaterial(matName: string): string {
  const n = matName.toLowerCase();
  if (n.includes("body")) return "Body";
  if (n.includes("cloth")) return "Cloth";
  if (n.includes("detail")) return "Details";
  if (n === "02___default" || n.includes("hair") || n.includes("beard")) return "Hair";
  return "Cloth"; // "24 - Default" is the lower cloak — treat as cloth
}

/** Meshes hidden in first person so the camera isn't inside the head. */
const FP_HIDE = /(head|hat|eyes|jaw|mustache|beard|skull)/i;

let gltf: GLTF | null = null;
const texCache = new Map<string, THREE.Texture>();
const matCache = new Map<string, THREE.MeshStandardMaterial>();
let loadAttempted = false;
let loadOk = false;

function loadTex(loader: THREE.TextureLoader, file: string, srgb: boolean): THREE.Texture {
  const cached = texCache.get(file);
  if (cached) return cached;
  const tex = loader.load(TEX_DIR + file);
  // glТF UVs assume flipY=false; TextureLoader defaults to true, which would
  // flip every map vertically on the mesh.
  tex.flipY = false;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  texCache.set(file, tex);
  return tex;
}

function materialFor(set: string, texLoader: THREE.TextureLoader): THREE.MeshStandardMaterial {
  const cached = matCache.get(set);
  if (cached) return cached;
  const ts = TEX_SETS[set] ?? TEX_SETS.Cloth;
  const mat = new THREE.MeshStandardMaterial({
    map: loadTex(texLoader, ts.albedo, true),
    normalMap: ts.normal ? loadTex(texLoader, ts.normal, false) : null,
    metalnessMap: ts.metallic ? loadTex(texLoader, ts.metallic, false) : null,
    metalness: 1, // the metallic map drives it per-pixel (skin ≈ 0, rings ≈ 1)
    roughness: 0.62, // no roughness map shipped; a believable constant
    side: set === "Cloth" || set === "Hair" ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (ts.alpha) {
    mat.alphaMap = loadTex(texLoader, ts.alpha, false);
    mat.transparent = false;
    mat.alphaTest = 0.5; // beard/hair cards are cutouts
  }
  matCache.set(set, mat);
  return mat;
}

/** Fetch + parse the mesh and its textures once, up front. */
export async function loadBugrimovLibrary(): Promise<boolean> {
  if (loadAttempted) return loadOk;
  loadAttempted = true;
  try {
    gltf = await new GLTFLoader().loadAsync(MESH_URL);
    const texLoader = new THREE.TextureLoader();
    for (const set of Object.keys(TEX_SETS)) materialFor(set, texLoader); // warm the caches
    loadOk = true;
  } catch (err) {
    console.warn("bugrimov pirate failed to load — falling back to Quaternius", err);
    loadOk = false;
  }
  return loadOk;
}

export function bugrimovReady(): boolean {
  return loadOk;
}

export function createBugrimovRig(_name: BugrimovName = "captain", heightM = 2.4): PirateRig | null {
  if (!gltf) return null;

  const inner = cloneSkeleton(gltf.scene) as THREE.Group;

  // rebind real textures by material name; collect head meshes for FP hide
  const bodyHideMeshes: THREE.Object3D[] = [];
  inner.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.frustumCulled = false; // skinned bounds lag the animation
    const matName = (Array.isArray(mesh.material) ? mesh.material[0]?.name : mesh.material?.name) ?? "";
    mesh.material = materialFor(setForMaterial(matName), new THREE.TextureLoader());
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
  root.rotation.y = Math.PI / 2; // glTF faces +z; the game uses +x (tune if he faces wrong)
  root.add(inner);

  const mixer = new THREE.AnimationMixer(inner);
  let head: THREE.Object3D | null = null;
  inner.traverse((o) => {
    if (!head && o.name === "head") head = o;
  });

  return {
    kind: "bugrimov",
    root,
    mixer,
    head,
    play() {
      /* no clips yet — bind pose until Mixamo animations are wired */
    },
    playFresh() {
      /* no clips yet */
    },
    update(dt) {
      mixer.update(dt);
    },
    setFirstPerson(fp) {
      for (const m of bodyHideMeshes) m.visible = !fp;
    },
  };
}
