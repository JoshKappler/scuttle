# Ship-Core Perf + Buoyancy Decoupling (Round 12, Agent C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

Implement round-12 **SP4 (ship-core performance)** and **SP5 (buoyancy decoupling)** with **zero behavior change**:

1. **SP4-A** — cache the per-ship Gerstner buoyancy lattice in `game/ship.ts applyForces` across substeps (~15 Hz refresh) instead of rebuilding it every substep.
2. **SP4-B** — freeze the breach orifice **list** when no carve has touched the ship for ~0.5 s, and sample breach sea-heads by bilinear interpolation from the cached lattice instead of exact per-cell Gerstner inversions.
3. **SP4-C** — hull ocean-profile cache: **VERIFIED ALREADY IMPLEMENTED** (see Architecture — no code change; verification task only).
4. **SP4-D** — deck-collider dirty-chunk rebuild: **VERIFIED ALREADY IMPLEMENTED** (round 7 — no code change; verification task only).
5. **SP5** — factor `TUN.phys.buoyancy` out of the heave-damping stiffness so buoyancy and damping become independent knobs, preserving the current in-game response at `buoyancy = 1.5` exactly (guarded by a step-response characterization test written FIRST).
6. New **trim test** (ballast fore/aft → right-signed equilibrium pitch) and **heave step-response guard test**.
7. **CLAUDE.md** LAW #3 one-line fix + one line documenting the decoupling.
8. Perf validation via the in-game timing HUD (`DEBUG.world.timing`) before/after.

## Architecture

All findings below were verified against source at commit `3316ef4` (2026-07-01). **THE CODE WINS** — re-verify each anchor before editing; line numbers cited are pre-edit and will drift a few lines as earlier tasks land, so every task also gives a unique code-snippet anchor to search for.

### Verified current mechanisms

- **Buoyancy lattice (SP4-A target).** `src/game/ship.ts` `applyForces` (declared line 821). When a focus is set (game path only — `world.focus = sloop` in `src/main.ts:328/622`; **no test ever sets focus**), lines 871–903 build a world-snapped coarse lattice (`BUOY_FIELD_M = 2.5` m, LOD-widened by distance, constants at lines 111–113) by evaluating `surfaceHeight()` at every node **every substep**, into the reused scratch `private waveField = new Float64Array(0)` (line 257). Columns bilinear-read it (lines 913–921). Headless/oracle path (`focus` unset → `useField === false`) samples `surfaceHeight` exactly per column — bit-identical determinism.
- **Breach heads (SP4-B target).** `updateFlooding` (line 644) throttles `updateFloodGeom` + `rebuildBreachInputs` to every 6th substep (`geomTick`, lines 661–663) or the instant `breachListDirty` is set. `rebuildBreachInputs` (lines 707–752) fuses **membership** (which breach cells / hatches are orifices) with **head resolution** (one `localToWorld` + one exact `surfaceHeight` Gerstner inversion per orifice). `breachListDirty` is set by `registerBreaches` (line 1544), `plugBreach` (line 609) — but **NOT** by `updateCompartmentOpenness` (lines 1492–1517) when it flips a hold `open` (today the 10 Hz full rebuild masks that; the freeze must fix it). Last-carve tracking already exists: `carveCells` resets `this.framesSinceCarve = 0` (line 1184); `flushDamage` increments it every step (line 1394). Substep order in `src/game/world.ts:104–110`: `updateFlooding` runs **before** `applyForces`, so flood reads the lattice filled on a *previous* substep — the sampler must fall back to exact inversion when no valid fill exists (first step / headless).
- **SP4-C is already done.** `buildHullProfile` (`src/sim/buoyancy.ts:283–339`) has exactly two runtime call sites, both in `src/main.ts`: line 370 (`makeProfileTex`, startup + hull swap only) and line 1639 inside `shipProfile()` (lines 1630–1644) which is **cached** per Ship in a `WeakMap` (`profileCache`, line 393) with an O(1) damage signal (`grid.solidCount()` returns a maintained counter — `src/sim/voxelGrid.ts:86–88`) and a 0.4 s rebuild throttle (`REBUILD_INTERVAL`, line 1630). `render/ocean.ts` never calls `buildHullProfile`; its seam is `setHullProfile(slot: number, data: Float32Array, nx: number, nz: number, sizeX: number, sizeZ: number): void` (declared `ocean.ts:125`, implemented `ocean.ts:1130–1134`), invoked only on slot-change/damage restamp (`feedProfiled`, main.ts:1645–1653). The spec's "rescans the whole grid per ship per frame" is stale — the cutout task already added this cache (see the comment block at main.ts:1617–1630, which explicitly declined to touch `game/ship.ts`). **No edits to `sim/buoyancy.ts`, `render/ocean.ts`, or `main.ts` are needed or permitted for this item.**
- **SP4-D is already done.** `rebuildDeckCollider` (`src/game/ship.ts:515–563`) re-sweeps **only** first-build/dirty/missing chunks from `colliderChunkCache` + `colliderDirtyChunks` (fields 278–279), populated by `markColliderChunkDirty` (569–581, called from `carveCells` line 1175 and the sever shed line 1448), and is debounced (`COLLIDER_QUIET`/`COLLIDER_MAX_STALE`, lines 1392–1400). Player-only: `walkable` flag (constructor line 309, early-outs at 516 and 570); enemies pass `walkable=false` (`src/main.ts:486`). Round 7 in CLAUDE.md confirms. **No code change.**
- **SP5 formulas (verified).** Lift: `liftPerCell = ρ·g·V_cell·TUN.phys.buoyancy·(1−waterlog)` (line 840) ⇒ the sim's TRUE heave stiffness is `k_true = ρ·g·A_waterplane·buoyancy`. Damping (lines 996, 1064–1066): `this.heaveStiffness = ρ·g·waterplane·TUN.phys.buoyancy`; `cHeave = 2·√(max(heaveStiffness·mass, 1))`; `cArea = (TUN.phys.heaveDamp · cHeave · wet)/aSub` with `wet = min(sub·5, 1)` (line 1050). So **c = 2·ζ·√(ρ·g·A·buoyancy·m)·wet**, ζ = `heaveDamp` = 0.2. `heaveStiffness` is written at line 996 and read ONLY at line 1065 (verified by grep — nothing else in `src/` touches it).
  - **Derivation (the plan's required algebra).** Decoupled damping must not reference `TUN.phys.buoyancy` at all: `c_new = 2·ζ′·√(ρ·g·A·m)·wet`. Matching the shipped response at buoyancy = 1.5: `ζ′ = 0.2·√1.5 ≈ 0.2449489743`. Note the *suggested* alternative — an internal `√(TUN.phys.buoyancy)` factor at the damping site — is algebraically a **no-op refactor**: `2·ζ·√(b)·√(ρgA·m) ≡ 2·ζ·√(ρgA·b·m)`, i.e. it reproduces today's coupling exactly and does NOT make the knobs independent. Therefore the compensation **must** land in the `heaveDamp` default: `0.2 → 0.2·Math.sqrt(1.5)` — the ONE authorized `core/tunables.ts` exception, its own loud commit. (Physical meaning after the change: `heaveDamp` is ζ referenced to the PURE hydrostatic stiffness ρgA; the true damping *ratio* at buoyancy 1.5 remains 0.2; the absolute coefficient `c` is bit-preserved to ~1 ulp since `2·0.2·√(1.5km) ≡ 2·(0.2√1.5)·√(km)`.)
- **Oracle exposure (verified).** No test constructs a real `Ship`, `Physics`, or Rapier world. Grep of `tests/` for `from "../src/game/` shows only pure imports (`SeverDebounce` from `game/ship`, fakes in `world.test.ts`/`fleet.test.ts`/etc.); grep for `rapier|RAPIER|init(` matches only the fake in `world.test.ts:18`. `applyForces`/`updateFlooding`/`rebuildBreachInputs` have **zero** test coverage today, and the lattice path additionally requires `focus` (never set headless). So the caches cannot change any existing test outcome; new pure-unit coverage is added by extracting testable pieces (the established `SeverDebounce` pattern — `tests/severDebounce.test.ts` imports from `../src/game/ship`).
- **Trim/stability test harness (verified).** `tests/draft.test.ts`, `tests/stability.test.ts`, `tests/manOfWarFloat.test.ts` are **sim-only**: they build hulls via `sim/shipwright`, then do pure probe hydrostatics (`makeProbes` + `probeForce` + `submergedFraction` from `sim/buoyancy`, bisection for equilibrium) with no physics engine. The new trim test (F) follows this exact pattern. Bow = **+x** (forward vector `(1,0,0)`; rudder at "the stern post (low-x end)", ship.ts:493); materials `IRON = 3`, `OAK = 1` (`sim/materials.ts:3–5`, iron 7800 kg/m³ vs oak 430).
- **Timing HUD (verified).** `GameWorld.timing = { flood, buoy, fixed, contact, flush, rapier, visual, total, substeps }` (`src/game/world.ts:43`), exposed as `DEBUG.world.timing`; the on-screen HUD (main.ts:2038–2060) shows/hides with `TUN.gfx.auto.hud` (tunables.ts:373). Fleet size is live via `TUN.fleet.enemyCount` (reconciled each update, `src/game/fleet.ts:133`; `DEBUG.TUN` is exposed).

### Design of the changes

- **`WaveFieldCache`** (new exported class in `game/ship.ts`, pure — no Rapier/THREE): owns the lattice buffer + snapped window `(x0, z0, nx, nz, h)` + `filledT` (sim-time of last fill). `ensure()` refills **only** when the snapped window changed **or** the fill is older than `WAVE_FIELD_MAX_AGE_S = 4·FIXED_DT` (~66.7 ms ⇒ 15 Hz). Because the window is snapped to the world lattice, "moved/rotated past a threshold" falls out for free: the window is bit-identical until the posed hull AABB crosses a lattice cell (≥ 2.5 m at the finest LOD). **Staleness error bound:** physics swell is λ ≥ 14 m; the largest component (λ = 150 m, a = 1.5 m, ω = √(g·2π/λ) ≈ 0.64 rad/s) moves ≤ a·ω·Δt ≈ **6.4 cm** in 66.7 ms; the λ = 14 m component (a ≈ 0.07 m, ω ≈ 2.1) ≤ 1 cm. That is ≤ ¼ voxel of waterline error, refreshed periodically (a 1/15 s latency on the swell input, not a drift) — the same accepted basis as the existing 10 Hz flood-geometry throttle. `filledT = −Infinity` initially ⇒ **refresh-on-first-use**, so step-1 results are identical to today; sim-time comparison (not a step counter) makes gaps (focus toggles, ships added mid-run) safe and stays deterministic (no wall clock).
- **Breach split**: `rebuildBreachInputs` (membership+heads fused) becomes `rebuildOrifices()` (membership + ship-LOCAL orifice geometry, pooled) + `refreshBreachHeads()` (per-orifice `localToWorld` + **lattice sample with exact-inversion fallback** + head sign filter into the existing pooled `breachInputs`). Membership can only change via events that set `breachListDirty` (new holes, plank plugs, hold-open flips — the last one gets the missing dirty-set added); the mandated 0.5 s carve window (`framesSinceCarve < BREACH_FREEZE_QUIET = 30`) keeps membership refreshing on the geom tick while carving is active, as belt-and-suspenders. Heads keep the exact same ~10 Hz cadence as today, so flood behavior is preserved modulo the ≤ 7 cm sea-height sampling delta (negligible against √(2g·Δh) orifice heads that are typically ~1 m).
- **SP5**: extract `heaveDampingCoef(waterplaneArea, mass)` (pure, exported) in the guard task with today's exact formula; the decoupling task then changes only the inside of that function + the single tunable value. The write-only `heaveStiffness` field is deleted (verified only ship.ts:996/1065 reference it).

## Tech Stack

- TypeScript strict (`npm run build` = `tsc --noEmit && vite build`), vitest (`npm run test` = `vitest run`; ~431 tests / 55 files — **vitest does NOT type-check**).
- Three.js + `@dimforge/rapier3d-compat` in `game/` (not needed by any new test — all new tests are pure).
- Playwright (MCP browser tooling) + Vite dev server on **:5173** (strict port) for perf validation.
- Git, direct on `main`, push withheld (orchestrator pushes per wave).

## Global Constraints

- `npm run build` AND `npm run test` must pass before every commit (vitest does NOT type-check).
- Stage ONLY owned files via explicit `git add <paths>` (never `git add -A`/`.` — concurrent agents share this working dir).
- Do NOT push (orchestrator pushes per wave).
- Do NOT edit frozen files: `src/game/voxelContact.ts`, `src/sim/crush.ts`, `src/sim/carve.ts`, `src/sim/voxelOverlap.ts`, `src/render/shipVisual.ts`, `src/render/voxelMesher.ts`, `src/game/debris.ts`, `src/game/sailing.ts`, `src/main.ts`. `src/core/tunables.ts` is frozen EXCEPT the single `heaveDamp` default edit in Task 3 (the ONE authorized exception, its own loudly-labeled commit). Owned files: `src/game/ship.ts`, `src/sim/buoyancy.ts` (verified: no change needed — do not edit), `src/render/ocean.ts` (verified: no change needed — do not edit), `CLAUDE.md` (LAW #3 fix + one decoupling line ONLY), tests for these.
- sim/ purity (no game/render imports, no `Date.now`/`Math.random` — pooled/cached state must be deterministic and fully reset). The new caches live in `game/` and are sim-time/step-counted only.
- TUN is not read by the vitest oracle (tunables.ts header states it; the new game-layer guard test deliberately reads TUN — that is allowed, it is not oracle sim/ code).
- Brig/frigate symmetric tests can false-fail under CPU load — re-run isolated (`npx vitest run tests/<file>`) before declaring red.
- Never `checkout`/`reset`/`stash`/`rebase` in this shared worktree.

---

### Task 1: Baseline perf capture (timing HUD, BEFORE any code change)

**Files:** none (read-only; record numbers in the session scratchpad + final report).

**Interfaces** — Consumes: `window.DEBUG.world.timing` (`src/game/world.ts:43`), `window.DEBUG.TUN.fleet.enemyCount` (live, `src/game/fleet.ts:133`), `window.DEBUG.sloop` (live player Ship). Produces: baseline numbers `{buoy, flood, contact, flush, rapier, visual, total, substeps}` for (a) a healthy 5-enemy scene and (b) the same scene with the player hull holed.

- [ ] Confirm the working tree is at the unmodified round-12 base for the owned files: `git status --porcelain -- src/game/ship.ts src/sim/buoyancy.ts src/render/ocean.ts src/core/tunables.ts CLAUDE.md` → empty output. (Other agents' files may be dirty — ignore them.)
- [ ] Ensure the dev server is up: fetch `http://localhost:5173/__build`. If it fails, start `npm run dev` in the background and re-check. If it reports "Port 5173 is in use" another agent's server is already serving — use it.
- [ ] With browser tooling (Playwright MCP), navigate to `http://localhost:5173/?at=harbor`, take a snapshot, and click the **Sandbox** button on the start menu (the sim is frozen until a voyage starts — menu/pause gate `world.step`). Wait until the sea/ship render and the fps HUD shows.
- [ ] In the page, raise the fleet and wait for spawns:
```js
window.DEBUG.TUN.fleet.enemyCount = 5;
```
Poll `window.DEBUG.fleet.enemies.length` until it reaches 5 (~10–20 s).
- [ ] Run the sampler (300-frame average) and record the result as **baseline-healthy**:
```js
await new Promise((res) => {
  const t = window.DEBUG.world.timing;
  const acc = { buoy: 0, flood: 0, contact: 0, flush: 0, rapier: 0, visual: 0, total: 0, substeps: 0, frames: 0 };
  (function tick() {
    acc.buoy += t.buoy; acc.flood += t.flood; acc.contact += t.contact; acc.flush += t.flush;
    acc.rapier += t.rapier; acc.visual += t.visual; acc.total += t.total; acc.substeps += t.substeps;
    if (++acc.frames >= 300) {
      window.__perf = Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, k === "frames" ? v : v / acc.frames]));
      res();
    } else requestAnimationFrame(tick);
  })();
});
window.__perf;
```
- [ ] Hole the player hull below the waterline to exercise the flood/breach path, confirm water comes aboard, then re-run the sampler and record as **baseline-flooded**:
```js
const s = window.DEBUG.sloop, g = s.build.grid, [nx, , nz] = g.dims;
let cell = null;
outer: for (let y = 2; y < 8; y++)
  for (let x = Math.floor(nx * 0.35); x < Math.floor(nx * 0.65); x++)
    for (let z = 0; z < nz; z++)
      if (g.isSolid(x, y, z)) { cell = [x, y, z]; break outer; }
s.carve(cell, 5e5, null, 60);
```
Wait ~5 s, check `window.DEBUG.sloop.waterAboard() > 0` (if still 0, run the snippet again one voxel-row lower). Re-run the sampler → **baseline-flooded**.
- [ ] Also run the full suite once to pin the green baseline: `npm run test` (expect all pass; note the exact test count). Save both perf tables + test count to the scratchpad. No commit.

---

### Task 2: SP5 guard (G) — extract `heaveDampingCoef` + heave step-response characterization test

**Files:** `src/game/ship.ts` (anchor: `const cHeave = 2 * Math.sqrt(Math.max(this.heaveStiffness * mass, 1));`, pre-edit lines 264–265, 996, 1064–1066), `tests/heaveResponse.test.ts` (new).

**Interfaces** — Produces: `export function heaveDampingCoef(waterplaneArea: number, mass: number): number` in `src/game/ship.ts` (pure; reads `TUN.phys` — the same testable-pure-export pattern as `SeverDebounce`). Consumes: `WATER_DENSITY`, `G` (already imported in ship.ts), `TUN` (already imported).

- [ ] Verify the anchors: read `src/game/ship.ts` around lines 260–266 (field `private heaveStiffness = 0;` with its comment), line 996 (`this.heaveStiffness = WATER_DENSITY * G * waterplane * TUN.phys.buoyancy;`), lines 1064–1066 (the `cHeave`/`cArea` pair). Grep `heaveStiffness` across `src/` — expect matches ONLY in `src/game/ship.ts` (it is write-only outside the damping site).
- [ ] Add the pure function to `src/game/ship.ts`, at module scope directly after the `SeverDebounce` class (before the `BUOY_LOD_*` constants), preserving today's formula EXACTLY:
```ts
/** Heave/pitch/roll damping coefficient c (N·s/m) for the wet waterplane: c = 2·ζ·√(k·m) with the
 *  LIVE hydrostatic stiffness k. Pure + exported so the step-response guard can characterize the
 *  response without Rapier (tests/heaveResponse.test.ts — same pattern as SeverDebounce). The
 *  `wet` saturation and the per-area distribution over the waterplane moments stay at the call
 *  site in applyForces. */
export function heaveDampingCoef(waterplaneArea: number, mass: number): number {
  const k = WATER_DENSITY * G * waterplaneArea * TUN.phys.buoyancy; // the live heave stiffness
  return 2 * TUN.phys.heaveDamp * Math.sqrt(Math.max(k * mass, 1));
}
```
- [ ] Replace lines 1064–1066 (inside `applyForces`'s drag block — both `waterplane` and `mass` are in scope there):
```ts
      // cArea is calibrated so PURE heave equals the old critical-ratio 2·ζ·√(k·m)·vY.
      // (extracted to heaveDampingCoef — pure + unit-tested; see tests/heaveResponse.test.ts)
      const cHeave = heaveDampingCoef(waterplane, mass);
      const cArea = aSub > 1e-6 ? (cHeave * wet) / aSub : 0;
```
- [ ] Delete the now write-only field `private heaveStiffness = 0;` and its two-line doc comment (pre-edit lines 264–265), and delete its assignment line (pre-edit line 996: `this.heaveStiffness = WATER_DENSITY * G * waterplane * TUN.phys.buoyancy;` plus the single comment line above it, `// live hydrostatic heave stiffness for the critical-damping term in the drag block`). The stiffness now lives only inside `heaveDampingCoef`.
- [ ] Create `tests/heaveResponse.test.ts` — the characterization guard. It must pass BOTH before and after Task 3 (that is the whole point):
```ts
import { describe, it, expect } from "vitest";
import { heaveDampingCoef } from "../src/game/ship";
import { TUN } from "../src/core/tunables";
import { G, WATER_DENSITY, FIXED_DT } from "../src/core/constants";

// ROUND-12 SP5 GUARD. Characterizes the CURRENT heave response so the stiffness decoupling
// (factoring TUN.phys.buoyancy out of the damping pairing) provably does not change the feel.
// The 1-DOF model matches applyForces exactly for pure heave at full wetness (wet = 1):
//   m·z̈ = −k_true·z − c·ż,  k_true = ρ·g·A·TUN.phys.buoyancy  (the per-cell lift slope:
//   liftPerCell/VOXEL_SIZE per straddling column, summed = ρ·g·A_waterplane·buoyancy),
//   c = heaveDampingCoef(A, m)  (applyForces' cArea·(vY·aSub) term at wet = 1).
// Representative brig-scale numbers — the assertions are ratio/shape-based, so the exact
// scale only needs to be realistic.
const AREA = 120; // m² wet waterplane
const MASS = 5.2e5; // kg

function trueStiffness(area: number): number {
  return WATER_DENSITY * G * area * TUN.phys.buoyancy;
}

/** Drop from z0 above equilibrium, integrate semi-implicit Euler at the fixed step.
 *  Returns first-overshoot fraction and the 5% settle time. */
function stepResponse(k: number, c: number, m: number, z0 = 0.5) {
  let z = z0, v = 0, minZ = 0, settle = 0;
  for (let i = 0; i < 60 * 60; i++) {
    v += ((-k * z - c * v) / m) * FIXED_DT;
    z += v * FIXED_DT;
    const t = (i + 1) * FIXED_DT;
    if (z < minZ) minZ = z;
    if (Math.abs(z) > 0.05 * z0) settle = t;
  }
  return { overshoot: -minZ / z0, settle };
}

describe("heave step response (round-12 SP5 guard — must stay green through the decoupling)", () => {
  it("damping pairs with the TRUE sim stiffness at ζ = 0.2 (the shipped feel)", () => {
    const c = heaveDampingCoef(AREA, MASS);
    const zeta = c / (2 * Math.sqrt(trueStiffness(AREA) * MASS));
    expect(zeta).toBeGreaterThan(0.199);
    expect(zeta).toBeLessThan(0.201);
  });

  it("absolute coefficient is pinned to the shipped calibration (hardcoded on purpose)", () => {
    // Deliberately NOT read from TUN: 0.2 (ζ) and 1.5 (buoyancy) are the shipped round-11 feel.
    // If either knob or formula moves WITHOUT exact compensation, this fails.
    const shipped = 2 * 0.2 * Math.sqrt(WATER_DENSITY * G * AREA * 1.5 * MASS);
    expect(heaveDampingCoef(AREA, MASS) / shipped).toBeCloseTo(1, 3);
  });

  it("step response: ~52.7% first overshoot, 5% settle in ~6.5–9.5 s (ζ=0.2 signature)", () => {
    const r = stepResponse(trueStiffness(AREA), heaveDampingCoef(AREA, MASS), MASS);
    // ζ=0.2 theory: overshoot = e^(−πζ/√(1−ζ²)) ≈ 0.527; band tolerates dt=1/60 integration error.
    expect(r.overshoot).toBeGreaterThan(0.5);
    expect(r.overshoot).toBeLessThan(0.55);
    // envelope 5% time = ln(20)/(ζ·ωn) ≈ 8.0 s at ωn = √(k_true/m) ≈ 1.87 rad/s
    expect(r.settle).toBeGreaterThan(5.5);
    expect(r.settle).toBeLessThan(9.5);
  });
});
```
- [ ] Run: `npx vitest run tests/heaveResponse.test.ts` → expect **3 passed** (this is characterization, green immediately — if any band misses, STOP: recompute the band from the observed value using the ζ=0.2 theory above, do not paper over a formula mismatch).
- [ ] Run `npm run build` and `npm run test` → all green (existing count + 3).
- [ ] Commit:
```
git add src/game/ship.ts tests/heaveResponse.test.ts
git commit -m "test(buoyancy): characterize heave step response + extract heaveDampingCoef (round-12 SP5 guard)

Pure extraction, formula unchanged: c = 2*heaveDamp*sqrt(rho*g*A*buoyancy*m).
Deletes the now write-only Ship.heaveStiffness field. Guard pins zeta=0.2,
the absolute coefficient, and the step-response shape before the decoupling.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: SP5 (E) — decouple heave damping from the buoyancy multiplier

**Files:** `src/game/ship.ts` (the `heaveDampingCoef` body from Task 2), `src/core/tunables.ts` (**THE ONE FROZEN-FILE EXCEPTION** — single value + its doc comment, lines 30–36), `tests/heaveResponse.test.ts` (adds one independence test).

**Interfaces** — Produces: `heaveDampingCoef` no longer reads `TUN.phys.buoyancy`; `TUN.phys.heaveDamp` default becomes `0.2 * Math.sqrt(1.5)`. Consumers unchanged (`applyForces` call site; dev-panel slider `main.ts:1850` renders any value — no edit needed or allowed there).

- [ ] Change the body of `heaveDampingCoef` in `src/game/ship.ts` to:
```ts
/** Heave/pitch/roll damping coefficient c (N·s/m) for the wet waterplane: c = 2·ζ·√(k·m) with the
 *  PURE hydrostatic stiffness k = ρ·g·A_waterplane. ROUND-12 SP5: TUN.phys.buoyancy is deliberately
 *  NOT in here — lift keeps the ×buoyancy feel multiplier, damping no longer silently tracks it, so
 *  the two knobs are independent. TUN.phys.heaveDamp was recalibrated 0.2 → 0.2·√1.5 in the same
 *  change, so the shipped response at buoyancy = 1.5 is numerically identical:
 *  2·0.2·√(1.5·k·m) ≡ 2·(0.2·√1.5)·√(k·m). Pure + exported for the step-response guard
 *  (tests/heaveResponse.test.ts). `wet`/area distribution stays at the call site in applyForces. */
export function heaveDampingCoef(waterplaneArea: number, mass: number): number {
  const k = WATER_DENSITY * G * waterplaneArea;
  return 2 * TUN.phys.heaveDamp * Math.sqrt(Math.max(k * mass, 1));
}
```
- [ ] In `src/core/tunables.ts`, replace lines 30–36 (the `heaveDamp` doc comment + value; everything else in the file untouched):
```ts
    /** heave damping RATIO ζ, referenced to the PURE hydrostatic stiffness k = ρ·g·A_waterplane
     *  (round 12 SP5: the `buoyancy` multiplier is factored OUT of the damping pairing, so moving
     *  `buoyancy` no longer silently moves the damping coefficient). Per submerged column the hull
     *  resists vertical motion with c = 2·ζ·√(k·m), distributed over the waterplane so the SAME
     *  coefficient also damps pitch & roll (a bow plunging into a wave drags water = pitch damping).
     *  0.2·√1.5 ≈ 0.245 reproduces the shipped feel EXACTLY — the playtest's preferred 0.2 ("heave
     *  ... looks the best (and most intense) at the lowest setting of .2") was tuned against k×1.5,
     *  and 2·0.2·√(1.5·k·m) ≡ 2·(0.2·√1.5)·√(k·m). */
    heaveDamp: 0.2 * Math.sqrt(1.5),
```
- [ ] Append the independence test to `tests/heaveResponse.test.ts` (inside the existing `describe`):
```ts
  it("damping no longer moves with the buoyancy multiplier (the SP5 decoupling)", () => {
    const c0 = heaveDampingCoef(AREA, MASS);
    const saved = TUN.phys.buoyancy;
    try {
      TUN.phys.buoyancy = 1.0; // would have shifted c by √1.5 before round 12
      expect(heaveDampingCoef(AREA, MASS)).toBe(c0);
    } finally {
      TUN.phys.buoyancy = saved;
    }
  });
```
- [ ] Run `npx vitest run tests/heaveResponse.test.ts` → **4 passed**. The three Task-2 guards MUST pass untouched: ζ stays 0.2 (c/2√(k_true·m) = 0.2√1.5·√(km)/√(1.5km) = 0.2), the absolute pin matches to ~1 ulp, the response shape is identical.
- [ ] Run `npm run build` and `npm run test` → all green with UNCHANGED expectations (draft/stability/float tests are sim-only and never touch TUN — verified in Architecture).
- [ ] Commit (the loud tunables-exception commit — both files must land atomically or the guard test goes red in between):
```
git add src/game/ship.ts src/core/tunables.ts tests/heaveResponse.test.ts
git commit -m "feat(buoyancy)!: decouple heave damping from TUN.phys.buoyancy (round-12 SP5)

*** TUNABLES EXCEPTION (authorized, single value): core/tunables.ts heaveDamp
*** 0.2 -> 0.2*sqrt(1.5) (~0.245). Damping k is now the PURE rho*g*A waterplane
*** stiffness; the recalibrated default preserves the shipped response at
*** buoyancy=1.5 EXACTLY (2*0.2*sqrt(1.5km) == 2*(0.2*sqrt1.5)*sqrt(km)).
Atomic with the ship.ts formula change: splitting them would break the
step-response guard between commits. Guard: tests/heaveResponse.test.ts
(zeta pin, absolute-coefficient pin, step-response shape, independence).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Trim test (F) — ballast fore/aft ⇒ right-signed equilibrium pitch

**Files:** `tests/trim.test.ts` (new). No src changes.

**Interfaces** — Consumes: `buildBrig`/`ShipBuild` (`src/sim/shipwright.ts:756/17`), `makeProbes`/`probeForce`/`submergedFraction`/`Probe` (`src/sim/buoyancy.ts`), `IRON`/`OAK` (`src/sim/materials.ts:3–5`), `grid.forEachSolid`/`grid.set` (`src/sim/voxelGrid.ts` interface lines 15/27), `G` (`src/core/constants.ts`). Same pure-hydrostatics harness as `tests/stability.test.ts`/`tests/manOfWarFloat.test.ts` (verified sim-only — no Rapier).

- [ ] Create `tests/trim.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { buildBrig, type ShipBuild } from "../src/sim/shipwright";
import { makeProbes, probeForce, submergedFraction, type Probe } from "../src/sim/buoyancy";
import { IRON, OAK } from "../src/sim/materials";
import { G } from "../src/core/constants";

/**
 * FORE-AFT TRIM (round 12 SP5 — closes the known oracle blind spot): shifting ballast
 * fore/aft must produce a right-signed, sensible equilibrium pitch. Pure probe hydrostatics
 * (same harness as stability.test.ts / manOfWarFloat.test.ts — no physics engine).
 * Conventions: bow = +x (rudder hangs off the low-x stern post); pitch is rotation about the
 * world z-axis, POSITIVE = bow-UP ((lx,ly) → (lx·c − ly·s, lx·s + ly·c) lifts +x for s > 0).
 */
function hydro(probes: Probe[], com: [number, number, number], pitch: number, comY: number) {
  let force = 0, torqueZ = 0;
  const c = Math.cos(pitch), s = Math.sin(pitch);
  for (const p of probes) {
    const lx = p.local[0] - com[0];
    const ly = p.local[1] - com[1];
    const wy = comY + lx * s + ly * c;
    const f = probeForce(p, wy, 0, 0); // flat water at y = 0
    force += f;
    // force acts at the centroid of the SUBMERGED segment (stability.test.ts invariant)
    const sub = submergedFraction(p, wy, 0);
    const lyApp = ly + (sub * p.height) / 2;
    const wxApp = lx * c - lyApp * s;
    torqueZ += wxApp * f; // τ = r × F, F vertical: τz = +rx·Fy — τz > 0 lifts the bow
  }
  return { force, torqueZ };
}

function equilibriumY(probes: Probe[], com: [number, number, number], mass: number, pitch: number): number {
  let lo = -5, hi = 5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (hydro(probes, com, pitch, mid).force > mass * G) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Longitudinal righting is restoring (huge waterplane I about z), so τz decreases with pitch:
 *  bisect for the zero crossing, re-floating at each candidate pitch. */
function equilibriumPitch(probes: Probe[], com: [number, number, number], mass: number): number {
  let lo = -0.2, hi = 0.2; // rad (±11.5° — far beyond any sane brig trim)
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const y = equilibriumY(probes, com, mass, mid);
    if (hydro(probes, com, mid, y).torqueZ > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Move ballast by material swap, mass-conserving (mirrors shipwright.lowerBallast's approach):
 *  the K aft-most IRON cells become OAK and the K fore-most OAK cells at/below the ballast band
 *  become IRON (forward = true), or mirrored. Geometry (solidity) is untouched, so the probes
 *  stay valid — only mass and COM move: exactly "shifting ballast". */
function shiftBallast(build: ShipBuild, k: number, forward: boolean): void {
  const iron: [number, number, number][] = [];
  let ironTopY = 0;
  build.grid.forEachSolid((x, y, z, mat) => {
    if (mat === IRON) { iron.push([x, y, z]); if (y > ironTopY) ironTopY = y; }
  });
  const oak: [number, number, number][] = [];
  build.grid.forEachSolid((x, y, z, mat) => {
    if (mat === OAK && y <= ironTopY) oak.push([x, y, z]);
  });
  expect(iron.length).toBeGreaterThanOrEqual(2 * k); // the brig must carry real iron ballast
  expect(oak.length).toBeGreaterThanOrEqual(2 * k);  // ...and real oak in the bilge band
  const byXyz = (a: [number, number, number], b: [number, number, number]) =>
    a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  iron.sort(byXyz);
  oak.sort(byXyz);
  const donors = forward ? iron.slice(0, k) : iron.slice(-k);      // iron leaves the far end
  const receivers = forward ? oak.slice(-k) : oak.slice(0, k);     // iron arrives at the near end
  for (const [x, y, z] of donors) build.grid.set(x, y, z, OAK);
  for (const [x, y, z] of receivers) build.grid.set(x, y, z, IRON);
}

const K = 120; // cells swapped ≈ 120·(7800−430)·0.25³ ≈ 13.8 t of ballast moved fore/aft

describe("fore-aft trim equilibrium (round-12 SP5 — the oracle blind spot)", () => {
  it("the stock brig floats near even keel", () => {
    const build = buildBrig();
    const probes = makeProbes(build.grid, build.compartments);
    const pitch0 = equilibriumPitch(probes, build.grid.centerOfMass(), build.grid.totalMass());
    expect(Math.abs((pitch0 * 180) / Math.PI)).toBeLessThan(1.0);
  });

  it("ballast shifted FORWARD → bow-DOWN equilibrium pitch of sensible magnitude", () => {
    const build = buildBrig();
    const probes = makeProbes(build.grid, build.compartments);
    const m0 = build.grid.totalMass();
    const pitch0 = equilibriumPitch(probes, build.grid.centerOfMass(), m0);
    shiftBallast(build, K, true);
    expect(build.grid.totalMass()).toBeCloseTo(m0, 3); // the swap is mass-conserving
    const pitchF = equilibriumPitch(probes, build.grid.centerOfMass(), build.grid.totalMass());
    const dDeg = ((pitchF - pitch0) * 180) / Math.PI;
    expect(dDeg).toBeLessThan(-0.1); // right SIGN: nose goes DOWN
    expect(dDeg).toBeGreaterThan(-8); // sensible MAGNITUDE (est. ~−0.8° for ~14 t over ~15 m)
  });

  it("ballast shifted AFT → bow-UP, mirrored sign", () => {
    const build = buildBrig();
    const probes = makeProbes(build.grid, build.compartments);
    const m0 = build.grid.totalMass();
    const pitch0 = equilibriumPitch(probes, build.grid.centerOfMass(), m0);
    shiftBallast(build, K, false);
    expect(build.grid.totalMass()).toBeCloseTo(m0, 3);
    const pitchA = equilibriumPitch(probes, build.grid.centerOfMass(), build.grid.totalMass());
    const dDeg = ((pitchA - pitch0) * 180) / Math.PI;
    expect(dDeg).toBeGreaterThan(0.1);
    expect(dDeg).toBeLessThan(8);
  });
});
```
- [ ] Run: `npx vitest run tests/trim.test.ts` → expect **3 passed**. Contingency (this closes a real blind spot, so a failure is a FINDING, not a test bug): if the stock-brig baseline exceeds 1.0°, print the observed value, widen ONLY the baseline band to observed + 0.5° with a comment documenting the current stock trim, and report it; if a SIGN assertion fails, STOP and debug the convention (check `hydro`'s τz sign against a hand case: a single probe forward of COM with f > 0 must give τz > 0) — do not flip assertions to match without understanding.
- [ ] Run `npm run build` and `npm run test` → all green.
- [ ] Commit:
```
git add tests/trim.test.ts
git commit -m "test(buoyancy): fore-aft trim equilibrium test (round-12 SP5 F - closes the oracle blind spot)

Pure probe-hydrostatics harness (same as stability/manOfWarFloat): mass-conserving
iron<->oak bilge swap shifts ~14t of ballast fore/aft; equilibrium pitch must be
right-signed (forward => bow-down) and sensible (0.1..8 deg) both ways.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: SP4-A — cache the buoyancy wave-field lattice across substeps

**Files:** `src/game/ship.ts` (anchors: `const BUOY_FIELD_M = 2.5;` ~line 113; field `private waveField = new Float64Array(0);` ~line 257; the `if (useField) { ... }` block in `applyForces` — search for `// world XZ AABB that bounds EVERY column centre`; the bilinear read — search for `const u = (wx - fX0) * invH`), `tests/waveFieldCache.test.ts` (new).

**Interfaces** — Produces: `export class WaveFieldCache` + `export const WAVE_FIELD_MAX_AGE_S` in `src/game/ship.ts` (pure — testable without Rapier); private `Ship.waveCache: WaveFieldCache` (consumed by Task 6's breach sampler). Consumes: `surfaceHeight`, `Wave` (already imported), `FIXED_DT` (**add to the constants import**, line 3).

- [ ] Verify the anchors: read `applyForces` (pre-edit lines 866–924) and confirm the fill loop + bilinear read match the Architecture description. Grep `waveField` in `src/` — expect only `src/game/ship.ts` (field decl + fill + read).
- [ ] Add `FIXED_DT` to the constants import at the top of `src/game/ship.ts`:
```ts
import { CHUNK_SIZE, FIXED_DT, G, MAX_CARVE_CELLS, VOXEL_SIZE, VOXEL_VOLUME, WATER_DENSITY } from "../core/constants";
```
- [ ] Write the failing test FIRST — create `tests/waveFieldCache.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { WaveFieldCache, WAVE_FIELD_MAX_AGE_S } from "../src/game/ship";
import { makeWaves, physicsWaves, surfaceHeight } from "../src/sim/gerstner";
import { Rng } from "../src/core/rng";
import { FIXED_DT } from "../src/core/constants";

// ROUND-12 SP4-A: the per-ship buoyancy lattice is cached across substeps. These tests pin the
// cache CONTRACT: (1) sampling accuracy vs the exact inversion is the same as the SHIPPED inline
// lattice (bilinear on a 2.5 m grid over the λ≥14 m swell — the cache changes WHEN it fills, not
// HOW it interpolates); (2) refill triggers: first use, window move past a lattice cell, max age
// (~15 Hz); (3) reuse otherwise (this is the perf win); (4) refresh-on-first-use ⇒ step-1 identical.
const waves = physicsWaves(makeWaves(new Rng("sea"), 16));

describe("WaveFieldCache (round-12 SP4-A)", () => {
  it("bilinear sample tracks the exact Gerstner inversion (shipped-lattice accuracy)", () => {
    const c = new WaveFieldCache();
    c.ensure(waves, 3.7, -30, -20, 30, 20, 2.5);
    for (let i = 0; i < 200; i++) {
      const wx = -28 + (i % 20) * 2.9;
      const wz = -18 + Math.floor(i / 20) * 3.6;
      const exact = surfaceHeight(waves, wx, wz, 3.7);
      expect(Math.abs(c.sample(wx, wz) - exact)).toBeLessThan(0.1);
    }
  });

  it("lattice nodes are EXACT samples at the fill time", () => {
    const c = new WaveFieldCache();
    c.ensure(waves, 0, -10, -10, 10, 10, 2.5);
    expect(c.sample(c.x0, c.z0)).toBeCloseTo(surfaceHeight(waves, c.x0, c.z0, 0), 12);
    expect(c.sample(c.x0 + 2.5, c.z0 + 2.5)).toBeCloseTo(surfaceHeight(waves, c.x0 + 2.5, c.z0 + 2.5, 0), 12);
  });

  it("reuses the fill while the snapped window is unchanged and younger than the max age", () => {
    const c = new WaveFieldCache();
    c.ensure(waves, 0, -10, -10, 10, 10, 2.5);
    const t0 = c.filledT;
    c.ensure(waves, FIXED_DT, -10, -10, 10, 10, 2.5); // next substep, same window
    c.ensure(waves, 3 * FIXED_DT, -9.9, -9.9, 9.9, 9.9, 2.5); // small drift, SAME snapped window
    expect(c.filledT).toBe(t0); // cache hit — never refilled
  });

  it("refills at the max age (~15 Hz) and on a window shift past a lattice cell", () => {
    const c = new WaveFieldCache();
    c.ensure(waves, 0, -10, -10, 10, 10, 2.5);
    c.ensure(waves, WAVE_FIELD_MAX_AGE_S, -10, -10, 10, 10, 2.5); // age hit → refill
    expect(c.filledT).toBe(WAVE_FIELD_MAX_AGE_S);
    c.ensure(waves, WAVE_FIELD_MAX_AGE_S + FIXED_DT, -13, -10, 7, 10, 2.5); // moved ≥ a cell → refill
    expect(c.filledT).toBe(WAVE_FIELD_MAX_AGE_S + FIXED_DT);
  });

  it("first use always fills; invalid before (breach sampler falls back to exact then)", () => {
    const c = new WaveFieldCache();
    expect(c.valid(0)).toBe(false);
    c.ensure(waves, 0, -10, -10, 10, 10, 2.5);
    expect(c.valid(0)).toBe(true);
    expect(c.valid(WAVE_FIELD_MAX_AGE_S + 1)).toBe(false); // a long-stale fill is not trusted
  });
});
```
Run `npx vitest run tests/waveFieldCache.test.ts` → **fails** (no export `WaveFieldCache`).
- [ ] Implement in `src/game/ship.ts`, directly after the `BUOY_FIELD_M` constant (module scope, before `class Ship`):
```ts
/** Substep-cache lifetime of the buoyancy wave lattice (s) — ~15 Hz refresh (round 12 SP4-A).
 *  Error bound of serving a stale fill: the physics swell is band-limited to λ≥14 m; its largest
 *  component (λ=150 m, a=1.5 m, ω≈0.64 rad/s) moves ≤ a·ω·Δt ≈ 6.4 cm in 66.7 ms, the λ=14 m
 *  component ≤ ~1 cm — ≤ ¼ voxel of waterline, refreshed every 4 substeps so it is a 1/15 s
 *  LATENCY on the swell input, never a drift (same basis as the 10 Hz flood-geometry throttle).
 *  Sim-time (not wall-clock) so it stays deterministic and gap-safe. */
export const WAVE_FIELD_MAX_AGE_S = 4 * FIXED_DT;

/** The per-ship coarse Gerstner lattice, CACHED across substeps (round 12 SP4-A). Previously the
 *  lattice was refilled — one surfaceHeight (~40-trig inversion) per node — EVERY substep per ship;
 *  now it refills only when the SNAPPED window moves or the fill exceeds WAVE_FIELD_MAX_AGE_S.
 *  Because the window is snapped to the world lattice, the movement/rotation threshold falls out of
 *  the snapping: the window is bit-identical until the posed hull AABB drifts past a lattice cell
 *  (≥ h ≈ 2.5 m at the finest LOD). filledT = −Infinity ⇒ refresh-on-FIRST-use, so step-1 results
 *  are identical to the uncached path. Pure (no Rapier/THREE) — unit-tested in
 *  tests/waveFieldCache.test.ts, same pattern as SeverDebounce. */
export class WaveFieldCache {
  field = new Float64Array(0);
  x0 = 0;
  z0 = 0;
  nx = 0;
  nz = 0;
  h = BUOY_FIELD_M;
  /** sim-time of the last fill; −Infinity = never filled. */
  filledT = -Infinity;

  /** Guarantee a usable fill covering [minX..maxX]×[minZ..maxZ] at spacing h for sim-time t.
   *  Window snapping + margins are IDENTICAL to the old inline fill (origin −h, count +2). */
  ensure(waves: Wave[], t: number, minX: number, minZ: number, maxX: number, maxZ: number, h: number): void {
    const x0 = Math.floor(minX / h) * h - h;
    const z0 = Math.floor(minZ / h) * h - h;
    const nx = Math.ceil((maxX - x0) / h) + 2;
    const nz = Math.ceil((maxZ - z0) / h) + 2;
    if (
      x0 === this.x0 && z0 === this.z0 && nx === this.nx && nz === this.nz && h === this.h &&
      t - this.filledT < WAVE_FIELD_MAX_AGE_S
    ) {
      return; // cache hit: same snapped window, samples fresh enough
    }
    this.x0 = x0; this.z0 = z0; this.nx = nx; this.nz = nz; this.h = h;
    const need = nx * nz;
    if (this.field.length < need) this.field = new Float64Array(need);
    const f = this.field;
    for (let iz = 0; iz < nz; iz++) {
      const zc = z0 + iz * h;
      const row = iz * nx;
      for (let ix = 0; ix < nx; ix++) f[row + ix] = surfaceHeight(waves, x0 + ix * h, zc, t);
    }
    this.filledT = t;
  }

  /** Is there a fill trustworthy for sim-time t? (false ⇒ callers fall back to the exact
   *  inversion — the headless/oracle path and the very first flood step of a run). */
  valid(t: number): boolean {
    return this.nx >= 2 && this.nz >= 2 && t - this.filledT <= WAVE_FIELD_MAX_AGE_S + 1e-9;
  }

  /** Bilinear read; indices clamped at the window edge exactly like the old inline read. */
  sample(wx: number, wz: number): number {
    const invH = 1 / this.h;
    const u = (wx - this.x0) * invH;
    const v = (wz - this.z0) * invH;
    let iu = u | 0;
    if (iu < 0) iu = 0; else if (iu > this.nx - 2) iu = this.nx - 2;
    let iv = v | 0;
    if (iv < 0) iv = 0; else if (iv > this.nz - 2) iv = this.nz - 2;
    const fu = u - iu;
    const fv = v - iv;
    const f = this.field;
    const b = iv * this.nx + iu;
    const h0 = f[b] + (f[b + 1] - f[b]) * fu;
    const h1 = f[b + this.nx] + (f[b + this.nx + 1] - f[b + this.nx]) * fu;
    return h0 + (h1 - h0) * fv;
  }
}
```
- [ ] Replace the `waveField` field on `Ship` (pre-edit lines 255–257) with:
```ts
  /** Coarse buoyancy wave lattice, CACHED across substeps (round 12 SP4-A) — refilled only on a
   *  snapped-window move or at WAVE_FIELD_MAX_AGE_S (~15 Hz). Also read by the breach-head sampler
   *  (SP4-B) with an exact-inversion fallback when invalid. See WaveFieldCache. */
  private readonly waveCache = new WaveFieldCache();
```
- [ ] In `applyForces`, replace the fill block (everything from `const useField = focusX !== undefined && focusZ !== undefined;` down to and including `const invH = 1 / fH;` — pre-edit lines 871–904) with:
```ts
    const useField = focusX !== undefined && focusZ !== undefined;
    if (useField) {
      // world XZ AABB that bounds EVERY column centre: transform the 8 corners of the local grid
      // envelope (every column lies inside it). The cache snaps the origin to the world lattice so
      // sample points are stable frame-to-frame (no temporal popping as she moves).
      const [gnx, gny, gnz] = this.build.grid.dims;
      const ex = gnx * VOXEL_SIZE, ey = gny * VOXEL_SIZE, ez = gnz * VOXEL_SIZE;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (let i = 0; i < 8; i++) {
        this.tmpV.set(i & 1 ? ex : 0, i & 2 ? ey : 0, i & 4 ? ez : 0).applyQuaternion(this.tmpQ);
        const cx = this.tmpV.x + tr.x, cz = this.tmpV.z + tr.z;
        if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
        if (cz < minZ) minZ = cz; if (cz > maxZ) maxZ = cz;
      }
      // a far ship's swell can be coarser still (it's tiny on screen) — fold the old distance LOD
      // into the lattice spacing rather than a separate reuse cache.
      const fdx = tr.x - focusX!, fdz = tr.z - focusZ!;
      const fd2 = fdx * fdx + fdz * fdz;
      const fH = fd2 > BUOY_LOD_FAR2 ? BUOY_FIELD_M * 2.4 : fd2 > BUOY_LOD_NEAR2 ? BUOY_FIELD_M * 1.6 : BUOY_FIELD_M;
      // ROUND 12 SP4-A: refill only on a snapped-window move / at ~15 Hz — not every substep.
      this.waveCache.ensure(waves, t, minX, minZ, maxX, maxZ, fH);
    }
```
- [ ] In the column loop, replace the inline bilinear read (pre-edit lines 911–924, the `if (useField) { ... } else { ... }` around `surfaceY`) with:
```ts
      // bilinear read off the cached coarse lattice (game), or an EXACT inversion (headless/oracle).
      const surfaceY = useField ? this.waveCache.sample(wx, wz) : surfaceHeight(waves, wx, wz, t);
```
(`surfaceY` was previously `let` + assigned in branches; it becomes a `const`. Delete the now-unused locals `fX0/fZ0/fNX/fNZ/fH/invH` and the old fill loop — after this edit, grep `fX0` in ship.ts must return nothing.)
- [ ] Extend the comment block above `BUOY_LOD_NEAR2` (pre-edit lines 102–110) by appending one line at its end: ` The lattice is additionally CACHED across substeps (round 12 SP4-A — see WaveFieldCache/WAVE_FIELD_MAX_AGE_S).`
- [ ] Run `npx vitest run tests/waveFieldCache.test.ts` → **5 passed**. Run `npm run build` and `npm run test` → all green (the oracle never sets `focus`, and first-use refill makes the game path's step-1 identical).
- [ ] Commit:
```
git add src/game/ship.ts tests/waveFieldCache.test.ts
git commit -m "perf(ship): cache the buoyancy wave-field lattice across substeps (round-12 SP4-A)

WaveFieldCache: refill only when the world-snapped window moves (>= one 2.5 m
lattice cell of hull drift/rotation) or the fill exceeds 4*FIXED_DT (~15 Hz).
Stale-field error <= ~6.4 cm on the lambda>=14 m swell (1/15 s latency, no drift).
Refresh-on-first-use => step-1 identical; oracle path (no focus) untouched.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: SP4-B — freeze the breach orifice list + sample sea-heads from the cached lattice

**Files:** `src/game/ship.ts` only. Anchors: `if (geomTick || this.breachListDirty) this.rebuildBreachInputs(waves, t);` (in `updateFlooding`), `private rebuildBreachInputs(waves: Wave[], t: number)` (pre-edit lines 707–752), `private pushBreach(` (754–761), `c.open = true;` in `updateCompartmentOpenness` (~1508), field comment above `private breachInputs` (239–251).

**Interfaces** — Consumes: `Ship.waveCache` (Task 5), `Ship.framesSinceCarve` (existing carve hook: reset in `carveCells` line 1184, incremented in `flushDamage` line 1394), `Ship.breachListDirty` (existing), `floodGeom` poolY, `BreachInput` (from `sim/compartments`). Produces: `export const BREACH_FREEZE_QUIET = 30`, private `rebuildOrifices()` + `refreshBreachHeads()` replacing `rebuildBreachInputs()`; a bug-fix dirty-set in `updateCompartmentOpenness`.

- [ ] Verify the anchors above, and verify no caller of `rebuildBreachInputs` exists other than the one line in `updateFlooding` (grep `rebuildBreachInputs` — 1 call + 1 decl).
- [ ] Add at module scope (next to `SEVER_QUIET`, ~line 65):
```ts
/** Steps of no-carving (~0.5 s) after which the breach ORIFICE LIST is FROZEN (round 12 SP4-B):
 *  membership then rebuilds only on an explicit breachListDirty event (a new hole, a plugged
 *  plank, a hold flipping open). While carving is active the list also refreshes on every ~10 Hz
 *  flood-geom tick, as belt-and-suspenders. Heads (sea/pool levels) keep the 10 Hz cadence always. */
export const BREACH_FREEZE_QUIET = 30;
```
- [ ] Add the orifice-geometry type + pooled fields on `Ship` (directly below the existing `breachPool` field, pre-edit line 250):
```ts
  /** FROZEN orifice geometry (round 12 SP4-B): each breach cell / hatch as ship-LOCAL centre metres
   *  + area + head offset, rebuilt by rebuildOrifices ONLY when the breach set changes (or on the
   *  geom tick within BREACH_FREEZE_QUIET steps of a carve). refreshBreachHeads re-resolves the
   *  cheap per-orifice heads (localToWorld + a lattice sample) from this list at ~10 Hz — replacing
   *  the fused rebuild that re-ran an exact Gerstner inversion per cell forever while flooded. */
  private orificeList: { compartmentId: number; area: number; lx: number; ly: number; lz: number; dy: number }[] = [];
  private orificePool: { compartmentId: number; area: number; lx: number; ly: number; lz: number; dy: number }[] = [];
```
- [ ] Replace the whole `rebuildBreachInputs` method (pre-edit lines 698–752, INCLUDING its doc comment) with the two methods below (keep `pushBreach` as is):
```ts
  /** Rebuild the FROZEN orifice list: which breach cells / hatches exist, their ship-local centres,
   *  raw areas and head offsets (dy = the raised hatch coaming; 0 for a hull hole). Runs only when
   *  the breach set can have changed (breachListDirty: registerBreaches / plugBreach / a hold
   *  flipping open) or on the geom tick while carving is active (< BREACH_FREEZE_QUIET steps).
   *  TUN.flood.inflowScale is applied at head-refresh time so the dev-panel knob stays live at the
   *  same ~10 Hz it always had. Pooled — a sustained flood allocates nothing. */
  private rebuildOrifices(): void {
    const list = this.orificeList;
    list.length = 0;
    const push = (compartmentId: number, area: number, lx: number, ly: number, lz: number, dy: number) => {
      const i = list.length;
      let o = this.orificePool[i];
      if (o) { o.compartmentId = compartmentId; o.area = area; o.lx = lx; o.ly = ly; o.lz = lz; o.dy = dy; }
      else { o = { compartmentId, area, lx, ly, lz, dy }; this.orificePool[i] = o; }
      list.push(o);
    };
    const COAMING = 0.55; // m — raised hatch lip, so deck wash doesn't flood an undamaged hold
    for (const c of this.build.compartments) {
      if (c.open) continue; // a torn-open hold is part of the sea — no inflow, it stays drained
      // each hull hole is its own orifice (a low hole floods while a high one on the same
      // compartment drains). Per-CELL area → total inflow scales with the punctured cell COUNT.
      const cells = this.breachCells.get(c.id);
      if (cells) {
        for (const [x, y, z] of cells) {
          push(c.id, VOXEL_SIZE * VOXEL_SIZE, (x + 0.5) * VOXEL_SIZE, (y + 0.5) * VOXEL_SIZE, (z + 0.5) * VOXEL_SIZE, 0);
        }
      }
      // deck hatch: an orifice at the coaming lip. Two-way for free — floods in over the coaming,
      // drains out the same lip once she's rolled far enough.
      if (c.hatchArea > 0) {
        const hx = (c.bboxMin[0] + c.bboxMax[0]) / 2;
        push(
          c.id,
          c.hatchArea,
          (hx + 0.5) * VOXEL_SIZE,
          (this.build.deckY + 0.5) * VOXEL_SIZE,
          (this.build.grid.dims[2] / 2) * VOXEL_SIZE,
          COAMING,
        );
      }
    }
    this.breachListDirty = false;
  }

  /** Re-resolve every frozen orifice into its two-reservoir head and repack the pooled
   *  `breachInputs` (only orifices with a positive head are ACTIVE — same filter the old fused
   *  rebuild applied). The sea level comes from the SP4-A lattice (bilinear, ~10 flops) instead of
   *  an exact ~40-trig Gerstner inversion per cell; falls back to the exact inversion when no valid
   *  fill exists (headless/oracle, or the first substep of a run — flood runs before applyForces).
   *  Same ~10 Hz cadence as before, so flood behaviour is preserved. */
  private refreshBreachHeads(waves: Wave[], t: number): void {
    this.breachInputs.length = 0;
    const p = this.tmpV;
    const scale = TUN.flood.inflowScale;
    const useCache = this.waveCache.valid(t);
    let lastComp = -1;
    let poolY = -Infinity;
    for (const o of this.orificeList) {
      if (o.compartmentId !== lastComp) {
        lastComp = o.compartmentId;
        poolY = this.floodGeom.get(o.compartmentId)?.poolY ?? -Infinity;
      }
      this.localToWorld([o.lx, o.ly, o.lz], p);
      const holeY = p.y + o.dy;
      const sea = useCache ? this.waveCache.sample(p.x, p.z) : surfaceHeight(waves, p.x, p.z, t);
      const extHead = sea - holeY; // sea above the hole drives IN
      const intHead = poolY - holeY; // pool above the hole drives OUT
      if (extHead > 0 || intHead > 0) this.pushBreach(o.compartmentId, o.area * scale, extHead, intHead);
    }
  }
```
- [ ] In `updateFlooding`, replace the single line `if (geomTick || this.breachListDirty) this.rebuildBreachInputs(waves, t);` with:
```ts
    // SP4-B: the orifice LIST is FROZEN once carving has been quiet ~0.5 s — membership can only
    // change via events that set breachListDirty. While carving is active it also refreshes on the
    // geom tick (belt-and-suspenders). HEADS keep the same ~10 Hz cadence as always, sampling the
    // sea from the SP4-A lattice instead of exact per-cell inversions.
    const listStale = this.breachListDirty || (geomTick && this.framesSinceCarve < BREACH_FREEZE_QUIET);
    if (listStale) this.rebuildOrifices();
    if (geomTick || listStale) this.refreshBreachHeads(waves, t);
```
- [ ] Bug-fix required by the freeze: in `updateCompartmentOpenness`, immediately after `c.open = true; c.waterVolume = 0;` add:
```ts
      this.breachListDirty = true; // the orifice set changed (an open hold's holes leave it) — unfreeze
```
(Today the unconditional 10 Hz membership rebuild masked this; with the frozen list the flip must dirty it explicitly.)
- [ ] Trim the stale references in the `breachInputs` field doc comment (pre-edit lines 239–251): replace the sentence beginning `The BreachInput objects are pooled (rebuilt in place)` through the end of that comment with: `Round 12 SP4-B split this into a FROZEN orifice list (rebuildOrifices — membership + local geometry, rebuilt only on breachListDirty / during active carving) and a ~10 Hz head refresh (refreshBreachHeads — lattice-sampled sea heads). Deterministic: step-counted + sim-time only.`
- [ ] Grep `rebuildBreachInputs` — expect zero matches. Run `npm run build` and `npm run test` → all green (no oracle coverage of this path — verified; `floodStep`/`compartments` tests are sim-only and untouched).
- [ ] Commit:
```
git add src/game/ship.ts
git commit -m "perf(ship): freeze the breach orifice list + lattice-sampled sea heads (round-12 SP4-B)

Membership (which cells/hatches are orifices) now rebuilds only on breachListDirty
(new hole / plug / hold-open flip - the open flip now sets the flag, previously
masked by the unconditional 10 Hz rebuild) or while carving is active
(< BREACH_FREEZE_QUIET = 30 steps since last carve). Heads keep the ~10 Hz cadence
but read the SP4-A lattice (bilinear) instead of an exact ~40-trig Gerstner
inversion per cell, with exact fallback when no valid fill exists (oracle path).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: SP4-C — hull ocean-profile cache: VERIFY (no code change)

**Files:** none (read-only verification; findings go in the final report).

**Interfaces** — the profile seam is **already**: `main.ts shipProfile()` (WeakMap `profileCache` + `profMeta`, damage-signalled by O(1) `grid.solidCount()`, throttled `REBUILD_INTERVAL = 0.4 s`) → `ocean.setHullProfile(slot: number, data: Float32Array, nx: number, nz: number, sizeX: number, sizeZ: number): void` (`render/ocean.ts:125/1130`) on slot-change/damage only. No new accessor is added: `main.ts` is frozen, so a Ship-side cache would have no consumer this wave (dead code), and the existing cache already eliminates the per-frame rescan the audit targeted.

- [ ] Grep `buildHullProfile` across `src/` — expect exactly: `src/main.ts:12` (import), `:370` (startup/hull-swap `makeProfileTex`), `:393` (WeakMap type), `:1639` (inside the cached `shipProfile`), plus the definition in `src/sim/buoyancy.ts` and a comment in `render/dynamicWaves.ts`. No call in `render/ocean.ts`.
- [ ] Read `src/main.ts:1617–1653` and confirm: rebuild only when `solids < meta.solids` (damage) and ≥ 0.4 s since the last build; atlas restamp (`setHullProfile`) only when the slot's ship changed or the profile was rebuilt. Read `src/sim/voxelGrid.ts:86–88` and confirm `solidCount()` returns a maintained counter (O(1)).
- [ ] Record in the final report: "SP4-C verified already implemented (cutout task); no per-frame `buildHullProfile` call exists; no change made; `sim/buoyancy.ts` and `render/ocean.ts` left untouched." No commit.

---

### Task 8: SP4-D — deck-collider dirty chunks: VERIFY (no code change)

**Files:** none (read-only verification).

- [ ] Read `src/game/ship.ts` `rebuildDeckCollider` and confirm the loop re-sweeps a chunk ONLY when `firstBuild || colliderDirtyChunks.has(key) || !colliderChunkCache.has(key)`, concatenating the rest from `colliderChunkCache` (typed-array copy, no re-greedy-mesh), with `colliderDirtyChunks.clear()` after.
- [ ] Confirm dirtying mirrors `voxelGrid.markDirty` semantics including chunk-face neighbours (`markColliderChunkDirty`), fed from both mutation paths: `carveCells` and the `flushDamage` sever shed.
- [ ] Confirm player-only: `if (!this.walkable) return;` in both `rebuildDeckCollider` and `markColliderChunkDirty`; enemies constructed with `walkable = false` (`src/main.ts:486`).
- [ ] Record in the final report: "SP4-D verified already implemented (round 7, per CLAUDE.md); the audit's 're-sweeps ALL chunks' claim is stale; no change made." No commit.

---

### Task 9: CLAUDE.md — LAW #3 fix + decoupling note (H)

**Files:** `CLAUDE.md` only (exactly two edits — nothing else in the file).

- [ ] Verify the code truth first: `src/game/ship.ts` applies the lateral (leeway) force at the live **centre of buoyancy** — `body.addForceAtPoint({ x: lat.x * fL, ... }, { x: clrX, y: cbWorldY, z: clrZ }, ...)` in `applyForces` (search anchor: `the keel's lateral resistance, applied at the CENTRE OF BUOYANCY`), and `tunables.ts lateralDrag` doc agrees. The doc line is wrong, the code is right.
- [ ] Edit 1 — replace CLAUDE.md line 66 (LAW #3), currently:
```
3. **Leeway drag applies at the COM**, supplying the turn's centripetal pull; the bank is a separate emergent G-couple. Gotcha: moving force-application points casually flips righting and capsizes her under sail.
```
with:
```
3. **Leeway drag applies at the CENTRE OF BUOYANCY** — below the COM; that below-COM offset is what rights her against sail heel and banks her outward in a turn (`game/ship.ts applyForces` applies the lateral force at the live CB) — supplying the turn's centripetal pull; the bank is reinforced by a separate emergent G-couple. Gotcha: moving force-application points casually flips righting and capsizes her under sail.
```
- [ ] Edit 2 — in the `phys` bullet of the Tunables section (line 48), replace the fragment `` `heaveDamp 0.2` (heave+pitch ζ) `` with:
```
`heaveDamp 0.245` (heave+pitch ζ; = 0.2·√1.5 — round 12 SP5: damping now pairs with the PURE ρ·g·A waterplane stiffness, so moving `buoyancy` no longer silently moves damping; the default was recalibrated so the shipped feel at buoyancy 1.5 is unchanged)
```
- [ ] Run `npm run build` and `npm run test` (unchanged, but the gate applies to every commit).
- [ ] Commit:
```
git add CLAUDE.md
git commit -m "docs: fix THE LAW #3 (lateral drag acts at the centre of buoyancy) + note the SP5 heaveDamp decoupling

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Final perf validation + report

**Files:** none (read-only; results in the final report).

- [ ] Run the full gate one last time: `npm run build` and `npm run test` → **all green with unchanged expectations** except the new files (`tests/heaveResponse.test.ts` ×4, `tests/trim.test.ts` ×3, `tests/waveFieldCache.test.ts` ×5 — net +12 tests over the Task-1 baseline count). If a brig/frigate symmetric test is red, re-run that file isolated before investigating.
- [ ] Repeat the exact Task-1 procedure (same URL, Sandbox, `enemyCount = 5`, same sampler, then the same carve snippet + flooded re-sample) against the dev server now serving the changed tree. Record **after-healthy** and **after-flooded**.
- [ ] Compare and report the deltas per bucket. Expectations: **buoy** down materially (the lattice fill — the dominant per-substep Gerstner cost for 6 hulls — now runs at ~15 Hz per ship instead of 60+ Hz; steady-state ≈ ÷4 on fill cost); **flood** down clearly in the flooded scene (per-orifice exact inversions → bilinear reads); **visual / contact / rapier** ≈ unchanged (not touched by this agent); **no behavior anomalies** — ships ride the swell normally, the holed hull floods and settles as before, no popping/teleporting. Note in the report that concurrent wave-1 agents share the tree, so absolute totals may drift; the buoy/flood buckets are this agent's signal.
- [ ] Final report must include: the baseline/after tables, the SP4-C and SP4-D verification findings (audit items already implemented — evidence lines), the SP5 derivation note (why the `√(TUN.phys.buoyancy)`-in-code option is a no-op and the tunable recalibration was chosen), and the commit list. Do NOT push.

---

### Critical Files for Implementation

- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\game\ship.ts` — every code change lands here (lattice cache, breach split, damping extraction/decoupling)
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\core\tunables.ts` — the single authorized `heaveDamp` recalibration (Task 3)
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\sim\buoyancy.ts` — probe harness consumed by the new trim test; verified NO edits needed (profile cache already lives in main.ts)
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\game\world.ts` — fixed-step order (flood → forces) + `timing` HUD consumed by validation; read-only
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\stability.test.ts` — the pure-hydrostatics harness pattern the new `tests/trim.test.ts` mirrors
