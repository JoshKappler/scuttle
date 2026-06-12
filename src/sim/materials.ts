/** Voxel material table. Index 0 is always empty space. */
export const EMPTY = 0;
export const OAK = 1;
export const PINE = 2;
export const IRON = 3;

export interface Material {
  name: string;
  density: number; // kg/m³
  /** Base color as linear RGB triplet 0..1 (weathered, desaturated palette per spec aesthetic). */
  color: [number, number, number];
  /** Hit points per voxel — how much cannonball energy a cell soaks. */
  strength: number;
}

// Wood densities are PLANK-THICKNESS HONEST: a 25 cm voxel stands in for
// planking + framing air, so its effective density is scaled down. Round-4
// values (230/170, ~8 cm planking) left her TOO corky — "two voxels
// underwater stays afloat … catches air going over waves" — so round 5
// reads as ~10-11 cm planking plus stores/fittings. Target draft ≈ 0.3 of
// the envelope (with the doubled keel ballast in shipwright.ts).
export const MATERIALS: Record<number, Material> = {
  [OAK]: { name: "oak", density: 300, color: [0.13, 0.085, 0.052], strength: 3 },
  [PINE]: { name: "pine", density: 215, color: [0.21, 0.152, 0.095], strength: 2 },
  [IRON]: { name: "iron", density: 7800, color: [0.07, 0.07, 0.08], strength: 8 },
};
