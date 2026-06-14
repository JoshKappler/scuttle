// @ts-nocheck -- throwaway spike (removed in Task 10); not part of the typed build.
// THROWAWAY perf/feasibility spike (plan Task 0). Run in Node via the gated test
// tests/voxelSpike.test.ts (RUN_SPIKE=1). Removed in Task 10.
// world.step() is CPU/WASM — identical cost in Node and the browser — so this is
// the authoritative gate for the NEW collision+carve cost.
//
// This refined run keeps the hulls INTACT (carves only a few voxels near the real
// contact point each step) so we measure SUSTAINED two-hull grinding, and it polls
// world.contactPair(...) to prove the contact manifold (point+normal) is readable —
// which is exactly how Task 5 will drive carving (no reliance on force events).
import RAPIER from "@dimforge/rapier3d-compat";
import { buildBrig } from "../sim/shipwright";
import { VOXEL_SIZE } from "../core/constants";

type Hull = {
  nx: number; ny: number; nz: number;
  solid: Set<number>; key: (x: number, y: number, z: number) => number;
  body: RAPIER.RigidBody; col: RAPIER.Collider; voxels: number; carved: number;
};

export async function runVoxelSpike(): Promise<Record<string, unknown>> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 }); // no gravity: isolate collision+carve cost
  world.timestep = 1 / 60;
  const errors: string[] = [];

  const makeHull = (sign: number): Hull => {
    const grid = buildBrig().grid;
    const [nx, ny, nz] = grid.dims;
    const key = (x: number, y: number, z: number) => x + nx * (y + ny * z);
    const coords: number[] = [];
    const solid = new Set<number>();
    grid.forEachSolid((x, y, z) => { coords.push(x, y, z); solid.add(key(x, y, z)); });
    const lenX = nx * VOXEL_SIZE;
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(sign * (lenX * 0.5 + 0.2), 0, 0) // facing faces ~0.4 m apart
        .setLinvel(-sign * 4, 0, 0)                       // close at ~8 m/s combined, then grind
        .setAdditionalMass(500000)
        .setLinearDamping(0),
    );
    const col = world.createCollider(
      RAPIER.ColliderDesc.voxels(new Int32Array(coords), { x: VOXEL_SIZE, y: VOXEL_SIZE, z: VOXEL_SIZE })
        .setDensity(0)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(0),
      body,
    );
    return { nx, ny, nz, solid, key, body, col, voxels: coords.length / 3, carved: 0 };
  };

  const A = makeHull(-1);
  const B = makeHull(1);

  let combineWorks = false;
  try { A.col.combineVoxelStates(B.col, 0, 0, 0); combineWorks = true; }
  catch (e) { errors.push("combineVoxelStates: " + (e as Error).message); }

  // carve up to n solid cells within a small box around a WORLD point on hull H
  const carveNear = (H: Hull, other: Hull, wx: number, wy: number, wz: number, n: number) => {
    const tr = H.body.translation(); // spike hulls don't rotate, so world→local is a translate
    const cx = Math.floor((wx - tr.x) / VOXEL_SIZE);
    const cy = Math.floor((wy - tr.y) / VOXEL_SIZE);
    const cz = Math.floor((wz - tr.z) / VOXEL_SIZE);
    let removed = 0;
    for (let r = 0; r <= 4 && removed < n; r++) {
      for (let dx = -r; dx <= r && removed < n; dx++)
        for (let dy = -r; dy <= r && removed < n; dy++)
          for (let dz = -r; dz <= r && removed < n; dz++) {
            const x = cx + dx, y = cy + dy, z = cz + dz;
            if (x < 0 || y < 0 || z < 0 || x >= H.nx || y >= H.ny || z >= H.nz) continue;
            if (!H.solid.has(H.key(x, y, z))) continue;
            H.solid.delete(H.key(x, y, z));
            try {
              H.col.setVoxel(x, y, z, false);
              if (combineWorks) H.col.propagateVoxelChange(other.col, x, y, z, 0, 0, 0);
            } catch (e) { errors.push("setVoxel: " + (e as Error).message); }
            removed++; H.carved++;
          }
    }
  };

  const events = new RAPIER.EventQueue(true);
  const allTimes: number[] = [];
  const contactTimes: number[] = [];
  let forceEvents = 0, collisionEvents = 0, contactSteps = 0;
  let sampleNormal: number[] | null = null, samplePoint: number[] | null = null, sampleNumContacts = 0;

  const STEPS = 400;
  for (let s = 0; s < STEPS; s++) {
    const t0 = performance.now();
    try { world.step(events); } catch (e) { errors.push("world.step: " + (e as Error).message); break; }
    allTimes.push(performance.now() - t0);
    events.drainContactForceEvents(() => { forceEvents++; });
    events.drainCollisionEvents(() => { collisionEvents++; });

    // poll the manifold directly — this is how Task 5 reads the contact
    let cp: { x: number; y: number; z: number } | null = null;
    let nC = 0; let nrm: { x: number; y: number; z: number } | null = null;
    world.contactPair(A.col, B.col, (m) => {
      nC = m.numContacts();
      if (nC > 0) { nrm = m.normal(); cp = m.solverContactPoint(0) ?? null; }
    });
    if (nC > 0 && cp && nrm) {
      contactSteps++;
      contactTimes.push(allTimes[allTimes.length - 1]);
      sampleNumContacts = nC;
      sampleNormal = [+nrm.x.toFixed(3), +nrm.y.toFixed(3), +nrm.z.toFixed(3)];
      samplePoint = [+cp.x.toFixed(2), +cp.y.toFixed(2), +cp.z.toFixed(2)];
      carveNear(A, B, cp.x, cp.y, cp.z, 4);
      carveNear(B, A, cp.x, cp.y, cp.z, 4);
    }
  }

  const stats = (arr: number[]) => {
    if (!arr.length) return { median: 0, p95: 0, max: 0, mean: 0 };
    const a = [...arr].sort((x, y) => x - y);
    const at = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    return {
      median: +at(0.5).toFixed(3), p95: +at(0.95).toFixed(3),
      max: +Math.max(...a).toFixed(3), mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(3),
    };
  };

  const result: Record<string, unknown> = {
    voxelsPerHull: A.voxels,
    steps: allTimes.length,
    contactSteps,
    perfAllStepsMs: stats(allTimes),
    perfContactStepsMs: stats(contactTimes), // the representative "two hulls grinding while carving" cost
    carvedA: A.carved, carvedB: B.carved,
    manifoldReadable: samplePoint !== null,
    sampleNumContacts, sampleNormal, samplePoint,
    forceEvents, collisionEvents,
    combineWorks,
    aVelEndX: +A.body.linvel().x.toFixed(2),
    errors,
    verdict:
      allTimes.length === 0 ? "CRASH"
      : !samplePoint ? "NO_CONTACT"
      : (stats(contactTimes).median <= 10 && stats(contactTimes).p95 <= 16.6) ? "PASS"
      : "REVIEW",
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof window !== "undefined") (window as any).SPIKE_RESULT = result;
  if (typeof document !== "undefined") document.title = "spike " + result.verdict;
  console.log("SPIKE_RESULT " + JSON.stringify(result));
  return result;
}
