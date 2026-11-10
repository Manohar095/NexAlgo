/**
 * The terminal's own Line Break transform: the contiguous-tiling construction
 * this chart always drew, registered over the package's entry.
 *
 * `openalgo-charts`'s built-in Line Break opens every new line at the last
 * line's close, so a reversal line spans back down (or up) across the whole
 * staircase it reverses — red across the green lines above it, green across
 * the red lines below. This chart's Line Break keeps its own construction
 * instead:
 *
 * - a reversal only starts once the close breaks beyond the extremes — the
 *   lows/highs, not the open/close pairs — of the prior `lines` lines;
 * - the reversal line then opens at the LAST line's far edge (the last
 *   green's low, the last red's high), so it shares an edge with the line it
 *   reverses and green and red tile contiguously instead of gapping away
 *   from each other;
 * - a continuation line still opens at the last line's close and stacks on
 *   it, as the classic construction has it.
 *
 * The run that wraps the transform follows the same `SeriesTransformRun`
 * contract as the Renko one: committed elements from completed bars, and the
 * newest source bar — the forming one — pushed through a `clone` whose
 * provisional elements a tick replaces.
 *
 * Ported verbatim (types stripped) from OpenAlgoNew
 * frontend/src/lib/trading/lineBreakAdjacent.ts — the only changes are the
 * import paths, pointed at the vendored openalgo-charts copy and the sibling
 * ported Renko module.
 */

import { registerSeriesTransform } from "./openalgo-charts.mjs";
import { AdjacentTransformRun } from "./openalgo-renko-adjacent.mjs";

const LINES_INPUT = {
  key: "lines",
  type: "number",
  label: "Lines to break",
  default: 3,
  min: 1,
  step: 1,
};

/** The spec check the engine performs before building, mirrored. */
function validateOptions(given) {
  const fail = (why) => {
    throw new TypeError(`openalgo-charts: invalid series transform: ${why}`)
  }
  if (given === null || typeof given !== "object" || Array.isArray(given)) {
    fail("options must be an object")
  }
  for (const [key, value] of Object.entries(given)) {
    if (key !== "lines") fail(`Line Break option "${key}" is not one it takes`)
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < LINES_INPUT.min ||
      !Number.isInteger(value)
    ) {
      fail(`Line Break option "lines" cannot be ${String(value)}`)
    }
  }
  return given.lines ?? LINES_INPUT.default
}

/** LineBreakAdjacentOptions (was a TS interface):
 *  { lines? } — number of prior lines to consider for reversals (default 3).
 */

/** LineState (was a TS interface):
 *  { direction: 1|-1|0, lines: Bar[] (recent completed, capped at the window),
 *    lastClose, lastTime }
 */

export class LineBreakAdjacentTransform {
  constructor(options = {}) {
    const { lines = 3 } = options
    if (lines < 2) throw new Error("LineBreak lines must be >= 2")
    this.n = lines
    this.state = { direction: 0, lines: [], lastClose: NaN, lastTime: 0 }
  }

  reset() {
    this.state = { direction: 0, lines: [], lastClose: NaN, lastTime: 0 }
  }

  clone() {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this, {
      state: { ...this.state, lines: this.state.lines.slice() },
    })
  }

  push(bar) {
    const close = bar.close
    const lines = []

    // Initialize on the first bar: the seed line keeps the bar's own OHLC.
    if (this.state.lines.length === 0) {
      this.state.lines.push({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume ?? 0,
      })
      this.state.direction = 0
      this.state.lastClose = close
      this.state.lastTime = bar.time
      return lines
    }

    // Skip duplicate (same timestamp and close)
    if (bar.time === this.state.lastTime && close === this.state.lastClose) {
      return lines
    }

    const { direction, lines: recent } = this.state
    const lastLine = recent[recent.length - 1]

    if (direction === 0) {
      // Initial direction determination - need at least two lines.
      if (recent.length === 1) {
        if (close > lastLine.high) {
          this.state.direction = 1
          this.pushLine(lines, this.createLine(bar, lastLine.close, close))
        } else if (close < lastLine.low) {
          this.state.direction = -1
          this.pushLine(lines, this.createLine(bar, lastLine.close, close))
        }
        // Close within the last line's range: no new line.
      }
    } else if (direction > 0) {
      // Currently in an uptrend (green lines).
      if (close > lastLine.high) {
        // Continuation: a new green line stacked on the last line's close.
        this.pushLine(lines, this.createLine(bar, lastLine.close, close))
      } else if (recent.length >= this.n && close < this.lowOfPriorN()) {
        // Reversal: close breaks below the low of the prior n lines. The red
        // line starts at the LAST GREEN line's LOW -- its open edge -- not at
        // its close and not at the trigger level: the reversal line is
        // contiguous with the line it reverses, and its close is the price
        // that broke the prior n lows.
        this.state.direction = -1
        this.pushLine(lines, this.createLine(bar, lastLine.low, close))
      }
      // Close within the prior n lines' range - no new line.
    } else {
      // Currently in a downtrend (red lines).
      if (close < lastLine.low) {
        // Continuation: a new red line stacked on the last line's close.
        this.pushLine(lines, this.createLine(bar, lastLine.close, close))
      } else if (recent.length >= this.n && close > this.highOfPriorN()) {
        // Reversal: close breaks above the high of the prior n lines. The
        // green line starts at the LAST RED line's HIGH -- its open edge.
        this.state.direction = 1
        this.pushLine(lines, this.createLine(bar, lastLine.high, close))
      }
      // Close within the prior n lines' range - no new line.
    }

    this.state.lastClose = close
    this.state.lastTime = bar.time
    return lines
  }

  /** Record a formed line in the state window and hand it to the run. */
  pushLine(elements, line) {
    elements.push(line)
    this.state.lines.push(line)
    if (this.state.lines.length > this.n) this.state.lines.shift()
  }

  /** The lowest low of the prior n lines. */
  lowOfPriorN() {
    const relevant = this.state.lines.slice(-this.n)
    return Math.min(...relevant.map((line) => line.low))
  }

  /** The highest high of the prior n lines. */
  highOfPriorN() {
    const relevant = this.state.lines.slice(-this.n)
    return Math.max(...relevant.map((line) => line.high))
  }

  /** A new line keeps the bar's time and volume, spanning open to close. */
  createLine(bar, open, close) {
    return {
      time: bar.time,
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: bar.volume ?? 0,
    }
  }

  flush() {
    // Line Break doesn't have partial lines to flush
    return []
  }
}

/* ── registration over the package's own entry ── */

const adjacentLineBreak = {
  name: "Line break",
  renderer: "candlestick",
  inputs: [LINES_INPUT],
  create(options) {
    validateOptions(options)
    return new AdjacentTransformRun(
      options,
      (given) => ({ lines: given.lines ?? 3 }),
      (resolved) => new LineBreakAdjacentTransform({ lines: resolved.lines })
    )
  },
}

let registered = false

/**
 * Register over the package's own Line Break entry. Importing this module
 * after `openalgo-charts/transform` is all the wiring the transform spec
 * needs: the spec still says `line-break`, and `lines` means the same thing.
 */
export function registerAdjacentLineBreakTransform() {
  if (registered) return
  registered = true
  registerSeriesTransform("line-break", adjacentLineBreak)
}

registerAdjacentLineBreakTransform()
