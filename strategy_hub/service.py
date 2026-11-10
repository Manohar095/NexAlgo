# -*- coding: utf-8 -*-
"""
strategy_hub/service.py — validation + CRUD for symbols and their per-symbol settings.

Port of strategy_hub_package/strategy_hub/service.py. The differences are only in
substrate: SQLAlchemy → stdlib sqlite3 (db.py), OpenAlgo's symbol master → the
running broker session's scrip search for lot size / tick / token.
"""

import logging
import re
import time
from datetime import datetime

from strategy_hub import db as hub_db

logger = logging.getLogger(__name__)

EXCHANGES = ("NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "BCD", "NCO")
PRODUCTS = ("MIS", "NRML", "CNC")
TRADE_MODES = ("LONG_ONLY", "SHORT_ONLY", "LONG_SHORT")
COMMANDS = ("SQUAREOFF",)
STATUS_STALE_SEC = 15
_HHMM = re.compile(r"([01]\d|2[0-3]):[0-5]\d")

# Default squareoff (IST) by exchange. Must stay earlier than the strategy's schedule stop.
SQUAREOFF_DEFAULTS = {"NSE": "15:15", "BSE": "15:15", "NFO": "15:15", "BFO": "15:15",
                      "CDS": "16:55", "BCD": "16:55", "MCX": "23:25", "NCO": "23:25"}

INT_FIELDS = ("quantity", "g2r", "r2g", "buy_brick_no", "sell_brick_no", "limit_buy_brick_no",
              "limit_sell_brick_no", "max_position_per_side", "atr_period")
# entry/sl trail bricks stay floats: the NexAlgo engine trails on fractional brick
# counts (models/symbol_config.py keeps sl_trail_brick_number as a float too).
FLOAT_FIELDS = ("brick_size", "tick_size", "limit_offset", "sl_lmt_buffer",
                "entry_trail_bricks", "sl_trail_bricks", "atr_multiplier", "ltp_percent")
CONFIG_FIELDS = INT_FIELDS + FLOAT_FIELDS + ("product", "trade_mode", "squareoff_time", "brick_method")

# Brick-size method (OpenAlgo parity): fixed | atr | ltp_pct
BRICK_METHODS = ("fixed", "atr", "ltp_pct")


def managed_id(exchange):
    """The managed strategy that runs every symbol of this exchange."""
    return f"renko_{str(exchange).upper()}"


def default_config(exchange="NFO"):
    return {
        "product": "MIS", "quantity": 1, "brick_size": 1.0, "g2r": 2, "r2g": 2,
        "buy_brick_no": 1, "sell_brick_no": -1, "limit_buy_brick_no": 1, "limit_sell_brick_no": 1,
        "entry_trail_bricks": 2, "sl_trail_bricks": 2,
        "brick_method": "fixed", "atr_period": 14, "atr_multiplier": 1.0, "ltp_percent": 0.25,
        "tick_size": 0.05, "limit_offset": 0.05, "sl_lmt_buffer": 0.05,
        "trade_mode": "LONG_ONLY", "max_position_per_side": 0,
        "squareoff_time": SQUAREOFF_DEFAULTS.get((exchange or "").upper(), "15:15"),
    }


# ---------------------------------------------------------------- symbol search
def _broker_search(query, exchange):
    """Scrip-master search through the shared broker session (same substrate the
    settings dialog's POST /api/search-symbols uses). Raises on transport errors."""
    from services.instance_manager import instance_manager

    res = instance_manager.broker.search_symbols(exchange=exchange, search_text=query)
    if isinstance(res, dict):
        values = res.get("values")
        if values is None:
            for value in res.values():
                if isinstance(value, list):
                    values = value
                    break
    elif isinstance(res, list):
        values = res
    else:
        values = None
    return [v for v in (values or []) if isinstance(v, dict)]


def search_symbols(query, exchange=None, limit=25):
    """Rows in the symbol_search shape {symbol, exchange, name, expiry, lotsize,
    tick_size, instrumenttype, strike} the panel expects."""
    if exchange and exchange not in EXCHANGES:
        exchange = None
    values = _broker_search(query, exchange)
    out = []
    for v in values:
        sym = str(v.get("tsym") or "").strip()
        exch = str(v.get("exch") or exchange or "").strip().upper()
        if not sym:
            continue
        if exchange and exch != exchange:
            continue
        out.append({
            "symbol": sym,
            "exchange": exch or "NSE",
            "name": v.get("dname") or v.get("cname") or v.get("tsym"),
            "expiry": v.get("exd") or v.get("expiry"),
            "lotsize": _f(v.get("ls")) or None,
            "tick_size": _f(v.get("ti")) or None,
            "instrumenttype": v.get("insttype") or v.get("instrumenttype"),
            "strike": _f(v.get("strprc")) or None,
            # extras the flow needs; harmless on the wire
            "token": str(v.get("token") or ""),
        })
        if len(out) >= limit:
            break
    return out


def _f(v, default=None):
    try:
        if v in (None, ""):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def _parse_expiry(text):
    for fmt in ("%d-%b-%y", "%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(text).strip().title(), fmt).date()
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------- validation
def _num(payload, key, kind, errors, required=True):
    raw = payload.get(key)
    if raw in (None, ""):
        if required:
            errors.append(f"{key} is required")
        return None
    try:
        return int(float(raw)) if kind is int else float(raw)
    except (TypeError, ValueError):
        errors.append(f"{key} must be a number")
        return None


def validate_config(payload, schedule_stop=None):
    """Validate the per-symbol settings (no symbol/exchange). Returns (clean_dict, errors)."""
    errors, clean = [], {}
    for k in INT_FIELDS:
        clean[k] = _num(payload, k, int, errors, required=(k != "max_position_per_side"))
    for k in FLOAT_FIELDS:
        clean[k] = _num(payload, k, float, errors, required=False)
    if clean.get("max_position_per_side") is None:
        clean["max_position_per_side"] = 0
    # Optional floats fall back the same way the engine's SymbolConfig does:
    # limit_offset → tick_size, sl_lmt_buffer → 0.05, entry trail → SL trail (→ 2).
    if clean.get("limit_offset") is None:
        clean["limit_offset"] = clean.get("tick_size")
    if clean.get("sl_lmt_buffer") is None:
        clean["sl_lmt_buffer"] = 0.05
    if clean.get("sl_trail_bricks") is None:
        clean["sl_trail_bricks"] = 2
    if clean.get("entry_trail_bricks") is None:
        clean["entry_trail_bricks"] = clean.get("sl_trail_bricks")

    clean["product"] = str(payload.get("product", "")).upper()
    if clean["product"] not in PRODUCTS:
        errors.append(f"product must be one of {', '.join(PRODUCTS)}")
    clean["trade_mode"] = str(payload.get("trade_mode", "")).upper()
    if clean["trade_mode"] not in TRADE_MODES:
        errors.append(f"trade_mode must be one of {', '.join(TRADE_MODES)}")

    clean["brick_method"] = str(payload.get("brick_method", "")).lower()
    if clean["brick_method"] not in BRICK_METHODS:
        errors.append(f"brick_method must be one of {', '.join(BRICK_METHODS)}")
    if clean.get("atr_period") is not None and not 2 <= clean["atr_period"] <= 200:
        errors.append("atr_period must be between 2 and 200")
    for k in ("atr_multiplier", "ltp_percent"):
        if clean.get(k) is not None and clean[k] <= 0:
            errors.append(f"{k} must be > 0")

    sq = str(payload.get("squareoff_time", "")).strip()
    if not _HHMM.fullmatch(sq):
        errors.append("squareoff_time must be HH:MM (24h, IST)")
    clean["squareoff_time"] = sq

    def pos(key, minimum=1):
        if clean.get(key) is not None and clean[key] < minimum:
            errors.append(f"{key} must be >= {minimum}")

    for k in ("quantity", "g2r", "r2g", "entry_trail_bricks", "sl_trail_bricks",
              "limit_buy_brick_no", "limit_sell_brick_no"):
        pos(k)
    for k in ("brick_size", "tick_size"):
        if clean.get(k) is not None and clean[k] <= 0:
            errors.append(f"{k} must be > 0")
    for k in ("limit_offset", "sl_lmt_buffer"):
        if clean.get(k) is not None and clean[k] < 0:
            errors.append(f"{k} must be >= 0")
    if clean.get("buy_brick_no") is not None and clean["buy_brick_no"] < 0:
        errors.append("buy_brick_no must be >= 0 (Green brick number)")
    if clean.get("sell_brick_no") is not None and clean["sell_brick_no"] > 0:
        errors.append("sell_brick_no must be <= 0 (Red brick number)")
    if clean.get("max_position_per_side") is not None and clean["max_position_per_side"] < 0:
        errors.append("max_position_per_side must be >= 0 (0 = quantity)")
    if clean.get("brick_size") and clean.get("tick_size") and clean["brick_size"] < clean["tick_size"]:
        errors.append("brick_size must be >= tick_size")

    if _HHMM.fullmatch(sq) and schedule_stop and sq >= schedule_stop:
        errors.append(
            f"squareoff_time {sq} must be earlier than the schedule stop {schedule_stop} of this exchange's "
            "strategy: the process stops at the stop time, before any squareoff could run"
        )
    return clean, errors


def validate_instrument(symbol, exchange, cfg):
    """Check the contract against the scrip master. Returns ({lot, token}, errors)."""
    symbol = str(symbol).strip()
    try:
        rows = _broker_search(symbol, exchange)
    except Exception as e:
        logger.warning("scrip search failed for %s:%s → %s", exchange, symbol, e)
        rows = None
    info = None
    for v in rows or []:
        if str(v.get("tsym") or "") == symbol and str(v.get("exch") or "").upper() == exchange:
            info = v
            break
    if info is None:
        return {}, [f"{exchange}:{symbol} not found in the scrip master (check the trading symbol)"]

    errors = []
    lot_raw = info.get("ls")
    try:
        lot = int(float(lot_raw)) if lot_raw not in (None, "") else None
    except (TypeError, ValueError):
        lot = None
    if lot and cfg.get("quantity") and cfg["quantity"] % lot != 0:
        errors.append(f"quantity {cfg['quantity']} must be a multiple of lot size {lot}")

    tick = _f(info.get("ti"))
    if tick and cfg.get("tick_size") and abs(cfg["tick_size"] - tick) > 1e-9:
        errors.append(f"tick_size {cfg['tick_size']} differs from the exchange tick size {tick}")

    exp = info.get("exd") or info.get("expiry")
    exp_date = _parse_expiry(exp) if exp else None
    if exp_date and exp_date < datetime.now().date():
        errors.append(f"contract expired on {exp}")

    token = str(info.get("token") or "")
    return {"lot": lot, "token": token}, errors


# ---------------------------------------------------------------- CRUD
_COLUMNS = (
    "id", "strategy_id", "symbol", "exchange", "enabled", "version", "tag_base", "strategy_name",
    "token", "product", "quantity", "lot_size", "brick_size", "brick_method", "atr_period",
    "atr_multiplier", "ltp_percent", "g2r", "r2g", "buy_brick_no",
    "sell_brick_no", "limit_buy_brick_no", "limit_sell_brick_no", "entry_trail_bricks",
    "sl_trail_bricks", "tick_size", "limit_offset", "sl_lmt_buffer", "trade_mode",
    "max_position_per_side", "squareoff_time", "created_at", "updated_at",
)


def _to_dict(row):
    d = dict(row)
    d["enabled"] = bool(d.get("enabled"))
    return d


def list_with_status():
    now = time.time()
    rows = hub_db.fetchall("SELECT * FROM strategy_symbol ORDER BY exchange, id")
    status = {}
    if rows:
        ids = [r["id"] for r in rows]
        marks = ",".join("?" * len(ids))
        status = {x["symbol_id"]: x for x in hub_db.fetchall(
            f"SELECT * FROM symbol_status WHERE symbol_id IN ({marks})", ids)}
    out = []
    for r in rows:
        d = _to_dict(r)
        st = status.get(r["id"])
        d["status"] = (dict(st) if st else None)
        d["stale"] = bool(d["enabled"] and (st is None or now - (st.get("updated_at") or 0) > STATUS_STALE_SEC))
        out.append(d)
    return out


def get_symbol(row_id):
    return hub_db.fetchone("SELECT * FROM strategy_symbol WHERE id=?", (row_id,))


def create_symbol(symbol, exchange, cfg, instrument, strategy_name=None):
    instrument = instrument or {}
    with_ok = hub_db.fetchone("SELECT id FROM strategy_symbol WHERE symbol=? AND exchange=?",
                              (symbol, exchange))
    if with_ok:
        return None, "This symbol is already added"
    tag_tmp = f"tmp_{time.time_ns()}"
    row_id = hub_db.write(
        "INSERT INTO strategy_symbol (strategy_id, symbol, exchange, enabled, version, tag_base, "
        "strategy_name, token, product, quantity, lot_size, brick_size, brick_method, atr_period, "
        "atr_multiplier, ltp_percent, g2r, r2g, buy_brick_no, "
        "sell_brick_no, limit_buy_brick_no, limit_sell_brick_no, entry_trail_bricks, sl_trail_bricks, "
        "tick_size, limit_offset, sl_lmt_buffer, trade_mode, max_position_per_side, squareoff_time, "
        "created_at, updated_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (managed_id(exchange), symbol, exchange, 0, 1, tag_tmp,
         strategy_name or symbol, instrument.get("token") or "", cfg["product"], cfg["quantity"],
         instrument.get("lot"), cfg["brick_size"], cfg["brick_method"], cfg["atr_period"],
         cfg["atr_multiplier"], cfg["ltp_percent"], cfg["g2r"], cfg["r2g"], cfg["buy_brick_no"],
         cfg["sell_brick_no"], cfg["limit_buy_brick_no"], cfg["limit_sell_brick_no"],
         cfg["entry_trail_bricks"], cfg["sl_trail_bricks"], cfg["tick_size"], cfg["limit_offset"],
         cfg["sl_lmt_buffer"], cfg["trade_mode"], cfg["max_position_per_side"], cfg["squareoff_time"],
         time.time(), time.time()),
    )
    # tag_base is stable per row: the strategy tags every order renko_<rowid>_EB/_ES/_SLL/_SLS/_SQ
    hub_db.write("UPDATE strategy_symbol SET tag_base=? WHERE id=?", (f"renko_{row_id}", row_id))
    return _to_dict(get_symbol(row_id)), None


def update_symbol(row_id, cfg, instrument):
    instrument = instrument or {}
    r = get_symbol(row_id)
    if not r:
        return None, "Symbol not found", 404
    if r["enabled"]:
        return None, "Disable the symbol before editing its settings", 409
    sets, params = [], []
    for k in CONFIG_FIELDS:
        sets.append(f"{k}=?")
        params.append(cfg[k])
    sets.append("lot_size=?"); params.append(instrument.get("lot"))
    if instrument.get("token"):
        sets.append("token=?"); params.append(instrument["token"])
    sets.append("version=?"); params.append((r["version"] or 1) + 1)
    sets.append("updated_at=?"); params.append(time.time())
    params.append(row_id)
    hub_db.write(f"UPDATE strategy_symbol SET {', '.join(sets)} WHERE id=?", params)
    return _to_dict(get_symbol(row_id)), None, 200


def delete_symbol(row_id):
    r = get_symbol(row_id)
    if not r:
        return "Symbol not found", 404
    if r["enabled"]:
        return "Disable the symbol before deleting it", 409
    hub_db.write_many([
        ("DELETE FROM symbol_status WHERE symbol_id=?", (row_id,)),
        ("DELETE FROM symbol_command WHERE symbol_id=?", (row_id,)),
        ("DELETE FROM strategy_symbol WHERE id=?", (row_id,)),
    ])
    return None, 200


def set_enabled(row_id, enabled):
    r = get_symbol(row_id)
    if not r:
        return None, "Symbol not found", 404
    statements = [("UPDATE strategy_symbol SET enabled=?, updated_at=? WHERE id=?",
                   (1 if enabled else 0, time.time(), row_id))]
    if enabled:
        # drop stale status from the last run
        statements.append(("DELETE FROM symbol_status WHERE symbol_id=?", (row_id,)))
    hub_db.write_many(statements)
    return _to_dict(get_symbol(row_id)), None, 200


def queue_command(row_id, command):
    if command not in COMMANDS:
        return "Unknown command", 400
    r = get_symbol(row_id)
    if not r:
        return "Symbol not found", 404
    if not r["enabled"]:
        return "Symbol is not enabled/running", 409
    hub_db.write("INSERT INTO symbol_command (symbol_id, command, created_at) VALUES (?,?,?)",
                 (row_id, command, time.time()))
    return None, 200


def exchange_counts():
    """{exchange: (total, enabled)} for exchanges that have at least one symbol."""
    out = {}
    for r in hub_db.fetchall("SELECT exchange, enabled FROM strategy_symbol"):
        total, en = out.get(r["exchange"], (0, 0))
        out[r["exchange"]] = (total + 1, en + (1 if r["enabled"] else 0))
    return out
