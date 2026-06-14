/**
 * The PORT screen — a dependency-free DOM overlay in the antique chart-room
 * theme (matches the .panel look in index.html: aged leather, brass rules,
 * parchment serif, gold #d8b24a). Built entirely in JS like the dev panel, so
 * it needs no index.html changes (fewer merge collisions with sibling branches).
 *
 * It is a DUMB view: the {@link PortController} hands it a plain {@link PortView}
 * and a set of {@link PortActions} callbacks. The screen never imports `Economy`
 * or touches game state — it only renders numbers and reports clicks. Opening it
 * frees pointer-lock (so the buttons are clickable mid-voyage); closing re-grabs
 * on the next canvas click, as usual.
 */

import type { UpgradeId } from "../sim/economy";

export interface CargoRow {
  name: string;
  qty: number;
  value: number; // total sale value of this row at the current market
}
export interface UpgradeRow {
  id: UpgradeId;
  name: string;
  desc: string;
  level: number;
  maxLevel: number;
  cost: number | null; // null = maxed
  affordable: boolean;
}
export interface PortView {
  portName: string;
  doubloons: number;
  notoriety: number;
  cargo: CargoRow[];
  cargoUsed: number;
  cargoCap: number;
  repairCost: number; // 0 when the hull is whole
  upgrades: UpgradeRow[];
}
export interface PortActions {
  onSell(): void;
  onRepair(): void;
  onBuy(id: UpgradeId): void;
  onClose(): void;
}
export interface PortScreen {
  readonly isOpen: boolean;
  open(view: PortView): void;
  refresh(view: PortView): void;
  close(): void;
  dispose(): void;
}

const GOLD = "#d8b24a";
const PARCH = "#d8c9a3";
const MUTE = "#a8895c";

function panelStyle(): Partial<CSSStyleDeclaration> {
  return {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(540px, 92vw)",
    maxHeight: "88vh",
    overflowY: "auto",
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
    padding: "20px 22px 18px",
    zIndex: "10001",
    userSelect: "none",
    boxShadow: "0 8px 34px rgba(0,0,0,0.7), inset 0 0 30px rgba(0,0,0,0.5)",
  };
}

function heading(text: string): HTMLDivElement {
  const h = document.createElement("div");
  h.textContent = text;
  Object.assign(h.style, {
    color: GOLD,
    fontVariant: "small-caps",
    letterSpacing: "0.1em",
    fontWeight: "700",
    fontSize: "12px",
    margin: "14px 0 6px",
    borderBottom: "1px solid rgba(201,162,39,0.25)",
    paddingBottom: "3px",
  } as Partial<CSSStyleDeclaration>);
  return h;
}

function button(label: string, onClick: () => void, enabled = true): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  Object.assign(b.style, {
    background: enabled ? "linear-gradient(180deg, #4a3414, #281a08)" : "rgba(40,30,16,0.5)",
    color: enabled ? "#e8d49e" : "rgba(168,137,92,0.5)",
    border: `1px solid ${enabled ? "#c9a227" : "rgba(138,108,42,0.4)"}`,
    borderRadius: "4px",
    padding: "5px 12px",
    cursor: enabled ? "pointer" : "default",
    font: '700 11px Georgia, serif',
    fontVariant: "small-caps",
    letterSpacing: "0.06em",
    whiteSpace: "nowrap",
  } as Partial<CSSStyleDeclaration>);
  b.disabled = !enabled;
  if (enabled) b.addEventListener("click", onClick);
  return b;
}

function row(): HTMLDivElement {
  const r = document.createElement("div");
  Object.assign(r.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
    margin: "4px 0",
  } as Partial<CSSStyleDeclaration>);
  return r;
}

export function createPortScreen(actions: PortActions): PortScreen {
  const backdrop = document.createElement("div");
  Object.assign(backdrop.style, {
    position: "fixed",
    inset: "0",
    background: "radial-gradient(ellipse at center, rgba(10,7,3,0.35), rgba(8,5,2,0.72))",
    zIndex: "10000",
    display: "none",
  } as Partial<CSSStyleDeclaration>);

  const root = document.createElement("div");
  Object.assign(root.style, panelStyle());
  root.style.display = "none";

  const title = document.createElement("div");
  Object.assign(title.style, {
    color: "#efe3c2",
    font: '700 22px Georgia, serif',
    fontVariant: "small-caps",
    letterSpacing: "0.08em",
    textAlign: "center",
    textShadow: "0 2px 8px #000",
  } as Partial<CSSStyleDeclaration>);

  const purse = document.createElement("div");
  Object.assign(purse.style, {
    textAlign: "center",
    color: GOLD,
    font: '700 16px Georgia, serif',
    margin: "2px 0 4px",
  } as Partial<CSSStyleDeclaration>);

  const body = document.createElement("div"); // the part we rebuild on refresh

  root.append(title, purse, body);
  document.body.append(backdrop, root);

  let open = false;

  const render = (v: PortView) => {
    title.textContent = `⚓ ${v.portName}`;
    purse.textContent = `⛀ ${v.doubloons} doubloons   ·   ${v.notoriety} infamy`;
    body.replaceChildren();

    // ---- Hold / manifest ----
    body.appendChild(heading(`Hold — ${v.cargoUsed}/${v.cargoCap}`));
    if (v.cargo.length === 0) {
      const empty = document.createElement("div");
      empty.textContent = "the hold is empty";
      empty.style.color = MUTE;
      empty.style.fontStyle = "italic";
      body.appendChild(empty);
    } else {
      let total = 0;
      for (const c of v.cargo) {
        total += c.value;
        const r = row();
        const left = document.createElement("span");
        left.textContent = `${c.name} ×${c.qty}`;
        const right = document.createElement("span");
        right.textContent = `⛀ ${c.value}`;
        right.style.color = GOLD;
        r.append(left, right);
        body.appendChild(r);
      }
      const sellRow = row();
      const lbl = document.createElement("span");
      lbl.textContent = `Sell all — ⛀ ${total}`;
      sellRow.append(lbl, button("Sell", actions.onSell, total > 0));
      body.appendChild(sellRow);
    }

    // ---- Repair ----
    body.appendChild(heading("Repair"));
    const repRow = row();
    const repLbl = document.createElement("span");
    if (v.repairCost <= 0) {
      repLbl.textContent = "hull is sound";
      repLbl.style.color = MUTE;
      repLbl.style.fontStyle = "italic";
      repRow.append(repLbl, button("Repair", actions.onRepair, false));
    } else {
      repLbl.textContent = `Patch her up — ⛀ ${v.repairCost}`;
      repRow.append(repLbl, button("Repair", actions.onRepair, v.doubloons >= v.repairCost));
    }
    body.appendChild(repRow);

    // ---- Upgrades ----
    body.appendChild(heading("Shipwright"));
    for (const u of v.upgrades) {
      const r = row();
      const left = document.createElement("div");
      const name = document.createElement("div");
      name.textContent = `${u.name}  (lv ${u.level}/${u.maxLevel})`;
      name.style.color = PARCH;
      const desc = document.createElement("div");
      desc.textContent = u.desc;
      desc.style.color = MUTE;
      desc.style.fontSize = "11px";
      desc.style.fontStyle = "italic";
      left.append(name, desc);
      const maxed = u.cost === null;
      const label = maxed ? "Max" : `Buy — ⛀ ${u.cost}`;
      r.append(left, button(label, () => actions.onBuy(u.id), !maxed && u.affordable));
      body.appendChild(r);
    }

    // ---- Footer ----
    const foot = document.createElement("div");
    Object.assign(foot.style, { textAlign: "center", marginTop: "16px" } as Partial<CSSStyleDeclaration>);
    foot.appendChild(button("Save & Cast Off", actions.onClose, true));
    body.appendChild(foot);
  };

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
    open(view: PortView) {
      render(view);
      setOpen(true);
    },
    refresh(view: PortView) {
      if (open) render(view);
    },
    close() {
      setOpen(false);
    },
    dispose() {
      root.remove();
      backdrop.remove();
    },
  };
}
