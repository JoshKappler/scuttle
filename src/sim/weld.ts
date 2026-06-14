import type { VoxelGrid } from "./voxelGrid";
import { OAK } from "./materials";

/**
 * Guarantee a hull grid is a SINGLE 6-connected solid, by bridging any floating
 * pieces to the main mass with a minimal run of timber (OAK).
 *
 * WHY THIS EXISTS: findSevered (game/ship.ts) sheds every solid cell not
 * 6-connected to the keel the instant ANY damage lands. The procedural shipwright
 * lays interior iron ballast in fixed z-bands against a CURVED shell, so the upper
 * ballast tiers (and a few structure bits) touch the shell only DIAGONALLY — i.e.
 * they are their own 6-connected components. A freshly-built brig is 27 components
 * (494 disconnected cells). On the first hit anywhere, findSevered deletes all 494
 * at once — below the waterline, symmetric, far from the impact (the playtest bug:
 * "the bottom-back falls away, never where I hit; we both sink immediately"). The
 * shipwright author already knew the failure mode (rail-post comment) but only
 * fixed the rail caps. Welding at build time makes the only severable pieces the
 * ones a real cut produces.
 *
 * Each floater is welded to the nearest connected cell with a monotone (axis-by-
 * axis) path of OAK. The path lies inside the bounding box of two existing hull
 * cells, so bridges stay local to the hull — never flung outside the shell. OAK is
 * the lightest solid, so the handful of added voxels is mass/trim-neutral.
 * Deterministic (sorted iteration). Returns the number of bridge voxels added.
 */
export function weldToSingleComponent(grid: VoxelGrid): number {
  const [nx, ny, nz] = grid.dims;
  const N = nx * ny * nz;
  const layer = nx * ny;
  const X = (c: number) => c % nx;
  const Y = (c: number) => Math.floor(c / nx) % ny;
  const Z = (c: number) => Math.floor(c / layer);
  const isSolid = (c: number) => grid.data[c] !== 0;

  // ---- 1. label 6-connected solid components ----
  const comp = new Int32Array(N).fill(-1);
  const compCells: number[][] = [];
  const st: number[] = [];
  for (let c = 0; c < N; c++) {
    if (!isSolid(c) || comp[c] !== -1) continue;
    const id = compCells.length;
    const cells: number[] = [];
    comp[c] = id;
    st.length = 0;
    st.push(c);
    while (st.length) {
      const cur = st.pop()!;
      cells.push(cur);
      const x = X(cur), y = Y(cur), z = Z(cur);
      if (x > 0 && isSolid(cur - 1) && comp[cur - 1] === -1) { comp[cur - 1] = id; st.push(cur - 1); }
      if (x < nx - 1 && isSolid(cur + 1) && comp[cur + 1] === -1) { comp[cur + 1] = id; st.push(cur + 1); }
      if (y > 0 && isSolid(cur - nx) && comp[cur - nx] === -1) { comp[cur - nx] = id; st.push(cur - nx); }
      if (y < ny - 1 && isSolid(cur + nx) && comp[cur + nx] === -1) { comp[cur + nx] = id; st.push(cur + nx); }
      if (z > 0 && isSolid(cur - layer) && comp[cur - layer] === -1) { comp[cur - layer] = id; st.push(cur - layer); }
      if (z < nz - 1 && isSolid(cur + layer) && comp[cur + layer] === -1) { comp[cur + layer] = id; st.push(cur + layer); }
    }
    compCells.push(cells);
  }
  if (compCells.length <= 1) return 0;

  // main = largest component (holds the keel + ballast bulk)
  let mainId = 0;
  for (let i = 1; i < compCells.length; i++) if (compCells[i].length > compCells[mainId].length) mainId = i;

  // floaters welded nearest-first via a growing pool of connected cells, so a floater
  // may bridge to an already-welded floater. Sorted by lowest cell index → deterministic.
  const floaters: number[] = [];
  for (let i = 0; i < compCells.length; i++) if (i !== mainId) floaters.push(i);
  floaters.sort((a, b) => compCells[a][0] - compCells[b][0]);
  const connectedCells = compCells[mainId].slice();

  let bridges = 0;
  for (const f of floaters) {
    // nearest (floaterCell, connectedCell) pair by Manhattan distance
    let best = Infinity, bfc = -1, bcc = -1;
    for (const fc of compCells[f]) {
      const fx = X(fc), fy = Y(fc), fz = Z(fc);
      for (const cc of connectedCells) {
        const d = Math.abs(fx - X(cc)) + Math.abs(fy - Y(cc)) + Math.abs(fz - Z(cc));
        if (d < best) { best = d; bfc = fc; bcc = cc; if (d <= 2) break; }
      }
      if (best <= 2) break;
    }
    if (bfc < 0) continue;

    // fill the monotone path bfc -> bcc (intermediates only) with OAK
    let x = X(bfc), y = Y(bfc), z = Z(bfc);
    const tx = X(bcc), ty = Y(bcc), tz = Z(bcc);
    const stepToward = () => {
      if (x !== tx) x += Math.sign(tx - x);
      else if (y !== ty) y += Math.sign(ty - y);
      else if (z !== tz) z += Math.sign(tz - z);
    };
    stepToward(); // step off the floater cell
    while (!(x === tx && y === ty && z === tz)) {
      if (!grid.isSolid(x, y, z)) { grid.set(x, y, z, OAK); bridges++; }
      // mirror the bridge across the centerline so a welded port floater keeps the hull
      // port/starboard symmetric (the pre-weld hull is symmetric, so the gap's mirror is
      // empty too). Its symmetric twin floater is connected by the same stroke.
      const mz = nz - 1 - z;
      if (mz !== z && !grid.isSolid(x, y, mz)) { grid.set(x, y, mz, OAK); bridges++; }
      stepToward();
    }
    for (const c of compCells[f]) connectedCells.push(c);
  }

  return bridges;
}
