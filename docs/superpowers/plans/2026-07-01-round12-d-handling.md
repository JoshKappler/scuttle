# Handling Retune + Pacing (Round 12, Agent D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Goal

SP3 of the round-12 overhaul (`docs/superpowers/specs/2026-07-01-round-12-overhaul-design.md`): make handling **weighty but responsive** — full-rudder time-to-90° at cruise of **Cutter ~2–3 s** and **Frigate ~5–6 s**, monotonic across Sloop/Brig — via three force-model changes (yaw added-mass factor 1.6 → 1.3, `TUN.phys.yawDamp` 0.6 → 0.4, a Cutter-anchored hull-length rudder lever), guarded by new deterministic per-tier turn-rate tests and a turn-heel capsize guard. Plus the wave-2 half of SP1's repair fix (`ship.repairSails` re-steps FELLED masts, consuming wave-1's `debris.removeRigFor`), and a pacing audit report with conservative TUN-only nudges.

## Architecture

### Verified mechanism map (all claims re-checked against source at commit `3316ef4`; wave 1 lands before this plan executes and **agent C edits `game/ship.ts` in wave 1 — locate every edit by the quoted code, never by raw line number**)

- **Yaw inertia** — `src/game/ship.ts` constructor (~344–361):
  ```ts
  const l = (nx - BOWSPRIT_MARGIN_VOX) * VOXEL_SIZE; // effective hull length, excludes bowsprit margin
  const h = hullHeightMeters(build);
  const w = nz * VOXEL_SIZE;
  const ixx = (mass / 12) * (w * w + h * h);
  const iyy = (mass / 12) * (l * l + w * w) * 1.6;
  const izz = (mass / 12) * (l * l + h * h) * 1.6;
  ```
  The 1.6 added-mass factor is **not** shared with roll: `ixx` (roll) carries **no** factor; `iyy` (yaw) and `izz` (pitch) each carry their own `1.6` literal. Only the **yaw** literal changes (pitch keeps 1.6 — it was tuned against swell hobby-horsing, per the in-code comment). Post-damage, `recomputeMassProperties()` rescales `inertiaBox` per axis by the real voxel-inertia ratio — no change needed there.
- **Yaw damping** — `src/game/ship.ts` `applyForces` (~1086): `const yawT = -om.y * wet * TUN.phys.yawDamp * this.inertia[1];` — verified exactly as briefed. **Additionally** the body carries Rapier `setAngularDamping(0.15)` (constructor, ~365) which also damps yaw: the effective decay rate is `yawDamp + 0.15`. The turn-rate model MUST include it (verified numerically — it shifts the Frigate's t90 by ~1.6 s).
- **Rudder torque** — `src/game/sailing.ts` (~140–146):
  ```ts
  const flow = Math.sign(this.speed || 1) * (TUN.phys.rudderLowFloor + Math.abs(this.speed));
  const yaw = this.rudder * flow * mass * TUN.phys.rudderGain * ship.rudderEff * ship.rudderPower;
  body.addTorque({ x: 0, y: yaw, z: 0 }, true);
  ```
  No hull-length term — verified. `sailing.apply` runs once per **fixed substep** inside `world.onFixedStep` (main.ts ~777, after `ship.applyForces` which `resetForces/resetTorques` each substep — `game/world.ts` step order verified), so a 1-DOF per-`FIXED_DT` Euler model mirrors the live loop. The AI (`game/ai.ts`) uses its own `SailingController` (efficiency 0.9 scales **thrust only**, not rudder) — enemies gain the same handling, as SP3 intends.
- **Turn-heel** — `src/game/ship.ts` `applyForces` (~1100–1124): `aLat = clamp(vF·ω, ±turnHeelMaxG=3)`; couple `heelT = mass·aLat·comLocal[1]·turnHeel·wet·deepening`; `deepening` fades the couple linearly from full at `0.6·turnHeelCap` to **zero at the cap (45°)**, and only when it would deepen the lean. Key verified fact: at cruise, `vF·ω_ss` is **24.8 m/s² (Cutter) / 8.1 (Frigate) after the retune** vs the 3 m/s² clamp — the couple is **already saturated** before AND after SP3, so faster ω adds **zero** heel torque; the safety bound is the fade-to-zero at the cap plus positive hydrostatic righting at the cap angle. That is what Task 5 pins with tests.
- **repairSails** — `src/game/ship.ts` (~453–462): loops masts, `if (!this.mastAlive[mi]) continue;`, re-stamps `EMPTY` cells from `mastCells/sailCells` to SPAR/CANVAS, sets `sailIntegrity=1`, then only `this.visual.refresh()`. Verified gaps: felled masts skipped entirely; restored cells are **not** put back into the Rapier hull voxel collider, the packed surface set, the buoyancy columns, or mass properties. Invoked by `game/port.ts` `applyRepair()` (~299) as bare `s.repairSails()` — port.ts is frozen, so the debris seam must be an optional field on `Ship` (details in Task 6). `HullCollider` (game/hullCollider.ts, frozen) exposes `readonly collider` whose Rapier `setVoxel(x,y,z,bool)` re-enables a voxel O(1).
- **Tests** — no existing test initializes Rapier or constructs a real `Ship`; game-layer physics is tested via **stub ships + the real controller reading live `TUN`** (`tests/sailing.test.ts` `fakeShip()` pattern) and pure imports from `game/ship.ts` work (`tests/severDebounce.test.ts` imports from `../src/game/ship`). The oracle (`sim/`) never reads TUN; **game-layer tests may and do import TUN** — our tests read the shipped defaults AND pin them explicitly so a tunables drift fails loudly.

### Tier numbers (computed by executing the real `sim/shipwright.ts` builds — exact, not estimates)

| tier | mass (kg) | grid dims | l = (nx−44)·0.25 (m) | w = nz·0.25 (m) | l²+w² (m²) | I_yaw @1.6 (kg·m²) | I_yaw @1.3 | rest sub. frac | cruise v (m/s) |
|---|---|---|---|---|---|---|---|---|---|
| Cutter | 124,760 | 128×70×26 | 21.0 | 6.5 | 483.3 | 8.039e6 | 6.531e6 | 0.336 | 17.7 |
| Sloop | 183,810 | 148×86×32 | 26.0 | 8.0 | 740.0 | 1.814e7 | 1.474e7 | 0.246 | 20.3 |
| Brig | 594,279 | 196×90×44 | 38.0 | 11.0 | 1565.0 | 1.240e8 | 1.008e8 | 0.308 | 18.5 |
| Frigate | 883,295 | 232×96×50 | 47.0 | 12.5 | 2365.3 | 2.786e8 | 2.263e8 | 0.267 | 19.6 |

Cruise = calm-water full-sail equilibrium of the real constants (wind 7 m/s from main.ts:433, `wf=1` best reach): solve `0.019·7² = 0.04·(1+0.08v)·v·sub + 0.02·v` (thrust coeff sailing.ts:89; forward drag ship.ts ~1054; 0.02 = body `setLinearDamping`). Rest submerged fraction `sub = mass/(1.5·1025·V_displacing)` (buoyancy ×1.5). `wet = min(sub·5, 1) = 1` for every tier afloat, so yaw damping runs at full `yawDamp`.

### Calibration (1-DOF yaw model, per-FIXED_DT Euler + Rapier 0.15 angular damping, `flow = 2.5 + v_cruise`, full rudder, verified by numeric integration)

`ω̇ = τ_r/I − yawDamp·ω`, then `ω /= (1 + 0.15·dt)` per step; `τ_r = flow·mass·rudderGain·lever`; `I = (mass/12)(l²+w²)·f`. Steady rate `ω_ss = τ_r/((yawDamp+0.15)·I)`; spin-up time constant `T = 1/(yawDamp+0.15)` — **independent of the inertia factor** (both τ_damp and I scale with I), so f changes steady rate only, yawDamp changes both.

Predicted time-to-90° (s) per stage — these become the test bands:

| stage | Cutter | Sloop | Brig | Frigate |
|---|---|---|---|---|
| current (f=1.6, d=0.6, no lever) | **3.08** | 3.80 | 7.18 | **9.73** |
| Task 2: f=1.3 | 2.68 | 3.28 | 6.07 | 8.15 |
| Task 3: d=0.4 | 2.47 | 2.98 | 5.20 | 6.78 |
| Task 4: lever `(l/21)^0.35` | **2.47** | 2.85 | 4.50 | **5.50** |

Lever derivation: after f=1.3 + d=0.4 the Frigate sits at 6.78 s; the Cutter (anchor, lever ≡ 1 at `L0 = 21 m` = its effective hull length) must not move. Required Frigate ω gain = ratio to land ~5.5 s ⇒ lever ≈ 1.33 over a length ratio 47/21 = 2.238 ⇒ exponent `ln(1.33)/ln(2.238) ≈ 0.35`. Physical story: rudder torque ∝ (rudder force ∝ area·v²)·(lever ∝ L), but the existing model already scales torque with `mass` (∝ L³·density-ish), over-crediting size — the residual, calibrated correction is `(l/L0)^0.35`. Targets hit and monotonic: **2.47 / 2.85 / 4.50 / 5.50**. Side effect (accepted, playtest-liked direction): zero-way pivot authority rises ~1.7× on the Cutter and ~2.3× on the Frigate (flow floor 2.5 unchanged).

### Consumed interface (wave 1, agent B)

`game/debris.ts` → `removeRigFor(ship: Ship): void` on `DebrisManager` — despawns that ship's floating rig-debris islands. **Not present at plan time (`grep removeRigFor src/game/debris.ts` = empty at `3316ef4`); wave 1 lands it first. At execution, verify the exact exported name/signature in `game/debris.ts` before Task 6 and adapt the wiring note (never the ship.ts callback shape) if it differs.** `ship.ts` never imports the debris manager (constructed in frozen main.ts); the seam is an optional callback field `Ship.onRigRepair` (Task 6). Degraded fallback if unwired: the duplicate floating rig waterlogs and despawns on its own within `TUN.rig.fallLifetime` (40 s) — cosmetic only.

## Tech Stack

TypeScript strict (tsc 6, `npm run build` = `tsc --noEmit && vite build`), vitest 4 (`npm run test`), Three.js 0.184 (importable in node tests), Rapier3d-compat **not** initialized in tests (stub-body pattern from `tests/sailing.test.ts`). Deterministic sim oracle in `src/sim/` (pure, no TUN); live layer `src/game/` reads `TUN` from `src/core/tunables.ts`.

## Global Constraints

- **`npm run build` AND `npm run test` must pass before EVERY commit** — vitest does NOT type-check; a red `tsc` hides behind green tests.
- **Stage ONLY owned files via explicit `git add <paths>`** — never `git add -A` or `git add .` (concurrent agents share this worktree).
- **Do NOT push** — the orchestrator pushes per wave.
- **Do NOT edit frozen files**: `game/debris.ts` (consume only), `game/port.ts`, `game/hullCollider.ts`, `main.ts`, everything under `render/`, everything under `sim/` (read-only audit only), and any other file not in the owned set. Owned set: `src/game/ship.ts`, `src/game/sailing.ts`, `src/core/tunables.ts`, `tests/**` for these, plus the single deliverable `docs/superpowers/plans/2026-07-01-round12-pacing-report.md`.
- **THE LAW: no attitude clamps, no rate caps — emergent physics only.** Every change here is mass/inertia/force-model-side. Leeway drag at the CB is untouched. `sim/` purity/determinism holds (no sim/ code changes at all).
- **TUN is not read by the vitest oracle** (`sim/` tests); game-layer tests read the live shipped defaults AND pin them so a drift fails loudly.
- **Brig/frigate symmetric tests can false-fail under CPU load — re-run isolated** (`npx vitest run tests/brig.test.ts`) before declaring red.
- Line anchors below are from commit `3316ef4` (pre-wave-1). Wave-1 agent C edits `game/ship.ts`; **always locate edit points by the quoted code**. All existing stability/draft/float tests must stay green with unchanged expectations.

---

### Task 1: Turn-rate characterization harness + tests (current behavior, expected-to-change)

**Files**
- `src/game/ship.ts` — constructor (~344–372): extract `YAW_ADDED_MASS` / `PITCH_ADDED_MASS` / `BODY_ANGULAR_DAMPING` consts + pure `yawInertia(build)` export (pure refactor, zero behavior change).
- `tests/helpers/yawHarness.ts` — NEW (not matched by vitest's `*.test.ts` glob; shared by Tasks 1–5).
- `tests/turnRate.test.ts` — NEW.

**Interfaces** — Consumes: none. Produces: `yawInertia`, `YAW_ADDED_MASS`, `PITCH_ADDED_MASS`, `BODY_ANGULAR_DAMPING` exports (consumed by tests only).

- [ ] In `src/game/ship.ts`, directly above `export class Ship` (near the existing `SEVER_QUIET` exports), add:
  ```ts
  /** Box-inertia added-mass factors: a hull drags entrained water when it rotates. Split per axis
   *  (round 12 SP3): PITCH keeps the swell-tuned 1.6 (brig hobby-horse fix, round 8); YAW gets its
   *  own factor so turning agility is tunable without touching the pitch feel. Roll (ixx) never
   *  carried a factor. Exported for the deterministic turn-rate oracle (tests/turnRate.test.ts). */
  export const YAW_ADDED_MASS = 1.6;
  export const PITCH_ADDED_MASS = 1.6;
  /** Rapier body-level angular damping (constructor .setAngularDamping). Acts on yaw IN ADDITION to
   *  TUN.phys.yawDamp — the turn-rate model must include it (effective decay = yawDamp + this). */
  export const BODY_ANGULAR_DAMPING = 0.15;

  /** Yaw (about +Y) box inertia of the intact hull — EXACTLY the constructor's formula, exported
   *  pure so the turn-rate tests cannot silently drift from the game (shared single source). */
  export function yawInertia(build: ShipBuild): number {
    const mass = build.grid.totalMass();
    const [nx, , nz] = build.grid.dims;
    const l = (nx - BOWSPRIT_MARGIN_VOX) * VOXEL_SIZE;
    const w = nz * VOXEL_SIZE;
    return (mass / 12) * (l * l + w * w) * YAW_ADDED_MASS;
  }
  ```
- [ ] In the `Ship` constructor, replace the two lines
  ```ts
  const iyy = (mass / 12) * (l * l + w * w) * 1.6;
  const izz = (mass / 12) * (l * l + h * h) * 1.6;
  ```
  with
  ```ts
  const iyy = yawInertia(build); // yaw factor split out (round 12 SP3) — see YAW_ADDED_MASS
  const izz = (mass / 12) * (l * l + h * h) * PITCH_ADDED_MASS;
  ```
  and replace `.setAngularDamping(0.15)` with `.setAngularDamping(BODY_ANGULAR_DAMPING)`.
- [ ] Create `tests/helpers/yawHarness.ts` (COMPLETE):
  ```ts
  import { SailingController, type Wind } from "../../src/game/sailing";
  import { yawInertia, BODY_ANGULAR_DAMPING, type Ship } from "../../src/game/ship";
  import type { ShipBuild } from "../../src/sim/shipwright";
  import { TUN } from "../../src/core/tunables";
  import { FIXED_DT } from "../../src/core/constants";

  /** Reference calm-water full-sail cruise speeds (m/s), per tier — the equilibrium of the real
   *  constants: 0.019·wind² = 0.04·(1+0.08v)·v·sub + 0.02·v with wind = 7 m/s (main.ts) and
   *  sub = mass/(1.5·1025·V_displacing). Derivation in the round-12 agent-D plan. */
  export const CRUISE = { cutter: 17.7, sloop: 20.3, brig: 18.5, frigate: 19.6 } as const;

  /** The shipped physics wind (main.ts:433) — unused at sailSet 0 but apply() requires it. */
  const WIND: Wind = { dirX: 1, dirZ: 0, speed: 7 };

  /** Minimal fake hull for SailingController.apply(): identity heading (+x), speed held at
   *  `cruise`, torque captured. Same pattern as tests/sailing.test.ts fakeShip(). */
  function makeStub(build: ShipBuild, cruise: number) {
    const cap = { tau: 0 };
    const body = {
      rotation: () => ({ x: 0, y: 0, z: 0, w: 1 }),
      linvel: () => ({ x: cruise, y: 0, z: 0 }),
      mass: () => build.grid.totalMass(),
      addForceAtPoint: () => {},
      addTorque: (t: { x: number; y: number; z: number }) => { cap.tau += t.y; },
    };
    const ship = {
      body,
      submergedFrac: 1,
      build,
      mastAlive: build.masts.map(() => true),
      sailIntegrity: build.masts.map(() => 1),
      comLocal: [0, 0, 0],
      rudderEff: 1,
      rudderPower: 1,
      localToWorld: (l: [number, number, number], out: { set: (x: number, y: number, z: number) => unknown }) => {
        out.set(l[0], l[1], l[2]);
        return out;
      },
    } as unknown as Ship;
    return { ship, cap };
  }

  /** The REAL rudder torque (N·m) sailing.ts produces at full rudder + cruise flow. */
  export function rudderTorque(build: ShipBuild, cruise: number): number {
    const { ship, cap } = makeStub(build, cruise);
    const sail = new SailingController();
    sail.sailSet = 0; // no thrust — pure rudder
    sail.rudder = 1;  // full helm
    cap.tau = 0;
    sail.apply(ship, WIND);
    return cap.tau;
  }

  /**
   * Deterministic 1-DOF time-to-90° (s): full rudder at held cruise speed, calm sea (no waves in
   * this model at all — swell never enters), mirroring the live per-substep order (game/world.ts):
   * ship.applyForces yaw damping (τ = −ω·wet·TUN.phys.yawDamp·I_yaw, wet = 1 afloat — every tier's
   * rest submergence ×5 saturates min(sub·5,1)) + sailing.apply rudder torque, integrated at
   * FIXED_DT with Rapier's body angular damping factor. Reads the LIVE shipped TUN — a tunables
   * drift moves the result out of band and fails the assertions loudly.
   */
  export function timeTo90(build: ShipBuild, cruise: number): number {
    const iyaw = yawInertia(build);
    const { ship, cap } = makeStub(build, cruise);
    const sail = new SailingController();
    sail.sailSet = 0;
    sail.rudder = 1;
    let omega = 0;
    let heading = 0;
    const maxSteps = 60 * 40;
    for (let i = 0; i < maxSteps; i++) {
      cap.tau = 0;
      sail.apply(ship, WIND); // real torque incl. TUN.phys.rudderGain (+ lever once Task 4 lands)
      const tauDamp = -omega * 1 * TUN.phys.yawDamp * iyaw; // ship.applyForces yaw-damping line
      omega += ((cap.tau + tauDamp) / iyaw) * FIXED_DT;
      omega /= 1 + BODY_ANGULAR_DAMPING * FIXED_DT; // Rapier setAngularDamping
      heading += omega * FIXED_DT;
      if (heading >= Math.PI / 2) return (i + 1) * FIXED_DT;
    }
    return Infinity;
  }

  /** Steady-state yaw rate (rad/s) of the same model (closed form). */
  export function steadyYawRate(build: ShipBuild, cruise: number): number {
    return rudderTorque(build, cruise) / ((TUN.phys.yawDamp + BODY_ANGULAR_DAMPING) * yawInertia(build));
  }
  ```
- [ ] Create `tests/turnRate.test.ts` (COMPLETE — characterization version; the `EXPECT` table and knob-pin are updated by Tasks 2–4):
  ```ts
  import { describe, it, expect } from "vitest";
  import { buildCutter, buildSloop, buildBrig, buildFrigate } from "../src/sim/shipwright";
  import { TUN } from "../src/core/tunables";
  import { YAW_ADDED_MASS } from "../src/game/ship";
  import { timeTo90, CRUISE } from "./helpers/yawHarness";

  // ROUND-12 SP3 CHARACTERIZATION: pins the CURRENT shipped handling before the retune.
  // EXPECTED TO CHANGE: the retune tasks (inertia → yawDamp → rudder lever) update EXPECT +
  // the knob-pin step by step until the spec targets land (Cutter 2–3 s, Frigate 5–6 s).
  const builds = {
    cutter: buildCutter(),
    sloop: buildSloop(),
    brig: buildBrig(),
    frigate: buildFrigate(),
  } as const;
  type Tier = keyof typeof builds;

  // predicted (1-DOF model, verified numerically): cutter 3.08, sloop 3.80, brig 7.18, frigate 9.73
  const EXPECT: Record<Tier, [number, number]> = {
    cutter: [2.7, 3.5],
    sloop: [3.4, 4.2],
    brig: [6.7, 7.7],
    frigate: [9.2, 10.2],
  };

  describe("turn rate — time to 90° heading at cruise, full rudder (deterministic 1-DOF yaw model)", () => {
    it("pins the shipped handling knobs (a tunables drift fails HERE, loudly)", () => {
      expect(TUN.phys.yawDamp).toBe(0.6);
      expect(TUN.phys.rudderGain).toBe(2.0);
      expect(TUN.phys.rudderLowFloor).toBe(2.5);
      expect(YAW_ADDED_MASS).toBe(1.6);
    });

    for (const tier of Object.keys(builds) as Tier[]) {
      it(`${tier}: t90 within band [${EXPECT[tier][0]}, ${EXPECT[tier][1]}] s`, () => {
        const t = timeTo90(builds[tier], CRUISE[tier]);
        expect(t).toBeGreaterThan(EXPECT[tier][0]);
        expect(t).toBeLessThan(EXPECT[tier][1]);
      });
    }

    it("t90 is strictly monotonic up the tiers (bigger = statelier)", () => {
      const t = (Object.keys(builds) as Tier[]).map((k) => timeTo90(builds[k], CRUISE[k]));
      for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    });
  });
  ```
- [ ] Run `npx vitest run tests/turnRate.test.ts` — expected **PASS** (characterization of current behavior; also proves the pure-refactor exports changed nothing).
- [ ] Run `npm run build` and `npm run test` — all green (431+ tests unchanged).
- [ ] Commit:
  ```
  git add src/game/ship.ts tests/helpers/yawHarness.ts tests/turnRate.test.ts
  git commit -m "test(handling): 1-DOF per-tier turn-rate oracle + characterization of current feel

  Extracts YAW/PITCH_ADDED_MASS, BODY_ANGULAR_DAMPING and pure yawInertia() from the Ship
  constructor (zero behavior change) so the new deterministic harness shares the game's exact
  formula. Pins current t90: cutter 3.1s, sloop 3.8s, brig 7.2s, frigate 9.7s - retuned next.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 2: Yaw added-mass factor 1.6 → 1.3

**Files** — `src/game/ship.ts` (`YAW_ADDED_MASS` const from Task 1), `tests/turnRate.test.ts`.

**Interfaces** — Consumes/Produces: none.

- [ ] In `tests/turnRate.test.ts`, update the knob-pin `expect(YAW_ADDED_MASS).toBe(1.3);` and the table (predicted 2.68 / 3.28 / 6.07 / 8.15):
  ```ts
  const EXPECT: Record<Tier, [number, number]> = {
    cutter: [2.3, 3.1],
    sloop: [2.9, 3.7],
    brig: [5.6, 6.6],
    frigate: [7.7, 8.7],
  };
  ```
- [ ] Run `npx vitest run tests/turnRate.test.ts` — expected **FAIL** (code still at 1.6).
- [ ] In `src/game/ship.ts` set `export const YAW_ADDED_MASS = 1.3;` and extend its comment:
  ```ts
  /** ... Round 12 SP3: YAW eased 1.6 → 1.3 — the entrained-water moment for yaw about a slender
   *  hull is far below the pitch case (the hull slices; only the ends carry added moment), and the
   *  shared 1.6 was tuned for PITCH hobby-horsing, inherited by yaw incidentally. 1.3 keeps real
   *  added-mass weight while raising steady turn rate ~23% (ω_ss ∝ 1/factor); the spin-up time
   *  constant T = 1/(yawDamp+0.15) is untouched by this factor (damping torque scales with I). */
  export const YAW_ADDED_MASS = 1.3;
  ```
- [ ] Run `npx vitest run tests/turnRate.test.ts` — expected **PASS**. Then `npm run build` + `npm run test` — green (the inertia floor / recompute path scales from `inertiaBox`, unaffected; stability/draft/float oracles never read the box inertia).
- [ ] Commit:
  ```
  git add src/game/ship.ts tests/turnRate.test.ts
  git commit -m "feat(handling): yaw added-mass factor 1.6 -> 1.3 (pitch keeps 1.6)

  Yaw inherited the pitch-tuned 1.6 by sharing a literal; a slender hull entrains far less water
  in yaw. Steady turn rate +23% across tiers (t90: cutter 2.7s, frigate 8.2s). THE LAW: pure
  inertia change, no clamps.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 3: `TUN.phys.yawDamp` 0.6 → 0.4

**Files** — `src/core/tunables.ts` (`phys.yawDamp`, ~line 41), `tests/turnRate.test.ts`.

**Interfaces** — none.

- [ ] Update `tests/turnRate.test.ts`: knob-pin `expect(TUN.phys.yawDamp).toBe(0.4);` and the table (predicted 2.47 / 2.98 / 5.20 / 6.78):
  ```ts
  const EXPECT: Record<Tier, [number, number]> = {
    cutter: [2.1, 2.9],
    sloop: [2.6, 3.4],
    brig: [4.7, 5.7],
    frigate: [6.3, 7.3],
  };
  ```
- [ ] Run `npx vitest run tests/turnRate.test.ts` — expected **FAIL**.
- [ ] In `src/core/tunables.ts` change `yawDamp: 0.6,` to `yawDamp: 0.4,` and update its doc comment tail: `... SHIP-FEEL pass eased 0.7→0.6; ROUND-12 SP3 eased 0.6→0.4 (with the yaw added-mass split 1.6→1.3 and the hull-length rudder lever) so the steady rate rises and the coast-through after centering the helm stays damped by the body's 0.15 angular damping — final value calibrated by tests/turnRate.test.ts (cutter ~2.5 s, frigate ~5.5 s to 90°).`
- [ ] Run `npx vitest run tests/turnRate.test.ts` — expected **PASS**. Then `npm run build` + `npm run test` — green (TUN not read by the sim oracle).
- [ ] Commit:
  ```
  git add src/core/tunables.ts tests/turnRate.test.ts
  git commit -m "feat(handling): ease TUN.phys.yawDamp 0.6 -> 0.4

  Higher steady yaw rate for the same rudder torque; effective decay stays yawDamp+0.15 (Rapier
  body damping) so she still settles. t90 now: cutter 2.5s, sloop 3.0s, brig 5.2s, frigate 6.8s.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 4: Hull-length rudder lever, Cutter-anchored — calibrate to the spec targets

**Files** — `src/game/sailing.ts` (rudder block ~140–146 + imports), `src/core/tunables.ts` (new `phys.rudderLeverExp`), `tests/turnRate.test.ts` (final bands), `tests/sailing.test.ts` (fake ship gains `grid.dims`).

**Interfaces** — Consumes: `TUN.phys.rudderLeverExp` (new, own file). Produces: `rudderLever`, `RUDDER_LEVER_L0` exports (test-consumed). Note: no dev-panel slider for the new knob (sliders live in frozen main.ts — hand a one-liner note to agent E if wanted).

- [ ] Update `tests/turnRate.test.ts` to the **FINAL spec-target** version: knob-pin block becomes
  ```ts
  it("pins the shipped handling knobs (a tunables drift fails HERE, loudly)", () => {
    expect(TUN.phys.yawDamp).toBe(0.4);
    expect(TUN.phys.rudderGain).toBe(2.0);
    expect(TUN.phys.rudderLowFloor).toBe(2.5);
    expect(TUN.phys.rudderLeverExp).toBe(0.35);
    expect(YAW_ADDED_MASS).toBe(1.3);
  });
  ```
  and the table (predicted 2.47 / 2.85 / 4.50 / 5.50 — the spec bands):
  ```ts
  // ROUND-12 SP3 TARGETS (spec): cutter 2-3 s, frigate 5-6 s, monotonic between.
  const EXPECT: Record<Tier, [number, number]> = {
    cutter: [2.0, 3.0],
    sloop: [2.3, 3.4],
    brig: [4.0, 5.0],
    frigate: [5.0, 6.0],
  };
  ```
  Also update the header comment: characterization is over; this file is now the SP3 acceptance oracle.
- [ ] Update `tests/sailing.test.ts` `fakeShip()`: the ship object's `build` becomes
  ```ts
  build: { masts: [{ x: 0, z: 0, h: 4 }], grid: { dims: [128, 70, 26] } }, // cutter dims → rudder lever ≡ 1
  ```
- [ ] Run `npx vitest run tests/turnRate.test.ts` — expected **FAIL** (no lever yet; frigate ~6.8 s > 6.0).
- [ ] In `src/core/tunables.ts`, add below `rudderLowFloor`:
  ```ts
  /** ROUND-12 SP3 — hull-length RUDDER LEVER exponent. Rudder torque gains a factor
   *  (L/L0)^rudderLeverExp with L = the hull's effective length and L0 = the Cutter's (21 m), so
   *  authority grows with ship size instead of falling off with L² (steady rate ∝ gain·lever/(l²+w²)).
   *  Cutter-anchored: the Cutter's feel is UNCHANGED (lever ≡ 1); calibrated with yawDamp 0.4 +
   *  yaw added-mass 1.3 so tests/turnRate.test.ts lands cutter ~2.5 s / frigate ~5.5 s to 90°.
   *  0 = no lever (pre-round-12); 1 = full physical rudder-arm ∝ L (overshoots the tier targets). */
  rudderLeverExp: 0.35,
  ```
- [ ] In `src/game/sailing.ts`: add imports
  ```ts
  import { VOXEL_SIZE } from "../core/constants";
  import { BOWSPRIT_MARGIN_VOX } from "../sim/shipwright";
  ```
  add above the class:
  ```ts
  /** The Cutter's effective hull length (m) — (nx − BOWSPRIT_MARGIN_VOX)·VOXEL_SIZE of buildCutter's
   *  128-wide grid. The rudder-lever normalization anchor: the Cutter is UNCHANGED by the lever. */
  export const RUDDER_LEVER_L0 = 21;

  /** ROUND-12 SP3 — hull-length rudder lever (L/L0)^exp. Physical: rudder force × lever arm grows
   *  with hull length; the existing torque model already scales with mass, so the calibrated residual
   *  is sub-linear (exp 0.35 — see the round-12 agent-D plan arithmetic). Uses the SAME effective
   *  length convention as ship.ts yawInertia (grid X minus the empty bowsprit margin). */
  export function rudderLever(ship: Ship): number {
    const l = (ship.build.grid.dims[0] - BOWSPRIT_MARGIN_VOX) * VOXEL_SIZE;
    return Math.pow(Math.max(l, 1) / RUDDER_LEVER_L0, TUN.phys.rudderLeverExp);
  }
  ```
  and change the yaw line in `apply()` to:
  ```ts
  const yaw = this.rudder * flow * mass * TUN.phys.rudderGain * rudderLever(ship) * ship.rudderEff * ship.rudderPower;
  ```
- [ ] Run `npx vitest run tests/turnRate.test.ts tests/sailing.test.ts` — expected **PASS** (final: ~2.47 / 2.85 / 4.50 / 5.50, monotonic). Then `npm run build` + `npm run test` — green.
- [ ] Commit:
  ```
  git add src/game/sailing.ts src/core/tunables.ts tests/turnRate.test.ts tests/sailing.test.ts
  git commit -m "feat(handling): Cutter-anchored hull-length rudder lever; tier turn times hit spec

  torque *= (L/21m)^0.35 (TUN.phys.rudderLeverExp). With yaw factor 1.3 + yawDamp 0.4: t90 =
  cutter 2.5s, sloop 2.9s, brig 4.5s, frigate 5.5s (spec: 2-3 / 5-6, monotonic). Force-model
  only - no rate caps (THE LAW).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 5: Turn-heel re-verify + capsize guard test

**Files** — `src/game/ship.ts` (extract the fade as a pure export; `applyForces` turn-heel block ~1111–1122), `tests/turnHeel.test.ts` (NEW), possibly `src/core/tunables.ts` (`turnHeelCap` contingency only).

**Interfaces** — Produces: `turnHeelDeepeningFade` export.

Analysis to encode (verified in Architecture): `aLat = clamp(vF·ω, ±3)` was already saturated pre-retune (Cutter vF·ω ≈ 18.6 before, 24.8 after; Frigate 4.6 before, 8.1 after) — **the couple's magnitude does not grow with the new ω**, so `turnHeel` 4.0 needs no reduction; the capsize bound is (a) the couple fades to exactly 0 at `turnHeelCap` when deepening, and (b) hydrostatic righting is still restoring at the cap angle. The keel's lateral-drag bank (emergent, at the CB) is bounded by keel grip, not ω — unchanged mechanism, verified in-browser at wave hand-off (orchestrator pass).

- [ ] In `src/game/ship.ts`, add near `yawInertia`:
  ```ts
  /** Turn-heel soft-knockdown fade: 1 below 60% of the cap, linearly to 0 AT the cap — the couple
   *  can never PUSH her past turnHeelCap (buoyant righting then wins). Extracted pure for the
   *  round-12 capsize-guard test; used verbatim by applyForces. */
  export function turnHeelDeepeningFade(heelDeg: number, cap: number): number {
    return Math.min(Math.max((cap - heelDeg) / (cap * 0.4), 0), 1);
  }
  ```
  and in `applyForces` replace
  ```ts
  const fade = Math.min(Math.max((cap - heelDeg) / (cap * 0.4), 0), 1); // 1 below 0.6·cap → 0 at cap
  ```
  with
  ```ts
  const fade = turnHeelDeepeningFade(heelDeg, cap); // 1 below 0.6·cap → 0 at cap (pure, unit-tested)
  ```
- [ ] Create `tests/turnHeel.test.ts` (COMPLETE):
  ```ts
  import { describe, it, expect } from "vitest";
  import { buildCutter, buildFrigate } from "../src/sim/shipwright";
  import { makeProbes, probeForce, submergedFraction } from "../src/sim/buoyancy";
  import { G } from "../src/core/constants";
  import { TUN } from "../src/core/tunables";
  import { turnHeelDeepeningFade } from "../src/game/ship";
  import { steadyYawRate, CRUISE } from "./helpers/yawHarness";

  // ROUND-12 SP3 turn-heel guard: at the faster turn rates a hard turn must bank dramatically but
  // never capsize. Two facts pin that: (1) the G-couple saturates at turnHeelMaxG and fades to ZERO
  // at turnHeelCap, so more ω adds no heel torque and the couple cannot push past the cap; (2) the
  // hull's hydrostatic righting is still RESTORING at the cap angle, so buoyancy wins there.

  describe("turn-heel at round-12 turn rates", () => {
    it("the G-couple input vF·ω is SATURATED at cruise (faster turns add no heel torque)", () => {
      const cutter = steadyYawRate(buildCutter(), CRUISE.cutter) * CRUISE.cutter;
      const frigate = steadyYawRate(buildFrigate(), CRUISE.frigate) * CRUISE.frigate;
      expect(cutter).toBeGreaterThan(TUN.phys.turnHeelMaxG); // ≈25 vs 3
      expect(frigate).toBeGreaterThan(TUN.phys.turnHeelMaxG); // ≈8 vs 3
    });

    it("the deepening fade is full below 60% of the cap and exactly ZERO at/past the cap", () => {
      const cap = TUN.phys.turnHeelCap;
      expect(turnHeelDeepeningFade(0, cap)).toBe(1);
      expect(turnHeelDeepeningFade(cap * 0.6, cap)).toBe(1);
      expect(turnHeelDeepeningFade(cap, cap)).toBe(0);
      expect(turnHeelDeepeningFade(cap + 15, cap)).toBe(0);
      let prev = 1;
      for (let d = cap * 0.6; d <= cap + 1e-9; d += 1) {
        const f = turnHeelDeepeningFade(d, cap);
        expect(f).toBeLessThanOrEqual(prev + 1e-12);
        prev = f;
      }
    });

    // Hydrostatic righting at the cap angle, probe-model (same method as tests/stability.test.ts):
    // heel the hull turnHeelCap° about x, float it at equilibrium draft, require a RESTORING torque.
    for (const [name, builder] of [
      ["cutter", buildCutter],
      ["frigate", buildFrigate],
    ] as const) {
      it(`${name}: righting torque at turnHeelCap (${TUN.phys.turnHeelCap}°) heel is restoring`, () => {
        const ship = builder();
        const probes = makeProbes(ship.grid, ship.compartments);
        const mass = ship.grid.totalMass();
        const com = ship.grid.centerOfMass();
        const hydro = (heel: number, comY: number) => {
          let force = 0;
          let torqueX = 0;
          const c = Math.cos(heel);
          const s = Math.sin(heel);
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
        };
        const equilibriumY = (heel: number) => {
          let lo = -6;
          let hi = 6;
          for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            if (hydro(heel, mid).force > mass * G) lo = mid;
            else hi = mid;
          }
          return (lo + hi) / 2;
        };
        const heel = (TUN.phys.turnHeelCap * Math.PI) / 180;
        const { torqueX } = hydro(heel, equilibriumY(heel));
        expect(torqueX * heel).toBeLessThan(0); // opposes the heel → restoring at the cap
      });
    }
  });
  ```
- [ ] Run `npx vitest run tests/turnHeel.test.ts` — expected **PASS**. **Contingency (encode, don't guess):** if a righting-at-cap assertion fails, the hull's range of stability ends below 45° and the cap is unsafe at ANY turn rate — lower `TUN.phys.turnHeelCap` in steps of 5 (45 → 40 → 35) until the test passes at the cap, update the knob's comment, and note the feel change in the commit body. Do NOT touch `turnHeel`/`turnHeelMaxG` (the saturation test proves gain is not the binding safety knob).
- [ ] `npm run build` + `npm run test` — green.
- [ ] Commit:
  ```
  git add src/game/ship.ts tests/turnHeel.test.ts
  git commit -m "test(handling): turn-heel capsize guard at round-12 turn rates

  Pins: vF*omega saturates turnHeelMaxG (couple magnitude unchanged by faster turns), the
  deepening fade is exactly zero at turnHeelCap, and hydrostatic righting still restores AT the
  cap for cutter+frigate - a clean hard turn banks to ~cap and cannot capsize. Fade extracted
  pure (behavior identical).

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```
  (Add `src/core/tunables.ts` to the `git add` only if the contingency fired.)

### Task 6: `repairSails` re-steps FELLED masts (SP1 wave-2 half)

**Files** — `src/game/ship.ts` (`repairSails` ~453–462 + new `planRigRepair` export + new `onRigRepair` field near the other `on*` callbacks ~150–157), `tests/repairSails.test.ts` (NEW). READ-ONLY: `game/debris.ts` (verify `removeRigFor`), `game/port.ts` (caller, unchanged — `s.repairSails()` stays zero-arg).

**Interfaces** — **Consumes: `DebrisManager.removeRigFor(ship: Ship): void` (wave-1 agent B, game/debris.ts — VERIFY the exact exported name/signature in the file before coding; adapt only the wiring note below if it differs).** Produces: `Ship.onRigRepair?: (ship: Ship) => void` + `planRigRepair` export. **HAND-OFF (frozen-file wiring, for the orchestrator / agent E who owns main.ts in wave 2):** one line at each PLAYER-ship creation site in `main.ts` — `sloop.onRigRepair = (s) => debris.removeRigFor(s);` at the initial build (~line 448 block), the respawn re-wire (~664 block), and `fresh.onRigRepair = ...` in `swapPlayerShip` (~613 block). Enemies never call `repairSails`. Until wired, repair still fully works — the stale floating rig just self-despawns within `TUN.rig.fallLifetime` (40 s).

- [ ] Create `tests/repairSails.test.ts` (COMPLETE):
  ```ts
  import { describe, it, expect } from "vitest";
  import { buildCutter } from "../src/sim/shipwright";
  import { SPAR, CANVAS, EMPTY } from "../src/sim/materials";
  import { mastFootingCells } from "../src/sim/mastSupport";
  import { planRigRepair } from "../src/game/ship";

  // ROUND-12 (SP1 wave-2 half): port repair must be able to re-step a FELLED mast — re-stamp its
  // SPAR trunk + CANVAS sails from the build lists — not only regrow standing masts. The pure
  // planner is unit-tested here; Ship.repairSails composes it with the collider/surface/mass
  // bookkeeping (no Rapier in tests — verified in-browser at wave hand-off).
  function fresh() {
    const build = buildCutter();
    const mastCells = build.mastVoxels.map((c) => c.slice());
    const sailCells = build.sailVoxels.map((c) => c.slice());
    const footInit = build.masts.map((m) => mastFootingCells(build.grid, m.x, build.deckYAt(m.x)));
    return { build, mastCells, sailCells, footInit };
  }

  describe("planRigRepair (pure port sail-repair planner)", () => {
    it("healthy rig → empty plan (nothing to restore)", () => {
      const { build, mastCells, sailCells, footInit } = fresh();
      expect(planRigRepair(build, mastCells, sailCells, [true], footInit)).toHaveLength(0);
    });

    it("standing mast: restores EXACTLY the shot-out cells with the right materials", () => {
      const { build, mastCells, sailCells, footInit } = fresh();
      const holedTrunk = mastCells[0].slice(4, 7);
      const holedSail = sailCells[0].slice(0, 5);
      for (const c of [...holedTrunk, ...holedSail]) build.grid.remove(c.x, c.y, c.z);
      const plan = planRigRepair(build, mastCells, sailCells, [true], footInit);
      expect(plan).toHaveLength(1);
      expect(plan[0].mi).toBe(0);
      expect(plan[0].cells).toHaveLength(holedTrunk.length + holedSail.length);
      for (const c of plan[0].cells) {
        expect(build.grid.get(c.x, c.y, c.z)).toBe(EMPTY);
        expect([SPAR, CANVAS]).toContain(c.mat);
      }
      expect(plan[0].cells.filter((c) => c.mat === SPAR)).toHaveLength(holedTrunk.length);
      expect(plan[0].cells.filter((c) => c.mat === CANVAS)).toHaveLength(holedSail.length);
    });

    it("FELLED mast with its step intact: restores the ENTIRE trunk + canvas", () => {
      const { build, mastCells, sailCells, footInit } = fresh();
      for (const c of [...mastCells[0], ...sailCells[0]]) build.grid.remove(c.x, c.y, c.z);
      const plan = planRigRepair(build, mastCells, sailCells, [false], footInit);
      expect(plan).toHaveLength(1);
      expect(plan[0].cells).toHaveLength(mastCells[0].length + sailCells[0].length);
    });

    it("FELLED mast whose footing hull is destroyed is NOT re-stepped (mirrors flushDamage's rule)", () => {
      const { build, mastCells, sailCells } = fresh();
      for (const c of [...mastCells[0], ...sailCells[0]]) build.grid.remove(c.x, c.y, c.z);
      // an absurdly large build-time footing denominator → live fraction ≈ 0 < MAST_SUPPORT_MIN_FRAC
      const plan = planRigRepair(build, mastCells, sailCells, [false], [Number.MAX_SAFE_INTEGER]);
      expect(plan).toHaveLength(0);
    });
  });
  ```
- [ ] Run `npx vitest run tests/repairSails.test.ts` — expected **FAIL** (`planRigRepair` doesn't exist).
- [ ] In `src/game/ship.ts` add near `yawInertia` (COMPLETE):
  ```ts
  /** One restored rig cell: grid coords + the material to stamp back (SPAR | CANVAS). */
  export interface RigRepairCell { x: number; y: number; z: number; mat: number }

  /** PURE planner for port sail-repair (round 12 — unit-testable without Rapier). A STANDING mast
   *  regrows its shot-out trunk/yard/canvas cells; a FELLED mast (mastAlive false — its voxels were
   *  severed off as debris) is fully re-stepped, but ONLY if the hull carrying its step still holds
   *  MAST_SUPPORT_MIN_FRAC of the build-time footing (mirror of flushDamage's felling rule — you
   *  cannot re-rig a mast on a blown-open bow; hull repair is out of scope). footInit ≤ 0 = footing
   *  untracked → allow (same semantics as flushDamage's skip). Deterministic grid reads only. */
  export function planRigRepair(
    build: ShipBuild,
    mastCells: { x: number; y: number; z: number }[][],
    sailCells: { x: number; y: number; z: number }[][],
    mastAlive: boolean[],
    mastFootInit: number[],
  ): { mi: number; cells: RigRepairCell[] }[] {
    const grid = build.grid;
    const out: { mi: number; cells: RigRepairCell[] }[] = [];
    for (let mi = 0; mi < mastCells.length; mi++) {
      if (!mastAlive[mi]) {
        const footInit = mastFootInit[mi] ?? 0;
        if (footInit > 0) {
          const mx = build.masts[mi].x;
          const frac = mastFootingCells(grid, mx, build.deckYAt(mx)) / footInit;
          if (frac < MAST_SUPPORT_MIN_FRAC) continue; // no step left to rig on
        }
      }
      const cells: RigRepairCell[] = [];
      for (const c of mastCells[mi]) if (grid.get(c.x, c.y, c.z) === EMPTY) cells.push({ x: c.x, y: c.y, z: c.z, mat: SPAR });
      for (const c of sailCells[mi]) if (grid.get(c.x, c.y, c.z) === EMPTY) cells.push({ x: c.x, y: c.y, z: c.z, mat: CANVAS });
      if (cells.length > 0) out.push({ mi, cells });
    }
    return out;
  }
  ```
- [ ] Add the callback field next to `onCannonLost` (~157):
  ```ts
  /** Fired by port repair when a FELLED mast is about to be re-stepped, so the game layer can
   *  despawn that ship's floating rig debris (wired in main.ts to debris.removeRigFor — the
   *  round-12 wave-1 API). Optional: unwired, the stale debris still waterlogs + self-despawns
   *  within TUN.rig.fallLifetime (~40 s); only the visual duplicate lingers briefly. */
  onRigRepair?: (ship: Ship) => void;
  ```
- [ ] Replace `repairSails()` (COMPLETE — keep the original doc comment's first line, extend it):
  ```ts
  /** Port repair: re-grow every still-standing mast's shot-out trunk/yard/canvas voxels AND
   *  re-step FELLED masts whose hull footing survives (round 12 — a fully dismasted ship repairs
   *  at port; the felled rig's floating debris is despawned via onRigRepair). Restored cells
   *  re-enter EVERY live structure the carve removed them from: grid, Rapier hull voxel collider,
   *  packed surface set (ship-ship contact), buoyancy columns + mass properties, walkable deck
   *  collider, and the visual mesh. (Pre-round-12 this only wrote the grid + remeshed — repaired
   *  rig was intangible to contact and weightless; fixed for standing-mast repair too.) */
  repairSails(): void {
    const grid = this.build.grid;
    const plan = planRigRepair(this.build, this.mastCells, this.sailCells, this.mastAlive, this.mastFootInit);
    // despawn the floating rig debris of any felled mast we are about to re-step
    if (plan.some((m) => !this.mastAlive[m.mi])) this.onRigRepair?.(this);
    const nz = grid.dims[2];
    let restored = 0;
    for (const m of plan) {
      for (const c of m.cells) {
        grid.set(c.x, c.y, c.z, c.mat);
        try { this.hull.collider.setVoxel(c.x, c.y, c.z, true); } catch { /* collider mid-teardown — skip */ }
        this.dirtyColumns.add(c.x * nz + c.z); // INVARIANT: every live grid mutation records its column
        this.markColliderChunkDirty(c.x, c.y, c.z);
        restored++;
      }
      this.sailIntegrity[m.mi] = 1;
    }
    if (restored > 0) {
      // restored cells re-enter the hull boundary — full recompute is fine here (port-time, not a hot path)
      this.surface = computeSurface(grid);
      this.seedSurfacePacked();
      this.hullTopLocalY = -1; // restored CANVAS/SPAR may raise the tracked top
      this.recomputeMassProperties(); // consumes dirtyColumns → columns + mass + tuned inertia restored
      this.rebuildDeckCollider(); // player-only inside; re-sweeps just the dirtied chunks
    }
    this.updateMastState(); // re-derives mastAlive / mastTopY / sailIntegrity from the restored grid
    this.visual.refresh(); // remesh the hull + rig from the restored grid
  }
  ```
  Note: all names used are already imported/present in ship.ts (`computeSurface`, `mastFootingCells`, `MAST_SUPPORT_MIN_FRAC`, `SPAR`, `CANVAS`, `EMPTY`, `seedSurfacePacked`, `markColliderChunkDirty`, `recomputeMassProperties`, `rebuildDeckCollider`, `updateMastState`) — verify at execution since wave-1 C touched this file.
- [ ] Run `npx vitest run tests/repairSails.test.ts` — expected **PASS**. Then `npm run build` + `npm run test` — green (port.test.ts uses a stubbed Ship with its own `repairSails` — unaffected; verify).
- [ ] Commit:
  ```
  git add src/game/ship.ts tests/repairSails.test.ts
  git commit -m "feat(ship): port repair re-steps FELLED masts + full post-repair refresh

  repairSails now restores felled masts (SPAR+CANVAS from build lists) when the hull footing
  survives, fires onRigRepair so main.ts can despawn the floating rig via debris.removeRigFor
  (wave-1 API; graceful without wiring), and puts restored cells back into the hull collider,
  surface set, buoyancy columns, mass props and deck collider (pre-existing gap for standing-mast
  repair, fixed). Pure planner planRigRepair unit-tested.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 7: Pacing audit — report + TUN nudge decision

**Files** — CREATE `docs/superpowers/plans/2026-07-01-round12-pacing-report.md` (the explicit deliverable). READ-ONLY audit sources (verify each number against source before writing): `src/game/islandField.ts` (FIELD_M 1400, LAGOON_M 150, HARBOR_MIN/MAX 320/460, 8 wild islands r 28–93 m, 50 m min edge gap, `M_PER_VOX = 1.0`), `src/sim/islandwright.ts`, `src/main.ts` spawn ring `R = 105` (~474), `src/game/cannons.ts` `Cannons.RELOAD = 6` / `game/ai.ts` AI reload 9.5, `TUN.gun`, `sim/materials.ts`, `sim/fleetSpawn.ts` (threat divisor 120), `sim/shipwright.ts` port counts (2/4/5/6 per side + 2/4/6/8 chasers).

**Interfaces** — none. **Decision (made in this plan, from the numbers): apply ZERO TUN nudges.** Justification is in the report: every pacing lever either sits at a played-in value (gun/flood knobs), lives in a frozen file (spawn ring, AI reload, escalation divisor), or is structural (world scale) — and the audit's one real finding is that **turn time was the pacing bottleneck and SP3 just fixed it**. "At most 2–3 conservative nudges" is satisfied by zero; knob-twiddling without play data is riskier than none.

- [ ] Write `docs/superpowers/plans/2026-07-01-round12-pacing-report.md` with this content (verify every cited constant in source first; correct any that wave 1 moved):
  - **Cruise speed vs the world.** Calm-water full-sail equilibrium 17.7–20.3 m/s (34–39 kn) per tier (derivation table from this plan). Finding: code comments still claim "low-20s knots" — drifted; actual is ~2× that. Archipelago: radius 1400 m, harbor 320–460 m from spawn (17–25 s sail), 8 wild islands (28–93 m radius, ≥50 m gaps) + 12 sea stacks; full field crossing ≈ 2.5 min. Verdict: island density is fine at current speed; the world reads small for 38-kn hulls — **deferred structural option**: scale `FIELD_M`/island count, or a global speed retune (thrust constant is inline in sailing.ts — out of SP3's mandate).
  - **Enemy spawn distance.** Arena ring R = 105 m ahead (main.ts ~474) vs effective gun range ~250 m at 5° (max ~550 m): combat opens inside range immediately — matches the design intent ("a broadside's reach out"). No change (frozen file anyway).
  - **Reload cadence.** Player 6 s × 0.88^level; AI 9.5 s; ripple spread 1.6 s. Broadside weight 2/4/5/6 guns per side. Time-between-effective-broadsides ≈ reload + re-positioning; SP3 cut big-ship 90° re-position from 7.2/9.7 s (brig/frigate) to 4.5/5.5 s — **the retune itself is the round's pacing fix**.
  - **Time-to-kill.** Ball bore budget = ½·4.3·v²·13: muzzle 629 kJ ≈ 42 oak cells (15 kJ/cell; RAM 22.5); at 100 m (v≈117 m/s) ≈ 25 cells ≈ a 3-wide bore through a wall into the hold; at 250 m (v≈80) ≈ 12 cells ≈ barely one wall. Low hits: a 9–18-cell underwater bore ≈ 0.2–0.7 m³/s inflow (inflowScale 0.5) vs pump 0.3 m³/s (AI never pumps). Rough TTK: Cutter (241 m³ displacing, 8 holds) ~2–3 low broadsides + settle; Frigate (2149 m³, 11 holds) ~6–12 broadsides over several minutes, accelerating as she settles. Coherent tier ladder; no gun/flood nudge warranted without playtest.
  - **TUN nudges applied: none** (justification above). **Deferred list:** world scale vs real cruise speed; spawn-ring R (main.ts owner); escalation divisor 120 (sim/fleetSpawn.ts, already flagged in CLAUDE.md follow-ups); fix the stale "low-20s knots" comments; optional dev-panel slider for `rudderLeverExp` (main.ts owner).
- [ ] `npm run build` + `npm run test` — green (docs-only change; run anyway per constraint).
- [ ] Commit:
  ```
  git add docs/superpowers/plans/2026-07-01-round12-pacing-report.md
  git commit -m "docs(pacing): round-12 pacing audit - numbers per tier, zero TUN nudges applied

  Island spacing vs actual 34-39kn cruise, 105m spawn ring vs ~250m gun range, 6s/9.5s reload
  cadence, per-tier bore-budget + flood-rate TTK. Finding: turn time was the pacing bottleneck;
  SP3 fixes it. Structural items deferred with owners.

  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
  ```

### Task 8: Final verification

- [ ] `npm run build` — clean (type-checks everything; vitest does not).
- [ ] `npm run test` — full suite green. If `tests/brig.test.ts` / `tests/manOfWar*.test.ts` symmetric tests fail, re-run isolated (`npx vitest run tests/brig.test.ts`) before treating as red — known CPU-load false-fail.
- [ ] `git status --porcelain` — confirm NO modifications outside the owned set (`src/game/ship.ts`, `src/game/sailing.ts`, `src/core/tunables.ts`, `tests/*`, the pacing report). Confirm nothing is staged from frozen files. Do NOT push.
- [ ] Report to the orchestrator for the wave-2 in-browser pass: verify turn feel per tier (t90 stopwatch vs the table), hard-turn bank ~30–45° with no capsize, low-speed pivot feel (authority rose ~1.7–2.3×; if twitchy, `rudderLeverExp`/`rudderLowFloor` are the live knobs), and full-dismast → port repair → rig restored + debris despawned (needs the main.ts `onRigRepair` wiring — hand-off note in Task 6).

---

### Critical Files for Implementation
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\game\ship.ts` — yaw inertia constructor block, yaw-damping line, turn-heel fade, `repairSails`
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\game\sailing.ts` — rudder torque + new hull-length lever
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\core\tunables.ts` — `phys.yawDamp`, new `phys.rudderLeverExp`
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\tests\sailing.test.ts` — the stub-ship pattern the new harness extends (fake gains `grid.dims`)
- `C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\game\debris.ts` — READ-ONLY: verify wave-1 `removeRigFor(ship)` signature before Task 6
