# Voxel rig consolidation — masts, yards, sails & bowsprit become voxels — 2026-06-18

Fold the entire standing rig into the ship's voxel grid and delete the parallel mesh + lattice
rig systems. User mandate: *"we screwed up by trying to render them as anything other than voxels …
make them nothing special, just more voxels in the closest approximation of the shapes."*

**Supersedes `2026-06-16-voxel-rig-design.md`** (the lattice-rig design: `sim/rigBuild` + `sim/rigLattice`
+ `game/rig` + `render/rigVisual`). That round made the mast *trunk* voxels but kept yards, sails, the
upper topmast and the bowsprit as meshes/lattice — which is the seam this round removes.

## Symptom → root cause (verified in code)

| Symptom (user's words) | Root cause | Where |
|---|---|---|
| "Collision physics when masts/sails break is extremely janky" | A felled mast's yards+sails are **mesh clones** tumbled as a rigid group, handed off to a debris body, while `updateRig` races to hide the statics as the trunk voxels vanish — two fall systems kept in sync across a seam | `render/shipVisual.detachMast`/`cloneMastRig`/`updateRig`, `game/debris.spawnMast(mastRig)` |
| Bowsprit behaves unlike everything else | It's a **separate lattice** (`game/rig.ts` + `sim/rigLattice`) with its own bore + rigid-chunk fall + mesh clone | `game/rig.ts`, `sim/rigBuild.ts`, `sim/rigLattice.ts` |
| Sails punctured by analytic math, not the voxel ball | Cannon path runs an analytic segment-vs-rectangle test (`rigDamage.segmentSailHit`) *in front of* the voxel bore | `game/cannons.ts:285`, `sim/rigDamage.ts` |

The mast *trunk* is already voxels (`SPAR` id 13, `shipwright.stampMasts`) and breaks/severs/falls
correctly. Everything bolted around it is the special-case layer; this round removes the layer.

## Goals

1. **One destruction rule (LAW #4).** Mast, yards, sails and bowsprit are grid voxels; cannons, rams,
   severing and falling all reuse the existing voxel systems — no rig-specific physics.
2. **Sails stay breakable, even with the mast intact.** A ball punches real voxel holes in the canvas;
   holes cut thrust; a felled mast/yard drops the cloth that hangs off it. (User: keep the breakable
   sails — "a nice touch.")
3. **Don't capsize her (LAW #2/#3).** Big sail areas sit high; canvas must be near-massless so the COM
   barely moves and she still rides upright under sail.
4. **Maximize voxelization without breaking things.** Cannons, helm wheel and rudder stay meshes (the
   user's explicit line); everything else in the rig becomes voxels.

## Non-goals

- Cloth simulation / billow. Voxel sails are rigid and blocky, with hard-edged holes. (User: "nothing
  special.")
- Re-tuning ram/crush balance, ballistics, or flooding. This is a representation change; existing
  `TUN.crush`/`TUN.gun` semantics carry over.
- Touching the rudder/wheel/cannon meshes (kept) beyond removing their now-dead rig neighbors.

## Design

### A — Unified voxel rig stamping (`sim/shipwright.ts`)

Extend the mast-stamp pass (today `stampMasts`, run before `weldToSingleComponent`, after
`castFlatBallast`) into a single `stampRig` that lays the whole assembly as one face-connected voxel
island anchored through the deck plank to the keel. All parts live in the mast's x-plane (`x = mx`,
the bowsprit excepted) so they read as a flat square-rig silhouette and stay 18-connected.

- **Mast trunk** — 2×2 voxels (was 1×2): `x ∈ {mx, mx+1}`, `z ∈ {floor(cz), ceil(cz)}` (the existing
  mirror pair → port/starboard symmetric). `SPAR`. Rises `h` m from `deckYAt(mx)+1` as today; still
  grid-capped on the frigate/MoW.
- **Yards** — 1-voxel-thick horizontal `SPAR` bars at `x = mx`, one voxel tall, spanning
  `z ∈ [cz − w/2, cz + w/2]` at each of the 3 current `YARD_LEVELS` (widths `0.71/0.57/0.43 × h`).
  Centered on `cz` → symmetric; passes through the mast column → face-connected.
- **Sails** — 1-voxel-thin `CANVAS` sheets at `x = mx` filling each bay between consecutive yards
  (2 bays/mast): `y` between the two yards, `z` over the (tapering) yard width. The sheet's top edge is
  face-adjacent to the upper yard and its bottom edge to the lower yard → connected; a mid-sheet hole
  leaves the rest hanging from those edges.
- **Bowsprit** — a voxel-rasterized thick line (≈3–4 voxel diameter, corners trimmable toward a
  circle) from the stem heel to a tip `≈0.28·L` forward at the current `0.3` rad steeve. `SPAR`. Grows
  out the bow → needs grid room (§E).

`stampRig` returns, per mast, the stamped `SPAR` voxels (as today, `mastVoxels[mi]`) **and** the
stamped `CANVAS` voxels (`sailVoxels[mi]`) so the build exposes which cells carry which mast's canvas
(for the integrity count, §C). Deterministic integer math; never overwrites existing solid.

### B — New `CANVAS` material (`sim/materials.ts`)

New id (e.g. `CANVAS = 14`):
- **density ~6–10 kg/m³** — a ~1 mm cloth sheet occupying a 0.25 m voxel is physically near-massless;
  this is the LAW #2/#3 safeguard so large sail areas up high barely lift the COM. (Final value tuned
  against the stability test, §F.)
- **strength ~0.3–0.5** — far softer than oak (3) / spar (1.5): a ball blows straight through and it
  adds almost no ram resistance.
- **color** — light weathered off-white canvas, distinct from `SPAR` brown. The voxel mesher already
  colors by material; add the entry.

A dedicated material (vs reusing `SPAR`) lets density/strength/color differ from wood **and** lets the
sever/integrity logic tell cloth from spar.

### C — Damage, sever, fall, thrust (mostly emergent)

- **Cannon puncture** — delete the analytic `rig.sails`/`segmentSailHit`/`puncture`/`hitMast` branch in
  `game/cannons.ts`; the existing `boreCells` → `ship.crush` already collects every solid cell on the
  ball's path, so it punctures a `CANVAS` sheet (mast intact or not) and chips/bores `SPAR`. "Cloth
  tears, ball flies on; a thick mast slows it" falls out of the energy budget (`STRENGTH_TO_JOULES`).
- **Sever → float** — `debris.routeIsland` already routes a `SPAR`-bearing severed island to a
  persistent floating body (`spawnMast`). Generalize `islandHasSpar` → also catch `CANVAS` so a
  severed pure-cloth chunk floats (then waterlogs) instead of dusting; keep a small-fragment → `dust`
  threshold so a 1–2 cell scrap doesn't spawn a body. `spawnMast`'s `mastRig` (pre-cloned mesh) param
  is removed — the yards/sails are now in the re-gridded voxel island itself.
- **Felling** — unchanged mechanism: crushing/shooting the trunk base, or `mastSupport.ts` footing
  undermining (kept), disconnects the assembly → one voxel island drops. `mastAlive[mi]` already
  derives from surviving `SPAR` voxels in `ship.updateMastState`.
- **Thrust integrity** — `sailing.ts` is unchanged in shape (reads `mastAlive[mi]` + `sailIntegrity[mi]`).
  Replace the analytic `ship.hitSail` accounting with a voxel count: in the throttled `updateMastState`,
  `sailIntegrity[mi] = survivingCanvas(mi) / sailVoxels[mi].length` (0 when the mast is down). Holes
  literally cut speed; the existing nonlinear feel curve can be kept or simplified.

### D — Deletions / simplifications (after an importer check)

- **Delete:** `game/rig.ts` (RigManager: bowsprit bore + falling-rig), `sim/rigLattice.ts`,
  `sim/rigBuild.ts`, `render/rigVisual.ts`. In `sim/rigDamage.ts` drop `segmentSailHit` +
  `segmentMastHit`; **keep `segmentBoxHit`** (the rudder uses it).
- **`render/shipVisual.ts`:** remove the mesh mast/yard/sail/upper-topmast/bowsprit drawing, the sail
  shader + `sailUniforms`, `SailRecord`/`sails`, `puncture`/`repairSails`, `detachMast`/`cloneMastRig`/
  `updateRig`/`detachBowsprit`/`spritMesh`/`mastRigs`. The voxel mesher now draws the whole rig.
- **`game/cannons.ts`:** remove the analytic sail/mast pre-test + `hitSails` dedup set; keep the bore.
- **`game/ship.ts`:** remove `hitSail`/`hitMast` analytic + the `updateRig` call; add the canvas-count
  integrity. `repairSails` at port becomes "regrow canvas voxels for a standing mast" or is folded into
  the existing hull repair (decide in the plan — port repair already rebuilds hull voxels).
- **`main.ts` / `game/world.ts`:** unwire the RigManager step + its `refresh()`/effects/scene hookups.
- **Wiring removed from the fixed step:** the bowsprit bore loop — ramming with the bowsprit now
  emerges from `voxelContact` (it's just forward-protruding hull voxels).

**Kept as meshes (user's explicit line):** cannons, helm wheel, rudder.

### E — Build / grid changes (`sim/shipwright.ts`)

- The angled bowsprit extends forward of the stem and slightly up. The grid gains a **forward x-margin**
  (and a little y-headroom) so the rasterized bowsprit fits inside `dims`; the hull is offset back by
  that margin so existing stations are unchanged. Empty cells are cheap (buoyancy early-breaks on dry/
  empty; mesher skips them).
- **Big ships** (frigate/MoW) already cap mast height at the grid top with a cosmetic topmast cylinder;
  that cylinder is deleted, so those masts simply end at their voxel cap — a touch shorter, fully
  consistent. No grid-height increase for them.

### F — Risks & verification

- **Stability (LAW #2/#3)** — re-run the "rides upright, COM < 0.6·deck" stability test for every tier
  after tuning `CANVAS`/`SPAR` density; canvas density is the lever. This is the gating check.
- **Perf** — sails are dry, so per-voxel buoyancy early-breaks over them (the known bottleneck is
  buoyancy, not mesh); flat sheets greedy-mesh into few quads. Still, every one of up to 6 enemies gains
  canvas voxels — verify fps with a full fleet (real GPU, fresh browser profile per the launcher notes).
  If needed, coarsen sail resolution (a dial).
- **Build + tests** — `npm run build` (tsc) **and** `npm run test` green. Rig-specific tests
  (`rigBuild`/`rigLattice`/`rigDamage` sail+mast) are deleted/replaced; add tests for `stampRig`
  geometry/connectivity/symmetry and the canvas-count integrity.
- **In-browser (the real oracle)** — (1) shoot a sail with the mast intact → voxel holes appear + speed
  drops; (2) shoot the mast base → the whole rig falls as one floating body, no mesh flicker; (3) ram an
  enemy bow-on → the bowsprit chips/snaps via the normal crush.

## Dials (chosen defaults — approved 2026-06-18)

- Mast **2×2** voxels; yards **1** thick; sails **1** thick.
- Bowsprit **~3–4 voxel diameter**, **`SPAR`** (light): it chips/snaps like the rest rather than acting
  as an invulnerable battering ram. (Bump its material toughness later if a fiercer ram is wanted — a
  tunable, not a redesign.)
- Sail blockiness: sized to look proportional; hard-edged holes + no billow accepted. Coarsen only if
  perf demands.
- Felled-mast water behavior: keep the current debris float-then-waterlog feel (`TUN.rig` float knobs
  migrate or are re-homed; the falling body reuses `debris.ts`).

## Test impact

- Remove: `rigBuild`/`rigLattice` unit tests; the sail/mast cases in `rigDamage` tests (keep
  `segmentBoxHit`/rudder cases).
- Add: `stampRig` geometry + 18-connectivity + port/starboard symmetry; severing the mast base drops
  the canvas island; `sailIntegrity` = surviving-canvas fraction; stability test stays green per tier.

## Open / deferred

- Whether port repair "re-rigs" canvas voxels or the rig only regrows on a fresh hull — decide in the
  plan (port repair already rebuilds hull voxels, so re-stamping the rig is the natural choice).
- Optional later polish: a subtle vertex wobble on canvas voxels for a hint of fill, if the flat look
  reads as dead. Out of scope for this round.
