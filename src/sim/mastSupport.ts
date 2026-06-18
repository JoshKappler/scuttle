import type { VoxelGrid } from "./voxelGrid";
import { EMPTY, SPAR } from "./materials";

/**
 * Structural FOOTING support for a mast.
 *
 * A mast trunk is stamped sitting on the deck plank, and the deck plank runs the WHOLE length of the
 * hull — so the 18-connectivity sever (sim/connectivity.findSevered) always finds a path from the
 * mast back to the keel through that plank, even after the hull directly beneath the mast is blown
 * apart. The result the player reported: destroy the bow and the foremast keeps floating on a deck
 * cantilevered over nothing.
 *
 * Real masts are carried by the hull under their step, not by a plank bridging to midships. So a mast
 * also falls when the structure beneath its footing is gone: count the SOLID HULL cells (everything
 * that is neither air nor the mast's own SPAR) below the deck in a band of ±MAST_FOOTING_HALF voxels
 * around the mast's station. When that count drops below MAST_SUPPORT_MIN_FRAC of its intact value,
 * the step is undermined and game/ship fells the whole trunk as debris (the same path a shot-out base
 * already uses). Deterministic (grid reads only) → unit-testable like the rest of sim/.
 */

/** Half-width (voxels, each side of the mast's x) of the hull bay that carries the mast's step. ~3 m. */
export const MAST_FOOTING_HALF = 12;
/** Fell the mast once MORE than half of its footing hull has been destroyed. */
export const MAST_SUPPORT_MIN_FRAC = 0.5;

/**
 * Count the solid HULL cells (excluding air and the mast's own SPAR) below `deckY` in the
 * ±MAST_FOOTING_HALF band around `mastX` — the structure that carries the mast's step.
 */
export function mastFootingCells(grid: VoxelGrid, mastX: number, deckY: number): number {
  const [nx, , nz] = grid.dims;
  const x0 = Math.max(0, mastX - MAST_FOOTING_HALF);
  const x1 = Math.min(nx - 1, mastX + MAST_FOOTING_HALF);
  let count = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        const m = grid.get(x, y, z);
        if (m !== EMPTY && m !== SPAR) count++;
      }
    }
  }
  return count;
}
