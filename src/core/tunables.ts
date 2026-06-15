/**
 * Live-tunable physics + render parameters — the single mutable knob-board the
 * in-game DEV PANEL writes (backtick `\`` to toggle it) and the simulation reads
 * EVERY step/frame. This exists because the feel of the sea and the boat is a
 * subjective, iterate-until-it-looks-right thing the player asked to dial in
 * themselves ("just give me a dev panel where I can adjust these variables");
 * baking the values into code meant a reload-and-screenshot round trip per tweak.
 *
 * NOT persisted and NOT read by the deterministic vitest oracle — these only
 * scale forces/visuals at runtime. Defaults below are the shipped starting point;
 * the panel moves them live.
 */
export const TUN = {
  /** Hull hydrodynamics — read in game/ship.ts + game/sailing.ts. r17 PHILOSOPHY:
   *  the ship's ATTITUDE is now emergent from the per-voxel hull, not hand-tuned.
   *  Pitch, roll, trim and the turn-bank all come from real physics on the voxels:
   *  • buoyancy torques (each submerged cell lifts at its own spot) → wave-following
   *    pitch/roll + the ρgV·GM·sinθ righting that limits any heel — no clamp needed;
   *  • per-column VERTICAL drag (one ζ below) → heave + pitch + roll DAMPING for free;
   *  • turn-heel = the real centripetal G-force couple m·(v·ω)·h, where the lever h =
   *    (COM height − centre-of-buoyancy height) is measured LIVE from the wet voxels;
   *  • trim = where the hull settles given its per-voxel mass (move ballast, not a knob).
   *  So the six former levers (pitchDamp, rollDamp, trim, keelDepth, heelVelCap,
   *  turnHeelArm) are GONE — "mechanical interference with the voxel system just
   *  convolutes". What's left are four genuine physical coefficients. */
  phys: {
    /** global multiplier on per-voxel Archimedes lift. 1.5 was the playtest's
     *  preferred feel ("immediately makes things more realistic"). */
    buoyancy: 1.5,
    /** heave damping RATIO ζ: per submerged column the hull resists vertical motion
     *  with c = 2·ζ·√(k·m) against the LIVE hydrostatic stiffness, distributed over the
     *  waterplane so the SAME coefficient also damps pitch & roll (a bow plunging into a
     *  wave drags water = pitch damping). 0.2 was the playtest's preferred feel ("heave
     *  ... looks the best (and most intense) at the lowest setting of .2") — lightly
     *  damped so she rides the swell with life but never builds a resonant hobby-horse. */
    heaveDamp: 0.2,
    /** yaw angular damping (×yaw inertia) — the water + rudder resisting a spin. The one
     *  rotational axis with no buoyant restoring of its own, so it keeps a light damper. */
    yawDamp: 0.7,
    /** hydrodynamic lateral (leeway) resistance — the keel's grip on the water
     *  (×mass·vLat·submergedFrac). A REAL force (without it she slides sideways forever);
     *  applied at the COM so it supplies the turn's centripetal pull without itself
     *  heeling her — the bank is the separate emergent G-couple. The one lateral knob. */
    lateralDrag: 1.7,
  },

  /** Dynamic-wave interaction field (Crest/Atlas FDTD) — read in main.ts each frame
   *  and pushed to render/dynamicWaves.ts + render/ocean.ts. */
  dyn: {
    /** master enable — off → a perfectly clean cascade sea (no wake, no field). */
    enabled: true,
    /** how strongly the field displaces the ocean surface (uDynScale in ocean VERT). */
    heightScale: 0.45,
    /** ship-stamp impulse strength into the field's velocity channel. */
    inject: 0.6,
    /** field velocity damping (1/s). Higher kills the fast jagged ripples the
     *  injection used to pump in ("the ocean is violently shaking many times per
     *  second"); was 0.55. */
    damping: 1.8,
    /** foam-stamp strength (field froth + spray splash-down discs). 0 → no white
     *  spatter at all (the player's "constant spattering of white marks"). */
    foam: 0.0,
  },

  /** FFT chop (surface detail) controls — pushed to ocean.setChop each frame so the
   *  player can finally "play with the chop" (and bisect any residual jitter). The
   *  big swell shapes are NOT touched by these. */
  chop: {
    /** overall chop height/strength. 0 = pure swell (no FFT detail), 1 = default. */
    strength: 1.0,
    /** crest-pinch (horizontal choppiness): 0 = rounded swell, higher = sharper crests.
     *  1.5 was the playtest's preferred look ("chop looks best at chop:1 and chopiness:1.5"). */
    choppiness: 1.5,
  },

  /** Bow spray emission (read in main.ts checkBowSpray). The far-field ambient
   *  crest spray was removed in r16 — only bow spray + wake remain. */
  spray: {
    /** master enable for bow spray. */
    enabled: true,
    /** bow-wave spray strength multiplier. */
    bow: 1.0,
  },

  /** Cannon ballistics — read by game/cannons.ts (the LIVE ball) AND main.ts (the
   *  aim-arc preview). Both integrate from these same numbers with the same G +
   *  FIXED_DT, so the rendered trajectory and the real shot can never drift apart
   *  (the hard-won "line ≡ ball" invariant from playtest rounds 6–8). r18 retuned
   *  off the round-8 arcade values (72 m/s / 0.006 drag → ~70 m at 5°, ~180 m max)
   *  toward a weightier, flatter, more ballistic feel: 150 m/s / 0.0025 drag roughly
   *  TRIPLES range (~250 m at 5°, ~550 m max) while keeping the arc visible and
   *  leadable. Full age-of-sail realism (a 6-pdr is ~440 m/s / ~0.0008 drag → 1.4–2.4
   *  km) reads as invisible hitscan at this combat scale — drag the sliders to feel it. */
  gun: {
    /** muzzle speed (m/s). Real 6-pounder ≈ 440; 150 keeps the shot watchable. */
    muzzleSpeed: 150,
    /** quadratic air drag (per metre): |a_drag| = drag·v². Real ≈ 0.0008; 0.0025
     *  trims the long high tails without flattening the close-range arc. */
    drag: 0.0025,
    /** ball mass (kg) scaling the impact's momentum kick on the target hull.
     *  4.3 ≈ 9·(72/150) — preserves the old shove at the new, faster muzzle speed
     *  so the retune doesn't suddenly ram ships ~2× harder. */
    mass: 4.3,
    /** cannon bore: a ball pokes a hole CLEAN THROUGH — every solid voxel its path grazes
     *  vanishes, all the way out the far side (routed through ship.carveCells). boreRadiusVox
     *  is the tunnel half-width in voxels (0 = 1 wide, 1 = 3 wide); maxCellsPerHit is just a
     *  perf backstop on one ball's bore (set high — the hole should reach the far side). */
    boreRadiusVox: 1,
    maxCellsPerHit: 250,
    /** Fraction of the ball's ½mv² that goes to boring (crush()). >1 because
     *  STRENGTH_TO_JOULES is calibrated for RAMMING's megajoule reduced-mass impacts, so a
     *  ~48 kJ ball needs a multiplier to punch a 3-wide bore through both oak walls; this is
     *  the knob that decouples cannon penetration from the ram-tuned joule scale. Depth is
     *  still emergent (a half-speed ball at ¼ KE lodges; an iron belt resists). Tuned live
     *  at the Task 8 harness / Task 10 sweep alongside STRENGTH_TO_JOULES. Dropped 40→13 when
     *  STRENGTH_TO_JOULES was softened 15000→5000, so a ball still bores ~the same depth. */
    crushEfficiency: 13,
  },

  /** Ship-vs-ship DEFORMABLE contact (game/voxelContact.ts) — the Teardown rule. Ship-ship pairs
   *  are OUT of Rapier's rigid solver (physics.ts), so the hulls freely interpenetrate and the real
   *  voxel overlap is visible. Each fixed step voxelContact finds the overlapping voxel-pairs and
   *  branches PER CONTACT on the closing speed at that point:
   *   • closing FASTER than vBreak → BREAK both voxels; the fracture energy is removed from the
   *     closing motion (an inelastic bite, see crush.breakImpulse) but shed as a DRAG on the hull
   *     DRIVING in (crush.distributeClosingDrag) — the crumbling layer carries its momentum off as
   *     debris, so a heavy ram spends its OWN speed and does NOT shove a stationary victim up to
   *     ramming speed. Only the thin overlapping layer breaks each step, so the hull PLOWS into the
   *     cleared space next step, shedding a little per layer, until its approach drops under vBreak.
   *     Non-penetration here is free: the voxel in the way is gone, nothing to push against (no "jar").
   *     The drag is HORIZONTAL at COM height → an off-centre hit yaws (PIT), never rolls.
   *   • closing SLOWER than vBreak → REST: no damage; DELETE the closing and de-penetrate by POSITION
   *     along the horizontal COM→COM line (the geometric push-out axis FLIPS on engulf → shoves a
   *     lodged ram deeper) so two solid hulls can't share space — strong enough to EXPEL a lodge but
   *     position-only + closing-pre-zeroed, so it can't re-penetrate or fling. This is the ONLY place
   *     positional separation runs — the old bug ran it even while breaking, which WAS the jar.
   *  Heavier = harder to shove: each hull sheds Δv = (its drag share)/its mass. Replaces the retired
   *  3-part "carve/cancel/de-penetrate-every-step" rule (and the older rigid-reaction ram). */
  crush: {
    /** master enable — off → ship-vs-ship does nothing (hulls would ghost; see physics.ts hook). */
    enabled: true,
    /** closing speed (m/s) below which NOTHING breaks — the wood's "give" before it fractures
     *  ("more than say 4 knots"; 2.0 m/s ≈ 3.9 kn). Under it a slow bump just cancels + de-penetrates
     *  with no damage; over it the contact face crushes. The single velocity gate of the whole rule. */
    vBreak: 2.0,
    /** ×break-energy: how hard the wood is. Higher → a ram bites fewer voxels per joule AND sheds
     *  more speed per layer, so it penetrates LESS and resists more (a weightier, less explosive
     *  crash); lower → softer hulls that rip deep. The main "rip into each other" feel knob (was
     *  `yield`, inverted sense). 1.5 = ~50% tougher than the round-3 baseline (playtest: "tougher
     *  voxels"). */
    toughness: 1.5,
    /** how much of a BREAK hit's closing-Δv is handed to the struck hull as momentum (0..1) vs. spent
     *  slowing only the aggressor. 0 = a dead-in-the-water victim is NOT shoved at all (it just gets
     *  chewed); 1 = the full equal-and-opposite kick that drives both to a common velocity (the old
     *  "the victim steals all my speed" bug). 0.35 = the struck ship picks up a bit of the hit without
     *  being launched (playtest: "velocity transfers a bit more"). See crush.splitClosingImpulse. */
    transferFrac: 0.35,
    /** contact tolerance (VOXELS): an A voxel within this many voxels of a solid B voxel counts as
     *  touching/eligible to break. The voxels are a coarse hull approximation, so a little slack
     *  reads as "sufficiently close" without needing a half-voxel of real interpenetration first. */
    buffer: 0.4,
    /** REST de-penetration relaxation (0..1): fraction of the interpenetration depth the hulls move
     *  apart per step when too slow to break. Re-solved from the fresh overlap each step (never
     *  accumulates) and rate-capped by maxDepenSpeed. Raised 0.3→0.5 so a lodged ram is EXPELLED in a
     *  few steps rather than coasting through — the closing is zeroed first, so the overlap only ever
     *  shrinks (this can't re-penetrate or fling). */
    depen: 0.5,
    /** hard cap (m/s) on the REST positional separation (HORIZONTAL only) — the per-step ceiling on
     *  how fast a deep overlap clears. Raised 1.0→6.0: at 1.0 (≈1.7 cm/step) a deeply lodged hull
     *  could never be pushed out before it clipped through; 6.0 expels a metre-deep lodge in a handful
     *  of steps. It is position-only with the closing pre-zeroed, so even at 6 it eases (never flings)
     *  — for shallow everyday contacts depth·depen is far below this cap, so they still barely move. */
    maxDepenSpeed: 6.0,
    /** per-step cap (m/s) on the closing speed the BREAK bite may remove in one step. ALSO the main
     *  "how SLOW/drawn-out is the crash" knob: lower spreads the deceleration over more frames, so a
     *  hard ram grinds to a stop over ~½ s instead of slamming in one or two steps (playtest: "crashes
     *  happen a bit more slowly"). 3.5 (was 6) makes it bind on a fast ram; also a stability/NaN
     *  backstop on a huge single-step slab. */
    biteDvCap: 3.5,
    /** per-step break-energy CEILING (J, whole pair) — an anti-vaporize backstop. The real per-step
     *  limiter is GEOMETRY (only the thin overlapping layer can break); this only clamps a
     *  pathologically deep overlap (e.g. a teleport) from deleting a huge slab in one frame. */
    maxStepEnergy: 5.0e6,
    /** minimum penetration (m) before the REST branch responds — kills voxel flicker on a grazing
     *  touch / a calm side-by-side raft. */
    minDepth: 0.04,
    /** dust motes flung per voxel broken at the contact (visual; 0 = none). */
    fling: 1,
  },

  /** Flooding — the breach as a TWO-RESERVOIR orifice (sim/compartments.ts orificeFlow): flow is
   *  driven by the difference between the sea surface and the compartment's own pool at the hole,
   *  so she floods to a waterline EQUILIBRIUM (not to 100%) and DRAINS back out when a hole ends
   *  up above the pool (heel/capsize). These knobs scale the play-feel game/ship.ts feeds the
   *  deterministic oracle; the oracle's Cd + flow law stay exact. */
  flood: {
    /** multiplier on breach area → flow rate (1 = the raw orifice rate). 0.15 ≈ the playtest's
     *  "reduce flood rates ~85%": a holed hull settles and founders over a minute, not seconds,
     *  so flooding is a fightable, dramatic process (pumps + plank repairs matter). */
    inflowScale: 0.15,
    /** submerged fraction past which reserve buoyancy is treated as GONE and `waterlog` ramps to
     *  the final plunge. With waterline equilibrium in place a single nick never reaches this — only
     *  deep/progressive flooding does — so she mostly settles & survives (recovers below 0.7× this
     *  if drained/pumped). A healthy hull sits ~0.2 submerged, deck-awash ~0.5–0.6. */
    founderSubmerge: 0.6,
  },

  /** Fleet — how many hostile ships the FleetManager (game/fleet.ts) keeps sailing
   *  against the player. Integer 0..MAXVIS. Sunk enemies are auto-replaced to hold
   *  this count (true even at 1). Default 1 = the shipped duel. The dev panel drives
   *  this live; like every TUN knob it is NOT read by the deterministic vitest oracle. */
  fleet: {
    enemyCount: 1,
  },

  /** Visual-pass-1 graphics knobs — read by render/post.ts, render/sky.ts,
   *  render/clouds.ts and render/ocean.ts. Pure VISUALS: none of these are read
   *  by the deterministic vitest oracle, and none feed physics (THE LAW #1).
   *  Every effect is independently togglable so the browser demo can dial down
   *  while the Steam build runs full. */
  gfx: {
    /** master switch for the whole post-processing composer. Off → main.ts uses
     *  the legacy direct renderer.render path (no bloom/god rays/grade) — a perf
     *  floor + safety valve if the composer ever misbehaves. */
    post: { enabled: true },
    /** UnrealBloomPass — glows the sun disc, the sun-glint path and bright foam.
     *  Mild by design ("grounded realism with punch", not a bloom-fest). */
    bloom: { enabled: true, strength: 0.14, radius: 0.5, threshold: 1.5, clamp: 12 },
    /** screen-space god rays (render/post.ts GodRayPass) anchored at the sun's
     *  projected position; occlusion is free (dark geometry blocks the shafts). */
    godrays: { enabled: true, strength: 0.5, decay: 0.96, density: 0.85, weight: 0.5, samples: 60 },
    /** final color grade (render/post.ts GradePass): contrast + saturation +
     *  a subtle vignette for the cinematic punch. */
    grade: { contrast: 1.06, saturation: 1.1, vignette: 0.2 },
    /** water reflection of the sky env cube (render/ocean.ts): strength scales the
     *  Fresnel-weighted reflection; rebakeHz throttles re-rendering the sky+cloud
     *  cube (clouds drift slowly, so a couple of bakes a second is plenty). */
    reflection: { strength: 0.9, rebakeHz: 2 },
    /** procedural cloud dome (render/clouds.ts): coverage = how much sky is cloud,
     *  density = opacity/contrast of each puff, speed = drift rate. */
    clouds: { coverage: 0.5, density: 0.7, speed: 0.6 },
    /** triplanar procedural grit on island voxels (render/islandVisual.ts) — 0 =
     *  flat vertex color, 1 = full weathered variation. Silhouettes stay crisp. */
    islandGrit: { strength: 0.65 },
  },
};

export type Tunables = typeof TUN;
