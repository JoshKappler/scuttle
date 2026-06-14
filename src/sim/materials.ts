/** Voxel material table. Index 0 is always empty space. */
export const EMPTY = 0;
export const OAK = 1;
export const PINE = 2;
export const IRON = 3;
// id 4 is reserved (RAM armor on the destruction branches) — terrain starts at 5.
// Tropical terrain materials (islands & town). Additive — ships never use these.
export const SAND = 5;
export const ROCK = 6;
export const DARKROCK = 7;
export const GRASS = 8;
export const DIRT = 9;
export const PALMWOOD = 10;
export const FOLIAGE = 11;
export const ROOFTILE = 12; // terracotta — warm tiled roofs for the town

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
  [OAK]: { name: "oak", density: 430, color: [0.055, 0.032, 0.017], strength: 3 },
  [PINE]: { name: "pine", density: 310, color: [0.1, 0.066, 0.036], strength: 2 },
  [IRON]: { name: "iron", density: 7800, color: [0.07, 0.07, 0.08], strength: 8 },
  // Terrain palette — linear RGB, brighter than the ship woods because islands
  // render with a plain vertex-color material (no plank-texture darkening pass).
  // Starting values; tuned in-browser under the ACES tonemap.
  [SAND]: { name: "sand", density: 1600, color: [0.62, 0.54, 0.36], strength: 1 },
  [ROCK]: { name: "rock", density: 2600, color: [0.34, 0.34, 0.37], strength: 20 },
  [DARKROCK]: { name: "darkrock", density: 2900, color: [0.19, 0.2, 0.23], strength: 30 },
  [GRASS]: { name: "grass", density: 1500, color: [0.15, 0.33, 0.12], strength: 1 },
  [DIRT]: { name: "dirt", density: 1500, color: [0.2, 0.13, 0.07], strength: 1 },
  [PALMWOOD]: { name: "palmwood", density: 350, color: [0.2, 0.12, 0.05], strength: 2 },
  [FOLIAGE]: { name: "foliage", density: 100, color: [0.09, 0.34, 0.11], strength: 1 },
  [ROOFTILE]: { name: "rooftile", density: 1900, color: [0.42, 0.13, 0.07], strength: 4 },
};
