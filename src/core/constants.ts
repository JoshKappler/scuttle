export const G = 9.81; // m/s²
export const WATER_DENSITY = 1025; // kg/m³ (seawater)
export const VOXEL_SIZE = 0.25; // m per voxel cell
export const VOXEL_VOLUME = VOXEL_SIZE ** 3;
export const CHUNK_SIZE = 16; // voxels per chunk edge
export const FIXED_DT = 1 / 60; // physics step (s)
export const MAX_CARVE_CELLS = 60; // per carve() call — perf backstop + visible grind
