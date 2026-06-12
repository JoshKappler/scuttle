# Character-on-deck spike findings (plan Task 13)

Run with `?spike=char`. IJKL walk (camera-relative), U jump.

## What works (validated numerically via ship-local position tracking)

- **Trimesh-on-body collider**: the ship's greedy mesh doubles as a rapier
  trimesh collider attached to the ship rigid body — the capsule stands on
  the REAL deck (and can in principle drop through hatches into the hold).
- **Deck-carry coupling**: adding the ship's surface velocity at the
  character position (linvel + angvel × r) to the kinematic controller's
  desired movement keeps the capsule planted through hard turns under sail
  (drift < 10 cm during a 10 s sail+turn) and wave bobbing.
- **Edges are real**: walking off the bow drops you in the sea. That's a
  feature (kick-overboard is core combat design).
- Fall-speed clamp (−18 m/s) prevents trimesh tunneling.

## M4 follow-ups discovered

1. Slow lateral drift (~1 m / 14 s) while standing — likely because carry
   velocity is evaluated at the body origin offset rather than the contact
   point, or rounding in computedMovement. Consider working in ship-local
   space outright, or zeroing residual tangential velocity when grounded
   and input is idle.
2. No swimming: overboard = sink. Swim state per spec (armor-weighted).
3. Spawn timing: must spawn after splash-down settle (handled with simTime
   gate); ship-relative spawn should be used for boarding placement too.
4. Trimesh collider must REBUILD on damage remesh (currently built once).
   Cheap approach: rebuild only dirty chunks as separate per-chunk colliders.
5. First-person toggle still to come; orbit camera works fine for the spike.
