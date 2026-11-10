/**
 * What goes into a chart's CSV download.
 *
 * The engine already writes the file (`exportChartDataCsv`): UTC seconds, the
 * unrounded bars, and nothing a replay has not yet revealed. This is the
 * verbatim port of OpenAlgoNew `frontend/src/lib/trading/chartDataExport.ts`
 * (types stripped), turning the trader's choice into its options — plus the
 * light download dialog that stands in for their full ChartDataDialog while
 * this terminal has no studies/comparisons yet.
 */

/**
 * The span of bar times on screen, or null when no loaded bar is.
 */
export function visibleTimes(chart) {
  const view = chart.getVisibleLogicalRange();
  const axis = chart.dataLayer;
  const first = Math.max(0, Math.ceil(view.from));
  const last = Math.min(axis.length - 1, Math.floor(view.to));
  const tail = chart.primaryBars().at(-1)?.time;
  if (first > last || tail === undefined) return null;
  const from = axis.indexToTime(first);
  const end = axis.indexToTime(last);
  if (from === undefined || end === undefined) return null;
  const to = Math.min(end, tail);
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
}

/** The engine's options for one download. */
export function csvOptions(chart, options = {}) {
  const out = {};
  if (options.studies !== undefined) out.indicators = options.studies.length ? options.studies : false;
  if (options.comparisons === false) out.comparisons = [];
  if (options.range === "visible") {
    const range = visibleTimes(chart);
    if (!range) throw new Error("No bars are on screen to export");
    out.range = range;
  }
  return out;
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/**
 * The download dialog: every loaded bar (the default) or only those on
 * screen. Returns `{ range: 'all' | 'visible' }`, or null when dismissed.
 *
 * Their ChartDataDialog also lists studies and comparison toggles; both
 * arrive with the indicator and comparison rounds, so the card carries just
 * the two range rows until then.
 */
export function openDataDialog({ instrument }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "tt-dialog tt-data-dlg";
    dlg.innerHTML = `
      <div class="tt-box-head"><b>Download chart data</b></div>
      <p class="tt-mutedlite" style="margin:2px 2px 10px">${esc(instrument || "")} — UTC seconds, unrounded bars</p>
      <div class="tt-data-choices">
        <button type="button" class="tt-data-choice" data-act="all" data-title="All bars">
          <span class="tt-data-name">All bars</span>
          <span class="tt-data-sub">Every loaded bar</span>
        </button>
        <button type="button" class="tt-data-choice" data-act="visible" data-title="Visible bars">
          <span class="tt-data-name">Visible bars</span>
          <span class="tt-data-sub">Only what is on screen</span>
        </button>
      </div>
      <div class="tt-box-row">
        <span class="tt-growth"></span>
        <button type="button" class="tt-btn" data-act="cancel">Cancel</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.showModal();
    const close = (answer) => {
      dlg.close();
      resolve(answer);
    };
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(null);
    });
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close(null);
    });
    dlg.querySelector('[data-act="all"]').onclick = () => close({ range: "all" });
    dlg.querySelector('[data-act="visible"]').onclick = () => close({ range: "visible" });
    dlg.querySelector('[data-act="cancel"]').onclick = () => close(null);
  });
}
