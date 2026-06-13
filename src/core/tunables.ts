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
  /** Buoyancy + hull-attitude dynamics (read in game/ship.ts + game/sailing.ts). */
  phys: {
    /** global multiplier on per-voxel Archimedes lift. 1.5 was the playtest's
     *  preferred feel ("immediately makes things more realistic"). */
    buoyancy: 1.5,
    /** heave damping RATIO ζ (r16): the actual drag is c = 2·ζ·√(k·m) against the
     *  LIVE hydrostatic stiffness, so settling is consistent at any buoyancy. ~0.8
     *  is near-critical — rides the swell without porpoising or bouncing. (Was a raw
     *  force coefficient 2.8 before the per-voxel stiffness existed.) */
    heaveDamp: 0.8,
    /** beam-axis angular damping. The round-9..14 value was 4.2× the pitch
     *  inertia, which FROZE the wave-following the per-column buoyancy torques
     *  would otherwise produce ("the boat does not pitch fore/aft with the water
     *  under it, it just rises and falls uniformly"). Light now → she follows the
     *  swell face; just enough to settle in a wave or two without hobby-horsing. */
    pitchDamp: 1.3,
    /** fore-aft-axis (roll) angular damping (was 1.2×roll inertia). */
    rollDamp: 0.9,
    /** yaw angular damping (×yaw inertia). */
    yawDamp: 0.7,
    /** speed-planing bow-lift trim authority. Was 12 and swamped the wave pitch;
     *  small now so she planes a touch bow-up at speed without fighting the sea. */
    trim: 3.0,
    /** keel lateral resistance (×mass·vLat·submergedFrac). */
    lateralDrag: 1.7,
    /** depth below COM (m) the lateral keel force bites — the bank lever in turns. */
    keelDepth: 1.8,
    /** cap (m/s) on the lateral skid velocity that feeds the heel moment, so a
     *  hard snap-turn can't drive an unbounded couple that rolls the rail under
     *  ("under max speed and turn the ship can go completely underwater"). */
    heelVelCap: 6.0,
    /** turn-heel lever arm (m) handed to sailing.heel.turnHeelTorque — how hard she
     *  banks into a turn (was the static 4.2). */
    turnHeelArm: 3.4,
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
    /** crest-pinch (horizontal choppiness): 0 = rounded swell, higher = sharper crests. */
    choppiness: 1.0,
  },

  /** Bow spray emission (read in main.ts checkBowSpray). The far-field ambient
   *  crest spray was removed in r16 — only bow spray + wake remain. */
  spray: {
    /** master enable for bow spray. */
    enabled: true,
    /** bow-wave spray strength multiplier. */
    bow: 1.0,
  },
};

export type Tunables = typeof TUN;
