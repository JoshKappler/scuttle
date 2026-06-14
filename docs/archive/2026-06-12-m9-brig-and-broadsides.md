# M9 — Brig and Broadsides (playtest round 6)

> Executed autonomously. Each task = one commit on dev/m9-brig-and-broadsides; browser-verified via Playwright DEBUG telemetry before merge.

**Round-6 feedback → tasks:**

## Task 1 — Gunnery truth + fire-control rework
- Arc origin "slightly below the barrel": math muzzle = pivot+0.62 m + dir·1.6, but the GLB bore sits higher. Measure the loaded cannon model (vertex slice at the muzzle face, in pivot space) → `setMuzzleGeometry(tip, up)` consumed by `muzzleWorld`. One source of truth, now calibrated to the visible model.
- "Not firing along the line": broadside STAGGER (0.11 s/gun) launched later balls from a muzzle that had moved → stagger 0; all guns fire the tick you click ("fire all simultaneously" — round 6).
- Controls: RMB hold = aim (ALL guns on the looked-at side articulate + show arcs, anywhere aboard, both views). LMB while aiming = broadside. LMB on foot (not aiming) = slash. F-to-fire and single-gun deck fire REMOVED (round 6 reverses round 5 here). HUD labels updated; gun counts dynamic.

## Task 2 — Slash fix
- F near a gun always fired the gun (2.6 m radius covers the narrow deck) — gone with Task 1.
- "Clips you towards the back": combat one-shot clips carry baked root translation → strip `.position` tracks from attack/punch/hit clips at load.

## Task 3 — The brig (ship too small; cannons comically large → ship grows)
- New `buildBrig()`: 34 m / 9.5 m beam / 6 m hold (nx144 ny40 nz44, deckY 24, halfBeamMax 19, wider deck oval, less pinched tumblehome).
- Raised quarterdeck aft (t ≥ 0.78, +9 cells ≈ 2.25 m, "one story"), wheel on it, side companion stairs (1-cell steps; autostep 0.35 climbs), cabin door under the break, fence/bulwark generalized per-station deck height.
- 5 ports/side on the waist; 2 masts (fore/main, per-mast heights) + big bowsprit; ballast tiers parameterized by cz/halfBeam (tune to draft 45–50%).
- Sloop kept verbatim as the ENEMY ship (round 6: "keep current model… enemy easy opponent").
- De-hardcode: crew overboard bounds, boarding spawn/chest/respawn, wheel/ladder/rudder/bowsprit visuals, mast colliders, cutaway footprint, camera distances → all derived from ShipBuild.

## Task 4 — Physics retune for the brig
- Draft 45–50% of hull height, ~20–26 kn full sail, banked turns, no capsize at 100% canvas, deck walk + stairs + quarterdeck verified by telemetry.

## Task 5 — Enemy chase + nerf + man overboard
- aiBrain: CLOSE to ~55 m at full sail before turning abeam (was: parallel-sail at 90 m), in-irons escape only when range > 120, flee only when badly flooded (≥ 0.55). Tests updated.
- Nerf: AI sail efficiency 0.82, rudder rate 1.4/s, reload 9.5 s (player 6), jitter 2.5°.
- Player overboard (swimming) → crew eases sails to zero so the ship waits ("imaginary crew should throttle down").

## Task 6 — Helmsman at the wheel
- Pin right at the wheel (touching it), procedural arm raise to the rim, wheel spins with rudder (exists) — sells steering.

## Task 7 — Real wake
- Remove painted-on bow spray sprites. Ocean shader: per-ship stern-path ring buffer (32 pts) → curved foam wake that follows the actual track; bow swell bump in the vertex stage + contact foam at the cutting stem, scaled by speed.

## Task 8 — Verify, screenshots, docs, merge m9
