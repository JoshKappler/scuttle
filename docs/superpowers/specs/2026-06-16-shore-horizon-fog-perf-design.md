# SCUTTLE — Shore / Horizon / Fog / Perf pass (2026-06-16, overnight)

_Autonomous session. The user granted explicit permission to investigate, choose remedies, write
this spec, and implement it without review ("you pick your own preferred remedies, write your own
spec sheet, and follow it on your own ... without any input from me"). So the brainstorming
approval-gate is waived by the user; this doc is the record + the implementation checklist._

## The four problems (user, verbatim intent)

1. **The white wake line at the shore.** "There's a white line of wake that abruptly cuts off ...
   the part of the ocean that has waves versus the area by the island." Wants it GONE, and the
   wave→shore transition GRADUAL ("the seas a little more subtle when you're at the island, but a
   gradual way of doing this").
2. **Sky/horizon = "painted ceiling with walls coming down."** "Until we actually change the logic
   and make it so that it extends to the horizon along with the ocean, it's always gonna look like
   I'm inside of a Hollywood set." Wants the sky to genuinely meet the sea at the horizon.
3. **Ocean fog too intense.** "The fog ... on the surface of the water is a bit too intense ... I
   can still see the islands pretty clearly through it ... should only really become a thing in the
   far distance."
4. **Performance.** Top-of-the-line PC (RTX 5080), a couple of vessels, "lucky to get past forty
   frames per second." Any gains welcome.

## Root-cause findings (measured, real GPU via headed Playwright)

- **White line** = the shore SURF-FOAM tap (`ocean.ts` FRAG ~684-690): `wash += surf*0.55` over the
  BLED land-field band — a bright ring at the island edge. The ABRUPT cutoff = the shoaling band was
  tightened to 1.3 m (`ocean.ts` VERT ~326) → waves go full→flat over ~1.3 m = a hard ring.
- **"Walls coming down"** = the cloud dome's frozen-projection smear (`clouds.ts`): clouds sit at
  FULL opacity in `up∈[0.16, 0.30]` where the projection is frozen (`max(up,0.30)`) → a stretched
  cloud ring hugging the horizon, fading to TRANSPARENT (a hard edge) instead of into haze.
- **Fog** = exp² `uFogDensity 0.0016` with no clear-zone → ~21 % haze by 300 m, veiling mid-field
  islands. Also `scene.fog` is null above water, so ISLANDS don't fog at all → crisp islands over a
  hazy sea (incoherent horizon).
- **Perf — GPU is NOT the bottleneck.** Measured on the real 5080: 1 ship open water = 240 fps and
  **FLAT from 1 MP to 12 MP** (post.scale sweep); 3 frigates = 86-123 fps, also flat across
  resolution. The wall is **CPU buoyancy** (`ship.applyForces` → `surfaceHeight`): ~12-14 ms/substep
  for 3 frigates. The adaptive governor drops RESOLUTION (the blur) — useless for a CPU-bound frame.

## Remedies

### 1. Shore (ocean.ts) — gradual + no white line
- DELETE the shore surf-foam block (FRAG). The user: "if we just got rid of that white wake, it
  would go a long way." (Also saves a per-near-island texture tap.)
- Widen + smooth the VERT shoaling: full waves in deeper water tapering GRADUALLY to calm at the
  waterline over a ~4-5 m band (smootherstep), instead of the 1.3 m hard ring. Water stays OPAQUE
  (the void was already fixed `63f2590`), so a calmer near-shore band now reads as a subtle lagoon,
  not a navy moat.

### 2. Horizon / clouds (clouds.ts + main.ts) — dissolve into haze
- Clouds fade to ZERO opacity below the projection-freeze zone (`smoothstep(~0.20, ~0.48, up)`), so
  the smear ring is gone; the overhead cloudscape (up>0.48) stays.
- TINT clouds toward `HORIZON_COLOR` as they near the horizon (atmospheric perspective) so faint low
  clouds melt into the haze rather than showing as shapes against it. Pass `HORIZON_COLOR` into the
  CloudDome. Net: lower sky = pure haze == dome horizon == ocean far-fog → one seamless band, no
  walls, no ceiling edge.

### 3. Fog (ocean.ts + main.ts) — clear near, haze far
- Add `uFogStart` (~520 m) clear-zone to the ocean fog: `fogD = max(dist - uFogStart, 0)`. Near/mid
  water (and the islands you sail to) is crisp; the sea only hazes toward the horizon (full by
  R_FAR=2400). Keep `uFogColor = HORIZON_COLOR`.
- Add a FAR-biased linear `scene.fog` above water (`THREE.Fog(HORIZON_COLOR, ~700, ~2400)`) so
  DISTANT islands/ships melt into the same haze (coherent horizon) while near gameplay stays crisp.
  (Ocean keeps its own shader fog; both target HORIZON_COLOR pre-tonemap → consistent.)

### 4. Perf (gerstner.ts) — safe ~2× buoyancy trig cut, bit-identical
- Rewrite `surfaceHeight` allocation-free and skip the discarded `y` term in the 3 inversion
  iterations. Today it calls `displace` 4× — each allocates a `[x,y,z]` array AND computes `y` (a
  `sin`/wave) that the iterations THROW AWAY. The inversion only needs `x,z` (the `cos`). Inlining
  → ~40 trig + 0 allocs (was ~80 trig + 4 allocs). The y in iterations never feeds back, so `px,pz`
  and the final height are **bit-identical** → the deterministic vitest oracle + THE LAW #1 hold.
  Verified by the existing gerstner/buoyancy tests staying green.
- DOCUMENT (not implement tonight — needs a feel-test the sleeping user can't give): the bigger CPU
  levers are (a) worker/SharedArrayBuffer sim offload (CLAUDE.md's "real lever, not yet wired") and
  (b) enemy/distant-ship buoyancy column LOD. The GPU governor's blur does not help a CPU-bound
  frame and should not be leaned on for fleet perf.

## Verification
- `npm run build` (tsc + vite) clean; `npm run test` (278) green (esp. gerstner/buoyancy/stability).
- Headed real-GPU screenshots: shore (gradual, no white ring, opaque), horizon (clouds dissolve, no
  walls, seamless sea↔sky), fog (near islands crisp). Re-measure buoyancy ms before/after the
  gerstner cut at 3 frigates.
- Commit + push to main as each coherent change lands (user pref: commit+push as you go).
