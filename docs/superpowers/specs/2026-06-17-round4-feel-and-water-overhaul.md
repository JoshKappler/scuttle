# SCUTTLE Round-4 feel + water overhaul — orchestration spec (2026-06-17)

Head engineer = lead (me). 6 Opus subagents, one wave, **fully file-disjoint**. Lead owns the two shared
hubs (`core/tunables.ts`, `main.ts`) — pre-staged before dispatch — so no agent touches them. Direct to
`main`, no worktrees (user reaffirmed full autonomy). Lead integrates + does ALL in-browser verification.

## Ownership map (no two agents share a file)
| WP | Agent | Owns (edit only) | User items |
|----|-------|------------------|-----------|
| 1 | MANEUVER | `game/sailing.ts` | low+high turn ×2 |
| 2 | CANNON-PLACE | `game/gunnery.ts`, `render/shipVisual.ts` | guns nested inboard / poke through ports |
| 3 | CANNON-DYN | `game/cannons.ts`, `render/effects.ts` | live aim at launch; tracer trail; impact blast; verify fall-off |
| 4 | MAST-FLOAT | `game/rig.ts` | felled spar floats, no bounce |
| 5 | OCEAN | `render/ocean.ts` | NO void under the sea — solid navy body |
| 6 | FLOOD | `render/compartmentFluid.ts`, `sim/compartments.ts`, `game/ship.ts` | solid interior water clipped to hole; faster flow |

Lead owns: `core/tunables.ts` (pre-set: rudderGain 2.0 + rudderLowFloor 2.5; rig waterlog 0.02 +
fallFloatBuoy/fallVertDamp/fallSinkFloor; flood inflowScale 0.5 + pumpRate 0.3) and `main.ts` (wiring).

## Subagent rules (every prompt)
- Opus. Edit ONLY your owned files; read anything. NEVER edit `tunables.ts` or `main.ts` — read `TUN`;
  if you need a NEW knob, use a module-local const and REPORT it for the lead to promote.
- Do NOT run git. Do NOT run `tsc -p .` (cross-agent false errors) — typecheck only your own files if at
  all. Run only your module's vitest. NO browser/Playwright (lead does all live verification).
- THE LAW #1: render-only code must never feed `sim/` (determinism oracle). Shaders: tsc+tests can't catch
  GLSL bugs — write defensively, lead verifies in-browser.
- Report: what you changed, any new tunable/main.ts wiring the lead must add, and how you reasoned it correct.

## Root causes (found by lead)
- **Turn**: `sailing.ts:137` `flow = sign·(1.5+|speed|)`; `:142` yaw ∝ rudderGain. Both levers.
- **Gun reach**: `gunnery.ts` BARREL_INBOARD 2.6 / CHASER_INBOARD 0.5 / GUN_INBOARD_M 0.55 / TIP_FROM_TRUNNION_B 1.32 ×GUN_SCALE 1.6; `shipVisual.ts:816-907` places meshes + gunports.
- **Aim latched**: `cannons.ts` fireBroadside stores elevation/traverse in pendingShots; `update()` fires
  with the STORED values → later guns ignore new aim. Fix: read live aim at launch (lead passes a live
  source through `main.ts:742`).
- **Ball visual**: `cannons.ts:98-112` sphere, no trail; flight loop `:164-177`; impact `:220-237` (hook
  `effects.impactDebris/impact`). Add tracer in flight loop + a blast on impact.
- **Mast bounce**: `rig.ts:277-292` chunk buoyancy `ay += G·(1+2·sub)·1.3` with linDamp 0.999 = undamped
  spring → rockets/bounces. debris.ts:285-294 already solved this (near-critical kv). Mirror it.
- **Void**: `ocean.ts` bowl backdrop (radius 2350, lower hemi, rim y=-6) exists but still shows void through
  hull holes / at grazing-and-underwater angles. Surface alpha goes translucent (clarity 0.85) over a floor.
- **Flood render**: `compartmentFluid.ts` = top sheet + fading skirt → "levitating flat square"; relies on
  hull occlusion to clip. **Flow**: `compartments.ts orificeFlow` (signed, exact) × `ship.ts:515-552`
  breaches × inflowScale (now 0.5).

## Verification (lead, post-integration)
`tsc --noEmit -p .` → `npm run test` → `npm run build` → Playwright @5173: turn-circle readback, gun-tip
through ports screenshot, ripple-aim follow, mast settle (single-step), **void: look through a holed bow +
dunk camera underwater (no sky/void)**, **flood: solid body through hole, fast equalize on a big gash**.
