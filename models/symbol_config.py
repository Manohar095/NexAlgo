# -*- coding: utf-8 -*-
"""
models/symbol_config.py
========================
Every field that used to be a global constant in the single-symbol bot
(SYMBOL, TOKEN, BRICK_SIZE, TRADE_MODE, SL_BRICK_MULTIPLIER, ...) now
lives here, as one independent config object per symbol instance.
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

    # ---- Stop-loss settings ----
    sl_brick_multiplier: float = 2
    sl_limit_offset: Optional[float] = None  # defaults to tick_size if omitted

    # ---- Trading settings ----
    trade_mode: TradeMode = TradeMode.LONG_ONLY

    # ---- Auto square-off ----
    squareoff_hour: int = Field(15, ge=0, le=23)
    squareoff_minute: int = Field(15, ge=0, le=59)
    sl_lmt_buffer: float = 0.10

    # ---- Lifecycle ----
    autostart: bool = Field(False, description="Start automatically when the platform launches")

    @field_validator("sl_limit_offset")
    @classmethod
    def default_sl_offset(cls, v, info):
        if v is None:
            return info.data.get("tick_size", 0.05)
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
