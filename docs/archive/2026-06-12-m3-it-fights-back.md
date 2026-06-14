# SCUTTLE M3 ("It Fights Back") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A winnable, losable cannon duel: an AI captain that intercepts, circles to broadside, and fires back; player aiming, repairs (planks + pumps), spyglass, and win/lose states.

**Architecture:** AI decisions live in a PURE function `decideAI(view) → {sailSet, rudder, fireSide|null}` (unit-tested state transitions); a thin `AICaptain` adapter feeds it ship state and drives a `SailingController` + its own `Cannons`. Repairs mutate the existing breach/compartment state. Executed inline (same rationale as M1+M2 plan).

**Tech Stack:** unchanged (TS, three, rapier-compat, vitest).

### Task 1: Generalize cannons for multiple owners

- [ ] `Cannons` already takes one owner per broadside — verify per-shot owner is captured (move `owner` onto pendingShots entries), targets passed per-update. Player cannons target the enemy; enemy cannons target the player. No friendly fire against self.
- [ ] Manual check: two Cannons instances coexist. Commit.

### Task 2: Player aiming + spyglass

- [ ] Hold **right mouse**: aim mode — mouse pitch sets broadside elevation 0–14° (HUD shows it), F fires on the camera-facing side (replaces auto-bearing).
- [ ] Hold **Q**: spyglass — FOV lerps 60→16 with slight smoothing; HUD shows "spyglass".
- [ ] Manual check + commit.

### Task 3: AI captain — TDD on the pure brain

**Files:** `src/sim/aiBrain.ts`, `tests/aiBrain.test.ts`, `src/game/ai.ts`

```ts
export interface AIView {
  range: number;            // m to target
  bearingDeg: number;       // target bearing relative to own bow, -180..180 (+ = starboard)
  angleOffWindDeg: number;  // own bow vs wind-from
  floodFrac: number;        // own worst-compartment fill 0..1
  reloadReady: boolean;
}
export interface AIDecision { sailSet: number; rudderSign: -1 | 0 | 1; fire: "port" | "starboard" | null }
export function decideAI(v: AIView): AIDecision;
```

- [ ] Tests: far away (range > 90) → full sail, steer to close bearing toward 0; in range (≤90) → steer to put target abeam (|bearing| → 90); fires only when reloadReady && range ≤ 90 && bearing within 90±20 (side = sign); badly flooded (≥0.5) → flee: full sail, steer away (bearing → 180), never fire.
- [ ] Implement minimal `decideAI`, tests pass, commit.
- [ ] `AICaptain` adapter: builds AIView from rapier state each fixed step, applies decision via its own SailingController + Cannons (elevation auto: clamp(range/90·6, 0, 8)°, mild ±1.5° random jitter for fairness). Replace the anchored hulk with an AI ship spawned 250 m upwind. Manual duel check + commit.

### Task 4: Repairs — planks and pumps

- [ ] Ship API: `plugBreach()` — removes the most-submerged breach cell from its compartment registry (consumes 1 of 8 planks, 4 s channel time during which you can't fire); `togglePump()` — drains the most-flooded compartment at 0.12 m³/s while on. Both surfaced on HUD (planks left, pump target, flood % per compartment).
- [ ] Sim-level test: pump drain clamps at 0; plugging reduces effective breach area used next `updateFlooding`.
- [ ] Keys: R plug, P pump. Manual: hole own ship via enemy fire, plug + pump, survive. Commit.

### Task 5: Win/lose + restart

- [ ] Enemy sunk (all compartments ≥ 0.95 full OR body y < −12) → overlay "PRIZE TAKEN — the sea claims her" + gold counter stub. Player same condition → "SHE'S GONE — your gold sinks with her". Enter restarts (location.reload with same seed param). DOM overlay, no menu system yet.
- [ ] Full duel playthrough both outcomes (AI handicapped via accuracy jitter). Commit, tag `m3-it-fights-back`, merge per finishing skill.

**Out of scope (M4+):** boarding, melee, chests, swimming, sharks, ports, run structure.
