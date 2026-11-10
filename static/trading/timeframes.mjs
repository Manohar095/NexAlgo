/**
 * The timeframe controls: a strip of favorite intervals, an interval button,
 * and the grouped dropdown with a star against every row.
 *
 * Vanilla port of OpenAlgoNew `components/trading/TimeframeMenu.tsx` —
 * favorites strip (max-w, hidden scrollbar), the interval button, and the
 * popover sections per unit group, each row with a star toggle. Grouping,
 * identity (unit:multiplier) and row labels come straight from their module
 * scope; preferences ride the vendored widget's `createTimeframePreferences`
 * with our own storage key, so the favorites survive reloads.
 *
 * The "Add custom interval" row of their menu is deliberately OMITTED: our
 * broker datafeed serves only the fixed `/api/intervals` list, so a custom
 * code could be stored but never built (`canSelectInterval` refuses it) and
 * the row would read as a promise the chart breaks. Favorites, folding and
 * the stared browsing of the full list are all kept.
 */

import { intervalParts } from "/static/vendor/openalgo-charts/openalgo-charts.mjs";
import { createTimeframePreferences } from "/static/vendor/openalgo-charts/openalgo-charts.widget.mjs";
import { chromeIcon } from "/static/trading/glyphs.mjs";

/** Shared choices, separate from each pane's selected interval and layout. */
let shared = null;
export function chartTimeframePreferences() {
  if (!shared) {
    let storage = null;
    try {
      storage = localStorage;
    } catch {
      /* Private browsing can block storage. */
    }
    shared = createTimeframePreferences({
      storage,
      key: "cognix_terminal_timeframes",
      defaults: ["1m", "5m", "15m", "1h", "D"],
    });
  }
  return shared;
}

/* ── grouping helpers (their TimeframeMenu module scope, verbatim) ─────────── */

const GROUPS = ["s", "m", "h", "D", "W", "M", "tick", "other"];
const GROUP_NAMES = ["Seconds", "Minutes", "Hours", "Days", "Weeks", "Months", "Ticks", "Other"];
const NAMES = {
  s: "second",
  m: "minute",
  h: "hour",
  D: "day",
  W: "week",
  M: "month",
  tick: "tick",
  other: "interval",
};

function identity(code) {
  const part = safeParts(code);
  return part ? `${part.unit}:${part.multiplier}` : code;
}

function label(code) {
  const part = safeParts(code);
  return part
    ? `${part.multiplier} ${NAMES[part.unit]}${part.multiplier === 1 ? "" : "s"}`
    : code;
}

function safeParts(code) {
  try {
    return intervalParts(code);
  } catch {
    return null;
  }
}

function unique(codes) {
  const seen = new Set();
  return codes.filter((code) => {
    const key = identity(code);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Mount the controls.
 *
 *   strip     — element the favorite pills go into (role=toolbar)
 *   anchor    — element the interval button + its popover go into
 *   groups    — flat string[], or [{items: string[]}] nested groups
 *   canSelectInterval(code) — whether the chart can actually build it
 *   onSelect(code)          — the page applies it to the terminal
 *
 * Returns `{ setCurrent(code), open(), close(), destroy() }`.
 */
export function mountTimeframeControls({ strip, anchor, groups, canSelectInterval, onSelect }) {
  const preferences = chartTimeframePreferences();
  const flat =
    Array.isArray(groups) && groups.length && Array.isArray(groups[0]?.items)
      ? groups.flatMap((g) => (Array.isArray(g?.items) ? g.items : []))
      : Array.isArray(groups)
        ? groups.filter((c) => typeof c === "string")
        : [];
  let current = "";

  const wrap = document.createElement("div");
  wrap.className = "tt-tf-wrap";
  anchor.appendChild(wrap);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tt-tf-btn";
  button.setAttribute("aria-label", "Interval");
  wrap.appendChild(button);

  const pop = document.createElement("div");
  pop.className = "tt-tf-pop";
  pop.setAttribute("aria-label", "Timeframes");
  pop.style.display = "none";
  wrap.appendChild(pop);

  let folded = new Set();
  let open = false;

  const choose = (code) => {
    if (canSelectInterval(code)) {
      setOpen(false);
      onSelect(code);
    }
  };

  const swapIcon = (slot) => {
    const built = chromeIcon(slot.dataset.icon, slot.dataset.iconSize === "14" ? 14 : 16);
    if (built) slot.replaceWith(built);
  };

  function paintIcons(scope) {
    scope.querySelectorAll("span[data-icon]").forEach(swapIcon);
  }

  function renderStrip() {
    strip.innerHTML = "";
    const favorites = preferences.favorites();
    for (const code of favorites) {
      const active = identity(current) === identity(code);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tt-tf-fav" + (active ? " active" : "");
      b.setAttribute("aria-label", `Favorite interval ${code}`);
      b.setAttribute("aria-pressed", active ? "true" : "false");
      b.disabled = !canSelectInterval(code);
      b.textContent = code;
      b.onclick = () => choose(code);
      strip.appendChild(b);
    }
  }

  function renderPop() {
    pop.innerHTML = "";
    const favorites = preferences.favorites();
    const favoriteKeys = new Set(favorites.map(identity));
    const codes = unique([current, ...favorites, ...flat.filter(canSelectInterval)]);
    for (let index = 0; index < GROUPS.length; index++) {
      const group = GROUPS[index];
      const rows = codes
        .filter((code) => (safeParts(code)?.unit ?? "other") === group)
        .sort((a, b) => (safeParts(a)?.multiplier ?? 0) - (safeParts(b)?.multiplier ?? 0));
      if (!rows.length) continue;
      const section = document.createElement("section");
      section.className = "tt-tf-group";
      const head = document.createElement("button");
      head.type = "button";
      head.className = "tt-tf-group-head";
      head.setAttribute("aria-expanded", folded.has(group) ? "false" : "true");
      const name = document.createElement("span");
      name.textContent = GROUP_NAMES[index];
      head.appendChild(name);
      const chev = document.createElement("span");
      chev.dataset.icon = folded.has(group) ? "chevron-down" : "chevron-up";
      chev.dataset.iconSize = "14";
      head.appendChild(chev);
      head.onclick = () => {
        const next = new Set(folded);
        if (next.has(group)) next.delete(group);
        else next.add(group);
        folded = next;
        renderPop();
      };
      section.appendChild(head);
      if (!folded.has(group)) {
        for (const code of rows) {
          const key = identity(code);
          const text = label(code);
          const selected = key === identity(current);
          const enabled = canSelectInterval(code);
          const row = document.createElement("div");
          row.className = "tt-tf-row" + (selected ? " selected" : "");
          const main = document.createElement("button");
          main.type = "button";
          main.className = "tt-tf-row-main";
          main.setAttribute("aria-pressed", selected ? "true" : "false");
          main.disabled = !enabled;
          if (!enabled) main.title = "The current data source cannot build this interval";
          main.textContent = text;
          main.onclick = () => choose(code);
          row.appendChild(main);
          // Their grid keeps the custom/trash column; we have none, so a spacer
          // holds the 2rem column and the star stays in the third.
          row.appendChild(document.createElement("span"));
          const star = document.createElement("button");
          star.type = "button";
          star.className = "tt-tf-star" + (favoriteKeys.has(key) ? " on" : "");
          star.setAttribute(
            "aria-label",
            `${favoriteKeys.has(key) ? "Remove" : "Add"} ${text} ${
              favoriteKeys.has(key) ? "from" : "to"
            } favorites`
          );
          star.setAttribute("aria-pressed", favoriteKeys.has(key) ? "true" : "false");
          const starIcon = document.createElement("span");
          starIcon.dataset.icon = favoriteKeys.has(key) ? "star-filled" : "star";
          star.appendChild(starIcon);
          star.onclick = (e) => {
            e.stopPropagation();
            try {
              preferences.toggle(code);
            } catch {
              /* off */
            }
          };
          row.appendChild(star);
          section.appendChild(row);
        }
      }
      pop.appendChild(section);
    }
    paintIcons(pop);
  }

  function setOpen(value) {
    open = value;
    pop.style.display = open ? "flex" : "none";
    if (open) {
      // Fixed to the window: the band scrolls its own overflow-x and an
      // absolutely placed popover would be clipped by it (Radix portals
      // these; we place them by rect).
      const r = button.getBoundingClientRect();
      pop.style.left = `${Math.round(r.left)}px`;
      pop.style.top = `${Math.round(r.bottom + 4)}px`;
      renderPop();
    }
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }

  button.onclick = (e) => {
    e.stopPropagation();
    setOpen(!open);
  };
  const outside = (e) => {
    if (open && !wrap.contains(e.target)) setOpen(false);
  };
  const escapeKey = (e) => {
    if (e.key === "Escape" && open) setOpen(false);
  };
  const gone = () => {
    if (open) setOpen(false);
  };
  document.addEventListener("click", outside);
  document.addEventListener("keydown", escapeKey);
  // Scrolling moves the anchor out from under the fixed popover: closed, like
  // the Tip label.
  window.addEventListener("scroll", gone, true);
  window.addEventListener("resize", gone);

  const unsubscribe = preferences.subscribe(() => {
    renderStrip();
    if (open) renderPop();
  });

  renderStrip();

  return {
    setCurrent(code) {
      current = code;
      button.textContent = "";
      const text = document.createElement("span");
      text.className = "tt-tf-current";
      text.textContent = code || "-";
      button.appendChild(text);
      const chev = document.createElement("span");
      chev.dataset.icon = "chevron-down";
      chev.dataset.iconSize = "14";
      button.appendChild(chev);
      paintIcons(button);
      renderStrip();
      if (open) renderPop();
    },
    open() {
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    destroy() {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", escapeKey);
      window.removeEventListener("scroll", gone, true);
      window.removeEventListener("resize", gone);
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          /* off */
        }
      }
      wrap.innerHTML = "";
      strip.innerHTML = "";
    },
  };
}
