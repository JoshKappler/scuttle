/**
 * The MENU overlay — start screen + pause screen — a dependency-free DOM overlay
 * in the same antique chart-room theme as {@link createPortScreen} (aged leather,
 * brass rules, parchment serif, gold). Built entirely in JS so it needs no
 * index.html changes. It is a DUMB view: it renders buttons and reports clicks
 * through {@link MenuActions}; it never touches game state. Settings are deferred
 * to a later pass (Phase 4).
 */

const PARCH = "#d8c9a3";
const MUTE = "#a8895c";

export interface MenuActions {
  onNewCareer(): void;
  onContinue(): void;
  onSandbox(): void;
  onResume(): void;
  onQuitToMenu(): void;
}

export interface MenuScreen {
  readonly isOpen: boolean;
  /** Title screen. `hasCareer` enables the Continue button. */
  showStart(hasCareer: boolean): void;
  /** In-game pause screen (Resume / Quit to Menu). */
  showPause(): void;
  hide(): void;
  dispose(): void;
}

function bigButton(label: string, onClick: () => void, enabled = true): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  Object.assign(b.style, {
    display: "block",
    width: "100%",
    background: enabled ? "linear-gradient(180deg, #4a3414, #281a08)" : "rgba(40,30,16,0.5)",
    color: enabled ? "#e8d49e" : "rgba(168,137,92,0.5)",
    border: `1px solid ${enabled ? "#c9a227" : "rgba(138,108,42,0.4)"}`,
    borderRadius: "4px",
    padding: "11px 14px",
    margin: "8px 0",
    cursor: enabled ? "pointer" : "default",
    font: '700 15px Georgia, serif',
    fontVariant: "small-caps",
    letterSpacing: "0.08em",
  } as Partial<CSSStyleDeclaration>);
  b.disabled = !enabled;
  if (enabled) b.addEventListener("click", onClick);
  return b;
}

export function createMenuScreen(actions: MenuActions): MenuScreen {
  const backdrop = document.createElement("div");
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    background: "radial-gradient(ellipse at center, rgba(10,7,3,0.55), rgba(6,4,2,0.86))",
    zIndex: "10010", // above the port screen (10000/10001)
    display: "none",
  } as Partial<CSSStyleDeclaration>);

  const root = document.createElement("div");
  Object.assign(root.style, {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(420px, 90vw)",
    background:
      "repeating-linear-gradient(100deg, rgba(255,235,200,0.016) 0 2px, transparent 2px 5px)," +
      "radial-gradient(ellipse at 30% 0%, rgba(96,66,28,0.30), transparent 60%)," +
      "linear-gradient(170deg, rgba(38,26,14,0.96), rgba(16,10,5,0.98))",
    border: "2px solid #8a6c2a",
    outline: "1px solid rgba(201,162,39,0.35)",
    outlineOffset: "3px",
    borderRadius: "6px",
    color: PARCH,
    font: '13px/1.55 Georgia, "Times New Roman", serif',
    padding: "26px 28px 22px",
    zIndex: "10011",
    userSelect: "none",
    textAlign: "center",
    boxShadow: "0 8px 34px rgba(0,0,0,0.7), inset 0 0 30px rgba(0,0,0,0.5)",
    display: "none",
  } as Partial<CSSStyleDeclaration>);

  const title = document.createElement("div");
  Object.assign(title.style, {
    color: "#efe3c2",
    font: '700 40px Georgia, serif',
    fontVariant: "small-caps",
    letterSpacing: "0.14em",
    textShadow: "0 3px 12px #000",
    margin: "0 0 2px",
  } as Partial<CSSStyleDeclaration>);

  const subtitle = document.createElement("div");
  Object.assign(subtitle.style, {
    color: MUTE,
    fontStyle: "italic",
    fontSize: "13px",
    margin: "0 0 18px",
  } as Partial<CSSStyleDeclaration>);

  const body = document.createElement("div"); // rebuilt per screen

  root.append(title, subtitle, body);
  document.body.append(backdrop, root);

  let open = false;
  const setOpen = (v: boolean) => {
    open = v;
    backdrop.style.display = v ? "block" : "none";
    root.style.display = v ? "block" : "none";
    if (v && document.pointerLockElement) document.exitPointerLock();
  };

  return {
    get isOpen() {
      return open;
    },
    showStart(hasCareer: boolean) {
      title.textContent = "SCUTTLE";
      subtitle.textContent = "a pirate's fortune, won broadside by broadside";
      body.replaceChildren(
        bigButton("New Career", actions.onNewCareer),
        bigButton(hasCareer ? "Continue Voyage" : "Continue (no save)", actions.onContinue, hasCareer),
        bigButton("Sandbox", actions.onSandbox),
      );
      setOpen(true);
    },
    showPause() {
      title.textContent = "Paused";
      subtitle.textContent = "the sea holds her breath";
      body.replaceChildren(
        bigButton("Resume", actions.onResume),
        bigButton("Quit to Menu", actions.onQuitToMenu),
      );
      setOpen(true);
    },
    hide() {
      setOpen(false);
    },
    dispose() {
      root.remove();
      backdrop.remove();
    },
  };
}
