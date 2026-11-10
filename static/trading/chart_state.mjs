/**
 * What a pane says while its chart is not simply showing bars.
 *
 * Verbatim port of OpenAlgoNew `frontend/src/lib/trading/chartState.ts`
 * (wording + timing, DOM-free) and the `ChartStateOverlay.tsx` DOM rendering.
 *
 * A pane is in one of four states: showing a chart (ready), waiting for bars
 * (loading), holding a reply with no bars in it (empty), or holding a request
 * that failed (error). The terminal reports the state of each load; the pane
 * draws it as an overlay over the chart rather than as a toast, because a toast
 * is gone in four seconds and the blank or stale chart it explained stays.
 *
 * The overlay never covers the chart with a scrim. A failed load leaves the
 * previous chart where it was, readable and usable around the card, and
 * Dismiss takes the card away. Only the card itself takes the pointer, and the
 * loading dots take nothing.
 */

/**
 * A warm load lands in a few milliseconds. The dots appear only for one that
 * takes longer than this, so a quick switch never flashes them.
 */
export const LOADING_DELAY_MS = 120;

export const CHART_READY = Object.freeze({ kind: "ready", symbol: "", interval: "" });

const NETWORK = /failed to fetch|networkerror|network request failed|load failed/i;

/**
 * The cause of a failed load in a trader's words: no status code, no
 * endpoint, no exception class. The full error has already gone to the
 * console by the time this sees it.
 */
export function traderReason(raw) {
  if (NETWORK.test(raw)) {
    return "The algo server could not be reached. Check that the server is running and the network is up";
  }
  const text = raw
    .replace(/^\s*(?:history error|[a-z]*error)\s*:\s*/i, "")
    // The request helper's own wording: `history failed (500): ...`.
    .replace(/(?:\/api\/v\d+\/)?[\w/.-]+\s+failed\s*\(\d{3}\)\s*:?/gi, "")
    .replace(/\/api\/v\d+\/[\w/.-]*/gi, "")
    .replace(/\s*\((?:HTTP\s*)?\d{3}\)/gi, "")
    .replace(/\b(?:HTTP|status(?: code)?)\s*\d{3}\b:?/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:\-,\s]+|[.:,\s]+$/g, "");
  if (!text) return "The broker did not return bars";
  return text[0].toUpperCase() + text.slice(1);
}

/** A load that failed. `reason` is the cleaned error text. */
export function chartLoadFailed(symbol, interval, reason) {
  return { kind: "error", symbol, interval, message: traderReason(reason) };
}

/** A load that came back with no bars. */
export function chartNoData(symbol, interval, message) {
  return message === undefined
    ? { kind: "empty", symbol, interval }
    : { kind: "empty", symbol, interval, message };
}

/** The words the overlay shows for a state: cause first, then what to do. */
export function chartStateCopy(view) {
  const symbol = view.symbol.trim();
  const interval = view.interval.trim();
  if (view.kind === "loading") {
    const what = [symbol, interval].filter(Boolean).join(" ");
    return { title: what ? `Loading ${what}` : "Loading chart", text: "", role: "status" };
  }
  if (view.kind === "empty") {
    return {
      title: `No data for ${symbol || "this symbol"}${interval ? ` on ${interval}` : ""}`,
      text: `${view.message ?? "The broker returned no bars for this range"}. Try another interval, or check the symbol.`,
      role: "status",
    };
  }
  if (view.kind === "error") {
    return {
      title: `Could not load ${symbol || "the chart"}${interval ? ` on ${interval}` : ""}`,
      text: `${view.message ?? "The broker did not return bars"}. Try again in a moment.`,
      role: "alert",
    };
  }
  return { title: "", text: "", role: "status" };
}

/**
 * Turns load states into what is on screen. `show(null)` means nothing.
 *
 * A new load hides any card at once, so a retry never leaves the old failure
 * up beside the dots, and the dots wait `delay` before they appear.
 */
export function createChartStateGate(show, delay = LOADING_DELAY_MS) {
  let timer = null;
  let shown = null;
  let dead = false;
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const put = (view) => {
    if (dead || view === shown) return;
    shown = view;
    show(view);
  };
  return {
    set(view) {
      if (dead) return;
      clear();
      if (view.kind === "ready") {
        put(null);
        return;
      }
      if (view.kind === "loading") {
        if (shown && shown.kind !== "loading") put(null);
        timer = setTimeout(() => {
          timer = null;
          put(view);
        }, delay);
        return;
      }
      put(view);
    },
    dismiss() {
      clear();
      put(null);
    },
    destroy() {
      clear();
      dead = true;
    },
  };
}

/* ── ChartStateOverlay.tsx, as DOM ──────────────────────────────────────────── */

const BUTTON_CLASS = "tt-tstate-btn";

/**
 * Mount the overlay over `pane` (a `position:relative` element). Returns
 * `{ show(view), destroy() }`; `show(null)` takes the card away.
 */
export function mountChartStateOverlay(pane, { onRetry, onDismiss }) {
  const box = document.createElement("div");
  box.className = "tt-tstate";
  pane.appendChild(box);
  let current = null;
  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const render = (view) => {
    if (!view || view.kind === "ready") {
      box.innerHTML = "";
      box.removeAttribute("data-chart-state");
      box.style.display = "none";
      current = null;
      return;
    }
    const copy = chartStateCopy(view);
    const loading = view.kind === "loading";
    if (current !== view.kind) {
      box.innerHTML = loading
        ? `<div class="tt-tstate-card tt-tstate-loading">` +
          `<span class="tt-tstate-dots" aria-hidden="true">` +
          `<i style="animation-delay:0ms"></i><i style="animation-delay:150ms"></i><i style="animation-delay:300ms"></i>` +
          `</span><span class="tt-tstate-title">${esc(copy.title)}</span></div>`
        : `<div class="tt-tstate-card tt-tstate-msg" role="${copy.role}" ` +
          `aria-live="${copy.role === "alert" ? "assertive" : "polite"}">` +
          `<p class="tt-tstate-title">${esc(copy.title)}</p>` +
          `<p class="tt-tstate-text">${esc(copy.text)}</p>` +
          `<div class="tt-tstate-actions">` +
          `<button type="button" class="${BUTTON_CLASS}" data-act="retry">Try again</button>` +
          `<button type="button" class="${BUTTON_CLASS}" data-act="dismiss">Dismiss</button>` +
          `</div></div>`;
      const retry = box.querySelector('[data-act="retry"]');
      const dismiss = box.querySelector('[data-act="dismiss"]');
      if (retry) retry.onclick = () => onRetry && onRetry();
      if (dismiss) dismiss.onclick = () => onDismiss && onDismiss();
      current = view.kind;
    } else {
      const title = box.querySelector(".tt-tstate-title");
      if (title) title.textContent = copy.title;
      if (!loading) {
        const text = box.querySelector(".tt-tstate-text");
        if (text) text.textContent = copy.text;
      }
    }
    box.dataset.chartState = view.kind;
    box.style.display = "";
  };
  return {
    show: render,
    destroy() {
      box.remove();
    },
  };
}
