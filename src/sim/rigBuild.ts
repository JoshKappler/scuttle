/**
 * Build a Rig (sim/rigLattice) from a ship's geometry. Mirrors the spar/sail
 * layout render/shipVisual draws (trunk + 3 yards + 2 laced sails per mast,
 * plus the bowsprit) so the lattice lines up with the hull. Pure: takes a
 * RigSpec, returns a Rig. See docs/superpowers/specs/2026-06-16-voxel-rig-design.md.
 */
import { type Rig, type RigNode, type RigLink, type Vec3, type LinkKindV, NodeFlag, LinkKind, dist } from "./rigLattice";

export interface MastSpec { x: number; z: number; h: number; } // voxel coords (x,z); h in meters
export interface RigSpec {
  voxelSize: number;
  /** Deck-top height (m) at a mast's voxel-x — pass build.deckYAt-derived value. */
  deckTopY: (xVox: number) => number;
  masts: MastSpec[];
  /** Optional bowsprit as a ship-local heel->tip segment (meters). */
  bowsprit?: { heel: Vec3; tip: Vec3 };
}

// Tuning defaults (overridden live by TUN.rig once wired in a later phase).
const TRUNK_STEP = 2.0;   // m between trunk nodes
const WOOD_BREAK = 0.06;
const WOOD_MASS = 4.0;

const YARD_NODES = 5;            // nodes across one yard
const YARD_FORE = 0.25;          // m the yard sits forward of the trunk axis
const YARD_LEVELS = [            // fraction of mast height, fraction-of-height width
  { f: 0.17, wf: 0.71 },
  { f: 0.56, wf: 0.57 },
  { f: 0.88, wf: 0.43 },
];

const CLOTH_COLS = 8;
const CLOTH_ROWS = 6;
const CLOTH_FORE = 0.4;   // m the cloth hangs forward of the yards
const CLOTH_BREAK = 0.30;
const LACE_BREAK = 0.40;  // cloth-to-yard lacing (a touch tougher than the cloth)
const CLOTH_MASS = 0.4;

export function buildRig(spec: RigSpec): Rig {
  const nodes: RigNode[] = [];
  const links: RigLink[] = [];
  const vs = spec.voxelSize;

  const addNode = (pos: Vec3, mass: number, flags: number, pinned: boolean): number => {
    nodes.push({ pos, prev: { ...pos }, mass, pinned, flags });
    return nodes.length - 1;
  };
  const addLink = (a: number, b: number, kind: LinkKindV, breakStrain: number): void => {
    links.push({ a, b, rest: dist(nodes[a].pos, nodes[b].pos), breakStrain, kind, alive: true });
  };

  for (const m of spec.masts) {
    const mx = (m.x + 0.5) * vs;
    const mz = (m.z + 0.5) * vs;
    const deckTop = spec.deckTopY(m.x);

    // --- trunk ---
    const count = Math.max(2, Math.round(m.h / TRUNK_STEP) + 1);
    const trunkIdx: number[] = [];
    let prevIdx = -1;
    for (let i = 0; i < count; i++) {
      const y = deckTop + (i / (count - 1)) * m.h;
      const isFoot = i === 0;
      const idx = addNode({ x: mx, y, z: mz }, WOOD_MASS, NodeFlag.WOOD | (isFoot ? NodeFlag.FOOT : 0), isFoot);
      if (prevIdx >= 0) addLink(prevIdx, idx, LinkKind.WOOD, WOOD_BREAK);
      trunkIdx.push(idx);
      prevIdx = idx;
    }

    const nearestTrunk = (y: number): number => {
      let best = trunkIdx[0], bestD = Infinity;
      for (const ti of trunkIdx) {
        const d = Math.abs(nodes[ti].pos.y - y);
        if (d < bestD) { bestD = d; best = ti; }
      }
      return best;
    };

    // --- yards (record geometry so the cloth can lace to them) ---
    const yards: { idx: number[]; yc: number; width: number }[] = [];
    for (const lv of YARD_LEVELS) {
      const yc = deckTop + lv.f * m.h;
      const width = m.h * lv.wf;
      const yardIdx: number[] = [];
      for (let j = 0; j < YARD_NODES; j++) {
        const z = mz - width / 2 + (width * j) / (YARD_NODES - 1);
        yardIdx.push(addNode({ x: mx + YARD_FORE, y: yc, z }, WOOD_MASS, NodeFlag.WOOD, false));
        if (j > 0) addLink(yardIdx[j - 1], yardIdx[j], LinkKind.WOOD, WOOD_BREAK);
      }
      addLink(yardIdx[(YARD_NODES - 1) >> 1], nearestTrunk(yc), LinkKind.WOOD, WOOD_BREAK); // the sling
      yards.push({ idx: yardIdx, yc, width });
    }

    const nearestYardNode = (yardIdx: number[], z: number): number => {
      let best = yardIdx[0], bestD = Infinity;
      for (const yi of yardIdx) {
        const d = Math.abs(nodes[yi].pos.z - z);
        if (d < bestD) { bestD = d; best = yi; }
      }
      return best;
    };

    // --- cloth: one sail between each consecutive yard pair ---
    for (let s = 0; s < yards.length - 1; s++) {
      const foot = yards[s], head = yards[s + 1];
      const grid: number[][] = [];
      for (let r = 0; r < CLOTH_ROWS; r++) {
        const fr = r / (CLOTH_ROWS - 1);
        const y = foot.yc + (head.yc - foot.yc) * fr;
        const w = foot.width + (head.width - foot.width) * fr;
        const row: number[] = [];
        for (let c = 0; c < CLOTH_COLS; c++) {
          const z = mz - w / 2 + (w * c) / (CLOTH_COLS - 1);
          row.push(addNode({ x: mx + CLOTH_FORE, y, z }, CLOTH_MASS, NodeFlag.CLOTH, false));
        }
        grid.push(row);
      }
      for (let r = 0; r < CLOTH_ROWS; r++) {
        for (let c = 0; c < CLOTH_COLS; c++) {
          if (c + 1 < CLOTH_COLS) addLink(grid[r][c], grid[r][c + 1], LinkKind.CLOTH, CLOTH_BREAK);
          if (r + 1 < CLOTH_ROWS) addLink(grid[r][c], grid[r + 1][c], LinkKind.CLOTH, CLOTH_BREAK);
          if (c + 1 < CLOTH_COLS && r + 1 < CLOTH_ROWS) addLink(grid[r][c], grid[r + 1][c + 1], LinkKind.CLOTH, CLOTH_BREAK);
        }
      }
      for (let c = 0; c < CLOTH_COLS; c++) {
        addLink(grid[0][c], nearestYardNode(foot.idx, nodes[grid[0][c]].pos.z), LinkKind.CLOTH, LACE_BREAK);
        addLink(grid[CLOTH_ROWS - 1][c], nearestYardNode(head.idx, nodes[grid[CLOTH_ROWS - 1][c]].pos.z), LinkKind.CLOTH, LACE_BREAK);
      }
    }
  }

  // --- bowsprit: a wood chain rooted at the bow (heel pinned) ---
  if (spec.bowsprit) {
    const { heel, tip } = spec.bowsprit;
    const len = dist(heel, tip);
    const count = Math.max(2, Math.round(len / TRUNK_STEP) + 1);
    let prevIdx = -1;
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      const pos = { x: heel.x + (tip.x - heel.x) * f, y: heel.y + (tip.y - heel.y) * f, z: heel.z + (tip.z - heel.z) * f };
      const isHeel = i === 0;
      const idx = addNode(pos, WOOD_MASS, NodeFlag.WOOD | (isHeel ? NodeFlag.FOOT : 0), isHeel);
      if (prevIdx >= 0) addLink(prevIdx, idx, LinkKind.WOOD, WOOD_BREAK);
      prevIdx = idx;
    }
  }

  return { nodes, links, awake: false, sleepTimer: 0 };
}
