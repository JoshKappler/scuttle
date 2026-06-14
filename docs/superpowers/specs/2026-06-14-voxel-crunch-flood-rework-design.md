# Voxel Crunch + Flood Rework — Design Spec

_2026-06-14. Follow-up to `2026-06-13-voxel-destruction-core-design.md`, after live playtest of the deformable-contact rebuild._

> **THE RULE (CLAUDE.md):** when a doc disagrees with the code, the code wins. This spec is grounded in a live Playwright reproduction (numbers below), not theory.

## 1. The complaints (verbatim intent)

After the deformable-collision overhaul shipped, the player reported:

1. Damage happens **all at once**, not voxel-by-voxel; wants a soft, gradual "two wet-wood / two big Lego ships" crunch.
2. Ramming tears **huge holes in the bottom and back of the RAMMING ship — in places that never touched anything** — and both ships **sink immediately**. Specifically: *"two long stretches on the left and right side of the bottom spanning about a quarter of the length, plus smaller holes up front on the bottom,"* while *"the front of the ramming ship ends up totally fine."*
3. Damaged ships **sink far too fast**; should be a gradual, dramatic process. Even without a big hole she floods and founders almost instantly.
4. The hole punched in the **target** is a single instantaneous deletion; should grow voxel-by-voxel.
5. The hole in the rammed ship should be **the shape of the rammer's bow** (an imprint), and the rammer's bow should take **light** damage where it touches.
6. The flooded-water visual is **"weird blue rectangles"** that are not bound to the hull interior and are not truly fluid; wants per-voxel water bound to the inside.
7. Governing principle: **only voxels actually touching (or nearly touching) the other hull should change per tick.**

## 2. Root-cause diagnosis (live evidence)

Reproduced via `window.ramTest` on the brig (player, 152×42×44, 18 312 solid cells) vs the sloop enemy. Instrumented `carveCells`/`crush` and diffed the solid set before/after.

**The contact carve is CORRECT and already local.** Over the whole ram it removed **11 cells**, all at the **bow** (x 124-138), all **high** (y 15-27, at/above the waterline), almost all **RAM/pine** — exactly the contact patch.

**The damage the player sees comes from `findSevered`, not the contact.** The same ram deleted **593 cells via the sever path** (which bypasses `carveCells` — `flushDamage` calls `grid.remove` directly): spanning the **entire length** (x 15-138), **almost entirely the bottom** (580 / 593 are low-y), **perfectly symmetric** port/starboard (296 / 297), mostly cheap **oak**. That is precisely complaint #2.

**Why:** the pristine hull is **not one connected piece.** A 6-connectivity component scan of the freshly-built brig finds **1 main component (17 818 cells, contains the keel anchor) + 26 disconnected islands totalling 494 cells** — the iron ballast tiers and a few shell/structure bits, which sit only *diagonally* adjacent to the curved shell. The moment **any** damage fires `flushDamage → findSevered`, every one of those 494 pre-disconnected cells is declared "severed" and removed at once — below the waterline, symmetric, full-length, nowhere near the contact. The shipwright author already knew this failure mode (`shipwright.ts` rail-post comment: *"a cap cell without a post under it would float … it would sever as debris on the first hit anywhere"*) but only fixed it for the rail caps.

**The instant-sink follows directly:** that 593-cell below-waterline hole is an enormous breach. `breachInflow = 0.6·area·√(2g·depth)` per cell, so ~hundreds of breach cells flood the holds in ~1-2 s → `waterAboard` jumped to **535 m³** in the repro → founder. Fix the bogus sever and the breach (hence the flooding) shrinks to the real contact hole.

**"All at once" / "single punch":** partly the 593-cell sever lump (above); partly that a single `ramTest` impulse makes the rammer bounce off after ~11 cells and disengage, so the hole never grows. Sustained (sail-driven) contact must grind progressively.

## 3. Design — four fixes, in priority order

### FIX 1 — Connectivity (the catastrophe). `sim/shipwright.ts`, `sim/connectivity.ts`, `game/ship.ts`
- **Weld pass at build:** after a hull is rasterised, guarantee it is a **single 6-connected solid**. Find all components; for every non-main component, fill the shortest run of EMPTY cells to the main mass with a bridge voxel (member's own material, or OAK), repeat until one component. Re-run `findCompartments` afterwards so volumes reflect the (handful of) bridge cells. Deterministic.
- **`findSevered` becomes safe** once the hull is one piece: a non-anchor component can now only appear from a real cut. Add a **minimum island size** for spawning a debris *body* (tiny chips are just removed → dust, never a floating rigid sliver). Keep the "anchor cell destroyed → largest component is the ship" fallback.
- **Acceptance:** a fresh hull is exactly **1** connected component (new unit test). After a bow ram, the rammer loses **only** cells at/near the contact; **zero** bottom/stern cells vanish that weren't carved. The 3-watertight-compartments and watertight-shell invariants still hold; draft/trim essentially unchanged.

### FIX 2 — Gradual, local crunch + bow imprint. `game/voxelContact.ts`, `core/tunables.ts`
- **Rate-limit the carve per step** so each fixed step removes at most a thin contact layer (`TUN.crush.maxCellsPerStep`), cheapest/most-penetrating first. The capped penalty spring keeps the hulls engaged, so sustained contact grinds the hole **deeper over many steps** instead of one dump → the bow-shaped imprint emerges and the animation softens.
- **Lower the effective per-step carve energy** so material toughness actually bites at the contact (today's multi-MJ budget removes any candidate regardless of material). The RAM bow should lose only a few cells (light damage) while the struck oak caves — emergent, no special-case.
- Keep carving **only `ov.aCells` / `ov.bCells`** (the real overlap) — already correct; do not broaden.
- **Acceptance:** a sustained ram visibly eats the target voxel-by-voxel into a bow-shaped pocket; the rammer's RAM bow takes only light, local damage; side-by-side nudging still removes 0 cells.

### FIX 3 — Gradual flooding & sinking. `game/ship.ts`, `sim/compartments.ts`, `core/tunables.ts`
- Most of this is **free** once FIX 1 removes the giant breach: flooding then comes only from the real contact hole. Verify live; if a legitimately holed ship still founders too fast, expose flood/founder rates as tunables (`breach discharge`, `waterlog` ramp) and slow them so sinking is a ~minute-scale, fightable process (pumps/plugs matter).
- **Acceptance:** a ship holed at the waterline settles and founders gradually (tens of seconds), listing toward the breach; an undamaged ship never floods.

### FIX 4 — Per-voxel interior fluid. `render/compartmentFluid.ts` (replace), `game/ship.ts`/`render/shipVisual.ts` wiring
- Replace the counter-rotated clipped **plane** (the "blue rectangles") with **water rendered as voxels** that fill each compartment's interior **air cells** up to a **world-horizontal** level derived from `waterVolume`. Bound to the interior by construction (only compartment cells), pools to the low side when listing (level is world-Y), and reads as voxel-by-voxel. Rebuild the water mesh only when the level crosses a cell boundary (throttled); translucent water shading keyed to the ocean palette.
- **Acceptance:** flooded water appears as cubes inside the hull, never as slabs poking through the shell; rises as she floods; drains with the pump.

## 4. Non-goals / out of scope
- Full Navier–Stokes / inter-cell fluid flow (FIX 4 is a level-fill, not CFD).
- Reworking buoyancy, sailing, gunnery ballistics, or the ocean.
- The brig/sloop hull shapes and tuned trim — preserved; the weld pass must be trim-neutral.

## 5. Risks
- Weld bridges could perturb compartment count or trim → re-run `findCompartments`, assert the 3-compartment + density tests, live-check draft.
- Rate-limiting the carve too hard lets a fast ram interpenetrate before it grinds through → tune `maxCellsPerStep` against the spring at the live harness.
- Voxel water meshing cost → throttle rebuilds to cell-crossings; cap per-compartment cell count.

## 6. Verification
All four fixes are runtime/visual and must be verified **live** (Playwright at :5173 + readback), per the GPU-verification rule — `tsc` and the vitest oracle pass blind to these. Deterministic pieces (weld → single component; planCrush rate cap) also get vitest unit tests.
