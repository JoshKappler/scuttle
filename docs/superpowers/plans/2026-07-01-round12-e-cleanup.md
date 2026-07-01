# Cleanup & main.ts Extractions (Round 12, Agent E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**

Round-12 cleanup rider (agent E, wave 2 — runs AFTER agent D's handling commits are in): delete the two dead `TUN.flood.render` knobs (`skirtDepth`, `blendBand`) plus their dev-panel sliders; delete the zero-importer `sim/islandCollider.ts` (and its test) with a memory note; audit `render/post.ts` liveness (report only — it is LIVE); extract three self-contained subsystems out of the 2,441-line `src/main.ts` as **behavior-preserving pure moves** — aim-arc UI → `render/aimUI.ts`, cutaway controller → `render/cutawayController.ts`, player ship-swap flow → `game/shipSwap.ts`; record round 12 in CLAUDE.md and verify/fix the LAW #3 center-of-buoyancy correction; finish with a full in-browser smoke pass.

**Architecture**

- `render/aimUI.ts` (NEW): an `AimUI` class owning the fat-line trajectory pool + bearing/readout logic that currently lives at `main.ts` ~1398–1556. Pure math (`classifyBearing`, `gunBears`, `integrateAimArc`) is exported at module level so it unit-tests without a scene (pattern: `render/audioMath.ts`). **Invariant preserved:** the preview reads `TUN.gun.muzzleSpeed`/`TUN.gun.drag` + `FIXED_DT`/`G` live at draw time — the module imports `TUN` directly, exactly like the moved code, so rendered trajectory ≡ real shot stays true (CLAUDE.md `gun` section).
- `render/cutawayController.ts` (NEW): a `CutawayController` owning the X-toggle state, the ship-frame centerline `THREE.Plane`, the camera-side normal flip, the `interiorFill` PointLight, and the per-frame `shipVisual.setCutaway`/`updateCutawayCull` + `ocean.updateCutaway` calls (currently `main.ts` ~937–985, ~1066–1072, ~2230–2233, ~2310–2339). It goes in `render/` because every collaborator it drives is render-side (`ShipVisual`, `Ocean`, a scene light).
- `game/shipSwap.ts` (NEW): a `ShipSwap` class owning `swapPlayerShip`/`rebuildPlayerShip`/`respawnPlayerAtPort` (currently `main.ts` ~597–659). The complete rebind list lives in ONE place: game-layer rebinds (world add/remove/focus, debris callbacks, msg toasts, `port.setShip`, `fleet.setTarget`, `character.setShip`) are done directly; the main.ts-owned live bindings (`sloop`/`sloopVisual`/`currentTier` lets, render-hook rebinding, HUD flood strip, cutaway carry-over, `atWheel`) go through an explicit `PlayerShipBinding` interface of callbacks. `rebindPlayerRenderHooks()` STAYS in main.ts (it mutates main-scoped render state: `sloopProfile`, `slotShip`, `_dynShips`, aim pool, `prevGunsReady`) and is passed in as one callback.
- Everything moved is a literal move: same math, same call order, same allocation pattern. main.ts keeps construction + hotkey dispatch + per-frame ticks.

**Tech Stack**

TypeScript (strict, `noUnusedLocals` — leftover imports FAIL `tsc`), Three.js (incl. `three/examples/jsm/lines` fat lines), Rapier3D compat, Vite (dev on :5173, strictPort), Vitest (`tests/**/*.test.ts`, node env, does NOT type-check), Playwright MCP for in-browser verification.

## Global Constraints

- `npm run build` AND `npm run test` must pass before every commit (**vitest does NOT type-check** — a red `tsc` hides behind green tests; `npm run build` = `tsc --noEmit && vite build`).
- Stage ONLY owned files via explicit `git add <paths>` (never `git add -A` / `git add .`) — concurrent agents share this working dir; sibling files may be dirty.
- Do NOT push (the orchestrator pushes per wave).
- Do NOT edit frozen files. **Owned:** `src/main.ts`, `src/render/aimUI.ts` (new), `src/render/cutawayController.ts` (new), `src/game/shipSwap.ts` (new), `src/core/tunables.ts` (the two dead knobs ONLY), `src/sim/islandCollider.ts` (deletion), `CLAUDE.md`, `tests/aimUI.test.ts` (new), `tests/islandCollider.test.ts` (deletion). **Frozen (do not touch):** `game/ship.ts`, `game/sailing.ts`, `game/cannons.ts`, `game/gunnery.ts`, `game/port.ts`, `game/fleet.ts`, `game/world.ts`, `game/debris.ts`, `game/playerCharacter.ts`, all of `render/` except the two new files, all of `sim/` except the islandCollider deletion, all other tests, `package.json`, `vite.config.ts`, `tsconfig.json`.
- Every extraction is behavior-preserving: no logic changes while moving, no renames of behavior, no "improvements" — imports/exports/`this.`-plumbing only. Any line that differs from the moved original is shown explicitly in this plan.
- One extraction per commit, so any regression bisects instantly. After EACH extraction: build + test gate AND a dev-server boot smoke (game reaches the menu, sandbox starts, zero new console errors).
- Brig/frigate symmetric tests can false-fail under CPU load (known flake, 20 s timeout in `vite.config.ts`) — re-run isolated (`npx vitest run tests/brig.test.ts`) before declaring red.

**Line-number caveat (READ FIRST):** all `main.ts` line numbers below were verified at commit `3316ef4` (pre-wave-1). Wave-1 agent B adds ~1 line of sail wiring to `main.ts` and agent D has churned `tunables.ts`/`sailing.ts`/`ship.ts`, so numbers may shift by a few lines. Locate every block by its **anchor** (function name / comment quoted in each task) and verify the content matches this plan before moving it. THE RULE: the code wins.

---

### Task 1: Delete dead TUN knobs `flood.render.skirtDepth`/`blendBand` + their dev-panel sliders

**Files**
- `src/core/tunables.ts` — inside `flood.render` (block ~320–337): delete the `skirtDepth: 1.6,` entry + its 2-line doc comment (~321–323) and the `blendBand: 0.7,` entry + its 3-line doc comment (~330–333). Keep `topOpacity`, `skirtOpacity`, `shimmer` (all live in `render/compartmentFluid.ts`).
- `src/main.ts` — the last two sliders of the `"🔧 Crunch (ship-vs-ship)"` dev-panel section + their 2-line comment (~1976–1979; anchor: `label: "flood skirt m"`).
- `CLAUDE.md` — the `flood` tunables bullet (~line 53) still claims the knobs are "kept so the dev panel sliders don't break".

**Steps**

- [ ] Verify dead at execution time (agent D churned tunables.ts): `grep -rn "skirtDepth\|blendBand" src/` — expected hits ONLY `src/core/tunables.ts` (declarations) and `src/main.ts` (the two sliders). If any NEW reader appeared in wave 1, STOP and report instead of deleting.
- [ ] In `src/core/tunables.ts` delete exactly these lines (comment + knob, twice):
```ts
      /** max metres the side skirt drops below the pool surface (the body's visible depth/substance).
       *  Clamped to the compartment's actual floor depth, so a shallow pool shows a shallow body. */
      skirtDepth: 1.6,
```
```ts
      /** metres of level-difference (interior pool below local sea) over which the skirt fades from
       *  fully HIDDEN (inside ≈ sea, big-hole case → no exposed wall) up to fully shown (small hole,
       *  inside well below the sea). Smaller = the wall pops in sooner as the level drops. */
      blendBand: 0.7,
```
- [ ] In `src/main.ts` delete exactly these four lines:
```ts
        // flood-water render: side-skirt depth + the band over which the skirt fades out as the
        // interior pool equalises to the sea (so a big-hole flood blends flush with the breach).
        { type: "slider", label: "flood skirt m", obj: TUN.flood.render, key: "skirtDepth", min: 0, max: 4, step: 0.1 },
        { type: "slider", label: "flood blend m", obj: TUN.flood.render, key: "blendBand", min: 0.1, max: 3, step: 0.1 },
```
- [ ] In `CLAUDE.md` (~line 53), replace the clause `` `skirtDepth`/`blendBand` are now UNUSED (kept so the dev panel sliders don't break)`` with ``the dead `skirtDepth`/`blendBand` knobs + their dev-panel sliders were DELETED (round 12)``.
- [ ] Gate: `npm run build` AND `npm run test` green.
- [ ] Commit:
```
git add src/core/tunables.ts src/main.ts CLAUDE.md
git commit -m "chore(tunables): delete dead TUN.flood.render skirtDepth/blendBand + their dev-panel sliders

Read by nothing since the R4 solid-volume flood render replaced the skirt;
the dev-panel sliders were their only remaining references (verified by grep).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Delete unwired `sim/islandCollider.ts` + its test (memory note in CLAUDE.md)

**Files**
- `src/sim/islandCollider.ts` — 45 lines; its ONLY export is `surfaceBandVoxels(grid, waterlineY, below, above): Int32Array`.
- `tests/islandCollider.test.ts` — 3 tests; the file's ONLY importer in the whole repo (verified: `grep -rn "islandCollider" --include="*.ts" src/ tests/` → only the test's import; all other hits are docs/CLAUDE.md prose).
- `CLAUDE.md` — the archipelago bullet (~line 14) parenthetical that says the file "is kept in the tree but unwired".

**Steps**

- [ ] Re-verify zero production importers: `grep -rn "islandCollider\|surfaceBandVoxels" src/` — expected: only the declaration file itself. (The 2026-06-16 audio spec's "leave it" note is superseded by the approved round-12 spec: "remove the unwired surfaceBandVoxels export (or the file, with a memory-note)".)
- [ ] `git rm src/sim/islandCollider.ts tests/islandCollider.test.ts`
- [ ] In `CLAUDE.md` (~line 14), replace the parenthetical ``(`sim/islandCollider.ts surfaceBandVoxels` — origin/main's earlier rigid voxel-collider approach — is kept in the tree but unwired; the deformable crush superseded it.)`` with ``(the earlier rigid voxel-collider approach — `sim/islandCollider.ts surfaceBandVoxels` — was DELETED in round 12 after sitting unwired; the deformable crush superseded it. Recover from git history if ever wanted.)``
- [ ] Gate: `npm run build` AND `npm run test` green (test count drops by 3 — expected).
- [ ] Commit:
```
git add -u src/sim/islandCollider.ts tests/islandCollider.test.ts
git add CLAUDE.md
git commit -m "chore(sim): delete unwired islandCollider.ts (surfaceBandVoxels) + its test

Zero production importers (verified); its vitest file was the only consumer.
Memory note: this was the pre-deformable-crush rigid voxel-collider surface
(rapier Voxels-vs-Trimesh gap workaround) - superseded by game/voxelContact
terrain crush; recoverable from git history.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `render/post.ts` liveness audit (report-only — expected finding: LIVE)

**Files** — none edited. Audit only.

**Steps**

- [ ] `grep -rn "render/post\|from \"./post\"\|new Post(" src/` and confirm the finding (verified at plan time): `render/post.ts` is **LIVE** — imported at `src/main.ts:9`, constructed as the post-processing composer (`const post = new Post(renderer, bgScene, scene, camera, seam)` ~line 427), and driven per frame (`post.setSize` in `fitViewport` ~930, `post.setSun` ~2407, `post.render()` ~2419 behind `TUN.gfx.post.enabled`).
- [ ] No code change, no comment added anywhere. Record the finding as a trailer line in the NEXT cleanup commit's message (Task 4's commit — see its message below).

---

### Task 4: Extract aim-arc UI from `main.ts` → `render/aimUI.ts`

**Files**
- `src/render/aimUI.ts` — NEW (complete code below).
- `src/main.ts` — remove the block ~1398–1556 (anchor: comment `// broadside trajectory preview while aiming (RMB)` through the closing brace of `updateAimArc`), EXCEPT the line `const _camFollow = new THREE.Vector3();` (~1455) which is camera state used at ~2280 and STAYS in main.ts. Rewire 8 call sites (listed below). Drop now-unused imports.
- `tests/aimUI.test.ts` — NEW (pure-math tests below).

**What the block contains (all moves):** `ARC_PTS` (~1401), `ARC_SUB` (~1406), `aimLines` (~1407), `rebuildAimLines()` (~1413–1447) + its top-level call (~1448), `lookV`/`_aimInv` (~1453–1454), `type Bearing` (~1456), `aimBearing()` (~1457–1463), `gunBears()` (~1464–1466), `gunReadout()` (~1468–1492), `arcMuzzle` (~1494), `updateAimArc()` (~1495–1556).

**Verified external references being rewired:** `rebuildAimLines()` at ~641 (inside `rebindPlayerRenderHooks`); `aimBearing()` at ~793, ~809 (fire), ~2203 (`bearNow`), ~2218 (`sloopVisual.animate` aim arg); `aimLines` resolution loop at ~931 (`fitViewport`); `gunReadout()` at ~1316 and ~1370 (HUD); `updateAimArc()` at ~2212. `gunBears`/`arcMuzzle`/`lookV`/`_aimInv`/`ARC_*` have no other references (verified by grep).

**Interfaces**

```ts
// render/aimUI.ts — exports
export type Bearing = 1 | -1 | "fore" | "aft";
export const ARC_PTS = 64;
export const ARC_SUB = 6;
export function classifyBearing(lookLocalX: number, lookLocalZ: number): Bearing;
export function gunBears(p: { side: 1 | -1; facing?: "fore" | "aft" }, b: Bearing): boolean;
export function integrateAimArc(out: Float32Array, muzzlePos: THREE.Vector3, muzzleDir: THREE.Vector3,
  muzzleSpeed: number, drag: number, seaHeight: (x: number, z: number) => number): void;
export interface AimUIDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls: { aiming: boolean; elevationDeg: number; traverseDeg: number }; // main passes its PlayerControls
  cannons: {
    portReload(ship: Ship, portIndex: number, simTime: number): number;
    portReloadFrac(ship: Ship, portIndex: number, simTime: number): number;
  }; // main passes its Cannons
  waves: Wave[];
  getShip(): Ship;      // LIVE player ship (reassigned on hull swap) — main passes () => sloop
  getSimTime(): number; // main passes () => world.simTime
}
export class AimUI {
  constructor(d: AimUIDeps);            // calls rebuildAimLines() (mirrors the old top-level call)
  rebuildAimLines(): void;              // resize pool to the current hull's larger broadside
  aimBearing(): Bearing;                // camera-look battery pick
  gunReadout(): { frac: number; ready: number; total: number };
  updateAimArc(): void;                 // per-frame preview redraw
  setResolution(w: number, h: number): void; // fat-line px-width tracking (was the fitViewport loop)
}
```

**Steps**

- [ ] Create `src/render/aimUI.ts` with this COMPLETE content (bodies are the main.ts code moved verbatim except the shown substitutions: `sloop` → `this.d.getShip()` captured as a local, `world.simTime` → `this.d.getSimTime()`, `controls`/`cannons`/`scene`/`camera`/`waves` → `this.d.*`, `aimLines` → `this.lines`; the original comments move with their code — the plan elides a few long comment blocks with `// [original comment moved verbatim]`, which means copy them from main.ts):

```ts
import * as THREE from "three";
import { Line2 } from "three/examples/jsm/lines/Line2.js";
import { LineGeometry } from "three/examples/jsm/lines/LineGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { muzzleWorld, type MuzzleOut } from "../game/gunnery";
import { surfaceHeight, type Wave } from "../sim/gerstner";
import { FIXED_DT, G } from "../core/constants";
import { TUN } from "../core/tunables";
import type { Ship } from "../game/ship";

/** Broadside trajectory preview + battery-bearing logic, extracted from main.ts (round 12,
 *  pure move). INVARIANT (CLAUDE.md `gun`): the preview reads the SAME live ballistics the
 *  ball uses — TUN.gun.muzzleSpeed/drag at draw time, integrated at the ball's own
 *  FIXED_DT/G step — so the rendered trajectory ≡ the real shot, dev-panel sliders included. */

export type Bearing = 1 | -1 | "fore" | "aft";

// [original comment moved verbatim: "broadside trajectory preview while aiming (RMB)…"]
export const ARC_PTS = 64; // vertices in the preview polyline
// [original comment moved verbatim: "integrate the preview at the ball's exact step…"]
export const ARC_SUB = 6;

/** Pure battery pick from the camera look direction expressed in SHIP-LOCAL axes:
 *  more along the keel than across it lays the bow/stern CHASERS; across lays the broadside. */
export function classifyBearing(lookLocalX: number, lookLocalZ: number): Bearing {
  if (Math.abs(lookLocalX) > Math.abs(lookLocalZ)) return lookLocalX >= 0 ? "fore" : "aft";
  return lookLocalZ >= 0 ? 1 : -1;
}

export function gunBears(p: { side: 1 | -1; facing?: "fore" | "aft" }, b: Bearing): boolean {
  return typeof b === "number" ? !p.facing && p.side === b : p.facing === b;
}

/** Pure preview integration — the exact loop moved from main.ts updateAimArc:
 *  muzzle velocity along the barrel, NO ship carry, Euler at FIXED_DT with quadratic drag,
 *  1 vertex per ARC_SUB steps, tail clamped to the splash point where the arc meets the sea. */
export function integrateAimArc(
  out: Float32Array,
  muzzlePos: THREE.Vector3,
  muzzleDir: THREE.Vector3,
  muzzleSpeed: number,
  drag: number,
  seaHeight: (x: number, z: number) => number,
): void {
  const v = muzzleDir.clone().multiplyScalar(muzzleSpeed);
  const p = muzzlePos.clone();
  let vi = 0;
  for (let stepN = 0; vi < ARC_PTS; stepN++) {
    if (stepN % ARC_SUB === 0) {
      out[vi * 3] = p.x;
      out[vi * 3 + 1] = p.y;
      out[vi * 3 + 2] = p.z;
      vi++;
    }
    const sp = v.length();
    v.x += -drag * sp * v.x * FIXED_DT;
    v.y += (-G - drag * sp * v.y) * FIXED_DT;
    v.z += -drag * sp * v.z * FIXED_DT;
    p.addScaledVector(v, FIXED_DT);
    if (p.y < seaHeight(p.x, p.z)) {
      for (let j = vi; j < ARC_PTS; j++) {
        out[j * 3] = p.x;
        out[j * 3 + 1] = p.y;
        out[j * 3 + 2] = p.z;
      }
      break;
    }
  }
}

export interface AimUIDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  controls: { aiming: boolean; elevationDeg: number; traverseDeg: number };
  cannons: {
    portReload(ship: Ship, portIndex: number, simTime: number): number;
    portReloadFrac(ship: Ship, portIndex: number, simTime: number): number;
  };
  waves: Wave[];
  getShip(): Ship;
  getSimTime(): number;
}

export class AimUI {
  private readonly lines: { line: Line2; geo: LineGeometry; mat: LineMaterial; pos: Float32Array }[] = [];
  private readonly lookV = new THREE.Vector3();
  private readonly _aimInv = new THREE.Quaternion(); // reused — aimBearing() runs several times/frame
  private readonly arcMuzzle: MuzzleOut = { pos: new THREE.Vector3(), dir: new THREE.Vector3() };

  constructor(private readonly d: AimUIDeps) {
    this.rebuildAimLines(); // mirrors the old top-level rebuildAimLines() call in main.ts
  }

  // [original comment moved verbatim: "(Re)build one preview polyline per gun… FAT lines (Line2)…"]
  rebuildAimLines(): void {
    for (const a of this.lines) {
      this.d.scene.remove(a.line);
      a.geo.dispose();
      a.mat.dispose();
    }
    this.lines.length = 0;
    const build = this.d.getShip().build;
    const gunsPerSide = Math.max(
      build.cannonPorts.filter((p) => p.side === 1).length,
      build.cannonPorts.filter((p) => p.side === -1).length,
    );
    for (let i = 0; i < gunsPerSide; i++) {
      const pos = new Float32Array(ARC_PTS * 3);
      const geo = new LineGeometry();
      geo.setPositions(pos); // seed the attribute; updateAimArc refills it each frame
      // [original comment moved verbatim: "bold red-orange dashes…"]
      const mat = new LineMaterial({
        color: 0xff3a22,
        linewidth: 3.6,
        transparent: true,
        opacity: 0.98,
        dashed: true,
        dashSize: 1.4,
        gapSize: 0.9,
        depthTest: true,
      });
      mat.resolution.set(window.innerWidth, window.innerHeight);
      const line = new Line2(geo, mat);
      line.frustumCulled = false;
      line.visible = false;
      this.d.scene.add(line);
      this.lines.push({ line, geo, mat, pos });
    }
  }

  // [original comment moved verbatim: "which battery the camera bears toward…"]
  aimBearing(): Bearing {
    const rot2 = this.d.getShip().body.rotation();
    const inv = this._aimInv.set(rot2.x, rot2.y, rot2.z, rot2.w).invert();
    this.d.camera.getWorldDirection(this.lookV).applyQuaternion(inv);
    return classifyBearing(this.lookV.x, this.lookV.z);
  }

  // [original doc comment moved verbatim: "Reload readout for the bottom-right meter…"]
  gunReadout(): { frac: number; ready: number; total: number } {
    const ship = this.d.getShip();
    const simTime = this.d.getSimTime();
    const aiming = this.d.controls.aiming;
    const key = this.aimBearing();
    let total = 0;
    let ready = 0;
    let fracSum = 0; // sum of each gun's CONTINUOUS readiness (0 just-fired → 1 loaded)
    for (let i = 0; i < ship.build.cannonPorts.length; i++) {
      if (!ship.cannonAlive[i]) continue;
      if (aiming && !gunBears(ship.build.cannonPorts[i], key)) continue;
      total++;
      if (this.d.cannons.portReload(ship, i, simTime) <= 0) ready++;
      fracSum += this.d.cannons.portReloadFrac(ship, i, simTime);
    }
    return { frac: total > 0 ? fracSum / total : 0, ready, total };
  }

  updateAimArc(): void {
    // [original comment moved verbatim: "the WHOLE broadside, wherever you stand…"]
    const ship = this.d.getShip();
    const portIdxs: number[] = [];
    if (this.d.controls.aiming) {
      const bearing = this.aimBearing();
      ship.build.cannonPorts.forEach((p, i) => {
        if (ship.cannonAlive[i] && gunBears(p, bearing)) portIdxs.push(i);
      });
    }
    const simTime = this.d.getSimTime();
    const seaAt = (x: number, z: number) => surfaceHeight(this.d.waves, x, z, simTime);
    for (let pi = 0; pi < this.lines.length; pi++) {
      const arc = this.lines[pi];
      if (pi >= portIdxs.length) {
        arc.line.visible = false;
        continue;
      }
      arc.line.visible = true;
      // [original comment moved verbatim: "PURE-bore trajectory — muzzle velocity along the barrel, NO ship carry…"]
      muzzleWorld(ship, portIdxs[pi], this.d.controls.elevationDeg, this.d.controls.traverseDeg, this.arcMuzzle);
      // read the SAME live ballistics the ball uses (TUN.gun) so the preview
      // tracks the dev-panel sliders in lock-step with the real shot.
      integrateAimArc(arc.pos, this.arcMuzzle.pos, this.arcMuzzle.dir, TUN.gun.muzzleSpeed, TUN.gun.drag, seaAt);
      arc.geo.setPositions(arc.pos); // push the fresh curve into the fat-line instanced buffers
      arc.line.computeLineDistances(); // dashes need fresh arc lengths
    }
  }

  /** Fat aim lines size their width in px — track the canvas (was the fitViewport loop). */
  setResolution(w: number, h: number): void {
    for (const a of this.lines) a.mat.resolution.set(w, h);
  }
}
```

- [ ] In `src/main.ts`, replace the whole moved block (~1398–1556) with (note `_camFollow` survives here):
```ts
  // broadside trajectory preview + battery bearing/readout — extracted to render/aimUI.ts
  // (round 12, pure move). Reads TUN.gun live so the line ≡ the real shot, as before.
  const aimUI = new AimUI({
    scene,
    camera,
    controls,
    cannons,
    waves,
    getShip: () => sloop,
    getSimTime: () => world.simTime,
  });
  const _camFollow = new THREE.Vector3(); // reused — char third-person follow target each frame
```
- [ ] Rewire the 8 call sites (exact replacements):
  - ~641: `rebuildAimLines(); // resize…` → `aimUI.rebuildAimLines(); // resize…` (keep the comment)
  - ~793 and ~809: `cannons.fireBroadside(sloop, aimBearing(), t, …)` → `cannons.fireBroadside(sloop, aimUI.aimBearing(), t, …)`
  - ~931: `for (const a of aimLines) a.mat.resolution.set(w, h); // fat aim lines…` → `aimUI.setResolution(w, h); // fat aim lines size their width in px`
  - ~1316: `gunReadout().frac` → `aimUI.gunReadout().frac`
  - ~1370: `const gun = gunReadout();` → `const gun = aimUI.gunReadout();`
  - ~2203: `const bearNow = aimBearing();` → `const bearNow = aimUI.aimBearing();`
  - ~2212: `updateAimArc();` → `aimUI.updateAimArc();`
  - ~2218: `{ bearing: aimBearing(), …}` → `{ bearing: aimUI.aimBearing(), …}`
- [ ] Fix main.ts imports (`noUnusedLocals` will enforce): DELETE lines 2–4 (`Line2`, `LineGeometry`, `LineMaterial`), DELETE `import { muzzleWorld } from "./game/gunnery";` (~45), change `import { FIXED_DT, G, VOXEL_SIZE } from "./core/constants";` (~46) → `import { VOXEL_SIZE } from "./core/constants";`, and ADD `import { AimUI } from "./render/aimUI";`. (`surfaceHeight` stays — still used at ~1613/~2303/~2413.)
- [ ] Create `tests/aimUI.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { classifyBearing, gunBears, integrateAimArc, ARC_PTS } from "../src/render/aimUI";

describe("classifyBearing", () => {
  it("keel-dominant look lays the chasers", () => {
    expect(classifyBearing(1, 0.5)).toBe("fore");
    expect(classifyBearing(-1, 0.5)).toBe("aft");
  });
  it("beam-dominant look lays that broadside", () => {
    expect(classifyBearing(0.3, 1)).toBe(1);
    expect(classifyBearing(0.3, -1)).toBe(-1);
  });
  it("an exact tie goes to the broadside (strict > on |x|)", () => {
    expect(classifyBearing(1, 1)).toBe(1);
  });
});

describe("gunBears", () => {
  it("broadside guns bear only for their numeric side, chasers never do", () => {
    expect(gunBears({ side: 1 }, 1)).toBe(true);
    expect(gunBears({ side: 1 }, -1)).toBe(false);
    expect(gunBears({ side: 1, facing: "fore" }, 1)).toBe(false);
  });
  it("chasers bear only for their facing", () => {
    expect(gunBears({ side: 1, facing: "fore" }, "fore")).toBe(true);
    expect(gunBears({ side: 1, facing: "aft" }, "fore")).toBe(false);
    expect(gunBears({ side: 1 }, "fore")).toBe(false);
  });
});

describe("integrateAimArc", () => {
  const abyss = () => -1e9; // sea far below → the full arc always fits
  it("writes the muzzle as vertex 0 and fills all ARC_PTS vertices", () => {
    const out = new Float32Array(ARC_PTS * 3);
    integrateAimArc(out, new THREE.Vector3(2, 5, 3), new THREE.Vector3(1, 0, 0), 150, 0.0025, abyss);
    expect([out[0], out[1], out[2]]).toEqual([2, 5, 3]);
    expect(out[(ARC_PTS - 1) * 3]).toBeGreaterThan(2); // downrange
  });
  it("drag shortens range vs the drag-free arc", () => {
    const noDrag = new Float32Array(ARC_PTS * 3);
    const dragged = new Float32Array(ARC_PTS * 3);
    const dir = new THREE.Vector3(1, 0.2, 0).normalize();
    integrateAimArc(noDrag, new THREE.Vector3(0, 10, 0), dir, 150, 0, abyss);
    integrateAimArc(dragged, new THREE.Vector3(0, 10, 0), dir.clone(), 150, 0.0025, abyss);
    expect(dragged[(ARC_PTS - 1) * 3]).toBeLessThan(noDrag[(ARC_PTS - 1) * 3]);
  });
  it("clamps the tail to the splash point once the arc meets the sea", () => {
    const out = new Float32Array(ARC_PTS * 3);
    integrateAimArc(out, new THREE.Vector3(0, 2, 0), new THREE.Vector3(1, 0, 0), 150, 0.0025, () => 0);
    expect(out[(ARC_PTS - 2) * 3]).toBe(out[(ARC_PTS - 1) * 3]); // repeated splash vertex
    expect(out[(ARC_PTS - 1) * 3 + 1]).toBeLessThanOrEqual(0);
  });
});
```
- [ ] Gate: `npm run build` AND `npm run test` green.
- [ ] Boot smoke: dev server up on :5173 (start `npm run dev` in background if needed), Playwright: load, start Sandbox, hold RMB → red dashed arcs appear per gun; press F → the balls fly the drawn line; console free of new errors.
- [ ] Commit:
```
git add src/render/aimUI.ts src/main.ts tests/aimUI.test.ts
git commit -m "refactor(main): extract aim-arc UI -> render/aimUI.ts (pure move)

Behavior-preserving: pool rebuild on hull swap, bearing pick, reload readout,
and the FIXED_DT/G/TUN.gun preview integration are moved verbatim; preview
still reads the identical live ballistics as the ball (line == shot invariant).
Pure math (classifyBearing/gunBears/integrateAimArc) exported + unit-tested.

Round-12 audit note: render/post.ts is LIVE (imported+driven by main.ts:
composer construction, setSize, setSun, render) - kept.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Extract cutaway controller from `main.ts` → `render/cutawayController.ts`

**Files**
- `src/render/cutawayController.ts` — NEW (complete code below).
- `src/main.ts` — four regions:
  1. State block ~937–985 (anchor: comment `// cutaway damage view (X): a FIXED half-cut of the PLAYER ship.` through the end of `const updateHole = () => {…};`): `cutaway`, `cutPlane`, `cutNormalWorld`, `cutPointWorld`, the `interiorFill` PointLight, `holeQ`/`holeFwd`/`holeCenter`, `updateHole`.
  2. Hotkey ~1066–1072 (anchor: `if (e.code === "KeyX") {`).
  3. Per-frame interior-fill positioning ~2230–2233 (anchor: comment `// keep the interior fill at the player hull's centre of mass`).
  4. Per-frame cutaway block ~2310–2339 (anchor: `if (cutaway) {` … ends with the `// (no ship-local backing bowl…` comment).
  5. Hull-swap carry-over ~629–631 inside `rebuildPlayerShip` (anchor: `if (cutaway) visual.setCutaway(cutPlane);`).

**Verified collaborator signatures:** `ShipVisual.setCutaway(plane: THREE.Plane | null): void` and `updateCutawayCull(): void` (render/shipVisual.ts:290/343 — the cull side is re-derived from the shared plane's live orientation, which is why holding ONE `THREE.Plane` instance and mutating it per frame is load-bearing); `Ocean.setCutaway(on: boolean)` and `Ocean.updateCutaway(shipPos, fwdX, fwdZ, cutPlane)` (render/ocean.ts:96/100).

**Interfaces**

```ts
// render/cutawayController.ts — exports
export interface CutawayDeps {
  scene: THREE.Scene;                                   // hosts the interiorFill light
  camera: THREE.Camera;                                 // camera-side normal flip
  ocean: Pick<Ocean, "setCutaway" | "updateCutaway">;   // sea hole around the player
  getShip(): Ship;                                      // LIVE player ship — main passes () => sloop
}
export class CutawayController {
  constructor(d: CutawayDeps);        // builds + scene-adds the interiorFill PointLight
  readonly enabled: boolean;          // getter over the toggle state
  toggle(): void;                     // X hotkey body (visual.setCutaway + ocean.setCutaway)
  onShipSwapped(): void;              // carry the cut onto a freshly-built hull (no-op when off)
  updateInteriorFill(): void;         // per-frame: park the fill light at the hull COM
  update(): void;                     // per-frame: plane rebuild + side flip + sea hole + re-cull (no-op when off)
}
```

**Steps**

- [ ] Create `src/render/cutawayController.ts` with this COMPLETE content (all bodies are the main.ts code moved verbatim with `sloop` → `ship` local from `this.d.getShip()`, `camera` → `this.d.camera`, `ocean` → `this.d.ocean`; the long design comments at ~937–969 move to the class header — copy them verbatim):

```ts
import * as THREE from "three";
import type { Ship } from "../game/ship";
import type { Ocean } from "./ocean";

// [original comment blocks moved verbatim from main.ts ~937-969: "cutaway damage view (X)…",
//  "CUTAWAY SEA BACKING…", "INTERIOR FILL — 'the inside of the ship is always well lit…'"]

export interface CutawayDeps {
  scene: THREE.Scene;
  camera: THREE.Camera;
  ocean: Pick<Ocean, "setCutaway" | "updateCutaway">;
  getShip(): Ship;
}

export class CutawayController {
  private on = false;
  private readonly cutPlane = new THREE.Plane();
  // the ship-local beam axis (+Z) and a point on the keel centerline, reused each frame
  // to rebuild the world-space centerline cut plane from the live hull pose.
  private readonly cutNormalWorld = new THREE.Vector3();
  private readonly cutPointWorld = new THREE.Vector3();
  private readonly interiorFill: THREE.PointLight;
  private readonly holeQ = new THREE.Quaternion();
  private readonly holeFwd = new THREE.Vector3();
  private readonly holeCenter = new THREE.Vector3();

  constructor(private readonly d: CutawayDeps) {
    this.interiorFill = new THREE.PointLight(0xfff0d8, 0.9, 26, 1.6);
    this.interiorFill.castShadow = false;
    d.scene.add(this.interiorFill);
  }

  get enabled(): boolean {
    return this.on;
  }

  /** X hotkey. Only the PLAYER ship is cut — the plane is HER centerline (the camera
   *  follows her). Enemy hulls stay whole; they're inspected from afar. */
  toggle(): void {
    this.on = !this.on;
    this.d.getShip().visual.setCutaway(this.on ? this.cutPlane : null);
    this.d.ocean.setCutaway(this.on);
  }

  /** If the cutaway is on, carry it onto the freshly-built hull (the plane is the player's
   *  centerline; update() keeps it tracking the new ship's pose). Call AFTER the swap has
   *  re-pointed the live ship reference. */
  onShipSwapped(): void {
    if (this.on) this.d.getShip().visual.setCutaway(this.cutPlane);
  }

  /** Keep the interior fill at the player hull's centre of mass — it rides inside the
   *  hold so it lights the lower deck / compartments / flood water (seen via cutaway or
   *  a breach) at all times, then falls off well before reaching the open sea. */
  updateInteriorFill(): void {
    const com = this.d.getShip().body.worldCom();
    this.interiorFill.position.set(com.x, com.y, com.z);
  }

  private updateHole(ship: Ship): void {
    const rotS = ship.body.rotation();
    this.holeQ.set(rotS.x, rotS.y, rotS.z, rotS.w);
    this.holeFwd.set(1, 0, 0).applyQuaternion(this.holeQ);
    this.holeFwd.y = 0;
    this.holeFwd.normalize();
    const fp = ship.build.footprint;
    ship.localToWorld([(fp.minX + fp.maxX) / 2, 2, fp.zC], this.holeCenter);
    this.d.ocean.updateCutaway(this.holeCenter, this.holeFwd.x, this.holeFwd.z, this.cutPlane);
  }

  /** Per-frame while on: STATIC half-cut, fixed to the SHIP — rebuild the world-space
   *  centerline plane from the live pose, flip the normal to face away from the camera
   *  (the near half clips), refresh the sea hole, and re-cull the hull half as the
   *  camera orbits. [remaining original comments moved verbatim from main.ts ~2310-2338] */
  update(): void {
    if (!this.on) return;
    const ship = this.d.getShip();
    const rotS = ship.body.rotation();
    this.holeQ.set(rotS.x, rotS.y, rotS.z, rotS.w);
    this.cutNormalWorld.set(0, 0, 1).applyQuaternion(this.holeQ);
    this.cutNormalWorld.y = 0;
    this.cutNormalWorld.normalize();
    const fp = ship.build.footprint;
    ship.localToWorld([(fp.minX + fp.maxX) / 2, 2, fp.zC], this.cutPointWorld);
    if (
      this.cutNormalWorld.x * (this.d.camera.position.x - this.cutPointWorld.x) +
        this.cutNormalWorld.z * (this.d.camera.position.z - this.cutPointWorld.z) >
      0
    ) {
      this.cutNormalWorld.negate();
    }
    this.cutPlane.setFromNormalAndCoplanarPoint(this.cutNormalWorld, this.cutPointWorld);
    this.updateHole(ship);
    this.d.getShip().visual.updateCutawayCull();
  }
}
```

- [ ] In `src/main.ts` replace region 1 (~937–985) with:
```ts
  // cutaway damage view (X) — toggle state, centerline plane, camera-side flip, interior
  // fill light and the ocean hole all live in render/cutawayController.ts (round 12, pure move).
  const cutawayCtl = new CutawayController({ scene, camera, ocean, getShip: () => sloop });
```
- [ ] Region 2 — replace the KeyX handler body (~1066–1072) with:
```ts
    if (e.code === "KeyX") cutawayCtl.toggle();
```
- [ ] Region 5 — inside `rebuildPlayerShip` replace (~629–631) `// if the cutaway is on…` + `if (cutaway) visual.setCutaway(cutPlane);` with:
```ts
    cutawayCtl.onShipSwapped(); // carry the X cutaway onto the freshly-built hull
```
- [ ] Region 3 — replace the interior-fill block (~2226–2233, the comment + `{ const com = sloop.body.worldCom(); interiorFill.position.set(com.x, com.y, com.z); }`) with:
```ts
    cutawayCtl.updateInteriorFill();
```
- [ ] Region 4 — replace the whole `if (cutaway) { … }` block (~2310–2339) with:
```ts
    cutawayCtl.update();
```
  (The `if (!this.on) return;` inside `update()` preserves the exact gating; `ocean.updateCutaway` still runs only while cut, as before.)
- [ ] Add `import { CutawayController } from "./render/cutawayController";` to main.ts.
- [ ] Gate: `npm run build` AND `npm run test` green.
- [ ] Boot smoke: Playwright at :5173 — start sandbox, press X → solid voxel cross-section + interior stays lit + sea hole present; orbit the camera across the centerline → the open half flips; press X again → whole hull restored; no new console errors.
- [ ] Commit:
```
git add src/render/cutawayController.ts src/main.ts
git commit -m "refactor(main): extract cutaway controller -> render/cutawayController.ts (pure move)

Toggle state, ship-frame centerline plane, camera-side normal flip, interiorFill
light, ocean sea-hole and the per-frame setCutaway/updateCutawayCull calls move
verbatim; main.ts keeps construction + the X hotkey + two per-frame ticks.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Extract player ship-swap flow from `main.ts` → `game/shipSwap.ts` (riskiest — full rebind enumeration)

**Files**
- `src/game/shipSwap.ts` — NEW (complete code below).
- `src/main.ts` — replace the `// ---- hull swap …` block ~597–659 (`swapPlayerShip`, `rebuildPlayerShip`, `respawnPlayerAtPort` function declarations). **`rebindPlayerRenderHooks` (~633–643) STAYS in main.ts** — it mutates main-scoped render state (`sloopProfile` let + `makeProfileTex`, `ocean.setHullProfile`/`setFootprint`, `slotShip[0]`, `_dynShips[0]`, `aimUI.rebuildAimLines()`, `prevGunsReady = -1`) and is passed in as a callback. Rewire 4 call sites; add `shipSwap` to `window.DEBUG`.

**The complete rebind list (verified against main.ts ~601–659 — this is what the extraction centralizes):** capture old pose → `world.removeShip(old)` → `new ShipVisual` + `new Ship` (+rotation) → damage/debris callbacks (`onSevered`→`debris.spawn`, `onCannonLost`→`debris.spawnFallingCannon`, `onMastFelled`/`onRudderHit`→`msg.post` + `visual.chipRudder`) → `world.addShip` → re-point main's `sloop`/`sloopVisual` lets (the `DEBUG.sloop` getter reads these live, so DEBUG needs no rebinding) → `world.focus` → `port.setShip` → `fleet.setTarget` → `character.setShip` → render hooks (ocean profile atlas slot 0 + footprint + `slotShip[0]` + `_dynShips[0]` + aim-line pool + reload-bell baseline) → HUD flood strip rebuild (compartment count changed) → cutaway carry-over. Swap additionally sets `currentTier` + `port.syncAfterLoad()`; respawn additionally teleports seaward of the home dock, zeroes velocities, `port.syncAfterLoad()`, `character.reseat()`, `atWheel = true`.

**Interfaces**

```ts
// game/shipSwap.ts — exports
export interface PlayerShipBinding {
  getShip(): Ship;                              // main: () => sloop
  setShip(ship: Ship, visual: ShipVisual): void; // main reassigns the `sloop`/`sloopVisual` lets
  getTier(): ShipTierId;                        // main: () => currentTier
  setTier(id: ShipTierId): void;                // main reassigns `currentTier`
  rebindRenderHooks(): void;                    // main's rebindPlayerRenderHooks (ocean profile/footprint,
                                                //   slot 0, _dynShips[0], aim pool, reload-bell baseline)
  rebuildFloodSegments(): void;                 // HUD flood strip (compartment count changed)
  reapplyCutaway(): void;                       // main: () => cutawayCtl.onShipSwapped()
  setAtWheel(v: boolean): void;                 // respawn re-seats the captain at the helm
}
export interface ShipSwapDeps {
  physics: Physics;
  world: GameWorld;
  port: PortController;
  fleet: FleetManager;
  character: PlayerCharacter;
  debris: DebrisManager;
  msg: MessageBus;
  dock: { nearestDock(x: number, z: number): { x: number; z: number } | null }; // IslandField satisfies this
  binding: PlayerShipBinding;
}
export class ShipSwap {
  constructor(deps: ShipSwapDeps);
  swapPlayerShip(tierId: ShipTierId): void;   // shipyard purchase / save restore / sandbox config
  rebuildPlayerShip(build: ShipBuild): void;  // the full rebind, in ONE place
  respawnPlayerAtPort(): void;                // sink penalty respawn
}
```

**Steps**

- [ ] Create `src/game/shipSwap.ts` with this COMPLETE content (bodies moved verbatim from main.ts; every edited line — the `binding` indirections and the respawn's explicit re-fetch of the fresh ship — is shown here in full):

```ts
import { Ship } from "./ship";
import { ShipVisual } from "../render/shipVisual";
import type { Physics } from "./physics";
import type { GameWorld } from "./world";
import type { PortController } from "./port";
import type { FleetManager } from "./fleet";
import type { PlayerCharacter } from "./playerCharacter";
import type { DebrisManager } from "./debris";
import type { MessageBus } from "./messageBus";
import type { ShipTierId } from "./saveState";
import type { ShipBuild } from "../sim/shipwright";
import { tierById } from "./shipyard";

// ---- hull swap (shipyard purchase / save restore / respawn) ----
// Rebuild the player ship as a fresh hull, keeping world position/heading, and
// re-point every system that holds a player-ship reference. Extracted from main.ts
// (round 12, pure move): the COMPLETE rebind list lives HERE; the pieces main.ts
// owns (the live `sloop`/`sloopVisual`/`currentTier` bindings, render hooks, HUD
// flood strip, cutaway carry-over, atWheel) arrive through PlayerShipBinding.

export interface PlayerShipBinding {
  getShip(): Ship;
  setShip(ship: Ship, visual: ShipVisual): void;
  getTier(): ShipTierId;
  setTier(id: ShipTierId): void;
  rebindRenderHooks(): void;
  rebuildFloodSegments(): void;
  reapplyCutaway(): void;
  setAtWheel(v: boolean): void;
}

export interface ShipSwapDeps {
  physics: Physics;
  world: GameWorld;
  port: PortController;
  fleet: FleetManager;
  character: PlayerCharacter;
  debris: DebrisManager;
  msg: MessageBus;
  dock: { nearestDock(x: number, z: number): { x: number; z: number } | null };
  binding: PlayerShipBinding;
}

export class ShipSwap {
  constructor(private readonly d: ShipSwapDeps) {}

  swapPlayerShip(tierId: ShipTierId): void {
    this.d.binding.setTier(tierId);
    this.rebuildPlayerShip(tierById(tierId).build());
    this.d.port.syncAfterLoad(); // account-wide upgrades land on the new hull
  }

  rebuildPlayerShip(build: ShipBuild): void {
    const d = this.d;
    const old = d.binding.getShip();
    const at = old.body.translation();
    const rot = old.body.rotation();
    d.world.removeShip(old); // scene + geometry + rigid-body cleanup
    const visual = new ShipVisual(build);
    const fresh = new Ship(d.physics, build, visual, { x: at.x, y: Math.max(at.y, 0.5), z: at.z });
    fresh.body.setRotation(rot, true);
    fresh.onSevered = (isl) => isl.forEach((i) => d.debris.spawn(i, fresh));
    fresh.onCannonLost = (pi) => d.debris.spawnFallingCannon(fresh, pi);
    fresh.onMastFelled = () => d.msg.post("YOUR MAST GOES BY THE BOARD!");
    fresh.onRudderHit = (hp) => {
      visual.chipRudder(hp / 3);
      d.msg.post(hp > 0 ? "rudder hit — she answers slow!" : "RUDDER SHOT AWAY!");
    };
    d.world.addShip(fresh);
    d.binding.setShip(fresh, visual); // main.ts re-points its live `sloop`/`sloopVisual` lets
    d.world.focus = fresh; // keep the buoyancy LOD focus on the live player hull
    d.port.setShip(fresh);
    d.fleet.setTarget(fresh);
    d.character.setShip(fresh);
    d.binding.rebindRenderHooks();
    d.binding.rebuildFloodSegments(); // new hull → new compartment count → rebuild the flood readout
    d.binding.reapplyCutaway(); // if the cutaway is on, carry it onto the freshly-built hull
  }

  // Respawn a fresh hull of the current tier in clear water just seaward of the home
  // dock, and re-seat the captain at the wheel. (Used by the sink penalty.)
  respawnPlayerAtPort(): void {
    const d = this.d;
    this.rebuildPlayerShip(tierById(d.binding.getTier()).build());
    const sloop = d.binding.getShip(); // the FRESH hull just bound above
    const tr = sloop.body.translation();
    const dock = d.dock.nearestDock(tr.x, tr.z);
    if (dock) {
      sloop.body.setTranslation({ x: dock.x + 54, y: 0.6, z: dock.z }, true);
      sloop.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true); // bow SEAWARD (+x) — sail away from the dock
    }
    sloop.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    sloop.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    d.port.syncAfterLoad();
    d.character.reseat();
    d.binding.setAtWheel(true); // back at the helm
  }
}
```

- [ ] In `src/main.ts`, replace the block ~597–659 with the construction below **plus the KEPT `rebindPlayerRenderHooks` function declaration exactly as it stands today** (with its Task-4 `aimUI.rebuildAimLines()` line). All binding callbacks are lazy arrows, so referencing `cutawayCtl` (declared later, ~937) and `rebuildFloodSegments`/`atWheel` (declared later) is TDZ-safe — swaps only ever run after full init:
```ts
  // ---- hull swap (shipyard purchase / save restore / respawn): game/shipSwap.ts (round 12) ----
  // The full rebind list lives there; these callbacks hand it the main-owned live bindings.
  const shipSwap = new ShipSwap({
    physics,
    world,
    port,
    fleet,
    character,
    debris,
    msg: gs.msg,
    dock: islands, // IslandField.nearestDock — respawn teleports seaward of the home pier
    binding: {
      getShip: () => sloop,
      setShip: (ship, visual) => {
        sloop = ship;
        sloopVisual = visual;
      },
      getTier: () => currentTier,
      setTier: (id) => {
        currentTier = id;
      },
      rebindRenderHooks: () => rebindPlayerRenderHooks(),
      rebuildFloodSegments: () => rebuildFloodSegments(),
      reapplyCutaway: () => cutawayCtl.onShipSwapped(),
      setAtWheel: (v) => {
        atWheel = v;
      },
    },
  });
  function rebindPlayerRenderHooks(): void {
    // … UNCHANGED — keep the existing body verbatim (sloopProfile/ocean/slotShip/_dynShips/
    // aimUI.rebuildAimLines()/prevGunsReady) …
  }
```
- [ ] Rewire the 4 call sites:
  - ~562 (`port` `onSwapShip`): `swapPlayerShip(id);` → `shipSwap.swapPlayerShip(id);`
  - ~574 (`applySave`): `swapPlayerShip(s.shipTier);` → `shipSwap.swapPlayerShip(s.shipTier);`
  - ~902 (sink handler): `respawnPlayerAtPort();` → `shipSwap.respawnPlayerAtPort();`
  - ~2095 (`applyChoice`): `swapPlayerShip(cfg.shipTier as ShipTierId);` → `shipSwap.swapPlayerShip(cfg.shipTier as ShipTierId);`
- [ ] Add to the `window.DEBUG` object (~1097–1131), after `port,`: `shipSwap, // hull-swap flow (game/shipSwap.ts) — lets scripted checks swap tiers directly` (dev-surface only; documented in CLAUDE.md in Task 7).
- [ ] Imports: add `import { ShipSwap } from "./game/shipSwap";`; change ~line 20 `import { buildCutter, buildSloop, type ShipBuild } from "./sim/shipwright";` → `import { buildCutter, buildSloop } from "./sim/shipwright";` (`ShipBuild` was only used by the moved `rebuildPlayerShip`; `noUnusedLocals` enforces). `tierById` STAYS imported in main (still used by `spawnEnemy` ~463 and the unlock toast ~885).
- [ ] Gate: `npm run build` AND `npm run test` green.
- [ ] **Focused in-browser rebind check** (this is the risky one): Playwright at :5173 → start Sandbox (Cutter) → console `DEBUG.economy.state.doubloons = 10000; DEBUG.port.openPort()` → buy a Sloop in the shipyard tab → confirm `DEBUG.currentTier === "sloop"` and `DEBUG.sloop.build.cannonPorts.length` changed → close port → sail (W), RMB-aim (arc count matches the new hull's guns), F fire, X cutaway on the new hull → `DEBUG.port.openPort()` again (dock/port path still bound). Also `DEBUG.shipSwap.swapPlayerShip("brig")` from the console as a direct-path check. Zero console errors throughout.
- [ ] Commit:
```
git add src/game/shipSwap.ts src/main.ts
git commit -m "refactor(main): extract player ship-swap flow -> game/shipSwap.ts (pure move)

swapPlayerShip/rebuildPlayerShip/respawnPlayerAtPort move verbatim; the full
player-reference rebind list (world/focus, port, fleet target, character,
debris+msg callbacks, render hooks, flood HUD, cutaway carry, atWheel) now
lives in ONE place behind an explicit PlayerShipBinding type. main.ts keeps
rebindPlayerRenderHooks (its render state) + the live sloop/tier lets; DEBUG
gains a shipSwap handle. In-browser: port purchase, sail+fire+cutaway on the
swapped hull, and re-dock all verified.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CLAUDE.md round-12 note + LAW #3 verification

**Files** — `CLAUDE.md` only.

**Steps**

- [ ] Read the CLAUDE.md header first: wave-1 agents (A/B/C) and agent D may already have added round-12 text. If a round-12 entry exists, APPEND only the cleanup clause below to it; do not duplicate or rewrite their claims. Do NOT rewrite the round-11/10/… history.
- [ ] If no round-12 entry exists, prepend to the `_Last verified against code:` italic block (keeping round 11 text after it): `2026-07-01 — **round 12** (OVERHAUL — see docs/superpowers/specs/2026-07-01-round-12-overhaul-design.md: per-contact collision classification, cloth-mesh sails over voxel truth, perf caches, buoyancy stiffness decoupling, per-tier handling retune, cleanup). ` In all cases append the cleanup clause: ``Cleanup (agent E): `main.ts` shed three subsystems as pure moves — aim-arc UI → `render/aimUI.ts` (preview still reads TUN.gun live, line ≡ shot), cutaway → `render/cutawayController.ts`, hull-swap flow → `game/shipSwap.ts` (the full player-reference rebind list behind one `PlayerShipBinding` type); dead `TUN.flood.render.skirtDepth`/`blendBand` + the unwired `sim/islandCollider.ts` deleted; `render/post.ts` audited LIVE.``
- [ ] LAW #3 check (spec SP5 assigns the fix to wave-1 agent C): if line ~66 still reads `**Leeway drag applies at the COM**`, replace the bullet with: `3. **Leeway drag applies at the CENTER OF BUOYANCY** (below the COM — that offset is what rights her and banks turns; the code was right, the old doc was wrong), supplying the turn's centripetal pull; the bank is a separate emergent G-couple. Gotcha: moving force-application points casually flips righting and capsizes her under sail.` If agent C already fixed it, leave it untouched.
- [ ] Architecture section: add `shipSwap` to the `src/game/` list, `aimUI`, `cutawayController` to the `src/render/` list; update the `src/main.ts` line to `— entry / main loop / camera / FP viewmodel / window.DEBUG (aim UI, cutaway, ship-swap extracted round 12)`.
- [ ] `window.DEBUG` doc line (~33): add `shipSwap` to the exposed list.
- [ ] Run `npm run test`, note the real file/test counts, and refresh the stale `## Run / build / test` counts line (currently "39 files / ~278 tests") to the actual numbers printed.
- [ ] Gate: `npm run build` AND `npm run test` green (docs-only, but the gate is cheap and mandatory).
- [ ] Commit:
```
git add CLAUDE.md
git commit -m "docs: CLAUDE.md round-12 note (cleanup/extractions) + LAW #3 CB verification

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Full in-browser smoke pass (Playwright at :5173)

**Files** — none edited. Screenshots go to the **projects ROOT** (`C:\Users\joshu\OneDrive\desktop\projects\`), named `scuttle-r12e-*.png`.

**Steps**

- [ ] Ensure the dev server is serving THIS tree on :5173 (`npm run dev` background if needed; the `/__build` badge should show the Task-7 commit hash, not-dirty after all commits).
- [ ] Boot: navigate to `http://localhost:5173` → start menu renders (`scuttle-r12e-menu.png`); console clean.
- [ ] Start Sandbox → world builds, ship afloat (`scuttle-r12e-sea.png`).
- [ ] Sail: hold `W` a few seconds, `A`/`D` steer — speed HUD climbs, wake draws.
- [ ] Aim + fire: hold RMB → red dashed arcs, one per broadside gun (`scuttle-r12e-aim.png`); press `F` → tracer/balls follow the drawn line, reload meter drops then refills, bell rings on reload (`scuttle-r12e-fire.png`).
- [ ] Cutaway: press `X` → solid cross-section, lit interior, sea hole (`scuttle-r12e-cutaway.png`); orbit the camera across the centerline → open half flips; `X` again restores.
- [ ] Ship swap (the Task-6 rebind, end to end): console `DEBUG.economy.state.doubloons = 10000; DEBUG.port.openPort()` → buy a hull tier in the shipyard → close port → confirm `DEBUG.currentTier` changed, aim-arc count matches the new hull, sail + fire + `X` all work on it (`scuttle-r12e-swap.png`) → `DEBUG.port.openPort()` again (dock rebind holds).
- [ ] Esc pause: press `Escape` → pause menu (`scuttle-r12e-pause.png`); Resume → play continues.
- [ ] Read the full console log — zero uncaught errors/warnings introduced this round. If ANY check fails: STOP, apply superpowers:systematic-debugging against the single extraction commit that owns the failure (one extraction per commit = instant bisect), fix, re-gate, amend nothing — new fix commit.
- [ ] Report completion to the orchestrator with the screenshot list + `git log --oneline` of this workstream's commits. Do NOT push (orchestrator pushes wave 2).

---

### Critical Files for Implementation

- C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\main.ts
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\core\tunables.ts
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\sim\islandCollider.ts
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\CLAUDE.md
- C:\Users\joshu\OneDrive\desktop\projects\scuttle\src\render\shipVisual.ts (read-only reference — `setCutaway`/`updateCutawayCull` contracts)
