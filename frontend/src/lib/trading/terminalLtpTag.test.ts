import type { PrimitiveRenderContext } from 'openalgo-charts'
import { describe, expect, it } from 'vitest'
import { LtpTag } from './terminal'

/**
 * The live-LTP tag.
 *
 * The engine's own PriceLine puts its price into the pane's autoscale, and
 * this tag's stacked placement is a price outside the data: the scale grows to
 * cover the pill, the wider scale re-measures the same two-row gap as more
 * price, the pill reaches further, the scale grows again — a tick-driven
 * runaway that vertically zoomed a live brick chart out of existence. These
 * tests guard the two halves of the fix: the tag answers no autoscale at all,
 * and the pill's row is decided from pixels at draw time, hopping only when
 * the last-value tag's band would print through it.
 */

type Kit = {
  ctx: CanvasRenderingContext2D & { __strokeY?: number }
  rects: { y: number; h: number }[]
  texts: { text: string; y: number }[]
}

function kit(): Kit {
  const rects: { y: number; h: number }[] = []
  const texts: { text: string; y: number }[] = []
  const ctx = {
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    setLineDash() {},
    measureText: (text: string) => ({ width: text.length * 7 }),
    fillRect(_x: number, y: number, _w: number, h: number) {
      rects.push({ y: y + h / 2, h })
    },
    fillText(text: string, _x: number, y: number) {
      texts.push({ text, y })
    },
  } as unknown as Kit['ctx']
  // The dashed guide strokes at the live price's row; remember its y so a test
  // can pin the line to the true LTP regardless of where the pill rests.
  const realStroke = (ctx as Record<string, unknown>).stroke as () => void
  ;(ctx as Record<string, unknown>).stroke = () => {
    ctx.__strokeY = (ctx as unknown as { __moveY?: number }).__moveY
    realStroke()
  }
  const realMoveTo = (ctx as Record<string, unknown>).moveTo as (x: number, y: number) => void
  ;(ctx as Record<string, unknown>).moveTo = (_x: number, y: number) => {
    ;(ctx as unknown as { __moveY?: number }).__moveY = y
    realMoveTo(_x, y)
  }
  return { ctx, rects, texts }
}

/** 10 media px per price unit around 100, so a 22px row is 2.2 price units. */
function rc(): PrimitiveRenderContext {
  return {
    dpr: 1,
    plotWidth: 900,
    plotHeight: 500,
    priceScale: {
      priceToY: (price: number) => 100 + (100 - price) * 10,
    },
  } as unknown as PrimitiveRenderContext
}

describe('the drawn LTP tag', () => {
  it('answers no autoscale — the pill can never move the price scale', () => {
    const tag = new LtpTag()
    tag.report(100, 100, '#26a69a', '100.00')
    expect(tag.autoscaleInfo()).toBeNull()
  })

  it('draws the dashed guide at the true LTP even when the pill is parked', () => {
    const tag = new LtpTag()
    tag.report(100, 100, '#26a69a', '100.00')
    const { ctx, texts } = kit()
    tag.draw(ctx, rc())
    // Equal prices: top layer, a row above the anchor's band.
    expect(texts[0].text).toBe('100.00')
    expect(texts[0].y).toBe(78)
    // The guide still sits at the live price's own row, not the parked one.
    expect(ctx.__strokeY).toBe(100)
  })

  it('keeps the pill on the LTP row when the anchor is comfortably away', () => {
    const tag = new LtpTag()
    tag.report(90, 100, '#ef5350', '90.00')
    const { ctx, texts } = kit()
    tag.draw(ctx, rc())
    // y(90) = 200 — 100px from the anchor, far outside the two-row band.
    expect(texts[0].y).toBe(200)
  })

  it('hops below the tag and its countdown row when the LTP sits under the anchor', () => {
    const tag = new LtpTag()
    tag.report(98.5, 100, '#ef5350', '98.50')
    const { ctx, texts } = kit()
    tag.draw(ctx, rc())
    // y(98.5) = 125 — inside the band. Bottom layer: two full rows below the
    // anchor, clear of the tag and the countdown pill beneath it.
    expect(texts[0].y).toBe(100 + 2 * 22)
  })

  it("renders the pill at the engine's tag geometry", () => {
    const tag = new LtpTag()
    tag.report(90, 100, '#ef5350', '90.00')
    const { ctx, rects } = kit()
    tag.draw(ctx, rc())
    expect(rects[0].h).toBe(18)
  })
})
