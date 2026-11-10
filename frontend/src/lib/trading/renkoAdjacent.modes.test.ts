import { describe, expect, it } from 'vitest'
import { getSeriesTransform } from 'openalgo-charts'
import { RenkoAdjacentTransform, registerAdjacentRenkoTransform } from './renkoAdjacent'

const feed = [
  { time: 1, open: 100, high: 100.5, low: 99.5, close: 102, volume: 10 },
  { time: 2, open: 102, high: 102.5, low: 101.5, close: 104, volume: 10 },
  { time: 3, open: 104, high: 104.5, low: 103.5, close: 106, volume: 10 },
  { time: 4, open: 106, high: 106.5, low: 105.5, close: 102, volume: 10 },
  { time: 5, open: 102, high: 102.5, low: 101.5, close: 106, volume: 10 },
]

describe('renkoAdjacent modes', () => {
  registerAdjacentRenkoTransform()

  it('keeps the fixed-mode bricks anchored at the inner edge', () => {
    const mine = new RenkoAdjacentTransform({ boxSize: 2 })
    const out = feed.flatMap((bar) => mine.push(bar as never)).map((b) => `${b.open}->${b.close}`)
    expect(out).toEqual([
      '102->104',
      '104->106',
      '104->102',
      '104->106',
    ])
  })

  it('accepts every upstream option key through the definition', () => {
    const def = getSeriesTransform('renko')
    const run = def.create({ mode: 'percent', percent: 0.5, method: 'hl' })
    expect(() => run.setData(feed as never)).not.toThrow()
    expect(run.elements().length).toBeGreaterThan(0)
    expect(() => def.create({ mode: 'bogus' })).toThrow(TypeError)
    expect(() => def.create({ atrPeriod: 2.5, mode: 'atr' })).toThrow(TypeError)
  })

  it('prices percent-mode bricks off the band they open in', () => {
    const mine = new RenkoAdjacentTransform({ mode: 'percent', percent: 0.5 })
    const elements = feed.flatMap((bar) => mine.push(bar as never))
    // Percent of price: resolved from the band's price, 102 * 0.5% = 0.51.
    const first = elements[0]
    expect(first.close - first.open).toBeCloseTo(0.51, 5)
  })

  it('sizes ATR bricks off the smoothed truerange', () => {
    const def = getSeriesTransform('renko')
    const run = def.create({ mode: 'atr', atrPeriod: 2, atrMultiplier: 1 })
    run.setData(feed as never)
    expect(run.elements().length).toBeGreaterThan(0)
    for (const el of run.elements()) expect(Math.abs(el.close - el.open)).toBeGreaterThan(0)
  })
})
