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

// ---- pooled per-call scratch (round-12 SP4) ----
// planCarve used to build a fresh node-object binary heap + a fresh seen-Set on EVERY call — pure
// GC churn on the damage path. The heap is now four parallel number arrays with an explicit live
// length (no node objects at all) and `seen` is one module-level Set; both are FULLY reset at
// function entry (heapLen = 0, seen.clear()), so no state crosses calls. Determinism preserved:
// the module is synchronous + single-threaded, the comparisons and visit order are IDENTICAL to
// the old object heap (min-heap keyed on cumulative cost only), and there are no game/render
// imports and no Date.now/Math.random (sim/ purity). The RESULT array is always fresh — callers
// keep it.
const heapC: number[] = [];
const heapX: number[] = [];
const heapY: number[] = [];
const heapZ: number[] = [];
let heapLen = 0;
const seen = new Set<number>();

function heapSwap(i: number, j: number): void {
  let t = heapC[i]; heapC[i] = heapC[j]; heapC[j] = t;
  t = heapX[i]; heapX[i] = heapX[j]; heapX[j] = t;
  t = heapY[i]; heapY[i] = heapY[j]; heapY[j] = t;
  t = heapZ[i]; heapZ[i] = heapZ[j]; heapZ[j] = t;
}
function heapUp(n: number): void {
  while (n > 0) { const par = (n - 1) >> 1; if (heapC[par] <= heapC[n]) break; heapSwap(par, n); n = par; }
}
function heapDown(n: number): void {
  for (;;) {
    let s = n; const l = 2 * n + 1, r = 2 * n + 2;
    if (l < heapLen && heapC[l] < heapC[s]) s = l;
    if (r < heapLen && heapC[r] < heapC[s]) s = r;
    if (s === n) break;
    heapSwap(s, n); n = s;
  }
}
function heapPush(c: number, x: number, y: number, z: number): void {
  heapC[heapLen] = c; heapX[heapLen] = x; heapY[heapLen] = y; heapZ[heapLen] = z;
  heapUp(heapLen++);
}
/** Pops the min-cost node into _top (module scratch — no per-pop allocation). */
const _top = { c: 0, x: 0, y: 0, z: 0 };
function heapPop(): void {
  _top.c = heapC[0]; _top.x = heapX[0]; _top.y = heapY[0]; _top.z = heapZ[0];
  heapLen--;
  if (heapLen > 0) {
    heapC[0] = heapC[heapLen]; heapX[0] = heapX[heapLen]; heapY[0] = heapY[heapLen]; heapZ[0] = heapZ[heapLen];
    heapDown(0);
  }
}

export function planCarve(p: CarveParams): CarveResult {
  const [nx, ny, nz] = p.dims;
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  const d = p.dir ? norm(p.dir) : null;

  heapLen = 0;   // reset the pooled scratch — nothing survives from the previous call
  seen.clear();

  const seed = nearestSolid(p);
  if (!seed) return { cells: [], spent: 0 };
  heapPush(0, seed[0], seed[1], seed[2]); seen.add(idx(seed[0], seed[1], seed[2]));

  const out: [number, number, number][] = []; // returned to the caller — NEVER pooled
  let spent = 0;
  while (heapLen > 0 && out.length < p.maxCells) {
    heapPop();
    const curC = _top.c, curX = _top.x, curY = _top.y, curZ = _top.z;
    const cost = p.strengthAt(curX, curY, curZ) * STRENGTH_TO_JOULES; // removal cost (raw)
    if (spent + cost > p.energy) break;                               // can't afford the cheapest remaining → done
    spent += cost; out.push([curX, curY, curZ]);
    for (const [sx, sy, sz] of STEPS) {
      const x = curX + sx, y = curY + sy, z = curZ + sz;
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) continue;
      if (!p.isSolid(x, y, z)) continue;
      const ni = idx(x, y, z); if (seen.has(ni)) continue; seen.add(ni);
      const align = d ? Math.max(0, sx * d[0] + sy * d[1] + sz * d[2]) : 1;
      const penalty = 1 + LATERAL_BIAS * (1 - align); // forward ×1, lateral/back up to ×2.5
      heapPush(curC + p.strengthAt(x, y, z) * STRENGTH_TO_JOULES * penalty, x, y, z);
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
