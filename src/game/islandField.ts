import * as THREE from "three";
import { Rng } from "../core/rng";
import { VOXEL_SIZE } from "../core/constants";
import type { Physics } from "./physics";
import { buildHarborIsland, buildIsland, type IslandModel } from "../sim/islandwright";
import { surfaceBandVoxels } from "../sim/islandCollider";
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
const FIELD_M = 1400; // archipelago radius (bigger islands need more room)
const HARBOR_MIN = 320;
const HARBOR_MAX = 460;
const HARBOR_R = 150; // harbor grid half-extent — the BIGGEST island (see WILD_R_MAX)
const HARBOR_PEAK = 40;
const WILD_R_MAX = Math.floor(HARBOR_R / 1.6); // 93 — keeps the harbor ≥1.5× the largest wild island

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
    peakVox: HARBOR_PEAK,
    ruggedness: 0.5,
    landBias: 0.5,
  });

  // scatter wild islands via rejection sampling (spacing + lagoon). Sizes are drawn
  // from spread buckets so the field has tiny islets AND big landmasses, not a row
  // of same-size discs.
  // sizes spread across buckets (all capped below the harbor) so the field has
  // tiny islets AND big landmasses — but none rivalling the harbor
  const buckets = [
    [28, 45], // islets
    [45, 66],
    [66, WILD_R_MAX], // largest wild islands (≤ HARBOR_R/1.6)
  ];
  const wanted = 8;
  let tries = 0;
  let made = 0;
  while (made < wanted && tries < 1500) {
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
      peakVox: rng.int(Math.round(radiusVox * 0.32), Math.round(radiusVox * 0.55)), // taller when bigger
      ruggedness: rng.range(0.4, 0.8),
      landBias: rng.range(0.0, 0.34), // varies how much of the area is land
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
          ? buildHarborIsland({ seed: p.seed, radiusVox: p.radiusVox, peakVox: p.peakVox })
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

      // Two static colliders on one fixed body:
      //  • a TRIMESH (render-derived) — what the on-foot character's KCC walks on.
      //  • a VOXELS collider for ship HULLS. rapier-compat generates NO voxel↔trimesh
      //    contacts, so a hull (itself a Voxels shape) sails straight THROUGH the trimesh.
      //    We build a second collider from the island's own grid — only the surface cells in
      //    a band around the waterline a hull can reach (surfaceBandVoxels), so a ~500 k-cell
      //    harbor island contributes ~150 k. Group 0x0002ffff matches the hull, so it grounds
      //    ship hulls/debris while the character KCC (which filters bit 1) ignores it.
      if (visual.colliderIndices.length > 0) {
        const body = physics.world.createRigidBody(
          R.RigidBodyDesc.fixed().setTranslation(p.x, worldY, p.z),
        );
        physics.world.createCollider(
          R.ColliderDesc.trimesh(visual.colliderVerts, visual.colliderIndices),
          body,
        );
        const hullVoxels = surfaceBandVoxels(model.grid, model.meta.waterlineY, 6, 16);
        if (hullVoxels.length > 0) {
          physics.world.createCollider(
            R.ColliderDesc.voxels(hullVoxels, { x: M_PER_VOX, y: M_PER_VOX, z: M_PER_VOX })
              .setCollisionGroups(0x0002ffff),
            body,
          );
        }
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

  /**
   * Bake a top-down LAND-HEIGHT field of the whole archipelago for the ocean to shoal
   * against (render/ocean.ts setLandField): R = terrain-top world-Y, encoded to a byte as
   * (y+100)/160. Open sea reads 0 → −100 m. Built from the islands' actual collider vertices
   * (the true irregular coastline), then bled outward with a gentle downward ramp so the wave
   * displacement tapers smoothly to flat over ~25 m of approach instead of snapping at the
   * grid edge. One-time at startup; the ocean samples it per vertex/fragment. Returns null for
   * an island-free world.
   */
  buildLandField(): { tex: THREE.DataTexture; minX: number; minZ: number; sizeX: number; sizeZ: number } | null {
    if (this.islands.length === 0) return null;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const i of this.islands) {
      const p = i.placement;
      minX = Math.min(minX, p.x - p.radiusM - 60);
      maxX = Math.max(maxX, p.x + p.radiusM + 60);
      minZ = Math.min(minZ, p.z - p.radiusM - 60);
      maxZ = Math.max(maxZ, p.z + p.radiusM + 60);
    }
    const sizeX = maxX - minX;
    const sizeZ = maxZ - minZ;
    const N = 512;
    const DEEP = -100;
    let cur = new Float32Array(N * N).fill(DEEP);
    // splat each island's collider verts: keep the MAX world-Y per texel = the terrain top.
    for (const inst of this.islands) {
      const p = inst.placement;
      const worldY = -inst.model.meta.waterlineY * M_PER_VOX;
      const v = inst.visual.colliderVerts; // local metres (already × scale)
      for (let k = 0; k + 2 < v.length; k += 3) {
        const wx = v[k] + p.x;
        const wy = v[k + 1] + worldY;
        const wz = v[k + 2] + p.z;
        const tx = Math.floor(((wx - minX) / sizeX) * N);
        const tz = Math.floor(((wz - minZ) / sizeZ) * N);
        if (tx < 0 || tx >= N || tz < 0 || tz >= N) continue;
        const idx = tx + tz * N;
        if (wy > cur[idx]) cur[idx] = wy;
      }
    }
    // bleed land outward with a ~1.2 m/ring downward ramp → a smooth ~25 m shoaling apron so
    // the calm band eases into open water instead of a hard line at the island's grid edge.
    const decay = 1.2;
    for (let pass = 0; pass < 12; pass++) {
      const next = cur.slice();
      for (let z = 0; z < N; z++) {
        for (let x = 0; x < N; x++) {
          let best = cur[x + z * N];
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const nz = z + dz;
              if (nx < 0 || nx >= N || nz < 0 || nz >= N) continue;
              const nb = cur[nx + nz * N] - decay;
              if (nb > best) best = nb;
            }
          }
          next[x + z * N] = best;
        }
      }
      cur = next;
    }
    // encode to a single-byte R texture: byte = (y + 100) / 160 → decoded as r*160 − 100 in GLSL.
    const bytes = new Uint8Array(N * N);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.max(0, Math.min(255, Math.round(((cur[i] + 100) / 160) * 255)));
    }
    const tex = new THREE.DataTexture(bytes, N, N, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return { tex, minX, minZ, sizeX, sizeZ };
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
