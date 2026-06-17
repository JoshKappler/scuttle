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
    const count = Math.max(2, Math.round(m.h / TRUNK_STEP) + 1);
    let prevIdx = -1;
    for (let i = 0; i < count; i++) {
      const y = deckTop + (i / (count - 1)) * m.h;
      const isFoot = i === 0;
      const idx = addNode({ x: mx, y, z: mz }, WOOD_MASS, NodeFlag.WOOD | (isFoot ? NodeFlag.FOOT : 0), isFoot);
      if (prevIdx >= 0) addLink(prevIdx, idx, LinkKind.WOOD, WOOD_BREAK);
      prevIdx = idx;
    }
  }

  return { nodes, links, awake: false, sleepTimer: 0 };
}
