/**
 * The MENU overlay — start screen + pause screen — a dependency-free DOM overlay
 * in the same antique chart-room theme as {@link createPortScreen} (aged leather,
 * brass rules, parchment serif, gold). Built entirely in JS so it needs no
 * index.html changes. It is a DUMB view: it renders buttons and reports clicks
 * through {@link MenuActions}; it never touches game state. Includes a Settings
 * sub-screen (master volume + default camera) reached from the title/pause screens.
 */

const PARCH = "#d8c9a3";
const MUTE = "#a8895c";

/** Optional click cue, wired by createMenuScreen from MenuActions.onUiClick (keeps this view engine-free). */
let uiClick: () => void = () => {};

export interface MenuActions {
  onNewCareer(): void;
  onContinue(): void;
  /** Sandbox button — opens the sandbox config screen (the game layer calls
   *  {@link MenuScreen.showSandboxConfig} from here). */
  onSandbox(): void;
  onResume(): void;
  onQuitToMenu(): void;
  /** Settings — live master volume (0..1) and default camera (0/1/2). */
  onSetVolume(v01: number): void;
  onSetCamera(mode: number): void;
  /** Current persisted settings, read when the Settings screen opens. */
  getSettings(): { masterVolume: number; defaultCamera: number };
  /** Settings screen closed — a good moment to persist. */
  onSettingsClosed?(): void;
  /** Optional click cue for buttons/pills. */
  onUiClick?(): void;
}

/** What the player chose on the sandbox config screen. Plain strings so this view
 *  stays engine-free (the game layer casts them to its tier ids). */
export interface SandboxConfig {
  /** which hull to start sailing (a tier id, e.g. "cutter"). */
  shipTier: string;
  /** how many hostile ships to keep at sea (0..maxEnemies). */
  enemyCount: number;
  /** what the enemies are: "mixed" (the notoriety-scaled spread) or a specific tier id. */
  enemyTier: string;
}

/** Data the game layer feeds the sandbox config screen (keeps the view dumb). */
export interface SandboxConfigOpts {
  /** selectable hull tiers, smallest → largest (id + display name). */
  tiers: { id: string; name: string }[];
  /** upper bound on the enemy-count picker. */
  maxEnemies: number;
  /** initial selection. */
  defaults: SandboxConfig;
  /** "Set Sail" pressed with the chosen config. */
  onStart(cfg: SandboxConfig): void;
  /** "Back" pressed — return to the title screen. */
  onBack(): void;
}

export interface MenuScreen {
  readonly isOpen: boolean;
  /** Title screen. `hasCareer` enables the Continue button. */
  showStart(hasCareer: boolean): void;
  /** Sandbox setup: pick starting ship, enemy count, and enemy type before sailing. */
  showSandboxConfig(opts: SandboxConfigOpts): void;
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
  if (enabled)
    b.addEventListener("click", () => {
      uiClick();
      onClick();
    });
  return b;
}

/** A small section caption above a chooser row. */
function sectionLabel(text: string): HTMLDivElement {
  const d = document.createElement("div");
  d.textContent = text;
  Object.assign(d.style, {
    color: MUTE,
    font: '700 11px Georgia, serif',
    fontVariant: "small-caps",
    letterSpacing: "0.12em",
    textAlign: "left",
    margin: "14px 0 6px",
  } as Partial<CSSStyleDeclaration>);
  return d;
}

/** A row of mutually-exclusive "pill" choices. Calls onPick with the chosen value
 *  and re-paints the selection highlight; returns the row element. */
function chooserRow(
  choices: { value: string; label: string }[],
  selected: string,
  onPick: (value: string) => void,
): HTMLDivElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "center",
  } as Partial<CSSStyleDeclaration>);
  let cur = selected;
  const pills: { value: string; el: HTMLButtonElement }[] = [];
  const paint = () => {
    for (const p of pills) {
      const on = p.value === cur;
      p.el.style.background = on ? "linear-gradient(180deg, #6a4c18, #3a2708)" : "rgba(40,30,16,0.5)";
      p.el.style.color = on ? "#f3e2b0" : "#a8895c";
      p.el.style.borderColor = on ? "#e0b537" : "rgba(138,108,42,0.45)";
      p.el.style.boxShadow = on ? "0 0 8px rgba(224,181,55,0.35)" : "none";
    }
  };
  for (const c of choices) {
    const el = document.createElement("button");
    el.textContent = c.label;
    Object.assign(el.style, {
      flex: "1 1 auto",
      minWidth: "44px",
      padding: "8px 10px",
      borderRadius: "4px",
      border: "1px solid",
      cursor: "pointer",
      font: '700 13px Georgia, serif',
      fontVariant: "small-caps",
      letterSpacing: "0.05em",
    } as Partial<CSSStyleDeclaration>);
    el.addEventListener("click", () => {
      uiClick();
      cur = c.value;
      paint();
      onPick(c.value);
    });
    pills.push({ value: c.value, el });
    row.appendChild(el);
  }
  paint();
  return row;
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

  uiClick = () => actions.onUiClick?.();
  let backToPrev: () => void = () => setOpen(false);

  /** A labelled 0–100 master-volume slider; reports the normalised 0..1 value live. */
  const volumeSlider = (value: number, onInput: (v: number) => void): HTMLDivElement => {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, { display: "flex", alignItems: "center", gap: "10px", margin: "4px 0 8px" } as Partial<CSSStyleDeclaration>);
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.value = String(Math.round(value * 100));
    Object.assign(input.style, { flex: "1 1 auto", cursor: "pointer", accentColor: "#c9a227" } as Partial<CSSStyleDeclaration>);
    const pct = document.createElement("div");
    pct.textContent = `${input.value}%`;
    Object.assign(pct.style, { width: "42px", textAlign: "right", color: MUTE, font: '700 12px Georgia, serif' } as Partial<CSSStyleDeclaration>);
    input.addEventListener("input", () => {
      pct.textContent = `${input.value}%`;
      onInput(Number(input.value) / 100);
    });
    wrap.append(input, pct);
    return wrap;
  };

  const showSettings = () => {
    title.textContent = "Settings";
    subtitle.textContent = "trim the ship to your liking";
    const s = actions.getSettings();
    const camRow = chooserRow(
      [
        { value: "0", label: "Char 3rd" },
        { value: "1", label: "Char 1st" },
        { value: "2", label: "Ship" },
      ],
      String(s.defaultCamera),
      (v) => actions.onSetCamera(Number(v)),
    );
    body.replaceChildren(
      sectionLabel("Master volume"),
      volumeSlider(s.masterVolume, (v) => actions.onSetVolume(v)),
      sectionLabel("Default camera"),
      camRow,
      bigButton("Back", () => {
        actions.onSettingsClosed?.();
        backToPrev();
      }),
    );
    setOpen(true);
  };

  const api: MenuScreen = {
    get isOpen() {
      return open;
    },
    showStart(hasCareer: boolean) {
      backToPrev = () => api.showStart(hasCareer);
      title.textContent = "SCUTTLE";
      subtitle.textContent = "a pirate's fortune, won broadside by broadside";
      body.replaceChildren(
        bigButton("New Career", actions.onNewCareer),
        bigButton(hasCareer ? "Continue Voyage" : "Continue (no save)", actions.onContinue, hasCareer),
        bigButton("Sandbox", actions.onSandbox),
        bigButton("Settings", showSettings),
      );
      setOpen(true);
    },
    showSandboxConfig(opts: SandboxConfigOpts) {
      title.textContent = "Sandbox";
      subtitle.textContent = "set your own scene, then make sail";
      const cfg: SandboxConfig = { ...opts.defaults };

      const shipRow = chooserRow(
        opts.tiers.map((t) => ({ value: t.id, label: t.name })),
        cfg.shipTier,
        (v) => {
          cfg.shipTier = v;
        },
      );
      const counts = Array.from({ length: opts.maxEnemies + 1 }, (_, i) => ({ value: String(i), label: String(i) }));
      const countRow = chooserRow(counts, String(cfg.enemyCount), (v) => {
        cfg.enemyCount = Number(v);
      });
      const typeChoices = [
        { value: "mixed", label: "Mixed" },
        ...opts.tiers.map((t) => ({ value: t.id, label: t.name })),
      ];
      const typeRow = chooserRow(typeChoices, cfg.enemyTier, (v) => {
        cfg.enemyTier = v;
      });

      body.replaceChildren(
        sectionLabel("Your ship"),
        shipRow,
        sectionLabel("Enemy ships"),
        countRow,
        sectionLabel("Enemy type"),
        typeRow,
        bigButton("Set Sail", () => opts.onStart(cfg)),
        bigButton("Back", opts.onBack),
      );
      setOpen(true);
    },
    showPause() {
      backToPrev = () => api.showPause();
      title.textContent = "Paused";
      subtitle.textContent = "the sea holds her breath";
      body.replaceChildren(
        bigButton("Resume", actions.onResume),
        bigButton("Settings", showSettings),
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
  return api;
}
