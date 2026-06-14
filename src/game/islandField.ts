import { Rng } from "../core/rng";
import { VOXEL_SIZE } from "../core/constants";

/** Terrain voxels render coarser than ship voxels: 0.25 m × this = 0.5 m cells. */
export const ISLAND_VOXEL_SCALE = 2;
const M_PER_VOX = VOXEL_SIZE * ISLAND_VOXEL_SCALE;

export interface IslandPlacement {
  kind: "harbor" | "wild";
  seed: number;
  x: number; // world metres (spawn ≈ origin)
  z: number;
  radiusVox: number;
  radiusM: number; // plan-view collision radius in metres (for spacing)
  peakVox: number;
  cliffiness: number;
}

const LAGOON_M = 120; // clear water around spawn
const FIELD_M = 700; // archipelago radius
const HARBOR_MIN = 240;
const HARBOR_MAX = 420;

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
  const harborR = 46;
  out.push({
    kind: "harbor",
    seed: rng.int(1, 1e9),
    x: Math.cos(ha) * hd,
    z: Math.sin(ha) * hd,
    radiusVox: harborR,
    radiusM: harborR * M_PER_VOX,
    peakVox: 20,
    cliffiness: 0.25,
  });

  // scatter wild islands via rejection sampling (spacing + lagoon)
  const wanted = 7;
  let tries = 0;
  while (out.filter((p) => p.kind === "wild").length < wanted && tries < 400) {
    tries++;
    const a = rng.range(0, Math.PI * 2);
    const d = rng.range(LAGOON_M + 40, FIELD_M);
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const radiusVox = rng.int(22, 52);
    const radiusM = radiusVox * M_PER_VOX;
    if (Math.hypot(x, z) < LAGOON_M + radiusM) continue;
    if (out.some((p) => Math.hypot(p.x - x, p.z - z) < p.radiusM + radiusM + 20)) continue;
    out.push({
      kind: "wild",
      seed: rng.int(1, 1e9),
      x,
      z,
      radiusVox,
      radiusM,
      peakVox: rng.int(24, 46),
      cliffiness: rng.range(0.2, 0.85),
    });
  }
  return out;
}
