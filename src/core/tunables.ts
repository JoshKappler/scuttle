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
     *  at the Task 8 harness / Task 10 sweep alongside STRENGTH_TO_JOULES. */
    crushEfficiency: 40,
  },

  /** Ship-vs-ship DEFORMABLE contact — ONE emergent rule (game/voxelContact.ts). The hull-hull
   *  pair is out of Rapier's rigid solver (physics.ts); each fixed step, where the two hulls'
   *  voxels overlap and are CLOSING, the relative closing KE (½μv²) is spent breaking the
   *  cheapest contacting voxels of both hulls, and the KE that breaking consumes IS the impulse
   *  μ·Δv exchanged at the contact point (faster ship slows, slower speeds up + off-centre spin
   *  / PIT). Can't break it → elastic bounce (solid stop). Big-rams-small breaks through; equals
   *  head-on disintegrate; stops once closing is too slow to break a voxel. Replaces the old
   *  penalty-spring (k/damping/fMax retired) and TUN.ram. */
  crush: {
    /** master enable — off → ship-vs-ship does nothing (hulls ghost; see physics.ts hook). */
    enabled: true,
    /** per-step break-energy CEILING (J, whole pair) — an anti-vaporize cap for extreme closing
     *  speeds, NOT the every-step rate. The real budget is the closing KE (½μv²); this only
     *  clamps it so a freakishly fast hit can't delete a huge slab in one frame. At normal
     *  sail-ram speeds ½μv² is already below this, so it rarely binds. */
    maxStepEnergy: 6.0e6,
    /** fraction of the closing KE available to break voxels (1 = all). Lower → tougher hulls
     *  (less breaks per hit) and more of the energy goes to the velocity exchange/bounce. */
    yield: 1,
    /** how strongly the energy SPENT breaking voxels removes closing speed (1 = full physical:
     *  the relative motion loses exactly the KE that became destruction). This is "the ram slows
     *  as it digs in"; the lost momentum is the impulse swapped between the hulls. */
    carveDamp: 1,
    /** fraction of the breaking's velocity change that is exchanged between the hulls (0..1).
     *  KEY "less aggressive" knob: fracturing wood dissipates energy but transmits little
     *  momentum, so most of the break is lost (to splinters/sound), not flung into the heavy
     *  hull. 0.2 = a ram slows + the target speeds up GENTLY over many voxels, instead of one
     *  ship launching the other. Applied at the contact point so a diagonal hit still yaws (PIT). */
    transfer: 0.2,
    /** de-penetration speed (m/s of separation per metre of interpenetration, capped at 1 m of
     *  depth) for an unbroken SOLID contact, so entangled hulls ooze apart instead of staying
     *  clipped through each other. Applied at the COM (pure linear) so it never ROLLS the hull,
     *  and never fires while a ram is actively breaking through. Gentle. */
    separate: 2,
    /** dust motes flung per voxel broken at the contact (visual; 0 = none). */
    fling: 1,
    /** minimum penetration (m) before any breaking — kills voxel flicker on a grazing touch /
     *  a calm side-by-side raft (which still gets the gentle bounce, just no damage). */
    minDepth: 0.06,
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
