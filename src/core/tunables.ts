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

  /** Ship-vs-ship DEFORMABLE contact — ONE emergent rule, no "rammer" vs "target" (game/
   *  voxelContact.ts). The hull-hull pair is out of Rapier's rigid solver (physics.ts); each fixed
   *  step, where the hulls' voxels overlap and CLOSE faster than vBreak, the cheapest contacting
   *  voxels of BOTH hulls break on a budget of the collision energy ½·μ·vClose². The momentum is a
   *  plain INELASTIC impulse along the relative-velocity direction that drives both hulls toward
   *  their COMMON velocity (faster slows, slower speeds up) until the relative motion — and the
   *  breaking — stop. It is symmetric and self-limiting (vRel→0 ⇒ impulse→0), so it can't fling, and
   *  it uses the velocity direction, NOT a centre-to-centre normal (which flipped/spiked at deep
   *  overlap). The struck ship is NOT rooted — the keel's own anisotropic water drag (ship.ts, ~42×
   *  stronger sideways than fore/aft) bleeds the velocity it gains, so a broadsided hull lurches
   *  then settles while a rear-ended one slides more: "in molasses", fully emergent. Replaces the
   *  retired penalty-spring (k/damping/fMax) and TUN.ram. */
  crush: {
    /** master enable — off → ship-vs-ship does nothing (hulls ghost; see physics.ts hook). */
    enabled: true,
    /** per-step break-energy CEILING (J, whole pair) — an anti-vaporize backstop, NOT the
     *  every-step rate. The real per-step limiter is GEOMETRY (only the voxels actually in the
     *  thin contact layer can break); this just clamps a pathologically deep overlap (e.g. a
     *  teleport) from deleting a huge slab in one frame. At sail-ram speeds it never binds. */
    maxStepEnergy: 5.0e6,
    /** closing speed (m/s) below which NOTHING breaks — the wood's "give" before it fractures
     *  ("more than say 4 knots"; 2.0 m/s ≈ 3.9 kn). Under it, a slow bump / side-by-side raft
     *  just springs apart (capped, gentle) with no damage; over it, the contact face crushes. */
    vBreak: 2.0,
    /** fraction of the collision energy ½·μ·vClose² made available to break voxels (1 = all). Lower
     *  → tougher hulls (fewer voxels break per hit, a ram penetrates less). */
    yield: 1,
    /** INELASTIC transfer fraction (0..1). 1 = a fully inelastic collision: the impulse cancels the
     *  hulls' relative velocity, so they reach a common velocity (the faster slows, the slower speeds
     *  up) — honest momentum transfer with NO rammer/target distinction. Lower → less velocity
     *  trades hands (stiffer, more rooted). NOT a fling knob: the transfer only ever closes the gap
     *  to the common velocity, never past it; what makes a struck ship "only move a bit" is the
     *  keel's water drag, not this. The struck hull's gain is applied at COM height → yaw (PIT),
     *  never roll. Raise toward 1 for a more epic, fully-inelastic exchange; lower for "not pushed as
     *  easily" (stiffer, the struck ship lurches less and the sea stops it sooner). 0.5 = a clear
     *  shove that still settles quickly. */
    transfer: 0.5,
    /** de-penetration separation speed (m/s) for the sub-vBreak case ONLY: when the hulls overlap
     *  but nothing is breaking (a slow bump, or lodged together after an impact), they're eased apart
     *  until they part at this speed — one-shot, never pulling together, equal-and-opposite at the COM
     *  (no roll), tiny so it can't fling. Never fires while a ram is breaking. */
    separate: 0.6,
    /** dust motes flung per voxel broken at the contact (visual; 0 = none). */
    fling: 1,
    /** minimum penetration (m) before any contact response — kills voxel flicker on a grazing
     *  touch / a calm side-by-side raft. */
    minDepth: 0.06,
    /** per-step cap (m/s) on the RELATIVE velocity the inelastic impulse may cancel in one step — a
     *  smoothing + NaN backstop. A real impact closes its gap over several steps anyway, so this
     *  rarely binds; it just keeps a single freak frame from applying a huge impulse. 4 ≈ snappy but
     *  spike-proof. */
    maxDvPerStep: 4,
  },

  /** Flooding — how fast the sea comes in through a breach. The deterministic floodStep oracle
   *  (sim/compartments.ts) is UNCHANGED; this scales the breach area game/ship.ts feeds it, so
   *  the vitest oracle stays exact while the play-feel is tunable. */
  flood: {
    /** multiplier on breach inflow (1 = the raw Bernoulli orifice rate). 0.15 ≈ the playtest's
     *  "reduce flood rates ~85%": a holed hull settles and founders over a minute, not seconds,
     *  so flooding is a fightable, dramatic process (pumps + plank repairs matter). */
    inflowScale: 0.15,
  },

  /** Fleet — how many hostile ships the FleetManager (game/fleet.ts) keeps sailing
   *  against the player. Integer 0..MAXVIS. Sunk enemies are auto-replaced to hold
   *  this count (true even at 1). Default 1 = the shipped duel. The dev panel drives
   *  this live; like every TUN knob it is NOT read by the deterministic vitest oracle. */
  fleet: {
    enemyCount: 1,
  },
};

export type Tunables = typeof TUN;
