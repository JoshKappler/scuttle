# Voxel Overhaul — Design Proposal (for review)

> Drafted autonomously overnight 2026-06-13 while the headline water/buoyancy/gameplay
> fixes shipped. This is a PROPOSAL to review and direct, not an approved/implemented
> plan — the user parked voxel work ("skip the voxel stuff for now, we'll tackle it
> later"). Nothing here is built yet. Read, correct, and greenlight the phases you want.

## Why this doc
The original vision (memory: voxel-first overhaul) wants ramming that "punches a hole
and snaps off", a bow that "crumbles the side of theirs" (front stronger than side),
masts/sails that are real voxels (thrust from remaining sail voxels, felled masts fall
under their own physics, Teardown-style), and in-hull flooding that looks like FLUID,
not a blue loading bar. This maps the gap between what already exists and that vision.

## What ALREADY exists (reuse it — don't rebuild)
- `src/sim/voxelGrid.ts` — the hull voxel grid (materials: OAK/PINE/IRON/EMPTY), `totalMass`,
  `centerOfMass`, `isSolid`.
- `src/sim/buoyancy.ts` — per-column Archimedes probes built from the grid; `Ship.applyForces`
  sums them. Damage already recomputes probes + rapier mass props (`recomputeMassProperties`).
- `Ship.applyDamage([x,y,z], radiusVox)` — removes a sphere of cells, recomputes mass + buoyancy,
  returns the count removed. THIS IS THE VOXEL-DESTRUCTION PRIMITIVE; it works today.
- `src/game/ramming.ts` — already detects ship-ship contact WITH closing speed and carves a
  sphere out of BOTH hulls at the waterline (`bite` marches inboard until it hits timber).
- `src/sim/compartments.ts` — flood model per watertight compartment (the "blue bar" today).
- `src/render/effects.ts` — `splinters`, `splash`, pooled particles for debris/spray.

## The gaps (what the user actually wants), phased low-risk → high-risk

### Phase V1 — Ramming that READS as carnage (smallest, highest value)
Ramming already damages both hulls, but the user saw "nothing." Likely causes + fixes:
1. **Bow-stronger-than-side asymmetry (the headline ask).** `ramming.ts:bite` currently carves
   both ships with the SAME radius. Change: scale each ship's bite by whether the CONTACT hit
   its bow (forward ~25% of the hull, along its fore-aft axis) vs its flank. A bow-on rammer
   should take a small bite; the victim's struck flank should take a large one. Concretely:
   `radiusVictim = base * sideFactor(victim)`, `radiusRammer = base * bowFactor(rammer)`, where
   bowFactor≈0.35 if the contact is in the rammer's forward wedge, sideFactor≈1.4 on a flank.
2. **It rarely connects / reads as subtle.** Verify in-browser that a deliberate ram actually
   triggers (`MIN_CLOSING` 4 m/s; the AI keeps distance). Consider a bigger splinter burst +
   a wood-crunch and a brief camera shake so a hit is unmistakable.
3. **Visible hole feedback.** Confirm `shipVisual` rebuilds the hull mesh after `applyDamage`
   so the removed voxels show as an actual hole (if it doesn't, that's why "nothing happened").
Risk: LOW — all in `ramming.ts` + a visual check. Fully verifiable (ram the enemy, count cells,
screenshot the hole). This alone likely satisfies the ramming complaint.

### Phase V2 — Structural break-off / debris physics (Teardown-style)
When damage disconnects a chunk (connectivity check already hinted in ramming comments), spawn
the severed voxels as a separate rapier body that floats/sinks on its own (reuse `debris.ts`).
A felled mast should fall and drift, not vanish or flop mechanically. Risk: MEDIUM — needs a
connected-components pass on the grid + dynamic body spawning. Self-contained, verifiable.

### Phase V3 — Voxel masts & sails (thrust from remaining canvas)
Today sail thrust is a percentage penalty. Vision: thrust ∝ surviving sail voxels per mast;
a shot-away mast removes its voxels and its thrust. Partly wired (`mastAlive`, `sailIntegrity`).
Make canvas a voxel/area count so damage is emergent, not a flat penalty. Risk: MEDIUM.

### Phase V4 — In-hull fluid (replace the blue bar)
Compartment flood volume already exists; render it as an actual water surface clipped inside
the hull (a small box of water per compartment whose level = waterVolume/area), sloshing with
roll/pitch, instead of a HUD bar. Risk: MEDIUM-HIGH (rendering inside the cutaway hull). The
ocean shader's in-hull discard + the cutaway system are the hooks.

## Open questions for the user (answer before building)
1. Ramming: should the PLAYER's bow be flat-out stronger (arcade "you win the ram"), or purely
   physics-symmetric with bow geometry doing the work? (Affects bowFactor/sideFactor tuning.)
2. Debris: do severed chunks persist (perf cost) or fade after a few seconds?
3. Scope tonight-vs-later: V1 is safe to do unattended next. V2–V4 want your eyes on them.

## Recommendation
Do **V1 first** (ram asymmetry + visible-hole verification + punchier feedback) — it's small,
low-risk, fully verifiable, and directly answers "ramming doesn't do anything." Then review
V2–V4 together before committing to the bigger refactors.
