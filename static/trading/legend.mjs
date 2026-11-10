/**
 * The charting terminal's OHLC readout, expressed as data rather than markup.
 *
 * Verbatim port of OpenAlgoNew `frontend/src/lib/trading/legend.ts` (+ the
 * `resolveCssColor` rasterizer from its `chartTheme.ts`), types stripped.
 *
 * One builder feeds two renderers: the live DOM overlay pinned to the top-left
 * of the pane (`legendHtml`), and the PNG export, which paints the same runs
 * onto the captured canvas (`terminal.mjs`). openalgo-charts'
 * `takeScreenshot()` composites only its own pane canvases, so the DOM overlay
 * is invisible to the export — sharing one model is what keeps the saved image
 * and the screen showing the same numbers instead of two hand-maintained
 * copies drifting.
 *
 * Runs carry a semantic tone, not a colour. The DOM renderer stays relative to
 * the CSS theme (inherit the foreground, dim the meta with opacity) so a theme
 * toggle recolours it with no repaint, while the canvas renderer resolves the
 * tone to a concrete colour, which is all a canvas can paint.
 */

/** Candle direction colours, shared by the OHLC legend and the last-price line. */
export const UP = "#26a69a";
export const DN = "#ef5350";
/** Last-price colour before any bar exists to take a direction from. */
export const LTP_NEUTRAL = "#e0b020";

/**
 * Any CSS colour as a plain `rgb()` or `rgba()` string the canvas will parse.
 * Port of chartTheme.ts `rasterize` (probe span + 1×1 canvas over black and
 * white, so tokens like oklch and alpha hairlines both survive to `fillStyle`).
 */
let probe = null;
let probeCtx = null;

function over(background, color) {
  const c = probeCtx;
  c.fillStyle = background;
  c.fillRect(0, 0, 1, 1);
  c.fillStyle = color;
  c.fillRect(0, 0, 1, 1);
  return c.getImageData(0, 0, 1, 1).data;
}

export function resolveCssColor(cssColor) {
  if (!probe) {
    probe = document.createElement("span");
    probe.style.display = "none";
    document.body.appendChild(probe);
    const cnv = document.createElement("canvas");
    cnv.width = cnv.height = 1;
    probeCtx = cnv.getContext("2d", { willReadFrequently: true });
  }
  if (!probeCtx) return cssColor;
  // Resolve the variable through the DOM first (it applies the active theme
  // class), then let the canvas normalise whatever comes back: oklch, hsl,
  // color-mix, a named colour. Assigning an invalid value leaves `fillStyle`
  // as it was, so the black set first is what an unparseable colour becomes.
  probe.style.color = "";
  probe.style.color = cssColor;
  const resolved = probe.style.color === "" ? "#000" : getComputedStyle(probe).color || "#000";
  probeCtx.fillStyle = "#000";
  probeCtx.fillStyle = resolved;
  const parsed = probeCtx.fillStyle;

  const onBlack = over("#000", parsed);
  const onWhite = over("#fff", parsed);
  // Every channel gives the same alpha, so the three are averaged: one channel
  // alone carries its own rounding, and on a grey token that is the whole error.
  let alpha = 0;
  for (let i = 0; i < 3; i++) alpha += 1 - (onWhite[i] - onBlack[i]) / 255;
  alpha = Math.min(1, Math.max(0, alpha / 3));

  if (alpha >= 0.999) return `rgb(${onBlack[0]},${onBlack[1]},${onBlack[2]})`;
  if (alpha <= 0.001) return "rgba(0,0,0,0)";
  const channel = (value) => Math.min(255, Math.max(0, Math.round(value / alpha)));
  const [r, g, b] = [channel(onBlack[0]), channel(onBlack[1]), channel(onBlack[2])];
  return `rgba(${r},${g},${b},${Math.round(alpha * 1000) / 1000})`;
}

/**
 * Build the readout: symbol, then its meta (interval, exchange, lot size), the
 * bar's O/H/L/C/V, and that bar's own change against the close before it.
 *
 * Everything here describes a single bar, so the whole line moves together as
 * the crosshair moves. Every section past the symbol and its meta is optional:
 * a freshly loaded chart has no crosshair bar, and the first bar of the loaded
 * history has nothing behind it to measure against.
 */
export function buildChartLegend(input) {
  const runs = [{ text: input.symbol, tone: "symbol" }];
  const lot = input.lotsize ? ` · lot ${input.lotsize}` : "";
  runs.push({ text: `· ${input.interval} · ${input.exchange}${lot}`, tone: "meta" });

  const bar = input.bar;
  if (bar) {
    const text =
      `O ${input.fmt(bar.open)} H ${input.fmt(bar.high)} ` +
      `L ${input.fmt(bar.low)} C ${input.fmt(bar.close)}`;
    const tone = bar.close >= bar.open ? "up" : "down";
    runs.push({ text, tone });
    // Volume is absent on the transformed chart types (renko, point-and-figure),
    // whose elements are not one bar each, so it is shown only when it is real.
    // Split into its own run rather than concatenated, so it can carry the
    // switch for the bars it is reading.
    if (typeof bar.volume === "number" && Number.isFinite(bar.volume) && bar.volume >= 0) {
      runs.push({
        text: `V ${input.fmtVolume(bar.volume)}`,
        tone,
        action: "volume",
        dim: input.volumeHidden === true,
      });
    }
  }

  // The bar's own change, against the close before it. Absolute first, percent
  // in parentheses, which is how a reader compares two instruments at a glance:
  // the points say how far it moved, the percent says how much that was.
  if (bar && input.prevClose != null && input.prevClose !== 0) {
    const change = bar.close - input.prevClose;
    const pct = (change / input.prevClose) * 100;
    const sign = change >= 0 ? "+" : "-";
    const mag = Math.abs(change);
    runs.push({
      text: `${sign}${input.fmt(mag)} (${sign}${Math.abs(pct).toFixed(2)}%)`,
      tone: change >= 0 ? "up" : "down",
    });
  }
  return runs;
}

/** Canvas paint attributes for a tone. `foreground` is the app's resolved text colour. */
export function legendToneStyle(tone, foreground) {
  switch (tone) {
    case "meta":
      return { color: foreground, alpha: 0.55 };
    case "up":
      return { color: UP, alpha: 1 };
    case "down":
      return { color: DN, alpha: 1 };
    case "ltp":
      return { color: LTP_NEUTRAL, alpha: 1 };
    default:
      return { color: foreground, alpha: 1 };
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** Inline style per tone for the DOM overlay; empty means inherit the theme. */
const HTML_TONE_STYLE = {
  symbol: "",
  meta: "opacity:.55",
  up: `color:${UP}`,
  down: `color:${DN}`,
  ltp: `color:${LTP_NEUTRAL}`,
};

/** Render the runs as the DOM overlay's markup, space-separated. */
export function legendHtml(runs) {
  return runs
    .map((run) => {
      const style = HTML_TONE_STYLE[run.tone];
      if (run.action !== undefined) {
        // Underlined on hover rather than boxed: it sits inside a line of
        // readout text. Struck through when off.
        const off = run.dim === true;
        const bits = [
          style ?? "",
          "cursor:pointer",
          "text-decoration:" + (off ? "line-through" : "none"),
          "text-underline-offset:3px",
          off ? "opacity:.5" : "",
        ]
          .filter(Boolean)
          .join(";");
        const title = off ? "Show volume" : "Hide volume";
        return (
          `<span data-legend-action="${run.action}" role="button" tabindex="0"` +
          ` title="${title}" aria-label="${title}" style="${bits}"` +
          ` onmouseover="this.style.textDecoration='underline'${off ? " + ' line-through'" : ''}"` +
          ` onmouseout="this.style.textDecoration='${off ? 'line-through' : 'none'}'"` +
          `>${esc(run.text)}</span>`
        );
      }
      const attr = style ? ` style="${style}"` : "";
      const tag = run.tone === "symbol" ? "b" : "span";
      return `<${tag}${attr}>${esc(run.text)}</${tag}>`;
    })
    .join(" ");
}
