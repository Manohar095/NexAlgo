import { type Bar, createChart, createLinkGroup, type Chart } from 'openalgo-charts'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkedChart } from './terminal'

/**
 * Linked-grid viewport sync: position follows, candle size does not.
 *
 * The engine's group applies a leader's window verbatim in the follower's
 * index space, which pins the follower's bar spacing to the leader's — the
 * reason candles on a side-by-side grid all resized when one was zoomed.
 * `LinkedChart` intercepts that application: the follower keeps its own span
 * (its zoom level) and only follows the window's right edge.
 */
const IST = 19_800

function sessions(count: number): Bar[] {
  const out: Bar[] = []
  let price = 812
  const open = Date.UTC(2026, 0, 2, 9, 15) / 1000 - IST
  for (let i = 0; i < count; i++) {
    price += Math.sin(i * 0.37) * 0.6
    out.push({ time: open + i * 60, open: price, high: price + 1, low: price - 1, close: price })
  }
  return out
}

const charts: Chart[] = []

beforeEach(() => {
  // The engine paints every pane on a canvas, which jsdom cannot hand a 2D
  // context for. The stub only has to keep pane construction alive; the
  // viewport assertions below read bar indexes, not pixels.
  const context = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 7 }),
      createLinearGradient: () => ({ addColorStop() {} }),
      getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
    },
    { get: (target, key) => target[key as keyof typeof target] ?? (() => {}) }
  )
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    context as unknown as CanvasRenderingContext2D
  )
})

function chartWith(bars: Bar[]): Chart {
  const chart = createChart(document.createElement('div'), {
    shortcuts: false,
    timeNavigator: false,
    raf: {
      schedule: (cb) => {
        cb()
        return 1
      },
      cancel() {},
    },
    drawCanvas: document.createElement('canvas'),
  })
  chart.applySize(900, 500)
  chart.addSeries('candlestick').setData(bars)
  charts.push(chart)
  return chart
}

const span = (chart: Chart) => chart.getVisibleLogicalRange()!.to - chart.getVisibleLogicalRange()!.from

describe('linked grid keeps each pane its own candle size', () => {
  it('a leader zoom moves the follower to the same right edge without changing its span', () => {
    const bars = sessions(600)
    const leader = chartWith(bars)
    const follower = chartWith(bars)
    const group = createLinkGroup()
    group.add(new LinkedChart(leader))
    group.add(new LinkedChart(follower))

    const spanBefore = span(follower)
    const toBefore = follower.getVisibleLogicalRange()!.to

    // The leader zooms deep on its own pane.
    leader.setVisibleLogicalRange({ from: 500, to: 530 })

    // The follower did not stretch: it holds the span it had, and rides
    // the leader's right edge instead.
    expect(span(follower)).toBeCloseTo(spanBefore, 0)
    expect(follower.getVisibleLogicalRange()!.to).toBeCloseTo(530, 0)
    expect(toBefore).toBeGreaterThan(400)
  })

  it('a leader pan moves the follower the same way, still spreading its own span', () => {
    const bars = sessions(600)
    const leader = chartWith(bars)
    const follower = chartWith(bars)
    const group = createLinkGroup()
    group.add(new LinkedChart(leader))
    group.add(new LinkedChart(follower))

    const spanBefore = span(follower)

    leader.setVisibleLogicalRange({ from: 400, to: 440 })

    expect(span(follower)).toBeCloseTo(spanBefore, 0)
    expect(follower.getVisibleLogicalRange()!.to).toBeCloseTo(440, 0)

    leader.setVisibleLogicalRange({ from: 300, to: 340 })

    expect(span(follower)).toBeCloseTo(spanBefore, 0)
    expect(follower.getVisibleLogicalRange()!.to).toBeCloseTo(340, 0)
  })

  it('a self-zoom on one pane leads the other pane by position only', () => {
    const bars = sessions(600)
    const leader = chartWith(bars)
    const follower = chartWith(bars)
    const group = createLinkGroup()
    group.add(new LinkedChart(leader))
    group.add(new LinkedChart(follower))

    leader.setVisibleLogicalRange({ from: 500, to: 530 })
    const leaderSpan = span(leader)
    const leaderTo = leader.getVisibleLogicalRange()!.to

    // The follower zooms its own pane out wide.
    follower.setVisibleLogicalRange({ from: 100, to: 560 })

    // The follower keeps what it asked for ...
    expect(span(follower) - (560 - 100)).toBeLessThan(1e-6)
    // ... and the pane it left behind moves to the new right edge without
    // adopting the follower's magnification: whoever gestures leads the
    // position, never magnification.
    expect(leader.getVisibleLogicalRange()!.to).toBeCloseTo(560, 0)
    expect(span(leader)).toBeCloseTo(leaderSpan, 0)
    expect(leaderTo).toBeGreaterThan(400)
  })
})
