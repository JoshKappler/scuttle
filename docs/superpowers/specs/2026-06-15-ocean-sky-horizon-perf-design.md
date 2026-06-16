# Ocean / Sky / Horizon + Perf pass — design (2026-06-15)

Feel-test driven visual + performance pass. Root-caused from live testing on the user's
RTX 5080. Four coupled changes ship together; a fifth (island-destruction) is split out into
its own design (see the end). The user approved this plan and the four forks below.

> Verification is **in-browser** (Playwright at `:5173` + screenshots/readback on the real GPU),
> not unit tests — this is shader/visual work. `npm run build` (tsc) + `npm run test` (vitest)
> must stay green; they catch type/logic regressions, not the look.

## Problem (what the user reported, root-caused)

1. **Navy moat at shorelines.** The shore-shoaling taper (`ocean.ts` VERT) kills wave
   displacement entirely once the seabed is within **5.5 m** of the surface, and that flat band
   is painted dark-navy + opaque → a flat navy ring instead of waves meeting the sand.
2. **"Drooping black tablecloth" sky + distant islands over void.** Same root cause, partly
   self-inflicted: commit `41f31df` faded the THREE.Sky dome's whole **lower hemisphere to black**;
   the ocean polar grid ends at **R_FAR = 950 m**, so at/just-below the horizon and under far-off
   islands you see that black skirt. THREE.Sky's atmospheric dome also reads "stretched" at the
   horizon.
3. **Lighter 1-voxel rim around the hull.** The depth-murk (`ocean.ts` FRAG) does
   `col = mix(col, uMurkColor, murk)` with `murk = clarity·(1−visFrac)` (peaks in the shallowest
   water) and `uMurkColor` (`0x0a1f3a`) **brighter** than the deep-water color (`0x02060e`). Over a
   submerged deck the thin shallow band at the waterline gets the most tint → a bright rim. It also
   costs GPU fill.
4. **Perf.** GPU-bound (ocean fragment fill + post-FX). The zero-cost cuts are spent; ~40 fps with
   one enemy. The adaptive governor masks it by dropping render-scale to 0.5–0.65 — **that drop is
   the blur** the user dislikes.

## Decisions (forks the user picked)

- Sky/horizon → **replace the skybox** (procedural gradient dome) + extend the sea to the horizon.
- See-into-water → **rework now** into true translucency (no bright rim).
- Perf → **crisp & fast** (accept visible tradeoffs: MSAA off, governor floored so it never mushes).
- Order → **visuals + perf first**; island-destruction deferred to its own design.

## A. Gradient sky dome + sea to the horizon

Replace `THREE.Sky` (and the black-hemisphere hack) in `render/sky.ts` with a cheap procedural
**gradient dome** — a large `BackSide` sphere, `ShaderMaterial`, `depthTest/Write:false`,
`renderOrder −1000`, pinned to the far plane (`gl_Position = xyww`) and **following the camera**
each frame (so the camera is always at its centre, like the cloud dome — works for the main camera
and the env-cube camera).

Fragment (object-space view dir `d = normalize(position)`):
- `d.y ≥ 0`: ramp **horizon haze → zenith blue** (smoothstep on `d.y`).
- `d.y < 0`: hold the **horizon haze color** (never black) so the lower hemisphere reads as distant
  sea/haze.
- **Sun**: warm disc (`dot(d, sunDir)`) with a soft halo; HDR core (~10–14 linear) so it still blooms
  and can seed god-rays, bounded by the existing pre-bloom clamp (`TUN.gfx.bloom.clamp`).

Keep the rest of `SkySetup` identical: `sunDir`, `sunColor`, `sunLight`, `fillLight`, `envCube`,
`addTo` / `updateEnv` / `bakeEnvironment`. `updateEnv` re-bakes the dome+clouds into `envCube` (ocean
reflection) unchanged; `bakeEnvironment` PMREMs the dome for IBL ambient unchanged. The `sky` field
becomes a `THREE.Mesh` (nothing in `main.ts` reads `.sky` directly).

**Sea to the horizon (seamless):** export a single `HORIZON_COLOR` from `sky.ts`; the dome's
horizon/below-horizon uses it, and `ocean.setFogColor(HORIZON_COLOR)` makes the ocean's
exponential-squared fog fade the far sea to the **same** color. Bump `R_FAR` 950 → ~2400 m (nearly
free — same screen coverage, just real water further out, fog hides the coarser far rings) so distant
islands sit on water/haze, not void. Net: no tablecloth, no void box, no floating islands, and a
cheaper sky (vs atmospheric scattering, ×6 env-cube faces).

## B. Depth-murk → true translucency (no rim)

In `ocean.ts` FRAG, **delete the additive brightening** `col = mix(col, uMurkColor, murk)` and the
`murk` term. Keep depth-driven **alpha** only:

```glsl
float columnDepth = vWorldPos.y - floorY;
float visFrac = clamp(columnDepth / max(uWaterVis, 0.05), 0.0, 1.0);
float shallowAlpha = mix(1.0, MURK_FLOOR, uWaterClarity); // clarity 0 → opaque (off)
float seaAlpha = mix(shallowAlpha, 1.0, visFrac);         // shallow translucent → deep opaque, MONOTONIC
gl_FragColor = vec4(col, min(cutAlpha, seaAlpha));
```

Why this kills the rim: the brightness came from adding a color *brighter* than deep water, peaking
at the waterline. With alpha only, the submerged deck (dark wood) shows through *darker*, not
brighter — no rim — while shallow water over the light sandy shelf still reads as sand-through-water
(desired). Open/deep water (`floorY` very low → `visFrac` 1) stays fully opaque, unchanged.
"Murky dense" is dialed by `uWaterVis` (lower = murkier) and `MURK_FLOOR` (higher = denser); starting
values ~visibility 3, floor ~0.33, both live on the existing dev sliders. (Optional later: a subtle
*darkening* tint that grows with depth — only if it reads too clear.)

## C. Waves to the shoreline

In `ocean.ts` VERT shoaling, tighten the band so waves keep full height until the seabed is ~1 m
under the surface, then flatten right at the wet sand:

```glsl
float shoal = clamp((-0.1 - landY) / 1.3, 0.0, 1.0); // full waves by ~1.4 m depth, flat at the waterline
```

(was `(-0.3 - landY) / 5.5`). With B, the near-shore shallows show sand-through-water instead of flat
navy, and the restored surface normals bring back Fresnel/specular so it stops reading as a solid
plane. Minor crest-clipping in the surf zone is acceptable (reads as breaking surf) and is what the
user asked for.

## D. Crisp & fast

- **MSAA 2 → 0** on the post HalfFloat RT + add a cheap **FXAA** pass after `OutputPass`
  (`render/post.ts`). Crisp edges, far less bandwidth than MSAA-resolving a full-screen HalfFloat.
- **Governor floor** (`render/perf.ts`): tiers become `[1.0, 0.85, 0.8(+drop godrays)]` — worst case
  is mild, never the 0.5 mush. Lower `TUN.gfx.auto.targetFps` 55 → ~50 so it holds full res down to
  ~43 fps instead of dropping eagerly.
- **Ocean fill**: gate the 3 cascade-**normal** texture taps behind the existing distance/`graze`
  fade (`if (nFade > 0.001)`) — skips 3 dependent texture reads for the far/grazing water that covers
  most of the screen; bit-identical output (the taps were multiplied by ~0 anyway).
- The cheaper gradient sky (A) compounds these. Target: hold full-res 60 with a small fleet.

Caveat carried from prior work: GPU thermally throttles over a long session, so **verify fps on a
fresh launch**, not mid-session A/B.

## Deferred — island-destruction (own design)

Hitting an island should damage the ship via the **same** voxel crush path as ship-vs-ship, with
island voxels **immovable + unbreakable** (the user's "all voxels are equal; island ones just don't
break or move" rule). Today island contacts never reach `voxelContact` (it only iterates ship-vs-ship)
and the rigid fixed collider just shoves the ship (the "launched into the air" glitch) with zero
carving. This is a real physics change (route ship↔island contacts into the crush path, one-sided
carve, no island mutation/impulse) and gets its own spec + plan after this pass lands. It is **not**
implemented in this pass.
