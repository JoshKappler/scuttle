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

export const MATERIALS: Record<number, Material> = {
  [OAK]: { name: "oak", density: 700, color: [0.28, 0.19, 0.12], strength: 3 },
  [PINE]: { name: "pine", density: 500, color: [0.45, 0.34, 0.22], strength: 2 },
  [IRON]: { name: "iron", density: 7800, color: [0.16, 0.16, 0.18], strength: 8 },
};
