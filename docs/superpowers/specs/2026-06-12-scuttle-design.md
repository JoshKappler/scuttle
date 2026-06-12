# SCUTTLE — Design Spec

**Date:** 2026-06-12
**Status:** Approved by user (brainstorming session 2026-06-12); awaiting implementation plan
**Working title:** SCUTTLE (placeholder; alternates considered: *Below the Waterline*, *Powder & Brine*, *Gold & Gunpowder*)

## Context & goals

A browser-playable, single-player pirate roguelite where ships are built from visible voxels that get genuinely shot apart, flood compartment by compartment, list, and sink — and boarding combat happens on those tilting, sinking decks.

This is a portfolio centerpiece intended to gain public traction (Reddit/X/itch.io) and support a job search. Goals, in priority order:

1. **Instantly playable** — a link in a tweet loads into gameplay in seconds. No login, no download, no loading screens.
2. **Visually impressive** — premium water, lighting, and physics spectacle; "wow" within the first 30 seconds.
3. **Genuinely fun** — a tight greed-vs-survival loop with real replayability, not a tech demo.
4. **Clip-generating** — every sinking is physically unique; damage moments are inherently shareable.

**Market position (from research, June 2026):** browser-playable naval combat with real flooding/sinking physics has no existing entrant. Mk48.io proved browser naval .io games sustain traffic (no destruction physics); Floating Sandbox proved sinking-as-spectacle has a large audience (desktop-only, sandbox, no goals); From the Depths/Stormworks proved the compartment-flooding architecture (desktop, brutal learning curves). Vibesail proved browser sailing feels good (no combat). The intersection is open.

## Decisions log

Choices made with the user during brainstorming:

| Decision | Choice | Rationale |
|---|---|---|
| Concept | Blend of "Broadside & Boarding" + "The Limp Home" | Cannon duels into boarding is the core fantasy; damage-management/ship-stealing is the survival layer |
| Player fantasy | Pirate; gold-looted-based scoring | User choice |
| Melee depth | Tight arcade melee (lock-on, slash/parry/kick); first-person toggle | Depth comes from the battlefield (listing decks), not the move list; FP is cheap if planned early |
| Ranged weapons | Period-only: muskets, blunderbuss as scarce one-shot pickups | User choice; no anachronistic guns |
| Ship visuals | Visible voxel ships ("Teardown at sea") | Sim == visuals; damage reads perfectly; simplest tech path; beauty from ocean + lighting |
| Session shape | Roguelite voyage: seeded sea, escalating encounters, death → leaderboard | Encounter chaining enables limping/ship-stealing; score-chase drives sharing |
| Platform | Web-first (desktop browser primary) | ~37% browser-play conversion vs ~6% download; recruiters click links |
| Single/multiplayer | Single-player v1; deterministic physics keeps multiplayer door open | User constraint (simplicity); v2 option |

## 1 — Game design

### The run

One run = one voyage across a procedurally seeded archipelago. The player starts on a small sloop and hunts AI ships of escalating class: **sloop → brig → frigate → galleon**. Gold is the score. Death ends the run and posts to a leaderboard.

### Encounter phases

1. **Approach** — wind-aware sailing; jockeying for broadside angle. Wind direction matters (sail trim affects speed; sailing into the wind is slow).
2. **Gunnery duel** — manually aimed cannon volleys (lead the target, choose elevation). Hits remove voxels. Below-waterline hits breach compartments → visible flooding, listing, slowing. The player's ship takes identical damage under identical physics.
3. **The decision** — the economic forcing function: **sinking a ship sends most of its gold down with it** (a few chests float up). Full loot requires disabling (dismast, hole above the waterline) and **boarding**. Boarding is always the greedy choice and always the risky one.

### Boarding

- Grapple to close, cross to the enemy deck.
- Tight arcade melee: third-person with first-person toggle; lock-on; three-move kit (slash, parry, kick). Enemy crews of 3–8 with state-machine AI.
- The kick is the hero move: knockback is physics-resolved — listing decks become slopes; enemies (and the player) can go overboard.
- Muskets/blunderbusses: scarce one-shot pickups on decks.
- If the enemy ship is holed and actively sinking, looting the hold races the rising water — the timer is the simulation, not a UI element.

### The limp-home layer

After a fight the player's ship is damaged too. Options:

- **Plug breaches** with planks (consumable; slow, partial repair at sea).
- **Man the pumps** (slows flooding in a chosen compartment).
- **Jettison cargo** to raise a flooded section above the waterline.
- **Beach** in shallow water for safer repairs.
- **Steal the enemy ship** — transfer flag and surviving crew to the vessel just fought (which the player already damaged; choices in the gunnery phase echo forward).
- **Port repairs** — proper repairs and crew hiring at ports, **paid in gold (i.e., score)**. Greed vs survival is the central tension dial.

### Legibility (core feature, not polish)

One key toggles a **cutaway X-ray view**: every compartment, its water level, breach locations, pump status. Rationale from research: Ultimate Admiral: Dreadnoughts sits at 62% positive largely due to opaque flooding; Stormworks' visible water-filling compartments are beloved. The sim must be watchable.

### Retention & sharing hooks

- **Daily seed** runs (same voyage for everyone, Spelunky-style).
- **Shareable seed links** ("beat my run").
- Leaderboard: gold, ships taken, distance sailed.
- Physically unique sinkings → organic clip generation.

### Explicitly out of v1

Multiplayer, ship-builder mode, open-world persistence/meta-progression, touch-screen melee. All are v2 candidates; none may creep into v1.

## 2 — Technical architecture

**Stack:** TypeScript + Vite + plain Three.js + Rapier physics. Static-site deployment. React renders the DOM UI overlay only (menus, HUD, leaderboard); the game loop is plain Three.js — no React Three Fiber in the hot path.

| Component | Choice | Rationale |
|---|---|---|
| Renderer | Three.js `WebGPURenderer` (auto WebGL2 fallback), TSL materials | One codebase, both backends. Caveat: LLMs are weaker on TSL (post-2023); feed docs; classic WebGL2/GLSL path is the fallback |
| Physics | `@dimforge/rapier3d-simd` (Apache-2.0) | Native **sparse voxel colliders** (shipped 2025) make mutable hulls a supported engine feature, not a hand-rolled convex-decomposition pipeline. `-deterministic` build variant enables exact seed-replays (leaderboard anti-cheat; future netcode). Chosen over JoltPhysics.js: Jolt's built-in buoyancy helper doesn't fit (ours must be flood-aware and custom regardless) |
| Ocean | Sum of 4–8 Gerstner waves, evaluated in vertex shader (render) and identically on CPU (physics) | CPU-evaluability is mandatory for buoyancy. FFT water deferred to v2 (TSL compute) because GPU displacement can't be cheaply queried |
| Visual budget | Lighting over geometry: Poly Haven ocean HDRIs (CC0), hull-contact foam/spray, bloom | Teardown precedent: voxels read premium when lighting does the work |
| Backend | One serverless endpoint (Vercel) + small Postgres/KV table: name, score, seed, replay hash | No accounts. Minimal attack surface: single validated insert, sanity bounds, rate limiting, replay-hash cheat-flagging. (Research: vibe-coded games repeatedly shipped client-side secrets / client-trusted scores) |
| Hosting | Static on own domain + itch.io embed | Single-threaded-friendly; no COOP/COEP requirements unless WASM threading is added later |

### Assets (all licenses verified June 2026)

| Asset | Source | License |
|---|---|---|
| Ship hulls | Self-authored in MagicaVoxel (free tool); 4–6 ship classes | Own work |
| Characters (animated) | Quaternius Pirate Kit (71 models) | CC0 |
| Cannons, props, port pieces | Kenney Pirate Kit (~70 models) + Kenney Watercraft Kit | CC0 |
| Sails | Cloth-textured quads + simple wind vertex shader (not voxels) | Own work |
| Lighting/skies | Poly Haven ocean HDRIs | CC0 |
| Audio | Kenney audio packs; Freesound (CC0 filter); Sonniss GameAudioGDC bundles | CC0 / Sonniss royalty-free license |

**License caution:** Floating Sandbox source is CC-BY 4.0 **with a no-distributing-builds clause** — it is an algorithm reference only (esp. the author's momentum-based flooding devlog); no code reuse.

## 3 — Simulation design

Each ship is **one rigid body** plus three data layers (the proven Stormworks/From the Depths pattern — never per-voxel rigid bodies, never simulated water particles):

### Voxel layer
- 3D grid per ship, ~30 cm cells. Sloop ≈ low thousands of voxels; galleon ≈ tens of thousands.
- Rendered as greedy-meshed 16³ chunks.
- Cannonball hit → remove voxels in a small blast radius → remesh touched chunks only (amortized across frames) → update Rapier voxel collider.
- Connectivity flood-fill from the keel detects severed islands (blown-off bow, falling mast) → spawn as short-lived independent debris bodies.

### Compartment layer
- At authoring time, flood-fill of interior air spaces partitions the hull into compartments (hold, gun deck, cabin…) connected via door/hatch cells.
- At runtime each compartment tracks one scalar water level. Per frame: breach area = count of missing hull voxels below the local waterline; inflow follows Bernoulli (deeper breaches flood faster); water flows between compartments through openings and new holes.
- Cost: O(compartments) per frame — roughly a dozen scalars per ship.
- Rendering: rising clipped water plane per compartment + spray particles at breach points.
- Reference: Floating Sandbox momentum-based flooding devlog (design reference only — see license caution).

### Buoyancy layer
- ~12–20 probe points across the hull sample the analytic Gerstner height (CPU) and apply Archimedes force at each probe position on the single rigid body.
- A compartment's flood level scales its associated probes' contribution toward zero.
- Listing, trim by the bow, and capsizing **emerge** from the solver. No scripted sinking animations anywhere.

### Characters on decks
- Kinematic capsule controllers simulated **in the ship's local frame** (stable footing on a moving deck) with **world-space gravity** (a listing deck genuinely becomes a slope; kicks send bodies downhill into the sea).
- Known-hard problem → prototype spike scheduled in Milestone 1, not discovered in Milestone 4.

### AI captains
- State machines: patrol → intercept → broadside circling → flee / strike colors.
- Difficulty = ship class + crew count + gunnery accuracy. No ML, no nontrivial pathfinding (open water).

## 4 — Milestones (each independently demo-able)

1. **It floats** — Gerstner ocean, one voxel sloop, probe buoyancy, wind sailing, lighting pass, **character-on-deck spike**. Screenshot-worthy from week one.
2. **It sinks** — cannonballs, voxel destruction, compartment flooding, listing, capsizing, debris, cutaway view. **First viral clip — post it the day it works.**
3. **It fights back** — AI ship duels, player damage/limping, plank repairs, pumps.
4. **Board her** — grappling, melee combat, muskets, looting, ship-stealing, first-person toggle.
5. **The run** — roguelite encounter chain, ports, gold economy, death, leaderboard, daily seed.
6. **Ship it** — sound, menus, perf pass against frame budget, itch.io + own domain, build-in-public posts.

Milestone ordering doubles as marketing strategy: M1–M2 produce shareable content months before launch (the pattern behind every build-in-public success studied).

## 5 — Testing strategy

- **Pure-function sim core:** flooding/buoyancy math lives in deterministic, engine-free TypeScript modules. Unit tests against known cases (breached compartment of volume V at depth D floods in T seconds; flooded bow → pitch-forward torque sign).
- **Determinism test:** same seed + same input log → identical replay hash.
- **Perf budget:** 60 fps (16.6 ms frame) at 1080p on an integrated-GPU laptop (e.g., Iris Xe class) during a two-ship engagement with active flooding; tracked as a number, not a vibe. Chunked remesh amortization verified under sustained bombardment.
- **Smoke tests:** Playwright loads the page, asserts the game reaches an interactive state on WebGPU and WebGL2 paths.

## 6 — Risks & mitigations

| Risk | Mitigation |
|---|---|
| Melee feel is hard to get right | Timeboxed; small move kit; the tilting deck does the heavy lifting; kick-first design; FP toggle is camera-only work |
| Remeshing hitches under bombardment | 16³ chunks, amortized remesh, Rapier voxel colliders designed for mutation |
| Character-on-moving-ship physics | M1 spike; ship-local kinematic controller pattern |
| TSL knowledge gaps in LLM-assisted dev | Feed current docs; WebGL2/GLSL fallback path |
| Flooding sim cost | Compartment-scalar model is O(compartments), not O(voxels) |
| Leaderboard cheating | Deterministic replay hash, server sanity bounds, rate limiting; accept imperfection in v1 |
| Scope creep (builder, multiplayer) | Formally out of v1 (§1); deterministic physics preserves the multiplayer option without paying for it now |
| Mobile expectations | Desktop browser is the v1 target; touch sailing is a stretch goal; touch melee explicitly excluded |

## 7 — Key references (from research session 2026-06-12)

- Rapier voxel colliders + 2025 review: dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge/
- Floating Sandbox flooding devlog: gabrielegiuseppini.wordpress.com/2018/09/08/momentum-based-simulation-of-water-flooding-2d-spaces/
- Gerstner buoyancy pattern: gamedeveloper.com "Water interaction model for boats in video games"; seacreaturegame.com Godot Gerstner+buoyancy writeup
- Three.js WebGPURenderer manual: threejs.org/manual/en/webgpurenderer.html
- Stormworks buoyancy/flooding rules: stormworks.fandom.com/wiki/Gameplay/Mechanics/Buoyancy
- War Thunder naval damage model (compartments + buoyancy %): warthunder.com/en/news/9795
- Browser-play conversion benchmark: howtomarketagame.com/2025/05/12/benchmark-itch-io-traffic/
- Assets: kenney.nl/assets/pirate-kit · quaternius.com/packs/piratekit.html · polyhaven.com
