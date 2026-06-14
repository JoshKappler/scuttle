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
    /** voxel-carving joules per cannonball hit — routed through the SAME carve()
     *  primitive as ramming. Sized for a small entry cluster, not a blown-out row. */
    carveJoules: 110000,
    /** max voxels one ball removes: a tight, directional bite along the ball's path. */
    maxCellsPerHit: 8,
  },

  /** Ship-vs-ship ramming destruction — read by game/collisionDestruction.ts each
   *  contact. Carve energy = impulseToJoules × max(0, contactImpulse − minImpulse): only
   *  the impulse ABOVE the crush threshold tears voxels out, so a hull resting its weight
   *  on another, a gentle fender, or two hulls floating side by side destroy NOTHING,
   *  while a real strike (impulse ≈ closing-speed × reduced-mass) bites hard. Dial live. */
  ram: {
    /** joules of voxel-carving per unit of impulse ABOVE minImpulse (kg·m/s). */
    impulseToJoules: 2.5,
    /** crush threshold: contacts at/below this carve nothing (resting weight, gentle
     *  fenders, floating side by side). Set above a hull's per-step weight impulse so
     *  only way-on impacts destroy. Raise if hulls chip on mere contact; lower if slow
     *  rams just bounce. */
    minImpulse: 100000,
    /** hard cap on voxels removed from ONE hull per contact-step — keeps each step's
     *  bite to "single voxels and small groups"; a deep gash emerges over many steps of
     *  a sustained ram, never a whole row in one frame. */
    maxCellsPerHit: 10,
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
