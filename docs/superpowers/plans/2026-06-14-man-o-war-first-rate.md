# Man-o'-War (first-rate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third, much larger voxel ship class — a three-gun-deck first-rate man-o'-war modeled on the *Sovereign of the Seas* (1637) — that the player can sail as a flagship.

**Architecture:** A new self-contained `buildManOfWar(): ShipBuild` in `src/sim/shipwright.ts`, built with the exact analytic-egg-section pattern of `buildBrig` scaled up: three gun-deck port tiers (lower/middle enclosed, weather deck open), bow + stern chasers, a raised quarterdeck aft and forecastle forward, three masts, and deep iron ballast tuned live against pure buoyancy tests so flotation is **emergent** (THE LAW #2). The simulation core, renderer, and firing code are already generic over `ShipBuild`/`cannonPorts`, so the only wiring is selecting which builder makes the player ship. The two existing tuned hulls are left untouched.

**Tech Stack:** TypeScript, Vite, Three.js, Rapier3D, vitest. Deterministic voxel shipwright (`src/sim/shipwright.ts`), buoyancy oracle (`src/sim/buoyancy.ts`).

---

## Reference & key facts (read before starting)

- Study `buildBrig()` in `src/sim/shipwright.ts:302-577` — `buildManOfWar` is a faithful scale-up of it. The `ShipBuild` interface is at `shipwright.ts:13-34`.
- `VOXEL_SIZE = 0.25` m. Convention: **low x = aft (stern), high x = bow.** `cz` is the centerline (half-cell on even `nz`); ports mirror with `Math.floor(cz)±hb` / `Math.ceil(cz)∓hb`.
- The renderer (`src/render/shipVisual.ts`) is **fully generic** over `cannonPorts`: it already draws a carriage + lathe barrel for every broadside gun and a framed gunport window for below-deck guns (`shipVisual.ts:674`). **No renderer changes are needed.**
- Firing (`src/game/cannons.ts:118` `fireBroadside`) fires **every loaded gun bearing for a side regardless of height**, so all three port (or starboard) tiers fire as one broadside for free. **No firing-code changes.**
- Handling is **emergent**: thrust ∝ mass (so acceleration is size-independent) but rudder yaw torque ∝ mass while yaw inertia ∝ mass·L², so the bigger hull turns ~half as fast on its own (`src/game/sailing.ts:77,125`). No sailing-code changes expected.
- `armorBow(grid)` is a module-private helper in `shipwright.ts:42` — `buildManOfWar` calls it directly.

---

## Task 1: `buildManOfWar` — the hull, gun decks, chasers, rig

**Files:**
- Modify: `src/sim/shipwright.ts` (add `buildManOfWar`, after `buildBrig`)
- Test: `tests/manOfWar.test.ts` (create)

- [ ] **Step 1: Write the failing structural test**

Create `tests/manOfWar.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildManOfWar } from "../src/sim/shipwright";
import { findCompartments } from "../src/sim/compartments";
import { RAM } from "../src/sim/materials";

const ship = buildManOfWar();

describe("shipwright man-o'-war (first-rate, three gun decks)", () => {
  it("is port/starboard symmetric", () => {
    const { grid } = ship;
    const [nx, ny, nz] = grid.dims;
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ny; y++)
        for (let z = 0; z < nz; z++)
          expect(grid.get(x, y, z)).toBe(grid.get(x, y, nz - 1 - z));
  });

  it("is watertight: no interior region leaks to the outside", () => {
    expect(ship.interiorLeaks).toHaveLength(0);
  });

  it("is bigger than the brig — a full-sized fighting ship", () => {
    expect(ship.lengthM).toBeGreaterThanOrEqual(45);
    expect(ship.beamM).toBeGreaterThanOrEqual(13);
  });

  it("carries three firing gun decks: 22 broadside ports a side across three heights", () => {
    const broadside = ship.cannonPorts.filter((p) => !p.facing);
    expect(broadside.filter((p) => p.side === 1)).toHaveLength(22);
    expect(broadside.filter((p) => p.side === -1)).toHaveLength(22);
    const decks = new Set(broadside.map((p) => p.y));
    expect(decks.size).toBe(3);
  });

  it("each broadside port pair is symmetric about the centerline", () => {
    const nz = ship.grid.dims[2];
    const byX = new Map<string, number[]>();
    for (const p of ship.cannonPorts.filter((p) => !p.facing)) {
      const k = `${p.x}:${p.y}`;
      const arr = byX.get(k) ?? [];
      arr.push(p.z);
      byX.set(k, arr);
    }
    for (const zs of byX.values()) {
      expect(zs).toHaveLength(2);
      expect(zs[0] + zs[1]).toBe(nz - 1);
    }
  });

  it("mounts bow AND stern chasers, seated below the weather deck (front + back guns)", () => {
    const fore = ship.cannonPorts.filter((p) => p.facing === "fore");
    const aft = ship.cannonPorts.filter((p) => p.facing === "aft");
    expect(fore.length).toBeGreaterThanOrEqual(2);
    expect(aft.length).toBeGreaterThanOrEqual(2);
    for (const p of [...fore, ...aft]) expect(p.y).toBeLessThan(ship.deckY);
  });

  it("leaves embrasures in the weather-deck fence for the upper-tier guns", () => {
    for (const p of ship.cannonPorts.filter((p) => !p.facing && p.y > ship.deckY)) {
      expect(ship.grid.get(p.x, ship.deckY + 4, p.z)).toBe(0); // EMPTY — fence open above the gun
    }
  });

  it("raises a quarterdeck aft with the wheel on it", () => {
    const q = ship.quarterdeck!;
    expect(q).not.toBeNull();
    expect(q.deckY - ship.deckY).toBeGreaterThanOrEqual(8);
    const ws = Math.round(ship.wheelM.x / 0.25);
    expect(ship.deckYAt(ws)).toBe(q.deckY);
    expect(ship.grid.isSolid(ws, q.deckY, Math.round(ship.wheelM.z / 0.25))).toBe(true);
  });

  it("raises a forecastle forward (the deck steps up at the bow too)", () => {
    const [nx] = ship.grid.dims;
    expect(ship.deckYAt(nx - 12)).toBe(ship.quarterdeck!.deckY);
    expect(ship.deckYAt(Math.round(nx / 2))).toBe(ship.deckY); // the waist stays low
  });

  it("has a reinforced RAM prow but a plain stern (directional bow armor)", () => {
    const { grid } = ship;
    const [nx, ny, nz] = grid.dims;
    let stemRam = 0, sternRam = 0;
    const stemX0 = Math.floor(nx * 0.85);
    const sternX1 = Math.floor(nx * 0.15);
    for (let x = 0; x < nx; x++)
      for (let y = 0; y < ny; y++)
        for (let z = 0; z < nz; z++) {
          if (grid.get(x, y, z) !== RAM) continue;
          if (x >= stemX0) stemRam++;
          else if (x < sternX1) sternRam++;
        }
    expect(stemRam).toBeGreaterThan(0);
    expect(sternRam).toBe(0);
  });

  it("subdivides the hold into watertight compartments, three masts, three hatches", () => {
    expect(findCompartments(ship.grid, ship.deckY).length).toBeGreaterThanOrEqual(3);
    expect(ship.hatches.length).toBe(3);
    expect(ship.masts.length).toBe(3);
  });

  it("deterministic: building twice yields identical grids", () => {
    const again = buildManOfWar();
    expect(again.grid.data).toEqual(ship.grid.data);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/manOfWar.test.ts`
Expected: FAIL — `buildManOfWar is not a function` / import error.

- [ ] **Step 3: Implement `buildManOfWar`**

Append to `src/sim/shipwright.ts` (after `buildBrig`, before the end of file). This is a faithful scale-up of `buildBrig` with three gun-deck tiers and a forecastle:

```ts
/**
 * A first-rate man-o'-war modeled on the Sovereign of the Seas (1637): three
 * gun decks, a raised quarterdeck aft + forecastle forward, three masts. The
 * brig's analytic egg-section scaled up (~50 m, 14 m beam). Flotation is
 * emergent — the iron ballast below is tuned live against the draft +
 * stability tests (THE LAW #2); no attitude is hand-set.
 */
export function buildManOfWar(): ShipBuild {
  const nx = 208;
  const ny = 54;
  const nz = 60;
  const grid = createGrid(nx, ny, nz);

  const x0 = 4;             // stern transom station (low x = AFT, bow at HIGH x)
  const L = 200;           // 50 m gun-deck length
  const deckY = 36;        // weather (main) deck, ~9 m above the keel plane
  const lowerGunY = 21;    // lower gun-deck port height (at the waterline belt)
  const midGunY = 29;      // middle gun-deck port height
  const qDeckY = deckY + 8; // raised quarterdeck AND forecastle: one ~2 m story up
  const qTaft = 0.20;      // stations with t < qTaft carry the aft quarterdeck
  const fcTfwd = 0.82;     // stations with t > fcTfwd carry the forward forecastle
  const halfBeamMax = 28;  // 14 m beam at the belt
  const cz = (nz - 1) / 2;
  const qX1 = Math.floor(x0 + qTaft * (L - 1) - 1e-9); // forward edge of the aft quarterdeck
  const fcX0 = Math.ceil(x0 + fcTfwd * (L - 1));       // aft edge of the forecastle
  const stairZs = [Math.floor(cz - 10), Math.ceil(cz + 10)]; // companion-stair lanes (both breaks)

  const stationT = (x: number) => (x - x0) / (L - 1);
  const keelY = (t: number) => 2 + Math.round(6 * Math.pow(Math.abs(t - 0.45) / 0.55, 1.8));
  const halfBeam = (t: number) => halfBeamMax * Math.pow(Math.sin(Math.PI * (0.13 + 0.87 * t)), 0.72);
  const sectionHalfBeam = (t: number, y: number) => {
    const k = keelY(t);
    const f = Math.min(Math.max((y - k) / (deckY - k), 0), 1);
    const d = f - 0.62;
    const a = d < 0 ? 0.64 : 0.67;
    const oval = Math.sqrt(Math.max(1 - (d / a) * (d / a), 0));
    return halfBeam(t) * (0.1 + 0.9 * oval);
  };

  const deckYAt = (x: number) => (x <= qX1 || x >= fcX0 ? qDeckY : deckY);

  const inside = (x: number, y: number, z: number): boolean => {
    const t = stationT(x);
    if (t < 0 || t > 1) return false;
    if (y < keelY(t) || y > deckYAt(x)) return false;
    return Math.abs(z - cz) <= sectionHalfBeam(t, y);
  };

  // rasterize: OAK shell, PINE planking at the weather deck AND the raised ends.
  // The weather-deck plane continues under the quarterdeck/forecastle as the
  // deck below; the shell rule raises the break walls and the topsides.
  let envelopeCells = 0;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++) {
        if (!inside(x, y, z)) continue;
        envelopeCells++;
        if (y === deckY || y === deckYAt(x)) {
          grid.set(x, y, z, PINE);
          continue;
        }
        const onShell =
          !inside(x - 1, y, z) ||
          !inside(x + 1, y, z) ||
          !inside(x, y - 1, z) ||
          !inside(x, y, z - 1) ||
          !inside(x, y, z + 1);
        if (onShell) grid.set(x, y, z, OAK);
      }
    }
  }

  // a walk-in door + companion stairs at EACH break (aft great cabin, forward
  // forecastle) so both raised decks are reachable from the waist. Steps are
  // single-voxel wedges (the character controller autosteps 0.35).
  const cutDoorAndStairs = (breakX: number, climbDir: 1 | -1) => {
    for (let z = Math.round(cz - 1.5); z <= Math.round(cz + 1.5); z++) {
      for (let y = deckY + 1; y <= deckY + 7; y++) {
        if (grid.get(breakX, y, z) !== EMPTY) grid.remove(breakX, y, z);
      }
    }
    for (const sz of stairZs) {
      for (let s = 0; s < 8; s++) {
        const sx = breakX + climbDir * (8 - s); // steps on the waist side, climbing to the break
        for (let z = sz - 1; z <= sz + 1; z++) {
          for (let y = deckY + 1; y <= deckY + 1 + s; y++) {
            if (grid.get(sx, y, z) === EMPTY) grid.set(sx, y, z, PINE);
          }
        }
      }
    }
  };
  cutDoorAndStairs(qX1, 1);    // aft quarterdeck: stairs forward of the break, climbing aft
  cutDoorAndStairs(fcX0, -1);  // forward forecastle: stairs aft of the break, climbing forward

  // iron ballast — deep z/t-bands following the fuller-aft centre of buoyancy,
  // like the brig but more of it (three gun decks = more top-weight). STARTER
  // pattern; Task 2 tunes the rows live until draft ≈ 0.45 with positive GM.
  const ballastZ = (k: number) => {
    const zs: number[] = [];
    for (let z = Math.ceil(cz - k); z <= Math.floor(cz + k); z++) zs.push(z);
    return zs;
  };
  // each row: [tier above keel, tMin, tMax, zHalf]
  const ballastRows: [number, number, number, number][] = [
    [0, 0.05, 0.90, 6],
    [1, 0.07, 0.88, 6],
    [2, 0.10, 0.85, 5],
    [3, 0.14, 0.82, 5],
    [4, 0.18, 0.78, 4],
    [5, 0.22, 0.74, 4],
    [6, 0.27, 0.69, 3],
    [7, 0.32, 0.64, 3],
    [8, 0.38, 0.58, 2],
  ];
  for (let x = 0; x < nx; x++) {
    const t = stationT(x);
    const by = keelY(t) + 1;
    for (const [tier, tMin, tMax, zHalf] of ballastRows) {
      if (t < tMin || t > tMax) continue;
      for (const z of ballastZ(zHalf)) {
        if (inside(x, by + tier, z) && grid.get(x, by + tier, z) === EMPTY) grid.set(x, by + tier, z, IRON);
      }
    }
  }

  // transverse watertight bulkheads at 1/4, 1/2, 3/4 (a longer hull → an extra one)
  const bulkheadXs = [x0 + Math.round(L / 4), x0 + Math.round(L / 2), x0 + Math.round((3 * L) / 4)];
  for (const bx of bulkheadXs) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(bx, y, z) && grid.get(bx, y, z) === EMPTY) grid.set(bx, y, z, OAK);
      }
    }
  }

  // ---- gun decks: three broadside tiers + axial chasers ----
  // lower & middle decks fire through framed ports in the side shell (the shell
  // voxel stays solid — the render frames it, shipVisual.ts:674); the weather
  // deck fires over the rail through fence embrasures like the brig's waist.
  const lowerXs = [0.26, 0.33, 0.40, 0.47, 0.54, 0.61, 0.68, 0.74].map((f) => x0 + Math.round(L * f));
  const midXs = lowerXs.slice();
  const upperXs = [0.30, 0.38, 0.46, 0.54, 0.62, 0.70].map((f) => x0 + Math.round(L * f));

  // bulwark fence at each deck's own edge (waist + quarterdeck + forecastle),
  // with embrasures for the weather-deck guns and gaps where the stairs land.
  for (let x = 0; x < nx; x++) {
    const dY = deckYAt(x);
    for (let z = 0; z < nz; z++) {
      if (!inside(x, dY, z)) continue;
      const onEdge =
        !inside(x - 1, dY, z) || !inside(x + 1, dY, z) || !inside(x, dY, z - 1) || !inside(x, dY, z + 1);
      if (!onEdge) continue;
      const nearPort = dY === deckY && upperXs.some((px) => Math.abs(x - px) <= 1);
      if (nearPort) continue;
      if ((x === qX1 || x === fcX0) && stairZs.some((sz) => Math.abs(z - sz) <= 1)) continue;
      grid.set(x, dY + 1, z, PINE);
      grid.set(x, dY + 4, z, PINE);
      const corner =
        (!inside(x - 1, dY, z) || !inside(x + 1, dY, z)) &&
        (!inside(x, dY, z - 1) || !inside(x, dY, z + 1));
      if (corner || (x + Math.round(Math.abs(z - cz))) % 3 === 0) {
        grid.set(x, dY + 2, z, PINE);
        grid.set(x, dY + 3, z, PINE);
      }
    }
  }

  // grated deck hatches over the holds (flooding paths, walkable)
  const hatchXs = [x0 + Math.round(L / 6), x0 + Math.round(L / 2), x0 + Math.round((5 * L) / 6)];
  const hatchZ = Math.floor(cz);
  const hatches: ShipBuild["hatches"] = [];
  for (const hx of hatchXs) hatches.push({ x: hx, z: hatchZ, w: 2, d: 2 });

  // weld floating internals (diagonal ballast tiers) to the main mass — ONE 6-connected solid.
  weldToSingleComponent(grid);

  const compartments = findCompartments(grid, deckY);
  const hatchAreaM2 = 2 * 2 * VOXEL_SIZE * VOXEL_SIZE;
  for (const c of compartments) c.hatchArea = hatchAreaM2;

  const claimed = new Set<number>();
  for (const c of compartments) for (const cell of c.cells) claimed.add(cell);
  const interiorLeaks: number[] = [];
  const idx = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < deckY; y++) {
      for (let z = 0; z < nz; z++) {
        if (inside(x, y, z) && grid.get(x, y, z) === EMPTY && !claimed.has(idx(x, y, z))) {
          interiorLeaks.push(idx(x, y, z));
        }
      }
    }
  }

  // broadside ports: 8 lower + 8 middle + 6 weather, each side, symmetric about cz.
  // floor/ceil split keeps the two batteries exactly mirrored on the even beam.
  const cannonPorts: ShipBuild["cannonPorts"] = [];
  const addBroadside = (xs: number[], gunY: number) => {
    for (const px of xs) {
      const t = stationT(px);
      const hb = Math.round(sectionHalfBeam(t, gunY));
      cannonPorts.push({ x: px, y: gunY, z: Math.floor(cz) + hb, side: 1 });
      cannonPorts.push({ x: px, y: gunY, z: Math.ceil(cz) - hb, side: -1 });
    }
  };
  addBroadside(lowerXs, lowerGunY);
  addBroadside(midXs, midGunY);
  addBroadside(upperXs, deckY + 1);

  // axial chasers: 2 bow (fore, under the forecastle) + 2 stern (aft, great cabin),
  // seated below the weather deck and fired apart from the broadsides (like the brig).
  const czi = Math.round(cz);
  cannonPorts.push({ x: x0 + L - 7, y: deckY - 5, z: czi - 1, side: -1, facing: "fore" });
  cannonPorts.push({ x: x0 + L - 7, y: deckY - 5, z: czi + 1, side: 1, facing: "fore" });
  cannonPorts.push({ x: x0 + 6, y: deckY - 1, z: czi - 1, side: -1, facing: "aft" });
  cannonPorts.push({ x: x0 + 6, y: deckY - 1, z: czi + 1, side: 1, facing: "aft" });

  // three masts: mizzen (aft), main (tallest, amidships), fore (forward)
  const masts = [
    { x: x0 + Math.round(L * 0.22), z: Math.round(cz), h: 22 },
    { x: x0 + Math.round(L * 0.48), z: Math.round(cz), h: 32 },
    { x: x0 + Math.round(L * 0.74), z: Math.round(cz), h: 26 },
  ];

  armorBow(grid); // reinforced forward shell — a bow-first ram wins (material cost asymmetry)

  return {
    grid,
    deckY,
    envelopeVolume: envelopeCells * VOXEL_VOLUME,
    compartments,
    interiorLeaks,
    cannonPorts,
    masts,
    hatches,
    lengthM: L * VOXEL_SIZE,
    beamM: halfBeamMax * 2 * VOXEL_SIZE,
    deckYAt,
    quarterdeck: { x1: qX1, deckY: qDeckY },
    wheelM: { x: (x0 + Math.round(L * 0.08) + 0.5) * VOXEL_SIZE, z: (nz / 2) * VOXEL_SIZE },
    footprint: {
      minX: (x0 - 6) * VOXEL_SIZE,
      maxX: (x0 + L + 6) * VOXEL_SIZE,
      zC: (nz / 2) * VOXEL_SIZE,
      halfZ: (halfBeamMax + 5.4) * VOXEL_SIZE,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/manOfWar.test.ts`
Expected: PASS — all structural/port/quarterdeck/forecastle/RAM/determinism cases green. (Flotation is NOT asserted here; that is Task 2.)

If the symmetry test fails, the most likely cause is a mast `z = Math.round(cz)` writing a voxel — confirm `masts` is metadata only (it does not call `grid.set`, matching `buildBrig`). If the port-pair test fails, confirm `addBroadside` uses `Math.floor(cz)+hb` and `Math.ceil(cz)-hb`.

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `npm run test`
Expected: all existing ~115 tests still PASS (the two tuned hulls are untouched).

- [ ] **Step 6: Commit**

```bash
git add src/sim/shipwright.ts tests/manOfWar.test.ts
git commit -m "feat(ship): buildManOfWar — three-gun-deck first-rate hull (structure)"
```

---

## Task 2: Tune ballast for emergent flotation (draft + stability)

**Files:**
- Modify: `src/sim/shipwright.ts` (the `ballastRows` array inside `buildManOfWar`)
- Test: `tests/manOfWarFloat.test.ts` (create)

**Context:** Both tests below are PURE (the buoyancy probe oracle — no browser), so the ballast is tuned by editing `ballastRows` and re-running them until green. This mirrors how the brig was tuned (see the comments at `shipwright.ts:389-454`).

- [ ] **Step 1: Write the failing flotation test**

Create `tests/manOfWarFloat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildManOfWar } from "../src/sim/shipwright";
import { makeProbes, probeForce, submergedFraction } from "../src/sim/buoyancy";
import { G, WATER_DENSITY } from "../src/core/constants";

const ship = buildManOfWar();
const probes = makeProbes(ship.grid, ship.compartments);
const mass = ship.grid.totalMass();
const com = ship.grid.centerOfMass();

/** Net vertical force and x-torque about the COM for the hull heeled by `heel`
 *  radians about x and floated with the COM at world height comY. */
function hydrostatics(heel: number, comY: number): { force: number; torqueX: number } {
  let force = 0, torqueX = 0;
  const c = Math.cos(heel), s = Math.sin(heel);
  for (const p of probes) {
    const ly = p.local[1] - com[1];
    const lz = p.local[2] - com[2];
    const wy = comY + ly * c - lz * s;
    const f = probeForce(p, wy, 0, 0);
    force += f;
    const sub = submergedFraction(p, wy, 0);
    const lyApp = ly + (sub * p.height) / 2;
    const wzApp = lz * c + lyApp * s;
    torqueX += -wzApp * f;
  }
  return { force, torqueX };
}
function equilibriumY(heel: number): number {
  let lo = -6, hi = 6;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (hydrostatics(heel, mid).force > mass * G) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe("man-o'-war flotation (emergent, tuned ballast)", () => {
  it("rides with real freeboard: ~0.45 of the envelope submerged (not awash, not corky)", () => {
    const ratio = mass / (WATER_DENSITY * ship.envelopeVolume);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.5);
  });

  it("heeling 5° produces a RESTORING torque (positive GM — she will not turtle)", () => {
    const heel = (5 * Math.PI) / 180;
    const y = equilibriumY(heel);
    const { torqueX } = hydrostatics(heel, y);
    expect(torqueX * heel).toBeLessThan(0);
    const gm = -torqueX / (mass * G * Math.sin(heel));
    expect(gm).toBeGreaterThan(0.15);
  });

  it("heeling 15° still restores (range of stability)", () => {
    const heel = (15 * Math.PI) / 180;
    const y = equilibriumY(heel);
    expect(hydrostatics(heel, y).torqueX * heel).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run the test to see where the starter ballast lands**

Run: `npx vitest run tests/manOfWarFloat.test.ts`
Expected: likely FAIL on the draft ratio (the starter ballast is a guess) and possibly the GM case. Read the actual `ratio` and `gm` from the failure output before adjusting.

- [ ] **Step 3: Tune `ballastRows` until both pass**

Edit the `ballastRows` array in `buildManOfWar` (`src/sim/shipwright.ts`) and re-run after each change. Use this convergence procedure (one lever at a time):

- **Draft ratio too HIGH (> 0.5, she floats too deep/heavy):** remove the top ballast row (the highest `tier`), or narrow a row's `[tMin, tMax]`, or shrink its `zHalf`. Less iron → lighter → rides higher.
- **Draft ratio too LOW (< 0.4, she floats too light/high):** add a row above the current top tier (e.g. `[9, 0.42, 0.54, 2]`), or widen `[tMin, tMax]`, or grow `zHalf`. More iron → heavier → sits deeper.
- **GM too low / 5° not restoring (top-heavy, toward turtle):** move iron LOWER — prefer removing a high `tier` row and widening a low row's `zHalf`/`t`-range. Mass nearer the keel drops the COM and raises GM. (Keep total iron roughly constant while you do this so the draft ratio stays put.)
- Re-run `npx vitest run tests/manOfWarFloat.test.ts` after each edit. Converge to: ratio ∈ (0.40, 0.50) AND gm > 0.15 AND 15° restoring.

Record the final tuned numbers and a one-line rationale in a comment above `ballastRows` (replace the "STARTER pattern" note), matching the brig's tuning-comment style.

- [ ] **Step 4: Confirm the structural test still passes after tuning**

Run: `npx vitest run tests/manOfWar.test.ts tests/manOfWarFloat.test.ts`
Expected: BOTH files PASS (ballast uses the symmetric `ballastZ`, so symmetry/watertightness are unaffected).

- [ ] **Step 5: Run the full suite**

Run: `npm run test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/sim/shipwright.ts tests/manOfWarFloat.test.ts
git commit -m "feat(ship): tune man-o'-war ballast — emergent ~0.45 draft, positive GM"
```

---

## Task 3: Let the player sail her (selection wiring)

**Files:**
- Modify: `src/main.ts` (import; player-build site `main.ts:131`; dev-panel groups `main.ts:1215`)

**Context:** Selection reuses the existing `?at=harbor` URL-param pattern (`main.ts:149`) and the dev panel's existing `button` control type — no new control type, no runtime hot-swap. `?ship=manowar` builds the man-o'-war as the player ship; default stays the brig, so shipped behavior is unchanged. `ocean.setFootprint` already derives from the player build's dimensions (`main.ts:136`), so the sea cut updates automatically.

- [ ] **Step 1: Import `buildManOfWar`**

In `src/main.ts:10`, extend the existing import:

```ts
import { buildBrig, buildSloop, buildManOfWar } from "./sim/shipwright";
```

- [ ] **Step 2: Choose the player builder from the URL param**

Replace `src/main.ts:131`:

```ts
  const sloopBuild = buildBrig();
```

with:

```ts
  // ?ship=manowar sails the first-rate flagship; default is the brig (shipped). `sloop`
  // names the player ship throughout for history's sake regardless of class.
  const sloopBuild =
    new URLSearchParams(location.search).get("ship") === "manowar" ? buildManOfWar() : buildBrig();
```

- [ ] **Step 3: Add a dev-panel "Ship" group that reloads into the chosen class**

In the `createDevPanel([ ... ])` array (`src/main.ts:1215`), add a new group (place it as the first element of the array so it sits at the top of the panel):

```ts
    {
      title: "Ship (reloads)",
      controls: [
        { type: "button", label: "Brig", onClick: () => { location.href = location.pathname; } },
        { type: "button", label: "Man-o'-War", onClick: () => { location.href = location.pathname + "?ship=manowar"; } },
      ],
    },
```

- [ ] **Step 4: Type-check and build**

Run: `npm run build`
Expected: `tsc --noEmit` PASSES (no unused-import or type errors) and Vite builds.

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: all tests PASS (no runtime knob is read by the deterministic oracle; default class unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(ship): select the man-o'-war via ?ship=manowar + dev-panel buttons"
```

---

## Task 4: In-browser verification (GPU/shaders/handling)

**Files:** none (verification only). Per `CLAUDE.md`, GLSL/runtime behavior must be verified live; screenshots land in the **projects ROOT** (`projects/<name>.png`).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (serves http://localhost:5173)

- [ ] **Step 2: Load the man-o'-war and let her settle**

Use Playwright MCP: navigate to `http://localhost:5173/?ship=manowar`. Wait ~8 s for splash-down to settle.

- [ ] **Step 3: Readback oracle — she floats level and at the right draft**

Run via `browser_evaluate`:

```js
() => {
  const s = window.DEBUG.sloop;
  const r = s.body.rotation();
  // quaternion → pitch (about z) and roll (about x), degrees
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2*(r.w*r.z - r.x*r.y)))) * 180/Math.PI;
  const roll  = Math.atan2(2*(r.w*r.x + r.y*r.z), 1 - 2*(r.x*r.x + r.z*r.z)) * 180/Math.PI;
  return { submergedFrac: s.submergedFrac, pitchDeg: pitch, rollDeg: roll };
}
```

Expected: `submergedFrac` ≈ 0.40–0.50, `|pitchDeg|` ≲ 2 (level trim, no bow/stern lean), `|rollDeg|` ≲ 2 (upright). If pitch is biased, the ballast centroid is fore/aft of the COB — nudge the `ballastRows` `t`-ranges aft/forward (as the brig comment at `shipwright.ts:399` describes) and re-run Task 2's tests.

- [ ] **Step 4: Visual — three gun-deck tiers, chasers, no sea-through-hull**

Screenshot a broadside view: `browser_take_screenshot` → `projects/manowar-broadside.png`, then Read it. Confirm: three rows of framed gunports up the side, a forecastle forward + quarterdeck aft, three masts, and the sea is cleanly cut to the hull (no water through the deck, no void under the hull on the bigger footprint). Screenshot the bow and stern → `projects/manowar-bow.png` / `projects/manowar-stern.png`; confirm the bow and stern chaser ports/barrels are present.

- [ ] **Step 5: Fire a full broadside (all three tiers fire as one)**

Aim a side at open water and fire the broadside (left-click, per the gunnery controls). Screenshot the muzzle flashes → `projects/manowar-broadside-fire.png`. Confirm muzzle smoke/flash appears at **all three tiers** simultaneously and from the chasers when fired fore/aft. (This needs no code — `fireBroadside` fires every bearing gun; this step just confirms the ports were placed correctly.)

- [ ] **Step 6: Handling check (emergent — expect no code change)**

Sail her: confirm she accelerates roughly like the brig but turns noticeably slower and heels modestly (stiff). This should emerge from mass + L² yaw inertia (`sailing.ts`). Only if she is unusable (e.g. will not answer the helm at all, or the camera clips inside the hull): note the specific problem and the single constant to adjust (rudder authority is the shared `0.5` at `sailing.ts:125` — avoid changing it as it affects the AI; prefer the per-controller `boost`/`sailSet`. The chase-camera distance lives in the camera section of `main.ts`). Do not pre-emptively tune; record findings.

- [ ] **Step 7: Capture results**

Note the readback numbers and attach the screenshot filenames in the task summary. No commit (verification only) unless Step 3/6 forced a ballast/handling fix — in that case commit that fix with a `fix(ship):` message and re-run `npm run test`.

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-06-14-man-o-war-first-rate-design.md`):
- New `buildManOfWar` alongside untouched sloop/brig → Task 1. ✓
- Three gun decks, real batteries → Task 1 (`addBroadside` ×3 tiers), verified Task 4 Step 5. ✓
- Bow + stern chasers (front/back guns) → Task 1 (4 chaser ports), test in Task 1. ✓
- Raised quarterdeck aft + forecastle forward → Task 1 (`deckYAt`, `cutDoorAndStairs` ×2), tests in Task 1. ✓
- Emergent flotation, draft ≈ 0.45, positive GM (Vasa guard) → Task 2. ✓
- Player-sailable + selector → Task 3; handling emergent → Task 4 Step 6. ✓
- Tests mirroring brig/draft/stability → Tasks 1 & 2. ✓
- Renderer renders interior-deck ports → reused existing path (`shipVisual.ts:674`), verified Task 4 Step 4 (no code task needed — documented). ✓

**2. Placeholder scan:** No TBD/TODO. Every code step shows complete code; the one "tune until green" step (Task 2 Step 3) gives an explicit, deterministic convergence procedure against pure tests, not a vague "handle it." ✓

**3. Type consistency:** `ShipBuild` fields returned match `shipwright.ts:13-34` (`deckYAt`, `quarterdeck`, `wheelM`, `footprint`, `cannonPorts` with `{x,y,z,side,facing?}`). Test helpers (`makeProbes`, `probeForce`, `submergedFraction`, `findCompartments`) match their existing call sites in `tests/stability.test.ts` and `tests/shipwright.test.ts`. `buildManOfWar` import added in Task 3 matches the export in Task 1. ✓

**Deliberate deviations from the spec (recorded):**
- The spec proposed a `TUN.player.shipClass` + dev-panel **dropdown**; this plan implements selection via a `?ship=manowar` **URL param + reload buttons** instead. Rationale: a runtime dropdown would require hot-swapping the live player `Ship` (rebuild body/visual/ocean-footprint/physics) — heavy and risky for a dev convenience. The URL-param approach reuses the proven `?at=harbor` pattern and the existing `button` control, achieving the same "select her" goal at near-zero risk. No `tunables.ts`/`devPanel.ts` changes are needed.
- The spec listed extracting `rasterizeShell`/`bulwarkFence`/`leakAudit` helpers. To keep regression risk to the tuned sloop/brig at zero, `buildManOfWar` is **self-contained** (inline, mirroring `buildBrig`); helper extraction is deferred as an optional later cleanup.

---

## Execution Notes

- Run one test file with `npx vitest run tests/<file>.test.ts`; the whole suite with `npm run test`.
- Keep the ~115 existing tests green at every commit (Tasks 1–3 each end on `npm run test`).
- The branch is `feat/ship-of-the-line`; PR-merge after Task 4.
