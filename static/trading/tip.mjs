/**
 * The terminal's hover label: a control's name, its keyboard shortcut and one
 * line on what it does.
 *
 * Vanilla port of OpenAlgoNew `Tip.tsx` (behaviour + wording) and
 * `tipPlacement.ts` (math, verbatim).
 *
 * Why not `title`: the browser's box waits about a second, cannot be styled,
 * cannot hold a shortcut beside the name, and on a row of bare glyphs the
 * second it costs is the whole problem. A `title` already on the control is
 * dropped by removing it at attach, so a control named only by its title needs
 * an `aria-label` (or a checked-label child). The label is portalled to the
 * full-screen element when one is open so it still shows there.
 *
 * It shows after a short rest, at once when moving along a row of controls
 * (warm within 500ms), on keyboard focus, and never on a touch. Pressing the
 * control hides it: once somebody has decided, a label left over the menu they
 * opened reads as part of the menu.
 */

/* ── tipPlacement.ts (verbatim math) ─────────────────────────────────────── */

/**
 * Where a hover label goes: beside its control on the side asked for, flipped
 * to the opposite side when that one has no room, and slid along the edge so
 * it never leaves the window.
 */

/** Space kept between the label and its control, and between the label and the window edge. */
const GAP = 6;
const EDGE = 4;

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

function fits(side, anchor, width, height, view) {
  if (side === "bottom") return anchor.top + anchor.height + GAP + height <= view.height - EDGE;
  if (side === "top") return anchor.top - GAP - height >= EDGE;
  if (side === "right") return anchor.left + anchor.width + GAP + width <= view.width - EDGE;
  return anchor.left - GAP - width >= EDGE;
}

const OPPOSITE = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/** The label's top-left corner in window pixels, and the side it ended up on. */
export function placeTip(anchor, size, view, side = "bottom") {
  const chosen =
    fits(side, anchor, size.width, size.height, view) ||
    !fits(OPPOSITE[side], anchor, size.width, size.height, view)
      ? side
      : OPPOSITE[side];
  if (chosen === "top" || chosen === "bottom") {
    const left = clamp(
      anchor.left + anchor.width / 2 - size.width / 2,
      EDGE,
      view.width - size.width - EDGE
    );
    const top =
      chosen === "bottom" ? anchor.top + anchor.height + GAP : anchor.top - GAP - size.height;
    return { left, top, side: chosen };
  }
  const top = clamp(
    anchor.top + anchor.height / 2 - size.height / 2,
    EDGE,
    view.height - size.height - EDGE
  );
  const left =
    chosen === "right" ? anchor.left + anchor.width + GAP : anchor.left - GAP - size.width;
  return { left, top, side: chosen };
}

/* ── Tip.tsx behaviour ─────────────────────────────────────────────────────── */

/** How long the pointer rests on a control before its label shows. */
const DWELL_MS = 350;
/** Moving on from one label to the next within this shows the next at once. */
const WARM_MS = 500;
let lastShown = 0;

let labelEl = null;
let labelFor = null; // the control the label is on
let labelSide = "bottom";
let labelChord = "";
let timer = null;
let pressed = false;
let listenersClean = null;

function ensureLabel() {
  if (labelEl) return labelEl;
  const node = document.createElement("div");
  node.id = "tt-tip";
  node.setAttribute("role", "tooltip");
  node.className = "tt-tip";
  node.style.visibility = "hidden";
  node.style.left = "0px";
  node.style.top = "0px";
  (document.fullscreenElement || document.body).appendChild(node);
  labelEl = node;
  return node;
}

function putTip(control) {
  const node = ensureLabel();
  const spec = specOf(control);
  if (!spec) return hideTip();
  node.innerHTML =
    `<span class="tt-tip-name">${escapeHtml(spec.title)}</span>` +
    (spec.chord ? `<span class="tt-tip-chord">${escapeHtml(spec.chord)}</span>` : "") +
    (spec.sub ? `<span class="tt-tip-sub">${escapeHtml(spec.sub)}</span>` : "");
  const box = control.getBoundingClientRect();
  const place = placeTip(
    { left: box.left, top: box.top, width: box.width, height: box.height },
    { width: node.offsetWidth, height: node.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
    labelSide
  );
  node.style.left = `${Math.round(place.left)}px`;
  node.style.top = `${Math.round(place.top)}px`;
  node.style.visibility = "visible";
  // Escape puts a label away; a scroll moves the control out from under it.
  const onKey = (event) => {
    if (event.key === "Escape") hideTip();
  };
  const onScroll = () => hideTip();
  window.addEventListener("keydown", onKey);
  window.addEventListener("scroll", onScroll, true);
  listenersClean = () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("scroll", onScroll, true);
  };
}

function specOf(control) {
  return control.__tipSpec || null;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

export function hideTip() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (listenersClean) {
    listenersClean();
    listenersClean = null;
  }
  if (labelEl) {
    labelEl.style.visibility = "hidden";
    labelEl.style.left = "0px";
    labelEl.style.top = "0px";
  }
  if (labelFor) {
    labelFor.removeAttribute("aria-describedby");
    labelFor = null;
  }
}

function showTip(control) {
  if (!specOf(control)) return; // tip === null ⇒ never shows
  if (timer) clearTimeout(timer);
  timer = null;
  hideTip();
  labelFor = control;
  control.setAttribute("aria-describedby", "tt-tip");
  lastShown = Date.now();
  putTip(control);
}

/**
 * Attach the terminal hover label to one control. `spec` is
 * `{ title, chord?, sub? }` (a `chord` shows in mono after the name, a `sub`
 * is one muted line on what it does); pass `null` to withhold it. The label
 * sits on `side` of the control ('bottom' by default, like the toolbar).
 */
export function attachTip(control, spec, side = "bottom") {
  ensureLabel();
  labelSide = side;
  control.__tipSpec = spec;
  // The browser's own box would draw over this one a second later.
  control.removeAttribute("title");
  control.addEventListener("pointerenter", (event) => {
    pressed = false;
    if (event.pointerType === "touch") return;
    if (!specOf(control)) return;
    if (timer) clearTimeout(timer);
    // Moving on from one label to the next within WARM shows at once.
    const warm = Date.now() - lastShown < WARM_MS;
    if (warm) showTip(control);
    else
      timer = setTimeout(() => {
        timer = null;
        showTip(control);
      }, DWELL_MS);
  });
  control.addEventListener("pointerleave", () => {
    pressed = false;
    hideTip();
  });
  control.addEventListener("pointerdown", () => {
    pressed = true;
    hideTip();
  });
  control.addEventListener("focus", (event) => {
    let visible = true;
    try {
      visible = event.target.matches(":focus-visible");
    } catch {
      visible = true;
    }
    if (!pressed && visible) showTip(control);
  });
  control.addEventListener("blur", () => hideTip());
  return () => {
    control.__tipSpec = null;
    if (labelFor === control) hideTip();
  };
}
