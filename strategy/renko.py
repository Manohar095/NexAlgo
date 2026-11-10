# -*- coding: utf-8 -*-
"""
strategy/renko.py
=================
Renko brick engine. Port of OpenAlgo strategy_hub/masters/renko_multi.py's
LiveRenko: same formation state machine (trend, reversal counts, one brick
per tick beyond the edge) but the size is a METHOD, not just a number —

  fixed     constant brick_size
  atr       constant after start (Wilder ATR over 5m candles, resolved by
            the engine once before the feed is attached)
  ltp_pct   multiplicative price bands — the band containing the edge fixes
            the size (floor x percent, tick-snapped), never the moving LTP

One instance per symbol.
"""

import math

BRICK_METHODS = ("fixed", "atr", "ltp_pct")


def band_brick_size(price, percent, tick_size):
    """
    Size for the LTP-percentage method: the price axis is cut into
    multiplicative bands — each boundary sits (1 + percent) times above the
    last — and the band containing price fixes the size (floor × percent,
    snapped onto the tick). At 1%, bricks in the ₹600 band measure ≈₹6 and
    in the ₹400 band ≈₹4; the ladder is anchored to 1, never to the moving
    LTP, so a brick keeps the size of its band for good.
    """
    pct = max(float(percent) / 100.0, 1e-9)
    p = max(float(price), 1e-9)
    growth = math.log(1 + pct)
    floor = (1 + pct) ** math.floor(math.log(p) / growth)
    raw = max(floor * pct, 1e-9)
    if tick_size and tick_size > 0:
        return round(max(tick_size, round(raw / tick_size) * tick_size), 10)
    return raw


def wilder_atr(bars, period):
    """
    Wilder's Average True Range over completed candles ([high, low, close]
    rows). A short history averages what is there instead of failing.
    Returns None only when no positive-range candle exists.
    """
    p = max(int(period), 1)
    trs = []
    prev_close = None
    for high, low, close in bars:
        if not (high and low and close):
            continue
        high, low, close = float(high), float(low), float(close)
        if prev_close is None:
            trs.append(high - low)
        else:
            trs.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
        prev_close = close
    if not trs:
        return None
    span = min(p, len(trs))
    atr = sum(trs[:span]) / float(span)
    for tr in trs[span:]:
        atr = (atr * (span - 1) + float(tr)) / span
    return atr if atr > 0 else None


class LiveRenko:
    """
    Same formation state machine as the original single-symbol bot — trend,
    reversal counts, one brick per tick beyond the edge — but every threshold
    re-reads the size of the current price level. For 'fixed' and 'atr' that
    is a constant (the ATR is resolved once at engine start), so nothing
    changes; for 'ltp_pct' the size follows the multiplicative band the edge
    sits in.
    """

    __slots__ = ("mode", "brick_size", "tick_size", "ltp_percent", "g2r", "r2g",
                 "last_close", "trend", "brick_no")

    def __init__(self, brick_size, g2r=2, r2g=2, mode="fixed", tick_size=0.0, ltp_percent=0.25):
        self.mode = mode if mode in BRICK_METHODS else "fixed"
        self.brick_size = brick_size
        self.tick_size = tick_size
        self.ltp_percent = ltp_percent
        self.g2r = g2r
        self.r2g = r2g
        self.last_close = None
        self.trend = None
        self.brick_no = 0

    def _price_to_level(self, price):
        if self.mode == "ltp_pct":
            # Seed the chain at the first price's band floor so later sizes
            # read off the same ladder the first brick will use.
            pct = max(self.ltp_percent / 100.0, 1e-9)
            p = max(price, 1e-9)
            return round((1 + pct) ** math.floor(math.log(p) / math.log(1 + pct)), 10)
        return round(round(price / self.brick_size) * self.brick_size, 10)

    def _size_at(self, price):
        if self.mode == "ltp_pct":
            return band_brick_size(price, self.ltp_percent, self.tick_size)
        return self.brick_size

    def process_price(self, price):
        bricks = []

        if self.last_close is None:
            self.last_close = self._price_to_level(price)
            self.trend = "Green"
            self.brick_no = -1
            return bricks

        while True:
            size = self._size_at(self.last_close)
            if self.trend == "Green":
                if price >= self.last_close + size:
                    self.last_close = round(self.last_close + size, 10)
                    self.brick_no += 1
                    bricks.append({"color": "Green", "brick_no": self.brick_no,
                                   "brick_price": round(self.last_close, 2)})
                elif price <= self.last_close - (self.g2r * size):
                    self.last_close = round(self.last_close - size, 10)
                    self.trend = "Red"
                    self.brick_no = 0
                    bricks.append({"color": "Red", "brick_no": self.brick_no,
                                   "brick_price": round(self.last_close, 2)})
                    break
                else:
                    break
            else:
                if price <= self.last_close - size:
                    self.last_close = round(self.last_close - size, 10)
                    self.brick_no -= 1
                    bricks.append({"color": "Red", "brick_no": self.brick_no,
                                   "brick_price": round(self.last_close, 2)})
                elif price >= self.last_close + (self.r2g * size):
                    self.last_close = round(self.last_close + size, 10)
                    self.trend = "Green"
                    self.brick_no = 0
                    bricks.append({"color": "Green", "brick_no": self.brick_no,
                                   "brick_price": round(self.last_close, 2)})
                    break
                else:
                    break

        return bricks
