// Pure, deterministic, engine-free. Spends an energy budget removing voxels,
// cheapest-to-reach first, biased along an impact direction. The single
// destruction primitive both ramming and cannon fire route through.
import { STRENGTH_TO_JOULES } from "./materials";

export interface CarveParams {
  dims: [number, number, number];
  isSolid: (x: number, y: number, z: number) => boolean;
  strengthAt: (x: number, y: number, z: number) => number; // material strength of a solid cell
  origin: [number, number, number];     // impact cell (may be empty; the flood finds the nearest solid)
  dir: [number, number, number] | null; // unit impact direction; null = isotropic
  energy: number;                        // joules
  maxCells: number;                      // per-call hard cap
}
export interface CarveResult { cells: [number, number, number][]; spent: number; }

const LATERAL_BIAS = 1.5; // lateral/backward steps cost up to ×(1+LATERAL_BIAS) more than forward
const STEPS: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export function planCarve(p: CarveParams): CarveResult {
  const [nx, ny, nz] = p.dims;
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const d = p.dir ? norm(p.dir) : null;

  // binary min-heap of { c: cumulative weighted cost, x, y, z }
  const heap: { c: number; x: number; y: number; z: number }[] = [];
  const up = (n: number) => { while (n > 0) { const par = (n - 1) >> 1; if (heap[par].c <= heap[n].c) break; [heap[par], heap[n]] = [heap[n], heap[par]]; n = par; } };
  const down = (n: number) => { for (;;) { let s = n; const l = 2 * n + 1, r = 2 * n + 2; if (l < heap.length && heap[l].c < heap[s].c) s = l; if (r < heap.length && heap[r].c < heap[s].c) s = r; if (s === n) break; [heap[s], heap[n]] = [heap[n], heap[s]]; n = s; } };
  const push = (c: number, x: number, y: number, z: number) => { heap.push({ c, x, y, z }); up(heap.length - 1); };
  const pop = () => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; down(0); } return top; };

  const seen = new Set<number>();
  const seed = nearestSolid(p);
  if (!seed) return { cells: [], spent: 0 };
  push(0, seed[0], seed[1], seed[2]); seen.add(idx(seed[0], seed[1], seed[2]));

  const out: [number, number, number][] = [];
  let spent = 0;
  while (heap.length && out.length < p.maxCells) {
    const cur = pop();
    const cost = p.strengthAt(cur.x, cur.y, cur.z) * STRENGTH_TO_JOULES; // removal cost (raw)
    if (spent + cost > p.energy) break;                                  // can't afford the cheapest remaining → done
    spent += cost; out.push([cur.x, cur.y, cur.z]);
    for (const [sx, sy, sz] of STEPS) {
      const x = cur.x + sx, y = cur.y + sy, z = cur.z + sz;
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      if (!p.isSolid(x, y, z)) continue;
      const ni = idx(x, y, z); if (seen.has(ni)) continue; seen.add(ni);
      const align = d ? Math.max(0, sx * d[0] + sy * d[1] + sz * d[2]) : 1;
      const penalty = 1 + LATERAL_BIAS * (1 - align); // forward ×1, lateral/back up to ×2.5
      push(cur.c + p.strengthAt(x, y, z) * STRENGTH_TO_JOULES * penalty, x, y, z);
    }
  }
  return { cells: out, spent };
}

function norm(v: [number, number, number]): [number, number, number] { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; }

function nearestSolid(p: CarveParams): [number, number, number] | null {
  const o: [number, number, number] = [Math.round(p.origin[0]), Math.round(p.origin[1]), Math.round(p.origin[2])];
  if (inBounds(p.dims, o) && p.isSolid(o[0], o[1], o[2])) return o;
  for (let r = 1; r <= 6; r++) for (const [sx, sy, sz] of STEPS) {
    const c: [number, number, number] = [o[0] + sx * r, o[1] + sy * r, o[2] + sz * r];
    if (inBounds(p.dims, c) && p.isSolid(c[0], c[1], c[2])) return c;
  }
  return null;
}
function inBounds(dims: [number, number, number], c: [number, number, number]): boolean {
  return c[0] >= 0 && c[1] >= 0 && c[2] >= 0 && c[0] < dims[0] && c[1] < dims[1] && c[2] < dims[2];
}
