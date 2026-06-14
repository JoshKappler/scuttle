import * as THREE from "three";
import { Rng } from "../core/rng";
import { VOXEL_SIZE } from "../core/constants";
import type { Physics } from "./physics";
import { buildHarborIsland, buildIsland, type IslandModel } from "../sim/islandwright";
import { IslandVisual } from "../render/islandVisual";

/** Terrain voxels render much coarser than ship voxels: 0.25 m × this = 1 m cells.
 *  Coarse cells let islands be hundreds of metres across (dwarfing the 34 m ship)
 *  while their voxel grids stay a manageable ~200 cells per side. */
export const ISLAND_VOXEL_SCALE = 4;
const M_PER_VOX = VOXEL_SIZE * ISLAND_VOXEL_SCALE;

export interface IslandPlacement {
  kind: "harbor" | "wild";
  seed: number;
  x: number; // world metres (spawn ≈ origin)
  z: number;
  radiusVox: number;
  radiusM: number; // plan-view collision radius in metres (for spacing)
  peakVox: number;
  ruggedness: number;
  landBias: number; // how much of the grid is land (low = small messy islet)
}

const LAGOON_M = 150; // clear water around spawn
const FIELD_M = 1200; // archipelago radius (bigger islands need more room)
const HARBOR_MIN = 320;
const HARBOR_MAX = 460;
const HARBOR_R = 95; // must match buildHarborIsland's radiusVox

/**
 * Deterministic archipelago layout for a world seed. Always places one reachable
 * harbor island (guaranteeing the town shows), then scatters wild islands via
 * rejection sampling: no overlaps, and a clear lagoon around spawn so the run
 * starts in open water. Pure — no scene/physics deps, so it unit-tests directly.
 */
export function planIslandPlacements(seed: string): IslandPlacement[] {
  const rng = new Rng(`islands-${seed}`);
  const out: IslandPlacement[] = [];

  // guaranteed harbor island at a deterministic bearing + reachable distance
  const ha = rng.range(0, Math.PI * 2);
  const hd = rng.range(HARBOR_MIN, HARBOR_MAX);
  out.push({
    kind: "harbor",
    seed: rng.int(1, 1e9),
    x: Math.cos(ha) * hd,
    z: Math.sin(ha) * hd,
    radiusVox: HARBOR_R,
    radiusM: HARBOR_R * M_PER_VOX,
    peakVox: 26,
    ruggedness: 0.3,
    landBias: 0.42,
  });

  // scatter wild islands via rejection sampling (spacing + lagoon). Sizes are drawn
  // from spread buckets so the field has tiny islets AND big landmasses, not a row
  // of same-size discs.
  const buckets = [
    [30, 50], // islets
    [50, 80],
    [80, 110],
    [110, 145], // big islands
  ];
  const wanted = 8;
  let tries = 0;
  let made = 0;
  while (made < wanted && tries < 900) {
    tries++;
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(LAGOON_M + 60, FIELD_M);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const [rlo, rhi] = buckets[made % buckets.length]; // cycle buckets → guaranteed spread
    const radiusVox = rng.int(rlo, rhi);
    const radiusM = radiusVox * M_PER_VOX;
    if (Math.hypot(x, z) < LAGOON_M + radiusM) continue;
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < p.radiusM + radiusM + 50)) continue;
    out.push({
      kind: "wild",
      seed: rng.int(1, 1e9),
      x,
      z,
      radiusVox,
      radiusM,
      peakVox: rng.int(Math.round(radiusVox * 0.4), Math.round(radiusVox * 0.7)), // taller when bigger
      ruggedness: rng.range(0.35, 0.75),
      landBias: rng.range(0.0, 0.32), // varies how much of the disc is land
    });
    made++;
  }
  return out;
}

export interface IslandInstance {
  placement: IslandPlacement;
  model: IslandModel;
  visual: IslandVisual;
  /** Harbor dock anchor in world space — the hook for the future docking interaction. */
  dockWorld: THREE.Vector3 | null;
}

/**
 * Owns the world's static archipelago: generates each placed island, adds its
 * visual to the scene, and builds a static Rapier trimesh collider so hulls
 * ground on beaches and stop at cliffs/the dock. Built once at startup; nothing
 * here runs per-frame. Islands are absent from every ship list, so they never
 * trip the ship-vs-ship destruction code.
 */
export class IslandField {
  readonly islands: IslandInstance[] = [];

  constructor(seed: string, physics: Physics, scene: THREE.Scene) {
    const R = physics.RAPIER;
    for (const p of planIslandPlacements(seed)) {
      const model =
        p.kind === "harbor"
          ? buildHarborIsland({ seed: p.seed })
          : buildIsland({
              seed: p.seed,
              radiusVox: p.radiusVox,
              peakVox: p.peakVox,
              ruggedness: p.ruggedness,
              landBias: p.landBias,
            });

      // sit the grid so its waterline row lands at world y≈0
      const worldY = -model.meta.waterlineY * M_PER_VOX;
      const visual = new IslandVisual(model.grid, { x: p.x, y: worldY, z: p.z }, ISLAND_VOXEL_SCALE);
      scene.add(visual.group);

      // static trimesh collider (default groups → collides with the ship hull cuboid)
      if (visual.colliderIndices.length > 0) {
        const body = physics.world.createRigidBody(
          R.RigidBodyDesc.fixed().setTranslation(p.x, worldY, p.z),
        );
        physics.world.createCollider(
          R.ColliderDesc.trimesh(visual.colliderVerts, visual.colliderIndices),
          body,
        );
      }

      let dockWorld: THREE.Vector3 | null = null;
      if (model.meta.dock) {
        const d = model.meta.dock;
        dockWorld = new THREE.Vector3(
          p.x + d.x * M_PER_VOX,
          worldY + d.y * M_PER_VOX,
          p.z + d.z * M_PER_VOX,
        );
      }
      this.islands.push({ placement: p, model, visual, dockWorld });
    }
  }

  /** Nearest harbor dock anchor to a world point (future docking interaction). */
  nearestDock(x: number, z: number): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bd = Infinity;
    for (const i of this.islands) {
      if (!i.dockWorld) continue;
      const d = Math.hypot(i.dockWorld.x - x, i.dockWorld.z - z);
      if (d < bd) {
        bd = d;
        best = i.dockWorld;
      }
    }
    return best;
  }
}
