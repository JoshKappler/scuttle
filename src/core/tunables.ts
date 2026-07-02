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
    /** heave damping RATIO ζ, referenced to the PURE hydrostatic stiffness k = ρ·g·A_waterplane
     *  (round 12 SP5: the `buoyancy` multiplier is factored OUT of the damping pairing, so moving
     *  `buoyancy` no longer silently moves the damping coefficient). Per submerged column the hull
     *  resists vertical motion with c = 2·ζ·√(k·m), distributed over the waterplane so the SAME
     *  coefficient also damps pitch & roll (a bow plunging into a wave drags water = pitch damping).
     *  0.2·√1.5 ≈ 0.245 reproduces the shipped feel EXACTLY — the playtest's preferred 0.2 ("heave
     *  ... looks the best (and most intense) at the lowest setting of .2") was tuned against k×1.5,
     *  and 2·0.2·√(1.5·k·m) ≡ 2·(0.2·√1.5)·√(k·m). */
    heaveDamp: 0.2 * Math.sqrt(1.5),
    /** yaw angular damping (×yaw inertia) — the water + rudder resisting a spin. The one
     *  rotational axis with no buoyant restoring of its own, so it keeps a light damper. SHIP-FEEL
     *  pass eased 0.7→0.6; ROUND-12 SP3 eased 0.6→0.4 (with the yaw added-mass split 1.6→1.3 and
     *  the hull-length rudder lever) so the steady rate rises and the coast-through after
     *  centering the helm stays damped by the body's 0.15 angular damping — final value
     *  calibrated by tests/turnRate.test.ts (cutter ~2.5 s, frigate ~5.5 s to 90°). */
    yawDamp: 0.4,
    /** hydrodynamic lateral (leeway) resistance — the keel's grip on the water
     *  (×mass·vLat·submergedFrac). A REAL force (without it she slides sideways forever);
     *  applied at the centre of buoyancy so it supplies the turn's centripetal pull AND, sitting
     *  below the COM, rights her against sail heel — the bank is the separate emergent G-couple
     *  (phys.turnHeel below). The one lateral knob. */
    lateralDrag: 1.7,
    /** SHIP-FEEL pass — rudder authority multiplier on the yaw torque (game/sailing.ts). The base
     *  yaw coefficient was 0.5; this replaces it so the turning circle is live-tunable. 1.0 (2× the old
     *  0.5), with yawDamp eased 0.7→0.6, roughly halves the turning circle (measured brig ≈327 m → ≈150 m).
     *  Bigger = tighter turn; too big spins her uncontrollably. (The "Sharper Rudder" UPGRADE —
     *  ship.rudderPower — still stacks ON TOP of this for the player.) */
    rudderGain: 2.0,
    /** SHIP-FEEL R4 — low-speed turn FLOOR fed into the rudder flow term in game/sailing.ts
     *  (yaw ∝ rudder·(rudderLowFloor+|speed|)·rudderGain). Near a standstill |speed|→0, so this floor
     *  is essentially ALL the steering authority you have; raised so you can pivot to line up a shot
     *  without way on (playtest: "very hard to line up shots, everything moves so slow"). Replaces the
     *  hard-coded 1.5 base that used to live in sailing.ts. */
    rudderLowFloor: 2.5,
    /** ROUND-12 SP3 — hull-length RUDDER LEVER exponent. Rudder torque gains a factor
     *  (L/L0)^rudderLeverExp with L = the hull's effective length and L0 = the Cutter's (21 m), so
     *  authority grows with ship size instead of falling off with L² (steady rate ∝ gain·lever/(l²+w²)).
     *  Cutter-anchored: the Cutter's feel is UNCHANGED (lever ≡ 1); calibrated with yawDamp 0.4 +
     *  yaw added-mass 1.3 so tests/turnRate.test.ts lands cutter ~2.5 s / frigate ~5.5 s to 90°.
     *  0 = no lever (pre-round-12); 1 = full physical rudder-arm ∝ L (overshoots the tier targets). */
    rudderLeverExp: 0.35,
    /** SHIP-FEEL pass — EXTRA roll damping about the ship's FORE-AFT axis only (×roll inertia·wet),
     *  on top of the shared heaveDamp ζ. This stiffens the side-to-side ROLL (less idle wallow and
     *  straight-line sway) WITHOUT over-damping heave/pitch (which the playtest liked light at 0.2).
     *  Higher = a stiffer, drier-rolling hull; 0 = old behaviour (roll damped only by heaveDamp). */
    rollDamp: 2.0,
    /** SHIP-FEEL pass — TURN-HEEL couple gain. A turning ship feels a lateral-G reaction m·(v·ω)
     *  acting at the COM above the keel's grip → a pure torque about the fore-aft axis that banks her
     *  OUTWARD of the turn (the separate emergent G-couple THE LAW #3 names). Applied as a couple
     *  (no net force → no translation artefact), scaled by the COM height above the keel (this.comLocal[1],
     *  NOT the COM−CB heelArm, which Task 3's lower COM collapsed), faded out near turnHeelCap, and
     *  ultimately BOUNDED by the buoyant ρgV·GM·sinθ righting — so this gain sets the steady lean in a
     *  hard turn (tuned so a full-rudder brig/cutter turn peaks ~40–45° without capsizing; the heavy,
     *  wide-turning Man-o'-War leans a stately ~20°). 0 = no turn heel; she can never turtle from this. */
    turnHeel: 4.0,
    /** SHIP-FEEL pass — clamp (m/s²) on the v·ω lateral acceleration feeding the turn-heel couple, so
     *  a collision spin or a momentary huge yaw rate can't slam her flat past the righting. */
    turnHeelMaxG: 3.0,
    /** SHIP-FEEL pass — soft KNOCKDOWN cap (degrees): the turn-heel couple fades from full at 60% of
     *  this angle down to ZERO at the cap, so a hard turn leans to ~this on EVERY hull but the couple
     *  can never push her past it into a capsize — the buoyant righting then wins. This is what makes
     *  one turnHeel gain safe across the light Cutter (which turns very tight) and the heavy Man-o'-War
     *  alike. 45 = the requested "almost 45° at peak turn". */
    turnHeelCap: 45,
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
    /** Broadside RAGGEDNESS (s): a battery doesn't all fire on one tick — a real ship-of-the-line
     *  lets the guns off in a ripple. The first gun cracks the instant you click (responsive), the
     *  rest fire at random offsets across this window until the whole battery is expended. 0 = the
     *  old simultaneous volley. Each ball still leaves from its OWN muzzle at LAUNCH time, so a
     *  later shot fires along where that gun bears then (the cost of the ripple vs. the frozen
     *  aim-line; accepted for the feel — "wouldn't fire twenty-one cannons at exactly the same time"). */
    broadsideSpread: 1.6,
    /** Cannon MOUNT survival fraction: a gun stays bolted to the deck while at least this share of
     *  its initial mount cells (the bed + the planking under the truck — sim/cannonMount.ts) is still
     *  solid. Once the hull beneath it is shot/rammed away below this, the gun loses its footing,
     *  tips off the side into the sea, and can no longer be fired or counted in a broadside. Lower =
     *  the gun clings on through more damage; higher = a glancing hit dismounts it. */
    mountToughness: 0.5,
    /** Outboard kick (m/s) added to a dismounted gun as it tips over the rail — so it clears the
     *  hull and splashes alongside instead of dropping straight through the deck. */
    fallKick: 1.5,
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
    /** closing speed (m/s) below which NOTHING breaks — the wood's "give" before it fractures.
     *  4.0 m/s ≈ 7.8 kn (raised from 2.0 on playtest: two hulls drifting/pressed side-by-side at a
     *  knot or two were tearing each other's sides off — that must just REST + de-penetrate now; only
     *  a deliberate ram at speed crushes). Under it a slow bump cancels + de-penetrates with no
     *  damage; over it the contact face crushes. The single velocity gate of the whole rule. */
    vBreak: 4.0,
    /** ×break-energy: how hard the wood is. Higher → a ram bites fewer voxels per joule AND sheds
     *  more speed per layer, so it penetrates LESS and resists more (a weightier, less explosive
     *  crash); lower → softer hulls that rip deep. The main "rip into each other" feel knob (was
     *  `yield`, inverted sense). 2.5 (was 1.5): stronger hulls so a glancing contact between two big
     *  ships no longer guts a whole side — a ram still bites, but takes real speed to chew deep. */
    toughness: 2.5,
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
     *  accumulates) and rate-capped by maxDepenSpeed. Raised 0.5→0.8 (was 0.3) so a lodged ram is
     *  EXPELLED in a few steps rather than coasting through ("phasing"): at 0.5 the rammer kept driving
     *  in faster than the push-out could clear → she slid through. The closing is zeroed first, so the
     *  overlap only ever shrinks (this can't re-penetrate or fling). */
    depen: 0.8,
    /** hard cap (m/s) on the REST positional separation (HORIZONTAL only) — the per-step ceiling on
     *  how fast a deep overlap clears. Raised 6.0→30.0 (was 1.0): at 6.0 the per-step cap is only
     *  0.10 m (≈0.05 m/hull after the inverse-mass split) so a real multi-metre ram lodge took ~20-40
     *  steps to clear while the rammer kept driving in → pure pass-through ("phasing"). 30.0 makes the
     *  per-step cap 0.5 m (0.25 m/hull) → a 2 m lodge clears in ~4-8 steps. It stays position-only with
     *  the closing pre-zeroed, so even at 30 it only ever shrinks the overlap (never re-penetrates or
     *  flings); shallow everyday contacts use depth·depen, far below this cap, so they still barely move. */
    maxDepenSpeed: 30.0,
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

  /** Felled-mast float physics — consumed by game/debris.ts (spawnMast / stepDebris).
   *  Masts are now real SPAR voxels carved by the unified crush; when the trunk is severed
   *  debris.spawnMast spawns a falling rigid body and these knobs tune how it topples,
   *  floats, and eventually waterlogs. NOT read by the deterministic vitest oracle. */
  rig: {
    /** sideways shove (m/s) given the felled mast so a vertical spar topples OVER the side instead of
     *  dropping straight down. The "goes by the board" lean (seeds the chunk's linear + roll kick). */
    toppleKick: 2.0,
    /** buoyancy lift decay per second — a downed mast floats on entrained air, then waterlogs and
     *  founders (cf. debris.wreckLift). R4: 0.06→0.02 so a felled spar FLOATS and drifts for a good
     *  while (the user's "fall into the water and then float around") before it slowly waterlogs under. */
    waterlog: 0.02,
    /** effective mass (kg) of one falling spar/cloth node when it crushes a deck (½·m·v² budget) —
     *  high enough that a toppling mast actually staves in what it lands on. */
    fallMass: 800,
    /** seconds before a falling-mast wreck is despawned (also goes early once fully sunk). */
    fallLifetime: 40,
    /** R4 mast-FLOAT: a felled spar must SETTLE and FLOAT, not bob/bounce.
     *  fallFloatBuoy = the target buoyancy multiplier while afloat (≈neutral so it rests awash,
     *  not a trampoline); fallVertDamp = near-critical vertical velocity damping that kills the bob
     *  the instant it touches water (kv = m·fallVertDamp·wet); the per-debris MAST_SINK_FLOOR
     *  constant in debris.ts sets the floor the lift decays toward so it eventually waterlogs under. */
    fallFloatBuoy: 1.0,
    fallVertDamp: 5.0,
  },

  /** Navigational hazards (game/islandField.ts) — extra terrain scattered at world generation.
   *  Read ONCE when the archipelago is built (changing it needs a reload, not a live tweak). */
  hazard: {
    /** how many sea-stack spires to scatter in open water between the islands. */
    seaStacks: 12,
  },

  /** Flooding — the breach as a TWO-RESERVOIR orifice (sim/compartments.ts orificeFlow): flow is
   *  driven by the difference between the sea surface and the compartment's own pool at the hole,
   *  so she floods to a waterline EQUILIBRIUM (not to 100%) and DRAINS back out when a hole ends
   *  up above the pool (heel/capsize). These knobs scale the play-feel game/ship.ts feeds the
   *  deterministic oracle; the oracle's Cd + flow law stay exact. */
  flood: {
    /** multiplier on EACH breach cell's orifice area → flow rate (1 = the raw orifice rate). A
     *  compartment's total inflow is this × the NUMBER of its breach cells × √(2g·depth), so a 1-cell
     *  nick and a 30-cell gash differ ~30× in area and further by depth (a deep hole has more head).
     *  Tuned WITH pumpRate so the three damage cases land where the player asked: a single waterline
     *  cell is trivially pumped, a ~6-10 cell hole sits about at pump capacity, a big low chunk
     *  (~25-40 cells, deep) outpaces the pump. R4: 0.2→0.5 so a hull broken WIDE open (a rammed-off bow,
     *  a 30-cell gash) floods AND drains FAST — equalising toward the waterline in a few seconds, not the
     *  "very slowly" the user reported — while the per-cell area scaling keeps a single nick trivial for
     *  the pump. Flow is signed (same orifice both ways), so the faster-out is automatic. */
    inflowScale: 0.5,
    /** pump drain rate (m³/s) — the bilge pump empties the single MOST-flooded compartment while ON
     *  (`P` toggles). Set so it beats every case BUT the worst: a small/medium breach is held or
     *  reversed, a gaping low hole still outpaces it. At a ~0.7 m-deep mid hole (~8 cells) the inflow
     *  is ≈0.22 m³/s, just under this; a single waterline cell (~0.013 m³/s) is trivially won; a
     *  ~30-cell deep gash (~1.4 m³/s) overwhelms it ~5×. Pair with inflowScale when retuning feel.
     *  R4: 0.25→0.3 to keep pace with the faster inflowScale on small/medium holes (pump still loses to
     *  a gaping low breach). */
    pumpRate: 0.3,
    /** submerged fraction past which reserve buoyancy is treated as GONE and `waterlog` ramps to
     *  the final plunge. With waterline equilibrium in place a single nick never reaches this — only
     *  deep/progressive flooding does — so she mostly settles & survives (recovers below 0.7× this
     *  if drained/pumped). A healthy hull sits ~0.2 submerged, deck-awash ~0.5–0.6. */
    founderSubmerge: 0.6,
    /** FLOOD-WATER VISUAL (render/compartmentFluid.ts) — pure VISUALS, not read by the oracle.
     *  The interior flood is rendered as a CLONE of the open-sea surface (same body colour, sky-env
     *  Fresnel reflection and a gentle Gerstner shimmer, shared live from render/ocean.ts) sitting at
     *  the compartment's own (lower) flood level, so it reads as "the ocean continuing into the room".
     *  ONE continuous top sheet per flooded compartment + a short SIDE SKIRT that gives the body real
     *  depth/substance. The skirt FADES OUT as the interior level rises to the local sea level (a big
     *  hole equalises fast → inside ≈ outside → no jarring exposed wall at the breach), and only shows
     *  for a small hole (interior well below the sea) or transiently while filling. */
    render: {
      /** max metres the side skirt drops below the pool surface (the body's visible depth/substance).
       *  Clamped to the compartment's actual floor depth, so a shallow pool shows a shallow body. */
      skirtDepth: 1.6,
      /** opacity of the top water sheet (0..1). Mostly opaque so it reads as the sea surface, with a
       *  touch of translucency so the timber beneath isn't a hard cut. */
      topOpacity: 0.92,
      /** opacity of the side skirt (0..1) at full exposure — a little less than the top so the depth
       *  reads as a darker body wall, not a second bright sheet. */
      skirtOpacity: 0.8,
      /** metres of level-difference (interior pool below local sea) over which the skirt fades from
       *  fully HIDDEN (inside ≈ sea, big-hole case → no exposed wall) up to fully shown (small hole,
       *  inside well below the sea). Smaller = the wall pops in sooner as the level drops. */
      blendBand: 0.7,
      /** gentle surface shimmer amplitude (m) of the shared Gerstner-style ripple on the flood top —
       *  the "moving water" life, kept small so the pool reads calm (a room, not the open sea). */
      shimmer: 0.05,
    },
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
     *  floor + safety valve if the composer ever misbehaves.
     *  PERF (these are the big levers — the post chain is fill-bound):
     *  maxPixelRatio caps the resolution the WHOLE chain renders at (1 = native
     *  pixels even on a 2× HiDPI display → up to 4× fewer pixels through bloom +
     *  god-rays; the final pass upscales to the canvas). scale multiplies that
     *  further (0.75 = render at 3/4 res for more speed; 1 = no extra scaling). */
    post: { enabled: true, maxPixelRatio: 1, scale: 1.0 },
    /** adaptive-quality governor + perf HUD (render/perf.ts). This is the answer to
     *  "why does it oscillate between 5 fps and smooth?": when `enabled`, a watchdog
     *  measures the real frame time and walks the post-FX DOWN (an extra resolution
     *  `scale` multiplier, then dropping god rays via `suppressGodrays`) whenever the
     *  framerate sits below `targetFps`, stepping back up when there's headroom — so the
     *  frame can't silently park at single digits. On a healthy GPU it stays at tier 0 and
     *  changes nothing. `scale`/`suppressGodrays`/`fps`/`tier` are WRITTEN by the governor
     *  (telemetry + outputs, not user knobs); `enabled`/`targetFps`/`hud` are the knobs.
     *  `hud` shows a small fps/ms/GPU readout (also names SOFTWARE rendering, the usual
     *  real cause of the 5-fps launches). */
    auto: { enabled: true, targetFps: 50, hud: true, scale: 1, suppressGodrays: false, fps: 0, tier: 0 },
    /** global ACES exposure (renderer.toneMappingExposure). <1 calms an over-bright
     *  sky/sun uniformly without touching the individual effects. Nested in its own
     *  flat object so the dev-panel slider's `obj` stays a Bag (the gfx root has
     *  sub-objects, which a Bag = Record<string, number|boolean> can't hold). */
    tone: { exposure: 0.82 },
    /** UnrealBloomPass — glows the sun disc, the sun-glint path and bright foam.
     *  Mild by design ("grounded realism with punch", not a bloom-fest). clamp caps
     *  the HDR fed to bloom — and, because the ClampShader runs before BOTH bloom and
     *  the OutputPass tonemap, it is the real CEILING on the sun disc itself (the three
     *  Sky renders it white-hot otherwise). Round 3: dropped 4→2.4 so the disc tonemaps
     *  to a soft warm-white, not a blinding star — the single biggest "subtle sun" lever. */
    bloom: { enabled: true, strength: 0.03, radius: 0.5, threshold: 1.7, clamp: 2.4 },
    /** screen-space god rays (render/post.ts GodRayPass) anchored at the sun's
     *  projected position; occlusion is free (dark geometry blocks the shafts).
     *  threshold gates which pixels seed shafts (high = only the sun disc, not the
     *  whole bright sky → no white haze). samples = the per-pixel march length, the
     *  pass's dominant cost; read ONCE at Post construction, so a reload is needed
     *  to change it (lower = much faster). */
    godrays: { enabled: true, strength: 0.07, decay: 0.95, density: 0.9, weight: 0.5, threshold: 8, samples: 16 },
    /** final color grade (render/post.ts GradePass): contrast + saturation +
     *  a subtle vignette for the cinematic punch. */
    grade: { contrast: 1.03, saturation: 1.08, vignette: 0.14 },
    /** water reflection of the sky env cube (render/ocean.ts): strength scales the
     *  Fresnel-weighted reflection (high = chrome mirror; the sea should mostly read
     *  as its own teal body with a sky SHEEN, not liquid metal). clamp caps the
     *  reflected HDR so a bright sky can't blow the water to white. rebakeHz throttles
     *  re-rendering the sky+cloud cube (clouds drift slowly — a couple bakes/s is plenty). */
    reflection: { strength: 0.22, rebakeHz: 1, clamp: 1.6 },
    /** underwater visibility / depth murk (render/ocean.ts). The sea becomes a
     *  translucent body you can see `visibility` metres into before it turns fully
     *  opaque, so a submerged deck dissolves into the water and the shallow seabed
     *  shows through. `clarity` 0 = OFF (exact current look); 1 = maximally see-through.
     *  The murk/deep COLOURS are tuned constants in ocean.ts (uMurkColor/uDeepColor),
     *  not sliders. */
    water: { visibility: 2.5, clarity: 0.85 },
    /** procedural cloud dome (render/clouds.ts): coverage = how much sky is cloud,
     *  density = opacity/contrast of each puff, speed = drift rate. */
    clouds: { coverage: 0.5, density: 0.7, speed: 0.6 },
    /** triplanar procedural grit on island voxels (render/islandVisual.ts) — 0 =
     *  flat vertex color, 1 = full weathered variation. Silhouettes stay crisp. */
    islandGrit: { strength: 0.65 },
    /** hull shade floor (render/shipVisual.ts). The oak albedo is intentionally tiny
     *  (sim/materials.ts OAK ≈ 0.055 linear, ×~0.5 in the shader) so the LIT wood stays
     *  dark — but diffuse reflection = albedo × light, so a face out of the sun (lit only
     *  by the hemisphere fill) reflected almost nothing and crushed to a pure-black void
     *  no matter how high the fill was pushed. shadeFloor adds a minimum self-lit term
     *  PROPORTIONAL TO the wood's own diffuse colour (so it carries the plank grain + tint,
     *  not a flat glow): outgoing += diffuseColor × shadeFloor. It lifts the dark/shaded
     *  side far more in relative terms than the already-bright sunlit side. 0 = old void. */
    hull: { shadeFloor: 1.2 },
    /** sail canvas (render/shipVisual.ts): the sail stays fully OPAQUE (same texture);
     *  glow = strength of the warm back-light ADDED where the sun lights the cloth's FAR
     *  side — i.e. when the sail is between the sun and the camera (0 = none/matte, higher
     *  = more sun glowing through the canvas). No see-through; this only adds light.
     *  0.6 (was 0.35) + a broader lobe in the shader makes it actually read on every
     *  ship instead of being a sliver only at the exact sun-dead-behind angle. */
    sail: { glow: 0.6 },
  },

  /** Dynamic weather (render/weather.ts) — storms scale with sea roughness. Pure visuals/audio +
   *  swell amplitude (the only physics input, via applySeaScale). NOT read by the vitest oracle.
   *  One eased `storminess` [0,1] drives sky/sun darkening, cloud thickening, rain, and lightning;
   *  Sandbox pins it to the chosen pill, Career drifts it with weather fronts (swell follows). */
  weather: {
    /** -1 = auto (sandbox: from the pill; career: weather fronts). 0..1 forces storminess for testing. */
    override: -1,
    /** storminess ease rate toward target (per second). */
    ease: 0.15,
    /** multipliers so the feel can be dialed live. */
    rain: 1,
    lightning: 1,
    cloudDark: 1,
    skyDark: 1,
    windBoost: 1,
    /** career weather-front shape (period in seconds, peak storminess 0..1). */
    frontPeriod: 140,
    frontIntensity: 1,
  },
};

export type Tunables = typeof TUN;
