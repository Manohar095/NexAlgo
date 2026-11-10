/**
 * The brick-series renderers for the terminal: Renko / Line Break bricks drawn
 * touching (no gaps between columns), and the brick-pitch volume overlay.
 *
 * Verbatim port of OpenAlgoNew `terminal.ts registerBrickChartRenderer` +
 * `drawGhostBrick`, structured as factories over a `host` context supplying
 * the terminal's outstanding-forming state (projections, ghost, replay).
 *
 * Pixel-snapping note, carried from theirs verbatim: draw in DEVICE pixels
 * with every rect edge snapped to the pixel grid — neighbouring columns round
 * to the SAME integer edge (no gap, no overlap), and stacked bricks share the
 * seam through a floor/ceil pair that either meets exactly or overlaps one
 * device pixel row — for the eye, corners touch for green and red alike.
 */

import { registerChartType } from "/static/vendor/openalgo-charts/openalgo-charts.mjs";
import { withAlpha, volumeColor } from "./chart_theme.mjs";

/**
 * Register the custom renderers for the brick charts (Renko, Line Break):
 * `renko-brick` / `line-break-brick` for the price series and `brick-volume`
 * for the histogram that rides the brick pitch.
 *
 * `host` supplies:
 *   ctype                 — the current chart-type id
 *   projections()         → readonly Bar[]   — the forming bar's projection elements
 *   projectionAnchor()    → number          — time slot the projections hang past
 *   ghost()               → Brick|null      — the shaded forming slot
 *   replayOwnsDisplay()   → boolean
 */
export function registerBrickRenderers(theme, host) {
  const { upColor, downColor } = theme;
  // Only the types whose next slot hangs a shaded ghost off it (the ghost
  // field itself is only set for them, so the renderer checks for nothing).
  const drawsGhost = host.ctype === "renko" || host.ctype === "line-break";

  const brickRenderer = {
    defaultStyle: {
      upColor,
      downColor,
      borderVisible: false,
      wickVisible: false,
      bodyVisible: true,
    },
    isPriceSeries: true,
    draw(ctx, items, toY, barSpacing, dpr, style) {
      const projections = drawsGhost ? host.projections() : [];
      const ghost = drawsGhost ? host.ghost() : null;
      ctx.save();
      // One snapped rect at media-x `x` — committed bricks and projection
      // bricks both draw through it, so their seams stay identical.
      const drawBrick = (x, open, close, color) => {
        const halfDev = (barSpacing * dpr) / 2;
        const left = Math.round(x * dpr - halfDev);
        const right = Math.round(x * dpr + halfDev);
        const top = Math.floor(Math.min(toY(open), toY(close)) * dpr);
        const bottom = Math.ceil(Math.max(toY(open), toY(close)) * dpr);
        ctx.fillStyle = color;
        ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
      };
      for (const item of items) {
        const { bar, x } = item;
        const isUp = bar.close >= bar.open;
        // A per-bar colour override carries the brick's own shade for
        // whatever needs one; completed bricks take the trend colours.
        const trend = isUp ? (style.upColor ?? upColor) : (style.downColor ?? downColor);
        drawBrick(x, bar.open, bar.close, bar.color ?? trend);
      }
      // Projection bricks: the forming bar's elements, drawn shaded in their
      // own columns past the last completed element. They are NOT in the
      // series — the axis's last-value tag stays on the last COMPLETED
      // brick, and these advance tick by tick until the candle closes, when
      // the same bricks arrive inside the series in full colour.
      if (host.ctype === "renko" || host.ctype === "line-break") {
        if (projections.length && items.length) {
          const anchorX = items[items.length - 1].x;
          for (let i = 0; i < projections.length; i++) {
            const bar = projections[i];
            const isUp = bar.close >= bar.open;
            const trend = isUp ? (style.upColor ?? upColor) : (style.downColor ?? downColor);
            drawBrick(anchorX + (i + 1) * barSpacing, bar.open, bar.close, withAlpha(trend, 0.35));
          }
        }
      }
      ctx.restore();
      // The forming slot: the shaded ghost hangs off the last element's
      // column, drawn with the exact same snapping as the bricks above.
      if (drawsGhost) drawGhostBrick(ctx, items, toY, barSpacing, dpr, upColor, downColor, host);
    },
    extents(bar, _style) {
      let min = bar.low;
      let max = bar.high;
      const draws = host.ctype === "renko" || host.ctype === "line-break";
      // The projections scale too: bricks still forming extend past the last
      // element, and autoscale must leave screen room for them.
      const projections = draws ? host.projections() : [];
      if (projections.length && bar.time === host.projectionAnchor()) {
        for (const p of projections) {
          min = Math.min(min, p.low, p.open, p.close, p.high);
          max = Math.max(max, p.high, p.open, p.close, p.low);
        }
      }
      // The ghost scale as well: a brick still gathering extends past the
      // last element too.
      const ghost = draws ? host.ghost() : null;
      if (ghost && ghost.anchor === bar.time) {
        min = Math.min(min, ghost.open, ghost.close);
        max = Math.max(max, ghost.open, ghost.close);
      }
      return { min, max };
    },
  };
  // Register with unique type names that won't conflict
  registerChartType("renko-brick", brickRenderer);
  registerChartType("line-break-brick", brickRenderer);

  // The volume overlay on a brick chart rides the same pitch. The built-in
  // histogram insets every bar within its column, which at the small spacing
  // a brick chart runs leaves a wide gap between consecutive volume bars —
  // the histogram must follow the brick pitch but keep its own column
  // rhythm. The same pixel snapping as `brickRenderer`, with a hairline gap
  // between neighbouring bars; per-point colours arrive at 60% alpha from
  // volumePoint, and the fallback is the theme's volume colour for when
  // direction matching is switched off.
  const brickVolumeRenderer = {
    defaultStyle: { color: volumeColor(host.modeName) },
    isPriceSeries: false,
    draw(ctx, items, toY, barSpacing, dpr, style) {
      ctx.save();
      const baseDev = Math.round(toY(0) * dpr);
      const halfDev = (barSpacing * dpr) / 2;
      for (const { bar, x } of items) {
        const value = Number.isFinite(bar.close) ? bar.close : bar.open;
        const top = Math.min(baseDev, Math.round(toY(value) * dpr));
        const height = Math.max(1, baseDev - top);
        // One device pixel inset per side: adjacent bars still share a
        // rounded pitch edge, but the two insets read as a hairline gap —
        // the histogram keeps its column rhythm the way candles do.
        const left = Math.round(x * dpr - halfDev) + 1;
        const right = Math.round(x * dpr + halfDev) - 1;
        ctx.fillStyle = bar.color ?? style.color ?? "#71717a";
        ctx.fillRect(left, top, Math.max(1, right - left), height);
      }
      ctx.restore();
    },
    extents(bar, _style) {
      return { min: bar.low, max: bar.high };
    },
  };
  registerChartType("brick-volume", brickVolumeRenderer);
}

/**
 * Draw the shaded slot the live LTP occupies: one column past the last
 * completed element's column, so a quantised chart still shows where the
 * running price stands between crossings.
 */
function drawGhostBrick(ctx, items, toY, barSpacing, dpr, upColor, downColor, host) {
  if (host.replayOwnsDisplay() || !items.length) return;
  const ghost = host.ghost();
  if (!ghost) return;
  const anchor = items[items.length - 1];
  if (anchor.bar.time !== ghost.anchor) return;
  const projections = host.projections();
  const halfDev = (barSpacing * dpr) / 2;
  // The ghost's column is a full brick-pitch past the last completed
  // element's column — past the projection slots when the forming bar has
  // already printed bricks there.
  const centerDev = (anchor.x + projections.length * barSpacing) * dpr;
  // The ghost's column starts where the anchor's ends, at the same pitch.
  const left = Math.round(centerDev + halfDev);
  const width = Math.max(1, left - Math.round(centerDev - halfDev));
  const top = Math.floor(Math.min(toY(ghost.open), toY(ghost.close)) * dpr);
  const bottom = Math.ceil(Math.max(toY(ghost.open), toY(ghost.close)) * dpr);
  ctx.fillStyle = withAlpha(ghost.close >= ghost.open ? upColor : downColor, 0.35);
  ctx.fillRect(left, top, width, Math.max(1, bottom - top));
}
