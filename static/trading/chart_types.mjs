/**
 * Chart-type catalogue for the trading terminal: the dropdown
 * groups, each type's underlying openalgo-charts series, and (for
 * movement-driven types) the transform the chart applies to the raw bars.
 *
 * Verbatim port of OpenAlgoNew `frontend/src/lib/trading/chartTypes.tsx`
 * (types stripped); `iconKey` rides the chrome glyph set via glyphs.mjs
 * chartTypeIcon().
 */

// Registers the in-chart transforms the specs below name, and the point and
// figure and Kagi renderers. Imported here, beside the catalogue that names
// them, so every chart reading this catalogue can apply them.
import "/static/vendor/openalgo-charts/openalgo-charts.transform.mjs";
// Renko then takes the terminal's own two-box staircase (reversals anchored
// at the inner edge) over the package's entry — same spec name and options.
// The vendored port self-registers on import and exports
// provisionalElementsOf() (the forming bar's projection elements).
import "/static/vendor/openalgo-charts/openalgo-renko-adjacent.mjs";
// Line Break likewise keeps the contiguous-tiling construction (reversal
// lines anchored at the last line's far edge).
import "/static/vendor/openalgo-charts/openalgo-linebreak-adjacent.mjs";

export const CHART_TYPE_GROUPS = [
  [
    { value: "bar", label: "Bars (OHLC)", iconKey: "chart-bar", series: "bar" },
    { value: "candlestick", label: "Candles", iconKey: "chart-candlestick", series: "candlestick" },
    { value: "hollow-candle", label: "Hollow Candles", iconKey: "chart-hollow-candle", series: "hollow-candle" },
    { value: "volume-candle", label: "Volume Candles", iconKey: "chart-volume-candle", series: "volume-candle" },
    { value: "high-low", label: "High-Low", iconKey: "chart-high-low", series: "high-low" },
  ],
  [
    { value: "line", label: "Line", iconKey: "chart-line", series: "line" },
    { value: "line-markers", label: "Line + Markers", iconKey: "chart-line-markers", series: "line-markers" },
    { value: "step", label: "Step", iconKey: "chart-step", series: "step" },
    { value: "area", label: "Area", iconKey: "chart-area", series: "area" },
    { value: "hlc-area", label: "HLC Area", iconKey: "chart-hlc-area", series: "hlc-area" },
    { value: "baseline", label: "Baseline", iconKey: "chart-baseline", series: "baseline", baseline: true },
  ],
  [
    {
      value: "heikin-ashi",
      label: "Heikin Ashi",
      iconKey: "chart-heikin-ashi",
      series: "candlestick",
      transform: () => ({ type: "heikin-ashi" }),
    },
    {
      value: "renko",
      label: "Renko",
      iconKey: "chart-renko",
      // The custom renderer registered in terminal.mjs draws touching bricks
      // without gaps; the transform spec itself is unchanged.
      series: "renko-brick",
      transform: (b) => ({ type: "renko", options: { boxSize: b } }),
    },
    {
      value: "range",
      label: "Range Bars",
      iconKey: "chart-range-bars",
      series: "candlestick",
      transform: (b) => ({ type: "range-bars", options: { range: b } }),
    },
    {
      value: "line-break",
      label: "Line Break",
      iconKey: "chart-line-break",
      series: "line-break-brick",
      transform: () => ({ type: "line-break", options: { lines: 3 } }),
    },
    {
      value: "point-figure",
      label: "Point & Figure",
      iconKey: "chart-point-figure",
      series: "point-figure",
      // Three boxes to reverse, from each bar's high and low: the standard
      // construction, and the transform's own defaults.
      transform: (b) => ({ type: "point-figure", options: { boxSize: b } }),
    },
    {
      value: "kagi",
      label: "Kagi",
      iconKey: "chart-kagi",
      series: "kagi",
      // A reversal of two boxes, the proportion the transform itself takes
      // between its box and a Kagi reversal when it sizes both from history.
      transform: (b) => ({ type: "kagi", options: { reversal: Number((b * 2).toPrecision(12)) } }),
    },
  ],
  [
    // The two profile types are the terminal's own profile-layer feature —
    // they arrive with the profile-layer round and stay disabled until then.
    { value: "tpo", label: "Time Price Opportunity", iconKey: "tpo", series: "candlestick", pending: true },
    { value: "session-volume-profile", label: "Session Volume Profile", iconKey: "profile", series: "candlestick", pending: true },
  ],
];

export const CHART_TYPES = Object.fromEntries(
  CHART_TYPE_GROUPS.flat().map((d) => [d.value, d])
);

/**
 * The types built from price boxes, which carry a settings dialog of their own
 * beside the chart type: box size and how it is measured, reversal, prices.
 */
export function isBoxChartType(value) {
  return value === "renko" || value === "point-figure";
}

/**
 * The chart type id the packaged widget knows a value by. The widget applies
 * a transform itself under the transform's own id, so `range` is `range-bars`
 * there; every other value is the same word.
 */
export function widgetChartType(value) {
  return CHART_TYPES[value]?.transform?.(0).type ?? value;
}

/**
 * Volume under each element of a transformed chart: the raw bars' volume summed
 * onto the element they formed, keyed by the element's time. An element's own
 * `volume` is not traded volume (a Kagi line keeps its thickness there and a
 * brick carries none), so this is what a volume histogram under one draws.
 * Raw bars after the last element (a brick still forming) count toward it.
 */
export function volumeUnderElements(elements, raw) {
  const out = [];
  let ri = 0;
  for (const element of elements) {
    let v = 0;
    while (ri < raw.length && raw[ri].time <= element.time) {
      v += raw[ri].volume || 0;
      ri++;
    }
    out.push({ time: element.time, open: 0, high: v, low: 0, close: v });
  }
  let rest = 0;
  while (ri < raw.length) {
    rest += raw[ri].volume || 0;
    ri++;
  }
  if (out.length && rest) {
    const last = out[out.length - 1];
    last.high += rest;
    last.close += rest;
  }
  return out;
}
