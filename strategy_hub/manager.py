# -*- coding: utf-8 -*-
"""
strategy_hub/manager.py — the strategy-process body, in-process.

Port of masters/renko_multi.py's SymbolManager. There it ran as the main() of an
OpenAlgo /python SUBPROCESS and hosted one RenkoStrategy instance per enabled row,
polling the config DB every 2 s, routing shared feed/order streams, and publishing
status. NexAlgo is a single-process app whose BrokerSession (login + WebSocket)
lives in-process, so the same manager is a body owned by registry.ExchangeProcess
(one thread per exchange) and each instance is the EXISTING
strategy/trading_engine.py TradingEngine — the same renko method (per-side entry
slots, brick trailing, one SL per leg, squareoff halts until disable).
"""

import logging
import threading

from strategy_hub import runtime as rt

logger = logging.getLogger(__name__)

# Wired by main.py's lifespan to the /ws broadcast (same as instance_manager's
# callbacks) so live status frames reach the panel without a refetch. Read when
# each SymbolManager is constructed.
DEFAULT_ON_LOG = None
DEFAULT_ON_STATUS = None

# hub product vocabulary → the engine's ProductType
_PRODUCT_MAP = {"MIS": "I", "NRML": "M", "CNC": "C"}


def engine_config_of(row):
    """hub row → models/symbol_config.SymbolConfig for TradingEngine."""
    from models.symbol_config import ProductType, SymbolConfig, TradeMode

    try:
        hh, mm = str(row.get("squareoff_time") or "15:15").split(":")
    except ValueError:
        hh, mm = "15", "15"
    return SymbolConfig(
        strategy_name=row.get("strategy_name") or row["symbol"],
        exchange=row["exchange"],
        trading_symbol=row["symbol"],
        token=str(row.get("token") or ""),
        quantity=int(row["quantity"] or 1),
        product_type=ProductType(_PRODUCT_MAP[row["product"]]),
        brick_size=float(row["brick_size"]),
        brick_method=str(row.get("brick_method") or "fixed"),
        atr_period=int(row.get("atr_period") or 14),
        atr_multiplier=float(row.get("atr_multiplier") or 1.0),
        ltp_percent=float(row.get("ltp_percent") or 0.25),
        green_to_red_rev=int(row["g2r"]),
        red_to_green_rev=int(row["r2g"]),
        buy_brick_no=int(row["buy_brick_no"]),
        sell_brick_no=int(row["sell_brick_no"]),
        limit_price_buy_brick_no=int(row["limit_buy_brick_no"]),
        limit_price_sell_brick_no=int(row["limit_sell_brick_no"]),
        tick_size=float(row["tick_size"]),
        sl_trail_brick_number=float(row["sl_trail_bricks"]),
        entry_trail_brick_number=float(row["entry_trail_bricks"]),
        limit_offset=float(row["limit_offset"] or row["tick_size"]),
        trade_mode=TradeMode(row["trade_mode"]),
        squareoff_hour=int(hh),
        squareoff_minute=int(mm),
        sl_lmt_buffer=float(row["sl_lmt_buffer"]),
        autostart=False,   # the hub, not the platform autostart flag, owns instance start
    )


class SymbolManager:
    """Config polling, instance lifecycle, command routing, status publishing."""

    def __init__(self, strategy_id, on_log=None, on_status=None):
        self.strategy_id = strategy_id
        self.on_log = on_log or DEFAULT_ON_LOG        # wired by main.py to the /ws broadcast
        self.on_status = on_status or DEFAULT_ON_STATUS  # wired by main.py to the /ws broadcast
        from strategy.broker import BrokerSession
        self.broker = BrokerSession.get()
        self.instances = {}    # symbol row id -> TradingEngine
        self.by_key = {}       # (exchange, symbol) -> TradingEngine
        self.versions = {}     # symbol row id -> row version at start
        self.errors = {}       # symbol row id -> message (failed to start)
        self.lock = threading.Lock()

    # ---- status mapping (engine state → symbol_status row) ----
    def _status_row(self, engine, rid):
        st = engine.get_status()
        blocked = bool(st.get("trades_blocked"))
        running = (st.get("status") == "RUNNING") and engine.status == "RUNNING"
        state = "HALTED" if (running and blocked) else ("RUNNING" if running else "STOPPED")
        pos = int(st.get("position_qty") or 0)
        brick = st.get("brick") or {}
        sl = st.get("sl_trigger_price")
        trend = brick.get("color") or st.get("trend")
        return {
            "symbol_id": rid,
            "state": state,
            "message": ("Halted: squareoff" if state == "HALTED" else None),
            "ltp": st.get("ltp"),
            "brick_color": trend if trend in ("Green", "Red") else None,
            "brick_no": brick.get("brick_no"),
            "long_qty": max(pos, 0),
            "short_qty": max(-pos, 0),
            "buy_pending": st.get("pending_buy_trigger_price"),
            "sell_pending": st.get("pending_sell_trigger_price"),
            "sl_long": sl if pos > 0 else None,
            "sl_short": sl if pos < 0 else None,
            "trades_blocked": 1 if blocked else 0,
        }

    # ---- instance lifecycle ----
    def _start_instance(self, row):
        cfg = engine_config_of(row)
        if not cfg.token:
            raise ValueError("the row has no broker token (delete and re-add the symbol)")
        key = (cfg.exchange, cfg.trading_symbol)
        with self.lock:
            if key in self.by_key:
                self.errors[row["id"]] = f"{cfg.exchange}:{cfg.symbol} already running under another row"
                return
        from strategy.trading_engine import TradingEngine
        engine = TradingEngine(
            instance_id=f"hub_{row['id']}",
            cfg=cfg,
            broker=self.broker,
            on_log=self.on_log,
            on_status=self.on_status,
        )
        with self.lock:
            self.instances[row["id"]] = engine
            self.by_key[key] = engine
            self.versions[row["id"]] = row["version"]
            self.errors.pop(row["id"], None)
        engine.start()
        logger.info("▶️ hub start %s:%s (row %s v%s)", cfg.exchange, cfg.trading_symbol,
                    row["id"], row["version"])

    def _stop_instance(self, rid):
        with self.lock:
            engine = self.instances.pop(rid, None)
            if engine is not None:
                self.by_key.pop((engine.cfg.exchange, engine.cfg.trading_symbol), None)
                self.versions.pop(rid, None)
        if engine is None:
            return
        try:
            engine.stop()
        except Exception:
            logger.exception("hub stop failed for %s", engine.id)
        try:
            row = self._status_row(engine, rid)
            row["state"], row["message"] = "STOPPED", "Stopped (broker orders untouched)"
            rt.write_status([row])
        except Exception:
            pass
        logger.info("⏹️ hub stop row %s (broker orders untouched)", rid)

    def sync_config(self):
        rows = rt.load_symbols(self.strategy_id)
        wanted = {r["id"]: r for r in rows if r["enabled"]}
        # version bump or row removed/gone-disabled → replace the instance
        for rid, engine in list(self.instances.items()):
            row = wanted.get(rid)
            if row is None or row["version"] != self.versions.get(rid):
                self._stop_instance(rid)
        for rid, row in wanted.items():
            if rid not in self.instances:
                try:
                    self._start_instance(row)
                except Exception as e:
                    logger.exception("hub start failed for row %s", rid)
                    self.errors[rid] = f"Start failed: {e}"
        for rid in list(self.errors):
            if rid not in wanted:
                self.errors.pop(rid, None)

    def handle_commands(self):
        for symbol_id, cmd in rt.pop_commands(self.strategy_id):
            engine = self.instances.get(symbol_id)
            if engine is None:
                logger.warning("command %s for row %s ignored (instance not running)", cmd, symbol_id)
                continue
            if cmd == "SQUAREOFF":
                # engine.squareoff() sleeps while it validates — keep the poll loop live
                threading.Thread(target=self._run_squareoff, args=(engine,), daemon=True).start()
            else:
                logger.warning("unknown hub command %s", cmd)

    def _run_squareoff(self, engine):
        try:
            engine.squareoff()
        except Exception:
            logger.exception("hub SQUAREOFF failed for %s", engine.id)

    def publish_status(self):
        rows = [self._status_row(engine, rid) for rid, engine in list(self.instances.items())]
        for rid, msg in self.errors.items():
            rows.append({"symbol_id": rid, "state": "ERROR", "message": msg, "trades_blocked": 1})
        rt.write_status(rows)

    def tick(self):
        for step in (self.sync_config, self.handle_commands, self.publish_status):
            try:
                step()
            except Exception:
                logger.exception("hub manager step %s failed", getattr(step, "__name__", step))

    def stop_all(self):
        for rid in list(self.instances):
            self._stop_instance(rid)
