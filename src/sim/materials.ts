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

// Wood densities are EFFECTIVE: a 25 cm hull voxel stands in for planking
// PLUS frames, knees, fasteners, guns, and stores. Round-4's corky values
// (230/170) floated her like driftwood; round 5's references put the
// waterline at the widest belt of the egg section — roughly 40% of the
// envelope volume submerged — so the shell carries real weight now
// (still comfortably under seawater's 1000, so a dry hull always floats).
// Round 9: "still a very light color compared to the darker wood of a real
// pirate ship." Dropped ~35% darker than the round-8 oak — weathered, tarred
// pirate planking, not honey birch. Still distinct from the near-black iron.
export const MATERIALS: Record<number, Material> = {
  [OAK]: { name: "oak", density: 430, color: [0.082, 0.05, 0.028], strength: 3 },
  [PINE]: { name: "pine", density: 310, color: [0.135, 0.092, 0.052], strength: 2 },
  [IRON]: { name: "iron", density: 7800, color: [0.07, 0.07, 0.08], strength: 8 },
};
