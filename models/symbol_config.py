# -*- coding: utf-8 -*-
"""
models/symbol_config.py
========================
Every field that used to be a global constant in the single-symbol bot
(SYMBOL, TOKEN, BRICK_SIZE, TRADE_MODE, SL_BRICK_MULTIPLIER, ...) now
lives here, as one independent config object per symbol instance.

Updated fields (to match strategy/trading_engine.py):
  - sl_brick_multiplier   → sl_trail_brick_number
  - sl_limit_offset       → limit_offset (now shared with entry trailing)
  - entry_trail_brick_number (new) — gap for the pending-entry trail,
    falls back to sl_trail_brick_number when omitted
"""

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator


class TradeMode(str, Enum):
    LONG_ONLY = "LONG_ONLY"
    SHORT_ONLY = "SHORT_ONLY"
    LONG_SHORT = "LONG_SHORT"


class ProductType(str, Enum):
    INTRADAY = "I"
    CNC = "C"
    MARGIN = "M"


class SymbolConfig(BaseModel):
    # ---- General ----
    strategy_name: str = Field(..., description="Friendly display name, e.g. 'SENSEX CE'")
    exchange: str = Field(..., description="e.g. BFO, NFO, NSE")
    trading_symbol: str = Field(..., description="Broker tradingsymbol, e.g. SENSEX2670276500PE")
    token: str = Field(..., description="Broker instrument token")
    quantity: int = Field(..., gt=0)
    product_type: ProductType = ProductType.INTRADAY

    # ---- Renko settings ----
    brick_size: float = Field(..., gt=0)
    green_to_red_rev: int = Field(2, ge=1)
    red_to_green_rev: int = Field(2, ge=1)

    # ---- Entry settings ----
    buy_brick_no: int = 1
    sell_brick_no: int = -1
    limit_price_buy_brick_no: int = 3
    limit_price_sell_brick_no: int = 3
    tick_size: float = 0.05

    # ---- Stop-loss & Entry Trailing settings ----
    # sl_trail_brick_number: SL distance from price while a position is open
    # (SL = price ± sl_trail_brick_number * brick_size). Renamed from
    # sl_brick_multiplier — same meaning, used the same way in
    # trading_engine.py's _periodic_state_check / order_handler / feed_handler.
    sl_trail_brick_number: float = 2

    # entry_trail_brick_number: gap used to trail a resting PENDING ENTRY
    # order as price retraces away from it, instead of cancelling it
    # (LONG_ONLY/SHORT_ONLY/LONG_SHORT all trail the same way; only
    # LONG_SHORT additionally cancels-and-reverses on a full one-brick
    # retracement past the origin). Optional[...] = None + validate_default
    # so that omitting the field falls back to sl_trail_brick_number,
    # matching how sl_limit_offset already fell back to tick_size below.
    entry_trail_brick_number: Optional[float] = Field(
        None,
        validate_default=True,
        description="Entry trail distance = entry_trail_brick_number * brick_size. Defaults to sl_trail_brick_number if omitted."
    )

    # limit_offset: shared SL-LMT limit offset for BOTH the stop-loss order
    # and the trailing pending-entry order (previously sl_limit_offset,
    # used only by the SL). Kept validate_default=True — without it,
    # omitting the field entirely would skip this validator and the field
    # would silently stay None all the way into
    # `self.cfg.limit_offset or self.cfg.tick_size` in trading_engine.py.
    # That `or` masks the miss for a None default, but the same gap would
    # have meant "omit the field" and "explicit None" behaved differently
    # from what the description promises, so this is fixed the same way
    # entry_trail_brick_number is.
    limit_offset: Optional[float] = Field(
        None,
        validate_default=True,
        description="Shared offset for SL and entry SL-LMT orders; defaults to tick_size if omitted."
    )

    # ---- Trading settings ----
    trade_mode: TradeMode = TradeMode.LONG_ONLY

    # ---- Auto square-off ----
    squareoff_hour: int = Field(15, ge=0, le=23)
    squareoff_minute: int = Field(15, ge=0, le=59)
    sl_lmt_buffer: float = 0.10

    # ---- Lifecycle ----
    autostart: bool = Field(False, description="Start automatically when the platform launches")

    @field_validator("limit_offset")
    @classmethod
    def default_limit_offset(cls, v, info):
        if v is None:
            return info.data.get("tick_size", 0.05)
        return v

    @field_validator("entry_trail_brick_number")
    @classmethod
    def default_entry_trail(cls, v, info):
        if v is None:
            return info.data.get("sl_trail_brick_number", 2)
        return v


class SymbolRecord(BaseModel):
    """A stored row: id + config + bookkeeping."""
    id: str
    config: SymbolConfig
    created_at: str
    updated_at: str


class SymbolCreateRequest(BaseModel):
    config: SymbolConfig


class SymbolUpdateRequest(BaseModel):
    config: SymbolConfig