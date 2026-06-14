/**
 * A tiny, dependency-free in-game DEV PANEL for live-tuning the sea + boat feel.
 * The player asked for exactly this — "just give me a dev panel where I can adjust
 * these variables myself until things look good" — so the subjective values
 * (buoyancy gains, wave/wake/spray strengths) can be dialed without a code edit +
 * reload per tweak. Backtick (`) toggles it; it writes straight into the live
 * {@link TUN} object that physics + render read every step, so changes take hold
 * immediately.
 *
 * No framework, no styling deps: a fixed overlay of <input type=range> sliders and
 * checkboxes bound to (object, key) pairs. Opening it frees the mouse (drops
 * pointer-lock) so the controls are clickable mid-voyage; closing it lets you
 * re-grab the helm with a click. A live READOUT line shows the numbers that matter
 * for tuning buoyancy (heel/pitch in degrees, submerged %, speed) so the effect of
 * a slider is visible without guesswork.
 */

// obj is a mixed bag (TUN.dyn has both numbers and a boolean), so bindings are
// typed loosely and the accessors cast — this is a dev tool, not a public API.
type Bag = Record<string, number | boolean>;
interface SliderSpec {
  type: "slider";
  label: string;
  obj: Bag;
  key: string;
  min: number;
  max: number;
  step: number;
}
interface ToggleSpec {
  type: "toggle";
  label: string;
  obj: Bag;
  key: string;
}
interface ButtonSpec {
  type: "button";
  label: string;
  onClick: () => void;
}
export type Control = SliderSpec | ToggleSpec | ButtonSpec;
export interface PanelGroup {
  title: string;
  controls: Control[];
}

export interface DevPanel {
  /** true when visible. */
  readonly open: boolean;
  toggle(): void;
  /** Update the live diagnostic readout line (called each frame). */
  setReadout(text: string): void;
  dispose(): void;
}

export function createDevPanel(groups: PanelGroup[]): DevPanel {
  const root = document.createElement("div");
  root.id = "dev-panel";
  Object.assign(root.style, {
    position: "fixed",
    top: "8px",
    right: "8px",
    width: "270px",
    maxHeight: "calc(100vh - 16px)",
    overflowY: "auto",
    background: "rgba(12,16,22,0.86)",
    color: "#cfe3f0",
    font: "11px/1.45 ui-monospace,Menlo,Consolas,monospace",
    padding: "8px 10px 10px",
    borderRadius: "6px",
    border: "1px solid rgba(120,160,190,0.35)",
    zIndex: "10000",
    display: "none",
    userSelect: "none",
    boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
  } as Partial<CSSStyleDeclaration>);

  const title = document.createElement("div");
  title.textContent = "⚓ DEV PANEL — ` to close";
  Object.assign(title.style, {
    fontWeight: "700",
    color: "#9fd0ff",
    marginBottom: "6px",
    letterSpacing: "0.04em",
  } as Partial<CSSStyleDeclaration>);
  root.appendChild(title);

  const readout = document.createElement("div");
  Object.assign(readout.style, {
    whiteSpace: "pre-wrap",
    color: "#8fe6b0",
    margin: "0 0 8px",
    padding: "4px 6px",
    background: "rgba(0,0,0,0.3)",
    borderRadius: "4px",
    minHeight: "14px",
  } as Partial<CSSStyleDeclaration>);
  root.appendChild(readout);

  for (const g of groups) {
    const h = document.createElement("div");
    h.textContent = g.title;
    Object.assign(h.style, {
      fontWeight: "700",
      color: "#ffd591",
      margin: "8px 0 3px",
      borderBottom: "1px solid rgba(120,160,190,0.2)",
    } as Partial<CSSStyleDeclaration>);
    root.appendChild(h);

    for (const c of g.controls) {
      if (c.type === "slider") root.appendChild(makeSlider(c));
      else if (c.type === "toggle") root.appendChild(makeToggle(c));
      else root.appendChild(makeButton(c));
    }
  }

  document.body.appendChild(root);

  let open = false;
  const setOpen = (v: boolean) => {
    open = v;
    root.style.display = v ? "block" : "none";
    // free the mouse so the sliders are usable mid-voyage; on close, the player
    // clicks to re-grab pointer lock / the helm as usual.
    if (v && document.pointerLockElement) document.exitPointerLock();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.code === "Backquote") {
      e.preventDefault();
      setOpen(!open);
    }
  };
  window.addEventListener("keydown", onKey);

  return {
    get open() {
      return open;
    },
    toggle() {
      setOpen(!open);
    },
    setReadout(text: string) {
      if (open) readout.textContent = text;
    },
    dispose() {
      window.removeEventListener("keydown", onKey);
      root.remove();
    },
  };
}

function row(): HTMLDivElement {
  const r = document.createElement("div");
  Object.assign(r.style, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    margin: "2px 0",
  } as Partial<CSSStyleDeclaration>);
  return r;
}

function makeSlider(c: SliderSpec): HTMLDivElement {
  const r = row();
  const label = document.createElement("span");
  label.textContent = c.label;
  Object.assign(label.style, { flex: "0 0 96px", color: "#cfe3f0" } as Partial<CSSStyleDeclaration>);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(c.min);
  input.max = String(c.max);
  input.step = String(c.step);
  input.value = String(c.obj[c.key]);
  Object.assign(input.style, { flex: "1 1 auto", minWidth: "0", accentColor: "#5fa8d8" } as Partial<CSSStyleDeclaration>);

  const val = document.createElement("span");
  val.textContent = fmt(c.obj[c.key] as number);
  Object.assign(val.style, {
    flex: "0 0 46px", // wide enough for 4-dp coefficients like "0.0025"
    textAlign: "right",
    color: "#9fd0ff",
  } as Partial<CSSStyleDeclaration>);

  input.addEventListener("input", () => {
    const n = parseFloat(input.value);
    c.obj[c.key] = n;
    val.textContent = fmt(n);
  });

  r.append(label, input, val);
  return r;
}

function makeToggle(c: ToggleSpec): HTMLDivElement {
  const r = row();
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = c.obj[c.key] as boolean;
  Object.assign(input.style, { accentColor: "#5fa8d8" } as Partial<CSSStyleDeclaration>);
  const label = document.createElement("label");
  label.textContent = c.label;
  label.style.color = "#cfe3f0";
  label.style.cursor = "pointer";
  input.addEventListener("change", () => {
    c.obj[c.key] = input.checked;
  });
  label.addEventListener("click", () => {
    input.checked = !input.checked;
    c.obj[c.key] = input.checked;
  });
  r.append(input, label);
  return r;
}

function makeButton(c: ButtonSpec): HTMLDivElement {
  const r = row();
  const btn = document.createElement("button");
  btn.textContent = c.label;
  Object.assign(btn.style, {
    flex: "1 1 auto",
    background: "rgba(95,168,216,0.2)",
    color: "#cfe3f0",
    border: "1px solid rgba(120,160,190,0.4)",
    borderRadius: "4px",
    padding: "3px 6px",
    cursor: "pointer",
    font: "inherit",
  } as Partial<CSSStyleDeclaration>);
  btn.addEventListener("click", c.onClick);
  r.appendChild(btn);
  return r;
}

function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // small coefficients (e.g. cannon air drag ≈ 0.0025) need more decimals than the
  // 2 dp used for ~unit-scale knobs, or they'd read as a meaningless "0.00".
  const a = Math.abs(n);
  return n.toFixed(a < 0.01 ? 4 : a < 1 ? 2 : 1);
}
