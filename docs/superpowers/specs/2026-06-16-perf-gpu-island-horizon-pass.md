# Perf / GPU diagnosis + island + horizon pass — 2026-06-16 (round 2)

Follows the overnight `8321ce7`-era work. Driven by a fresh playtest: "20 fps with three
ships, GPU reads as a GTX 980 not my 5080; the transparency around the hull is a white line
that negates the cutout; calculate fewer voxels until ships are near; hitting an island freezes;
the skybox is still a hollow cylinder/painted ceiling." Autonomy granted; this is the spec I
followed. Everything below was measured on the user's real RTX 5080 via headed Playwright
(system Chrome + Edge), not the headless software renderer.

## 1. THE HEADLINE: the 20 fps + "GTX 980" is a STALE BROWSER GPU PROFILE, not the game

Definitive measurements:
- `Win32_VideoController`: the machine has **exactly one real GPU, the RTX 5080**, driving a
  **3840×2160 (4K)** display. The only other adapter is a "Meta Virtual Monitor" (VR virtual
  display, not a renderer). **There is no physical GTX 980.**
- A **freshly-launched** browser on this machine (both system Chrome AND Edge, via Playwright
  `channel`) reports the GPU correctly as `ANGLE (NVIDIA GeForce RTX 5080 … D3D11)` and runs the
  **3-frigate scene at native 4K at ~174–182 fps**.
- Dropping 4K→1080p left fps **unchanged** → the game is **CPU-buoyancy-bound, not GPU-fill-bound,
  even at native 4K** (buoyancy ≈ 7.8 ms of an ~8 ms frame; rapier/visual ≈ 0.1 ms each). The 540p
  reading of 34 fps was a Chrome occluded-window throttle artifact, not signal.

Conclusion: the 5080 is present, correct, and fast here. The user's "GTX 980 + 20 fps" is their
**specific long-lived Edge session** (open since 6/14, many tabs) stuck on a degraded/stale GPU
path — almost certainly this PC was a GTX 980 before the 5080 and the browser profile cached the
old GPU's state / a degraded GPU process. A fresh GPU process fixes it.

**User remedy (≈30 s, no code):** fully QUIT Edge (every window) and reopen, then hard-reload
(Ctrl+Shift+R). If it still says 980, use Chrome or clear Edge's GPU cache, or use the EXE (which
forces the discrete GPU). The hard-reload ALSO pulls in current code — a 2-day-old tab is why "the
skybox looks exactly the same" (they never loaded the overnight horizon work).

**Shipped diagnostic (`perf.ts`):** a one-time banner when fps stays low (>6 s <28 fps) on a
HARDWARE GPU — names the (possibly-wrong) GPU string and nudges a full browser restart. This is
exactly the failure mode above; it would have told the user immediately.

## 2. White waterline foam ring — CUT (shipped `2acbd9e`)
`ocean.ts` drew an always-on `wlFoam` white ring hugging every hull's sea-cutout edge ("appears
white and totally negates … the nice hole cutout"). Removed it; the sea now meets the clean cut with
no ring. Bonus: drops up to MAXVIS×5 profile-atlas texture taps + a per-slot ellipse pass per ocean
fragment (a free fill saving). Verified on-GPU: no ring, hull reads clean. The `seaAlpha` depth-fade
("transparency beneath the hole") was NOT the culprit in open water (deep floor → opaque); left as-is.

## 3. Buoyancy LOD for distant ships — shipped (`8321ce7`)
Buoyancy (`surfaceHeight` per column / ship / substep) is the CPU wall. The swell is smooth
(λ≥14 m), so per-column sampling is heavy oversampling. Ships far from the player (`world.focus`)
now reuse a `surfaceHeight` sample across a small world cell (0.8 m mid / 1.8 m far); near/player
ships and tests keep EXACT per-column sampling (bit-identical → 282 tests green). Verified: distant
buoyancy −55…75 %, identical `submergedFrac` across LOD tiers (no draft change), total buoy 7.8→3.9 ms.
The player ship (always exact) is the remaining floor; coarsening it too is possible but risks feel
and was left for a feel-test. ship-vs-ship `voxelContact` was ALREADY AABB-broad-culled, so that half
of the "don't calc every voxel until near" request was already done.

## 4. Horizon / clouds — improved (shipped `db7d092`) + research
Current code already looked decent on-GPU (gradient sky, clouds fading to haze, clean seam — the
"still looks the same" was the stale tab). Applied the research's core fix anyway: the cloud
projection's hard floor `max(up,0.30)` froze a smear RING at the horizon (the "ceiling/wall"). Replaced
with a small additive bias `up+0.16` so cells stretch continuously toward the horizon, + fade alpha to
0 by the horizon (`smoothstep(0.05,0.32,up)`) so the low band dissolves into the haze. Verified on-GPU:
clouds recede and dissolve, no ring. Research (full report in the session): a sky feels infinite when
its colour is a pure function of VIEW DIRECTION (zero parallax) — our dome already is; the flat-plane
cloud projection was the finiteness cue. Further options if wanted: multi-layer parallax cloud planes,
or Sea-of-Thieves-style mesh clouds; and keep ocean far-fog == sky horizon colour (already done) with
wave amplitude tapering to flat at the horizon.

## 5. Island collision — ROOT-CAUSED, fix DEFERRED (the handoff)
**Not a freeze or a launch — a DOWNWARD shove.** Reproduced by single-stepping a frigate into a wild
island at 4–7 m/s: `y` plunges 0→−7 (submerged 0.13→0.55) while the hull plows straight through the
plan footprint, never stopping. Rapier's rigid Voxels(ship)-vs-Voxels(island) contact resolves along a
**vertical** normal (shoves the shallow hull down/under the tall waterline collider band) instead of a
horizontal wall. With continuous sail thrust this reads as "stuck/glitching at the island." The crush
path never runs for islands (they aren't `Ship`s), and `filterContactPair` only spares ship-vs-ship.

**Cheap fix tried + FAILED (reverted):** thinning the island collider's underwater band
(`surfaceBandVoxels` below 6→1) did NOT stop the down-shove.

**Correct fix (deferred — delicate physics, needs the user's feel-test):**
1. `physics.ts`: add `islandBodies: Set<number>`; `filterContactPair` returns `null` for a
   ship↔island pair too (stop the rigid shove). Register each island fixed-body handle in
   `islandField.ts`. Debris↔island stays rigid (debris isn't in `shipBodies`).
2. A custom one-sided handler (new `game/shipIsland.ts`, called from `world.step`, AABB/radius-culled):
   test the ship's hull columns/keel (world) against the island `VoxelGrid` directly —
   `isSolid(floor((wp-origin)/M_PER_VOX))` (⚠ islands are 4× coarser voxels, `ISLAND_VOXEL_SCALE=4`,
   so `voxelOverlap.detectContacts` CANNOT be reused as-is — that's the wrinkle the original design doc
   missed). On overlap: cancel the ship's inward radial velocity and push it out HORIZONTALLY (radial
   from island centre — the immovable analogue of the COM→COM line), never vertically (buoyancy owns Y).
   ⚠ verify the island grid↔world origin convention first (Rapier voxel (i,j,k) placement vs the fixed
   body translation) — get this wrong and the overlap test is offset.
3. Optional: carve the SHIP's voxels (island unbreakable, `breakable:false`) so ramming rock damages
   the hull — realises THE LAW #4 for terrain. Drag-only on the ship.
TDD-able in the vitest oracle (deterministic): ram a body into a mock island grid, assert horizontal
stop + monotonic overlap shrink + NO upward/downward velocity introduced. See
`docs/.../2026-06-16-island-destruction-design.md` for the original (pre-cell-mismatch) plan.

## Verification
`npm run build` (tsc) clean; `npm run test` 282 pass / 1 skip. All visual + perf claims verified
headed on the real RTX 5080 (Chrome + Edge). Throwaway probes deleted.

## Commits (main)
- `2acbd9e` fix(ocean): cut the white waterline foam ring around hulls
- `8321ce7` perf(buoyancy): distance LOD for far ships + stale-GPU-profile hint
- `db7d092` fix(clouds): direction-sampled projection so clouds dissolve at the horizon
