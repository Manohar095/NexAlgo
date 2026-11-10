/**
 * The terminal's own Renko transform: the two-box staircase this chart always
 * drew, registered over the package's entry.
 *
 * `openalgo-charts`'s built-in Renko has no reversal notion at all: it steps
 * one box in whatever direction a price crossing takes it, so the first brick
 * of every direction change re-covers the previous brick's band — red drawn
 * across the last green's row, green across the last red's. This chart's Renko
 * keeps its own classic construction instead: a reversal only starts after
 * two boxes against the trend, and its bricks then step from the INNER edge
 * (one box inside the old band), so red forms below green, green above red,
 * and every direction run advances without drawing over the brick before it.
 *
 * Everything else follows the package's own build: the same settings inputs
 * (Fixed / Percent of price / ATR / Percent of ATR, close vs high+low prices),
 * the same size resolution (a box kept at 0 is taken from the history the run
 * is loaded with, a percent left unset defaults to 1), and per-brick sizes
 * re-read from the band each step lands in.
 *
 * The run wrapping the transform follows the package's own `SeriesTransformRun`
 * contract — committed elements from completed bars, and the newest source bar,
 * the forming one, pushed through a `clone` whose provisional elements a tick
 * replaces. Every element keeps one time slot (collisions bumped forward a
 * second), so the bricks tile adjacent columns instead of stacking themselves
 * on the real bucket times.
 *
 * Ported verbatim (types stripped) from OpenAlgoNew
 * frontend/src/lib/trading/renkoAdjacent.ts — the only change is the import
 * path, pointed at the vendored openalgo-charts copy.
 */

import { registerSeriesTransform } from "./openalgo-charts.mjs";

/* ── options plumbing, shaped the way the engine's transform tier does it ── */

/** The package's own Renko inputs, verbatim — the settings dialog renders these. */
const RENKO_INPUTS = [
  {
    key: "mode",
    type: "select",
    label: "Box size from",
    default: "fixed",
    options: [
      { label: "Fixed size", value: "fixed" },
      { label: "Percent of price", value: "percent" },
      { label: "ATR", value: "atr" },
      { label: "Percent of ATR", value: "atrPercent" },
    ],
  },
  {
    key: "boxSize",
    type: "number",
    label: "Box size (0 = from history)",
    default: 0,
    min: 0,
    visibleWhen: { key: "mode", is: "fixed" },
  },
  {
    key: "percent",
    type: "number",
    label: "Box percent",
    default: 1,
    min: 0,
    visibleWhen: { key: "mode", is: ["percent", "atrPercent"] },
  },
  {
    key: "atrPeriod",
    type: "number",
    label: "ATR length",
    default: 14,
    min: 1,
    step: 1,
    visibleWhen: { key: "mode", is: ["atr", "atrPercent"] },
  },
  {
    key: "atrMultiplier",
    type: "number",
    label: "ATR multiplier",
    default: 1,
    min: 0,
    visibleWhen: { key: "mode", is: "atr" },
  },
  {
    key: "method",
    type: "select",
    label: "Prices",
    default: "close",
    options: [
      { label: "Close", value: "close" },
      { label: "High and low", value: "hl" },
    ],
  },
];

/** RenkoOptions shape (was a TS interface):
 *  { mode: 'fixed'|'percent'|'atr'|'atrPercent', boxSize, percent, atrPeriod,
 *    atrMultiplier, method: 'close'|'hl' }
 */

/**
 * The spec check the engine performs before building: the same option names,
 * the same input bounds, and a `TypeError` naming the offence, so a saved
 * layout with a stale choice is refused the same way the built-ins refuse it.
 */
function validateOptions(given) {
  const fail = (why) => {
    throw new TypeError(`openalgo-charts: invalid series transform: ${why}`)
  }
  if (given === null || typeof given !== "object" || Array.isArray(given)) {
    fail("options must be an object")
  }
  for (const [key, value] of Object.entries(given)) {
    const input = RENKO_INPUTS.find((candidate) => candidate.key === key)
    if (!input) {
      fail(`Renko option "${key}" is not one it takes`)
      continue
    }
    if (
      input.type === "number"
        ? !(
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= input.min &&
            value <= ("max" in input && typeof input.max === "number" ? input.max : Number.POSITIVE_INFINITY) &&
            (!("step" in input) || input.step !== 1 || Number.isInteger(value))
          )
        : !input.options.some((option) => option.value === value)
    ) {
      fail(`Renko option "${key}" cannot be ${String(value)}`)
    }
  }
}

/** The engine's automatic size: a fortieth of the range vs a thousandth of the last close. */
function sizeFromHistory(source) {
  let high = -Infinity
  let low = Infinity
  for (const bar of source) {
    if (bar.high > high) high = bar.high
    if (bar.low < low) low = bar.low
  }
  const value = Math.max((high - low) / 40, Math.abs(source[source.length - 1]?.close ?? 0) / 1e3)
  return value > 0 && Number.isFinite(value) ? Number(value.toPrecision(2)) : 1
}

/** A positive choice stands; a 0 (or anything not positive) falls back. */
function choose(given, fallback) {
  return typeof given === "number" && given > 0 ? given : fallback()
}

/** The package's own resolution: a mode-normalized option set, ready to build. */
function resolveOptions(given, source) {
  const mode = given.mode ?? "fixed"
  return {
    mode,
    boxSize: choose(given.boxSize, () => sizeFromHistory(source)),
    percent: choose(given.percent, () => 1),
    atrPeriod: choose(given.atrPeriod, () => 14),
    atrMultiplier: choose(given.atrMultiplier, () => 1),
    method: given.method ?? "close",
  }
}

/** RenkoAdjacentOptions (was a TS interface):
 *  { mode?, boxSize, percent?, atrPeriod?, atrMultiplier?, method?,
 *    reversal? } — reversal defaults to 2 (the standard two-box reversal).
 */

/** Wilder's ATR, as the engine keeps it: simple average over the first period, then smoothed. */
class AverageTrueRange {
  constructor(period) {
    this.period = Math.max(1, Math.floor(period))
    this.prevClose = NaN
    this.sum = 0
    this.n = 0
    this.atr = NaN
  }

  reset() {
    this.prevClose = NaN
    this.sum = 0
    this.n = 0
    this.atr = NaN
  }

  push(bar) {
    const range = Number.isNaN(this.prevClose)
      ? bar.high - bar.low
      : Math.max(bar.high - bar.low, Math.abs(bar.high - this.prevClose), Math.abs(bar.low - this.prevClose))
    this.prevClose = bar.close
    if (this.n < this.period) {
      this.sum += range
      this.n += 1
      this.atr = this.sum / this.n
    } else {
      this.atr = (this.atr * (this.period - 1) + range) / this.period
    }
  }

  clone() {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this)
  }

  value() {
    return this.atr
  }
}

export class RenkoAdjacentTransform {
  constructor(options) {
    this.mode = options.mode ?? "fixed"
    this.fixedSize = options.boxSize
    this.percent = options.percent ?? 1
    this.atrMultiplier = options.atrMultiplier ?? 1
    this.method = options.method ?? "close"
    this.reversalBoxes = options.reversal ?? 2
    this.atr = new AverageTrueRange(options.atrPeriod ?? 14)
    this.box = NaN
    this.edge = NaN
    this.direction = 0
    this.lastPrice = NaN
    this.lastTime = 0
    if (this.mode === "fixed" && !(this.fixedSize > 0)) {
      throw new Error("openalgo-charts: Renko boxSize must be > 0")
    }
    if ((this.mode === "percent" || this.mode === "atrPercent") && !(this.percent > 0)) {
      throw new Error("openalgo-charts: Renko percent must be > 0")
    }
  }

  reset() {
    this.box = NaN
    this.edge = NaN
    this.direction = 0
    this.lastPrice = NaN
    this.lastTime = 0
    this.atr.reset()
  }

  clone() {
    return Object.assign(Object.create(Object.getPrototypeOf(this)), this, {
      atr: this.atr.clone(),
    })
  }

  /** The package's own sizing: mode-dependent, re-read for every band. */
  resolve(price) {
    const size =
      this.mode === "fixed"
        ? this.fixedSize
        : this.mode === "percent"
          ? Math.abs(price) * this.percent / 100
          : this.mode === "atrPercent"
            ? this.atr.value() * this.percent / 100
            : this.atr.value() * this.atrMultiplier
    if (size > 0 && Number.isFinite(size)) return size
    if (this.box > 0) return this.box
    const tenthOfPrice = 0.01 * Math.abs(price)
    return tenthOfPrice > 0 ? tenthOfPrice : 1
  }

  push(bar) {
    const bricks = []
    if (this.mode === "atr" || this.mode === "atrPercent") this.atr.push(bar)

    // Initialize on first bar, the way the package seeds its grid.
    if (Number.isNaN(this.edge)) {
      this.box = this.resolve(bar.close)
      this.edge = Math.floor(bar.close / this.box) * this.box
      this.direction = 0
      this.lastPrice = bar.close
      this.lastTime = bar.time
      return bricks
    }

    // Skip duplicate close (same timestamp and same close)
    if (bar.time === this.lastTime && bar.close === this.lastPrice) {
      return bricks
    }

    // With the high+low method one bar can carry both a dip and a climb, so
    // every price point walks the state machine on the edge it left behind.
    for (const point of this.crossingPrices(bar)) {
      this.formFrom(bar, point, bricks)
    }

    this.lastPrice = bar.close
    this.lastTime = bar.time
    return bricks
  }

  /** The prices one bar is crossed with: its close, or its low and high. */
  crossingPrices(bar) {
    if (this.method === "close") return [bar.close]
    return bar.close >= bar.open ? [bar.low, bar.high] : [bar.high, bar.low]
  }

  /** One price point against the live edge, in the trend it is in. */
  formFrom(bar, price, bricks) {
    const { direction, edge, box } = this

    if (direction === 0) {
      // Initial state - determine first direction
      const firstSize = this.resolve(edge)
      const diff = price - edge
      if (diff >= firstSize) {
        this.direction = 1
        this.formUpBricks(price, bar, bricks)
      } else if (diff <= -firstSize) {
        this.direction = -1
        this.formDownBricks(price, bar, bricks)
      }
      // If |diff| < box, no brick forms yet
    } else if (direction > 0) {
      if (price >= edge + box) {
        // Continuation: price moved up by at least 1 box
        this.formUpBricks(price, bar, bricks)
      } else if (price <= edge - this.reversalBoxes * this.resolve(edge)) {
        // Reversal: price dropped two boxes from the outer edge. Reversal
        // bricks start from the INNER edge (one box inside), so red forms
        // below green instead of covering it.
        this.direction = -1
        this.reversalDown(price, bar, bricks)
      }
      // Price within current brick range - no brick forms
    } else {
      if (price <= edge - box) {
        // Continuation: price moved down by at least 1 box
        this.formDownBricks(price, bar, bricks)
      } else if (price >= edge + this.reversalBoxes * this.resolve(edge)) {
        // Reversal: green forms above red, anchored at the inner edge.
        this.direction = 1
        this.reversalUp(price, bar, bricks)
      }
      // Price within current brick range - no brick forms
    }
  }

  /**
   * Upward bricks from the current edge; every step re-resolves the band it
   * has climbed into, so a jump across several bands lands a run of bricks,
   * each sized for the band it opened in.
   */
  formUpBricks(price, bar, bricks) {
    let edge = this.edge
    while (price >= edge + this.box) {
      const close = edge + this.box
      bricks.push({
        time: bar.time,
        open: edge,
        high: close,
        low: edge,
        close,
        volume: bar.volume ?? 0,
      })
      edge = close
      this.box = this.resolve(edge)
    }
    this.edge = edge
  }

  /** Mirror of `formUpBricks` for the descent. */
  formDownBricks(price, bar, bricks) {
    let edge = this.edge
    while (price <= edge - this.box) {
      const close = edge - this.box
      bricks.push({
        time: bar.time,
        open: edge,
        high: edge,
        low: close,
        close,
        volume: bar.volume ?? 0,
      })
      edge = close
      this.box = this.resolve(edge)
    }
    this.edge = edge
  }

  /**
   * A reversal from an uptrend: the trigger is two boxes from the edge, and
   * the bricks then step from the inner edge — one box inside — re-resolving
   * each band on the way down. The same shape the fixed-size transform draws,
   * generalized to variable bands.
   */
  reversalDown(price, bar, bricks) {
    let cursor = this.edge - this.resolve(this.edge)
    for (;;) {
      const size = this.resolve(cursor)
      if (!(price <= cursor - size)) break
      const close = cursor - size
      bricks.push({
        time: bar.time,
        open: cursor,
        high: cursor,
        low: close,
        close,
        volume: bar.volume ?? 0,
      })
      cursor = close
    }
    this.edge = cursor
    this.box = this.resolve(cursor)
  }

  /** Mirror of `reversalDown` for the rise. */
  reversalUp(price, bar, bricks) {
    let cursor = this.edge + this.resolve(this.edge)
    for (;;) {
      const size = this.resolve(cursor)
      if (!(price >= cursor + size)) break
      const close = cursor + size
      bricks.push({
        time: bar.time,
        open: cursor,
        high: close,
        low: cursor,
        close,
        volume: bar.volume ?? 0,
      })
      cursor = close
    }
    this.edge = cursor
    this.box = this.resolve(cursor)
  }

  flush() {
    // Renko doesn't have partial bricks to flush
    return []
  }
}

/* ── the run: committed elements, provisional tail — the chart's own contract ── */

/** One source bar, last write wins, kept sorted by time. */
function dedupeTimes(bars) {
  const map = new Map()
  for (const bar of bars) map.set(bar.time, bar)
  return Array.from(map.values()).sort((a, b) => a.time - b.time)
}

/** AdjacentTransformLike (was a TS interface):
 *  { push(bar) => Bar[], clone() => AdjacentTransformLike, flush?() => Bar[] }
 */

/**
 * The newest run built from one of the terminal's transforms — the chart has
 * one price series, so one run matters at a time. The terminal reads the
 * forming bar's bricks off it (`provisionalElementsOf`) rather than walking
 * the engine's series data, which holds finished elements only.
 */
let latestRun = null

/** The forming bar's elements: shaded projection bricks for the renderer. */
export function provisionalElementsOf() {
  return latestRun?.provisional() ?? []
}

/**
 * The run: committed elements, provisional tail — the chart's own contract.
 * Shared by the terminal's Renko and Line Break transforms.
 *
 * The committed elements ARE the series: the chart draws them, reads its
 * last-value tag off them, and hands them to the renderer as items. The
 * forming bar's bricks (the provisional tail) stay OUT of the series — the
 * terminal reads them through `provisionalElementsOf` and the renderer paints
 * them past the last committed column — so the axis tag anchored to the last
 * COMPLETED brick does not chase every shaded brick a running candle prints.
 */
export class AdjacentTransformRun {
  constructor(given, resolve, make) {
    this.given = given
    this.resolve = resolve
    this.make = make
    this.sourceBars = []
    this.state = null
    this.elementBars = []
    this.provisionalBars = []
    this.index = []
    this.committed = 0
    this.resolved = null
    latestRun = this
  }

  setData(bars) {
    this.sourceBars = dedupeTimes(bars)
    this.resolved = null
    this.rebuild()
  }

  prepend(bars) {
    this.sourceBars = dedupeTimes([...this.sourceBars, ...bars])
    this.rebuild()
  }

  update(bar) {
    const len = this.sourceBars.length
    const last = this.sourceBars[len - 1]
    if (last === undefined || bar.time < last.time) {
      // A correction older than the newest bar re-forms everything.
      this.sourceBars = dedupeTimes([...this.sourceBars, bar])
      this.rebuild()
      return 0
    }
    const firstChanged = this.committed
    if (bar.time > last.time) {
      // The previous tail is no longer provisional: close it and move on.
      this.commit(len - 1)
      this.sourceBars.push(bar)
    } else {
      this.sourceBars[len - 1] = bar
    }
    this.formTail()
    return firstChanged
  }

  source() {
    return this.sourceBars
  }

  elements() {
    return this.elementBars
  }

  /** The forming bar's elements, newest run only; empty until a run exists. */
  provisional() {
    return this.provisionalBars
  }

  sourceIndex() {
    return this.index
  }

  rebuild() {
    this.elementBars = []
    this.provisionalBars = []
    this.index = []
    this.committed = 0
    const len = this.sourceBars.length
    if (len === 0) {
      this.state = null
      return
    }
    if (this.resolved === null) this.resolved = this.resolve(this.given, this.sourceBars)
    this.state = this.make(this.resolved)
    for (let i = 0; i < len - 1; i++) this.commit(i)
    this.formTail()
  }

  commit(index) {
    this.elementBars.length = this.committed
    this.index.length = this.committed
    for (const element of this.state.push(this.sourceBars[index])) this.append(element, index)
    this.committed = this.elementBars.length
  }

  /**
   * The forming bar through a clone: provisional elements a live tick
   * replaces, so no state is ever committed from it. They hang OUTSIDE the
   * series — `provisional()` hands them to the terminal, whose renderer draws
   * them past the last committed column, each tagged `projection` for the
   * translucent shade. When the bar closes, `commit` re-forms the same bricks
   * inside the series and they print full colour.
   */
  formTail() {
    this.elementBars.length = this.committed
    this.index.length = this.committed
    this.provisionalBars = []
    const len = this.sourceBars.length
    if (len === 0 || this.state === null) return
    const tail = this.state.clone()
    for (const element of tail.push(this.sourceBars[len - 1])) this.append(element, len - 1, true)
    for (const element of tail.flush?.() ?? []) this.append(element, len - 1, true)
  }

  /**
   * Element times strictly increase (collisions bumped +1s): one slot each.
   * A provisional element lands in `provisionalBars`, its time stamped past
   * the last committed element's (and the provisional ones before it), so the
   * terminal knows which columns the forming bricks occupy.
   */
  append(element, index, provisional = false) {
    if (provisional) {
      const lastTime =
        this.provisionalBars[this.provisionalBars.length - 1]?.time ??
        this.elementBars[this.elementBars.length - 1]?.time ??
        -Infinity
      const stamped =
        element.time > lastTime
          ? { ...element, projection: true }
          : { ...element, time: lastTime + 1, projection: true }
      this.provisionalBars.push(stamped)
      this.index.push(index)
      return
    }
    const lastTime = this.elementBars[this.elementBars.length - 1]?.time ?? -Infinity
    if (element.time > lastTime) {
      this.elementBars.push(element)
    } else {
      this.elementBars.push({ ...element, time: lastTime + 1 })
    }
    this.index.push(index)
  }
}

/* ── registration over the package's own entry ── */

const adjacentRenko = {
  name: "Renko",
  renderer: "candlestick",
  inputs: RENKO_INPUTS,
  create(options) {
    validateOptions(options)
    return new AdjacentTransformRun(options, resolveOptions, (resolved) => new RenkoAdjacentTransform(resolved))
  },
}

let registered = false

/**
 * Register over the package's own Renko entry. Importing this module after
 * `openalgo-charts/transform` is all the wiring the transform spec needs: the
 * spec still says `renko`, the options and their meaning are unchanged.
 */
export function registerAdjacentRenkoTransform() {
  if (registered) return
  registered = true
  registerSeriesTransform("renko", adjacentRenko)
}

registerAdjacentRenkoTransform()
