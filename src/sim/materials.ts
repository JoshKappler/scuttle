/** Voxel material table. Index 0 is always empty space. */
export const EMPTY = 0;
export const OAK = 1;
export const PINE = 2;
export const IRON = 3;
export const RAM = 4;

/** Joules of impact energy a cell absorbs per point of `strength` before it breaks.
 *  Calibrated against the deformable-contact energy scale: a ship's closing KE is ~½μv²
 *  (μ = reduced mass ~10^5 kg), so a hard ram carries millions of joules. At 60000, breaking
 *  one oak cell costs 3×60000 = 180 kJ, so a hard ram gouges ~50–80 voxels (KE ÷ cost) instead
 *  of pulverizing hundreds — and because the budget can't afford EVERY overlap cell, the
 *  cheapest (oak) go first and the tough RAM prow survives → bow-first ramming wins emergently.
 *  Cannons compensate via TUN.gun.crushEfficiency (their ½mv² is ~10^4 J, far below a ram). */
export const STRENGTH_TO_JOULES = 60000;

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
  // Reinforced bow timber — the toughest hull material (strength 24, 8× oak, 3× iron),
  // laid over the forward shell by armorBow() so a bow-first ram mechanically WINS: under the
  // symmetric-energy crunch the armored prow loses far fewer voxels per joule than the oak it
  // strikes, so ramming bow-first is a winning tactic — emergent from material cost, no special
  // collision case. Density matched to oak so the OAK→RAM armor swap is mass-neutral: it changes
  // toughness, never the hull's tuned draft/trim (THE LAW #2 — attitude is emergent).
  [RAM]: { name: "ram", density: 430, color: [0.04, 0.025, 0.015], strength: 24 },
};

/** Joules required to break one voxel of the given material (0 for empty/unknown). */
export function breakEnergy(mat: number): number {
  return (MATERIALS[mat]?.strength ?? 0) * STRENGTH_TO_JOULES;
}
