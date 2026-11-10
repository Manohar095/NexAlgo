/**
 * Chart theme + volume colouring for the trading terminal.
 *
 * Port of OpenAlgoNew `frontend/src/lib/trading/chartTheme.ts` (the parts the
 * terminal canvas eats — dialog metrics are a widget-round), `chartMotion.ts`
 * and `volumeSettings.ts`. The palette rides the page's own tokens
 * (`--tt-*`), the way theirs ride the app tokens.
 */

import { darkTheme, lightTheme } from "/static/vendor/openalgo-charts/openalgo-charts.mjs";

/**
 * The candle pair for each ground — identical to theirs: tuned per background.
 */
export const CANDLE_PAIRS = {
  dark: { up: "#14b887", down: "#f0525f" },
  light: { up: "#00855d", down: "#d42f34" },
};

/** How far the grid sits from the background towards the text colour. */
const GRID_STEP = { dark: 0.06, light: 0.055 };

/** The two colour forms this module ever meets; anything else reads as null. */
function parseRgb(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color.trim());
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** `color` moved `amount` of the way towards `towards`, in sRGB. */
export function mixColors(color, towards, amount) {
  const x = parseRgb(color);
  const y = parseRgb(towards);
  if (!x || !y || !(amount >= 0) || !(amount <= 1)) return color;
  const over = (a, b) => Math.round(a + (b - a) * amount);
  return `rgb(${over(x[0], y[0])},${over(x[1], y[1])},${over(x[2], y[2])})`;
}

/** `color` at `alpha`; anything unreadable is kept as it is. */
export function withAlpha(color, alpha) {
  const c = parseRgb(color);
  return c ? `rgba(${c[0]},${c[1]},${c[2]},${alpha})` : color;
}

/** Page token read where the chart lives. */
function token(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Build the canvas theme from the base palette and the page's own tokens —
 * buildChartTheme parity, with the page's `--tt-*` set standing in for the
 * app's token set.
 */
export function buildChartTheme(modeName) {
  const light = modeName === "light";
  const base = light ? lightTheme : darkTheme;
  const pair = light ? CANDLE_PAIRS.light : CANDLE_PAIRS.dark;
  const background = token("--tt-bg", light ? "#ffffff" : "#0b0e17");
  const foreground = token("--tt-text", light ? "#1a1e2b" : "#e6ecf5");
  const accent = token("--tt-accent", "#4b7bec");
  const mutedFg = token("--tt-muted", light ? "#5b6474" : "#8d99b8");
  const border = token("--tt-border", light ? "#e3e6ee" : "rgba(255,255,255,0.08)")
    .replace(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*[\d.]+\)$/, "rgb($1,$2,$3)");
  // Printed on the last-price tag and on the crosshair's pills alike.
  const tagText = light ? "#ffffff" : background;
  // The accent pill only where its text can be read on it.
  const pill = contrastRatio(accent, tagText) >= 4.5 ? accent : foreground;
  return {
    ...base,
    background,
    grid: mixColors(background, foreground, light ? GRID_STEP.light : GRID_STEP.dark),
    axisText: mutedFg,
    axisLine: border,
    paneSeparator: border,
    crosshair: mutedFg,
    crosshairLabelBackground: pill,
    upColor: pair.up,
    downColor: pair.down,
    wickUpColor: pair.up,
    wickDownColor: pair.down,
    lineColor: accent,
    // The fill under an area chart: the accent at the line, gone by the floor.
    areaTopColor: withAlpha(accent, light ? 0.22 : 0.3),
    areaBottomColor: withAlpha(accent, 0),
    baselineTopLine: pair.up,
    baselineTopFill: withAlpha(pair.up, light ? 0.14 : 0.18),
    baselineBottomLine: pair.down,
    baselineBottomFill: withAlpha(pair.down, light ? 0.14 : 0.18),
    lastPriceUp: pair.up,
    lastPriceDown: pair.down,
    lastPriceText: tagText,
    buy: pair.up,
    sell: pair.down,
    profit: pair.up,
    loss: pair.down,
  };
}

/** WCAG contrast ratio of two colours this module can read, or 0 when it cannot. */
export function contrastRatio(a, b) {
  const x = parseRgb(a);
  const y = parseRgb(b);
  if (!x || !y) return 0;
  const lum = (c) => {
    const [r, g, bl] = c.map((v) => {
      const n = v / 255;
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(x), lum(y)].sort((m, n) => n - m);
  return (hi + 0.05) / (lo + 0.05);
}

/** Volume-histogram color that reads well against the current theme. */
export function volumeColor(modeName) {
  if (modeName === "light") return "#d9d9de";
  return "#34343c";
}

/** How far direction-coloured volume sinks towards the chart background. */
const VOLUME_BLEND = 0.5;

/**
 * The candle pair as the volume histogram wears it: the same two hues, half
 * way to the background.
 */
export function quietVolumeStyle(style, background) {
  return {
    ...style,
    ...(style.upColor ? { upColor: mixColors(style.upColor, background, VOLUME_BLEND) } : {}),
    ...(style.downColor ? { downColor: mixColors(style.downColor, background, VOLUME_BLEND) } : {}),
  };
}

/* ── volume settings (volumeSettings.ts port, sans the settings dialog view) ── */

export const VOLUME_DEFAULTS = {
  "volume.colorByDirection": true,
  "volume.showMA": false,
  "volume.maPeriod": 20,
  "volume.maColor": "#e6b53c",
  "volume.maWidth": 1.5,
  "volume.maStyle": "solid",
};

/** Saved settings folded over the defaults, clamped like theirs. */
export function volumeValues(saved) {
  const values = { ...VOLUME_DEFAULTS };
  for (const key of Object.keys(values)) {
    const value = saved ? saved[key] : undefined;
    if (typeof value !== typeof values[key]) continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) continue;
      values[key] =
        key === "volume.maPeriod"
          ? Math.max(1, Math.min(500, Math.round(value)))
          : Math.max(1, Math.min(5, value));
    } else if (key === "volume.maStyle") {
      if (["solid", "dashed", "dotted"].includes(String(value))) values[key] = value;
    } else if (typeof value !== "string" || value.trim()) values[key] = value;
  }
  return values;
}

/** The histogram follows the same body-colour rule as the displayed candle. */
export function volumePoint(bar, previousClose, amount, style, direction) {
  const reference =
    style.colorByPreviousClose && Number.isFinite(previousClose) ? previousClose : bar.open;
  // `direction` true means colour per-bar at all; the bar's own override wins.
  const isUp = bar.close >= reference;
  const color = direction
    ? (bar.color ?? (isUp ? style.upColor : style.downColor))
    : undefined;
  return {
    time: bar.time,
    open: 0,
    high: amount,
    low: 0,
    close: amount,
    ...(color ? { color } : {}),
  };
}

/** A tail update reads at most one averaging window, regardless of retained history. */
export function volumeAveragePoint(bars, index, period) {
  let value = NaN;
  if (index + 1 >= period) {
    let total = 0;
    for (let i = index - period + 1; i <= index; i++) total += bars[i].close;
    value = total / period;
  }
  return { time: bars[index].time, open: value, high: value, low: value, close: value };
}

export function volumeAverage(bars, period) {
  let total = 0;
  return bars.map((bar, index) => {
    total += bar.close;
    if (index >= period) total -= bars[index - period].close;
    const value = index + 1 >= period ? total / period : NaN;
    return { time: bar.time, open: value, high: value, low: value, close: value };
  });
}

/* ── chart motion (chartMotion.ts port) ────────────────────────────────────── */

/**
 * Chart construction options for a user whose operating system asks for
 * less motion: a wheel zoom lands in one frame instead of gliding, and the
 * price range snaps rather than easing.
 */
export function chartMotionOptions() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return {};
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? { animZoom: false, animAutoscale: false }
      : {};
  } catch {
    return {};
  }
}
