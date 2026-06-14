/** Voxel material table. Index 0 is always empty space. */
export const EMPTY = 0;
export const OAK = 1;
export const PINE = 2;
export const IRON = 3;
export const RAM = 4; // reinforced bow armor (voxel-destruction branch)
// Tropical terrain materials (islands & town). Additive — ships never use these.
export const SAND = 5;
export const ROCK = 6;
export const DARKROCK = 7;
export const GRASS = 8;
export const DIRT = 9;
export const PALMWOOD = 10;
export const FOLIAGE = 11;
export const ROOFTILE = 12; // terracotta — warm tiled roofs for the town

/** Joules of impact energy a cell absorbs per point of `strength` before it breaks. WOOD IS
 *  SOFT: breaking one oak cell costs 3×15000 = 45 kJ. This is deliberately low — fracturing
 *  planking takes far less than the force needed to fling/roll a heavy hull, so a ram breaks
 *  voxels readily while the velocity it transfers stays gentle (the contact only passes on a
 *  small fraction of the break — see TUN.crush.transfer). The closing KE (½μv², μ ~10^5 kg)
 *  still far exceeds a cell, so the contact face breaks each step and the ram digs in; the
 *  cheapest (oak) go first so the tougher RAM prow outlasts the oak it strikes — bow-first
 *  ramming wins emergently. Cannons scale via TUN.gun.crushEfficiency. */
export const STRENGTH_TO_JOULES = 15000;

export interface Material {
  name: string;
  density: number; // kg/m³
  /** Base color as linear RGB triplet 0..1 (weathered, desaturated palette per spec aesthetic). */
  color: [number, number, number];
  /** Impact energy a cell absorbs before breaking (joules = strength × STRENGTH_TO_JOULES). */
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
  // Reinforced bow timber — strength 12 (4× oak, 1.5× iron), laid over the forward shell by
  // armorBow() so a bow-first ram mechanically WINS: under the symmetric-energy crunch the
  // armored prow loses far fewer voxels per joule than the oak it strikes. NOTE: it is tough,
  // not invincible — the prow still CHIPS (takes light, visible damage) where it bites, which is
  // the whole point of "the front takes lighter damage where it's touching." (An earlier value
  // of 24 sat above the per-step carve budget, so the bow took zero damage; 12 lets it chip.)
  // Density matched to oak so the OAK→RAM armor swap is mass-neutral: it changes toughness,
  // never the hull's tuned draft/trim (THE LAW #2 — attitude is emergent).
  [RAM]: { name: "ram", density: 430, color: [0.04, 0.025, 0.015], strength: 12 },
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

/** Joules required to break one voxel of the given material (0 for empty/unknown). */
export function breakEnergy(mat: number): number {
  return (MATERIALS[mat]?.strength ?? 0) * STRENGTH_TO_JOULES;
}
