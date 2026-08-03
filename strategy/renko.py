# -*- coding: utf-8 -*-
"""
strategy/renko.py
==================
Renko brick engine. Logic is UNCHANGED from the original single-symbol
bot — it was already a self-contained class with no globals, so it
plugs straight into the multi-symbol platform: one instance per symbol.
"""


class LiveRenko:
    __slots__ = ("brick_size", "g2r", "r2g", "last_close", "trend", "brick_no")

    def __init__(self, brick_size, g2r=2, r2g=2):
        self.brick_size = brick_size
        self.g2r        = g2r
        self.r2g        = r2g
        self.last_close = None
        self.trend      = None
        self.brick_no   = 0

    def _price_to_level(self, price):
        return round(round(price / self.brick_size) * self.brick_size, 10)

    def process_price(self, price):
        bricks = []

        if self.last_close is None:
            self.last_close = self._price_to_level(price)
            self.trend      = "Green"
            self.brick_no   = -1
            return bricks

        while True:
            if self.trend == "Green":
                if price >= self.last_close + self.brick_size:
                    self.last_close = round(self.last_close + self.brick_size, 10)
                    self.brick_no  += 1
                    bricks.append({
                        "color":       "Green",
                        "brick_no":    self.brick_no,
                        "brick_price": round(self.last_close, 2)
                    })
                elif price <= self.last_close - (self.g2r * self.brick_size):
                    self.last_close = round(self.last_close - self.brick_size, 10)
                    self.trend      = "Red"
                    self.brick_no   = 0
                    bricks.append({
                        "color":       "Red",
                        "brick_no":    self.brick_no,
                        "brick_price": round(self.last_close, 2)
                    })
                    break
                else:
                    break
            else:
                if price <= self.last_close - self.brick_size:
                    self.last_close = round(self.last_close - self.brick_size, 10)
                    self.brick_no  -= 1
                    bricks.append({
                        "color":       "Red",
                        "brick_no":    self.brick_no,
                        "brick_price": round(self.last_close, 2)
                    })
                elif price >= self.last_close + (self.r2g * self.brick_size):
                    self.last_close = round(self.last_close + self.brick_size, 10)
                    self.trend      = "Green"
                    self.brick_no   = 0
                    bricks.append({
                        "color":       "Green",
                        "brick_no":    self.brick_no,
                        "brick_price": round(self.last_close, 2)
                    })
                    break
                else:
                    break

        return bricks
