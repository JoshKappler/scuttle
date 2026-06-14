# m11 — Blue Water & Thunder (playtest round 8)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Executed inline this session (overnight autonomy, frequent commits).

**Goal:** Make the ocean feel like open sea (spectrum waves, no tiling, smooth substantial ship motion, visible bow/wake water), make the guns feel like guns (ship-velocity ballistics with an honest arc, flash + impact drama, bigger and better-placed cannon), and clear the round-8 punch list (fullscreen, ambient light, helm arm, 3P camera invert, enemy AI, forward lean).

**Architecture:** The wave system stays one source of truth (sim/gerstner.ts params feed both the CPU and the ocean vertex shader) but grows to a seeded 16-wave directional spectrum. Physics consumes only the long-wavelength subset (λ ≥ 14 m) so the hull rides swell, not chop — that alone delivers "higher perceived mass" without faking inertia. The ocean mesh becomes a camera-centered polar grid (fine rings near, coarse far, ~25k verts vs today's 160k) so near-field features (bow swell, flank ridge, foam lacing) actually resolve, with per-wave distance fade to kill far-field aliasing instead of a 10 m snap (the "stutter").

**Round-8 item → task map**

| # | Feedback | Task |
|---|----------|------|
| 1 | F fullscreen doesn't work | T1 |
| 2 | Shadows pitch black / need ambient | T2 |
| 3 | Right arm spasm at wheel (always) | T3 |
| 4 | Cannons smaller than realistic | T4 |
| 5 | Cannons too far forward, wheels over edge | T4 |
| 6 | Balls must inherit ship velocity; arc must match | T5 |
| 7 | Balls faster, more powerful, longer range | T5 |
| 8 | Muzzle flame/fire on firing | T6 |
| 9 | Dramatic effects on cannonball hits | T6 |
| 10 | 3P left/right mouse inverted vs 1P | T1 |
| 11 | Enemy runs away unprovoked | T7 |
| 12 | Ship leans forward | T8 |
| 13 | No visible 3D wake; wake stutters | T9 |
| 14 | Bow should push up/bulge water; splashes breaking waves | T9+T10 |
| 15 | Boat not substantial; bow buries at full throttle+turn; ocean pokes through deck | T8+T9 (physics-wave filter) |
| 16 | Waves visibly repeat; want a real-ocean feel, tunable | T9 |

### T1 — Quick controls fixes
- player.ts: `orbitYaw -=` → `+=` (match 1P sign).
- main.ts toggleFullscreen: `.catch` → toast the rejection reason; re-grab pointer lock after the transition if it was held. Verify in a HEADED browser with pointer lock engaged (headless lies about fullscreen).

### T2 — Lighting: ambient that exists
- sky.ts: build a PMREM environment from the Sky → `scene.environment` (MeshStandardMaterial needs IBL; hemisphere alone reads black on sides).
- `sunLight.shadow.intensity = 0.75` (r163+ knob: shadows attenuate, not erase).
- Hemisphere 0.95 → ~1.25, ground color brightened toward sea-bounce.
- Verify by screenshot: shaded hull flank must read as wood.

### T3 — Helm arms: freeze the whole bone, not one axis
postPose only overrode rotation.x; the idle clip kept writing y/z — the arm waves around (round 8: "spasm … all the time"). New model: on taking the wheel, after the next mixer update, snapshot all four arm-bone quaternions ONCE; every postPose: `bone.quaternion.copy(frozen)` then `rotateX(offset ∓ rudderLean)`. No per-frame capture loop, nothing for the mixer to fight. Verify: sample bone quaternions across 60 frames — variance ≈ 0; screenshots at rudder −1/0/+1.

### T4 — The battery: bigger, inboard, aft
- gunnery.ts: GUN_SCALE 1.25 → 1.6; GUN_INBOARD_M 0.2 → 0.55.
- shipwright.ts portXs: brig [0.3,0.42,0.54,0.66,0.78] → [0.3,0.41,0.52,0.63,0.74]; sloop [0.3,0.45,0.6,0.75] → [0.3,0.43,0.56,0.69] (battery centered nearer midship; forward stations sat on the bow taper — "front wheels over the edge").
- Verify: deck screenshot, all wheels on planks; tests green.

### T5 — Ballistics: carry the ship's velocity, honestly
- MUZZLE_SPEED 55 → 72 m/s, lives in gunnery.ts (shared constant).
- cannons.launch: `vel = dir·MUZZLE_SPEED + velocityAtPoint(owner, muzzlePos)`.
- main.ts arc: same initial conditions (`dir·MUZZLE_SPEED + velocityAtPoint(sloop, muzzle)`), so line ≡ ball by construction at the moment of firing.
- BLAST_RADIUS_VOX 1.7 → 2.1; ball impulse 6 → 9 kg·v.
- Verify live: at 10+ kn, fire along the line; measure landing vs predicted arc end < 2 m.

### T6 — Thunder: muzzle flash + impact drama
- effects.ts: second additive Points layer (fire/sparks, bigger size); pooled PointLights (4) for flashes (pre-added — adding lights at runtime recompiles every shader).
- `muzzleFlash(pos, dir)`: flame cone particles + light pop (~120 ms) + existing smoke.
- `impactBurst(pos, normal)`: splinters ×1.5, orange sparks, lingering smoke, flash light.
- Wire into cannons.update (fire + voxel hit). Verify by screenshot mid-broadside.

### T7 — Enemy AI: stop running
- Telemetry first: log decideAI inputs/decisions for 60 s from spawn. Fix what it shows (suspects: spawn 250 m upwind + in-irons bear-away loop reads as "running away"; close-action abeam dance opens range). Acceptance: from spawn, range closes monotonically-ish to < 90 m and broadsides begin.

### T8 — Trim & substance
- Measure pitch at full sail (flat water + waves). Counter bow-down with stronger speed-trim restoring if biased.
- Pitch damping 3.0 → 4.2; added-mass 1.45 → 1.6 on pitch/yaw.
- Acceptance: full throttle hard turn in the standard sea → bow never ships green water over the stem; pitch amplitude ≤ ~4°; still visibly undulates.

### T9 — Ocean v2: spectrum + polar mesh + smooth wake
- gerstner.ts: makeWaves(rng, 16) — λ log-spaced 90 → 3.5 m, amp ∝ λ^0.95 normalized to Hs ≈ 1.15 m, directional spread narrow for long waves / wide for chop, per-wave Q under a global Σ(Qka) ≤ 0.8 budget. Export `physicsWaves(waves)` = subset λ ≥ 14 m.
- All physics callers (ship forces, flooding, debris, swimmer, ball splash, camera-under) audit: physics subset for forces; FULL set wherever the test is "where is the visible surface" (camera fog, splash spawn heights).
- ocean.ts: NWAVES 16; replace PlaneGeometry with camera-centered polar grid (exp rings 0.6 → 640 m, ~150×168 ≈ 25k verts), continuous follow (no 10 m snap — that was the stutter), per-wave distance fade (short λ fade out before vertex spacing aliases them).
- Wake: trail points every 1.2 m with age ramp-in (new segments fade in, no pop); bow mound 0.7 → 1.05·sF (now resolvable); keep dry-hole + cutaway intact.
- Tests: spectrum invariants (count, λ range, steepness budget, physics subset), parity displace/surfaceHeight unchanged.

### T10 — Bow splashes
- Render-loop detector per ship: stem world point vs visual surface; on downward relative plunge > threshold, effects.splash + white spray, throttled ~4/s. Skip when submergedFrac says she's foundering.

### T11 — Live dial pass
- Sail the standard sea at full throttle, hard turns, spyglass horizon pan: check repetition, fps (should IMPROVE: 25k verts vs 160k), bobbing, deck dryness, wake smoothness. Tune amplitudes/damping. Screenshots for the report.

### T12 — Tests, docs, merge
- Full suite green; overnight-progress notes; merge --no-ff to main; tag m11-blue-water; push.
