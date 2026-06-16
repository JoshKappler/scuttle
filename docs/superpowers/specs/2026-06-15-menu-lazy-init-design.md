# Menu lazy-init — build the world only after a mode is chosen

_2026-06-15. Goal (user): the start/config menu shows on its own clean screen with **no game world loaded or rendered behind it**; the world (sky, ocean, physics, ship, islands, fleet) loads only **after** a mode is selected and is running — "what every game does."_

## Problem

`main()` (`src/main.ts`) builds the entire world eagerly (sky → ocean FFT → physics WASM → ship → islands → fleet → effects), *then* creates the menu (line ~419) and shows it. The render loop (line 1642) always draws the scene; the phase machine only gates `world.step` (physics), not rendering. Result: the menu is a semi-transparent DOM overlay (`menuScreen.ts`, backdrop `rgba … 0.55–0.86`) floating over a **frozen, fully-built game**.

## Approach — await-gate (chosen over a function extraction)

Extracting the ~1500-line build into a `startGame()` function is high-churn and risky in a no-CI file. Instead, insert an `await` near the top of `main()` so the existing build code stays exactly where it is and simply runs *later*:

1. **Hoist the shell** to the top of `main()` (right after `renderer`/`perf`/`scene`/`camera`): `gs` (GameState), `saves` (SaveManager), and the menu-facing state lets `currentTier` / `unlockedClasses` / `settings` / `forcedEnemyTier`.
2. **Create the menu up top** with *trivial* start callbacks that only **resolve a `choicePromise`** with the player's choice — `{kind:"career", fresh}` or `{kind:"sandbox", cfg}`. (They must NOT call `applySave`/`swapPlayerShip` — those don't exist yet.) The in-game callbacks (`onResume`/`onQuitToMenu`) close over the later `saveCurrent`; safe because they only fire post-build.
3. **Menu render loop while waiting:** `renderer.setAnimationLoop(() => renderer.clear())` against a dark clear color → a clean screen behind the DOM menu. `menu.showStart(...)`, then `const choice = await choicePromise`.
4. **On resolve:** `menu.hide()`, show a brief "Setting sail…" DOM overlay, yield one frame so it paints, then let the **existing build code run unchanged** (90–1640).
5. **After the full build** (just before the real `setAnimationLoop`, where everything incl. `rebuildPlayerShip` and the HUD is defined — same point the old click-callbacks effectively ran), apply the choice: the New Career / Continue / Sandbox logic lifted verbatim from the old menu callbacks, then `gs.startGame(mode)`, remove the loading overlay, and start the real loop.
6. **Render-gate** at the top of the real loop: `if (gs.phase === "menu") { clear to dark; return; }` so **Quit-to-Menu** is also a clean screen (the world stays built; we just don't draw it). Pause/port still render the frozen world (intended).

## Why it's safe

- The apply-choice runs **after the whole build**, exactly like the old click-time callbacks — so `rebuildPlayerShip` etc. see a fully-initialized scope (no TDZ).
- Only *declarations* move earlier (always safe); the heavy build code is untouched and merely deferred.
- `?spike` still early-returns before any of this; `?at=harbor` still runs inside the (now deferred) build.

## Verification

- `npm run build` (tsc) green; `npm run test` (sim oracle) green.
- Browser: (a) boot → clean dark menu, no ocean/ship; `window.DEBUG` absent until start. (b) New Career → loading → plays, captain rig = `universal`. (c) Esc → pause over frozen world → Resume. (d) Quit-to-Menu → clean screen. (e) Sandbox → config → Set Sail → plays with chosen ship/enemies. (f) Continue restores a saved career.

## Out of scope

Title art / animated menu background (could later render a cheap idle sea behind the menu instead of a flat clear). Settings UI. The world is still built once per session and kept in memory after Quit-to-Menu (not torn down) — acceptable; the goal is "not before first start," which this delivers.
