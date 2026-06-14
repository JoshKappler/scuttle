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
    crushEfficiency: 8,
  },

  /** Ship-vs-ship destruction — the Teardown-style CAPPED-IMPULSE contact, read by
   *  game/collisionDestruction.ts each step. ONE emergent rule: contact force vs. the
   *  voxels' strength. Below `minImpulse` the contact is solid (a weight a hull CAN bear,
   *  a gentle fender, floating side by side → no damage). Above it the contact voxels give
   *  way: the zone is pulverized to DUST (never a rigid beam — see debris.ts), the carve
   *  happens BEFORE the solver so the struck hull is barely shoved and the rammer digs into
   *  the void, and `drag` bleeds the digger's momentum into the destruction (it slows; the
   *  target doesn't pick the momentum up). Perching emerges as impossible: your own weight
   *  on a few deck voxels exceeds the threshold → they crush → you fall through. */
  ram: {
    /** master enable — off → plain rigid hull collisions, no destruction. */
    enabled: true,
    /** crush threshold (summed contact impulse, kg·m/s): the ONE gate. Set between a
     *  gentle nudge and a hull's full weight bearing on a small patch — so weight-on-deck
     *  crushes through (no perching) but a light touch / side-by-side raft does not.
     *  Raise if hulls chip on mere contact; lower if slow rams just bounce off. */
    minImpulse: 40000,
    /** carve joules per unit of impulse ABOVE the threshold — higher pulverizes a bigger
     *  crater per step. */
    impulseToJoules: 0.5,
    /** max voxels pulverized from ONE hull per contact-step. Generous: a hard ram turns the
     *  touched zone to dust; the gash deepens every step she stays driven in. Not a "small
     *  cluster" cap — lots of voxels is wanted, just never welded into a floating body. */
    maxCellsPerHit: 60,
    /** destruction drag (kg·m/s of momentum bled per voxel destroyed, from whichever hull
     *  is driving INTO the contact). This is "the energy goes into the destruction, not into
     *  shoving the target": the rammer slows as it digs in; the struck ship is barely moved.
     *  Clamped so it can never reverse a hull's motion. 0 = pure rigid shove. */
    drag: 4000,
  },

  /** Ship-vs-ship DEFORMABLE contact — the rebuild (game/voxelContact.ts). The hull-hull
   *  pair is out of Rapier's rigid solver (physics.ts); each fixed step we read the real
   *  voxel overlap and apply a soft, force-capped penalty spring whose over-cap energy CARVES
   *  both hulls at the contact. The carve shrinks the overlap → bleeds the spring, so the
   *  rammer decelerates and digs in while the target is barely shoved (fMax bounds the push).
   *  Mutual "wet-wood crunch", not rigid plow. Replaces TUN.ram (retired in Task 10). */
  crush: {
    /** master enable — off → ship-vs-ship does nothing (hulls ghost; see physics.ts hook). */
    enabled: true,
    /** penalty spring stiffness (N per metre of penetration). With substeps + critical
     *  damping the stability bound is ~ k·(dt/N)²/m_eff ≲ 1; start soft, raise at the harness. */
    k: 6.0e6,
    /** damping as a fraction of critical (c = mult·2·√(k·m_eff)). 1 = critically damped (no
     *  bounce); back off slightly for a little spring-feel. */
    damping: 0.9,
    /** force cap (N). THE knob for "barely shove the target": the push can never exceed this,
     *  so a hard ram's excess energy goes to carving instead of launching the struck ship.
     *  This cap also bounds the per-step impulse (≤ fMax·dt), which is what makes the contact
     *  stable in a single pass — no sub-stepping needed. */
    fMax: 6.0e5,
    /** fraction of the over-cap energy that becomes destruction (1 = all). Tunes how readily
     *  the crunch carves vs. just bounces. */
    yield: 1,
    /** dust motes flung per voxel carved at the contact (visual; 0 = none). */
    fling: 1,
    /** minimum penetration (m) before any carving — kills voxel flicker on a grazing touch /
     *  a calm side-by-side raft (which still gets the gentle spring, just no damage). */
    minDepth: 0.06,
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
