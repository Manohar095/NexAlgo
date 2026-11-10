# -*- coding: utf-8 -*-
"""
services/terminal_service.py
============================
OpenAlgoNew trading-terminal order layer for the new /trading page.

Wire model is the package's `OrderFeed` contract (openalgo-charts
/charts/trade/index.d.ts):

    place(req)               -> {orderId}          (or throws BrokerRejection
    modify(orderId, patch)   -> void                / PreflightFailure client
    cancel(orderId)          -> void                side — see below)
    closePosition(req)       -> receipt

Transport semantics implemented here, consumed by the JS feed adapter
(static/trading/trading_orders.mjs):

  - broker ANSWERED and refused  -> {"stat": "Not_Ok", "rejected": true}
    (authoritative: nothing is live, the intent settles as rejected)
  - transport / session / exception problem -> {"stat": "Not_Ok",
    "rejected": false, "error": ...} (ambiguous from the wire's view)

Order / position / execution books are normalized to the package's
data model (Order / Position / Execution rows) so the chart overlay
(order lines, position marker) does no Noren-guessing client-side.

Kill switch: `CHART_TRADING=0` in .env blocks every write endpoint while
the books keep reading live.
"""

import json
import logging
import os
import time
import threading

import pytz


IST = pytz.timezone("Asia/Kolkata")

# Write gate — reads (books) stay alive even when trading is disabled.
_TRADE_LOCK = threading.Lock()  # one write on the wire at a time


def chart_trading_enabled() -> bool:
    raw = str(os.getenv("CHART_TRADING", "1")).strip()
    return raw not in ("0", "false", "False", "no", "NO", "off")


# ============================================================
# Noren <-> package data-model mapping
# ============================================================

_SIDE_TO_NOREN = {"BUY": "B", "SELL": "S"}
_TYPE_TO_NOREN = {"MARKET": "MKT", "LIMIT": "LMT", "SL": "SL-LMT", "SL-M": "SL-M"}
_VALID_PRODUCTS = {"CNC", "NRML", "MIS"}

_STATUS_MAP = [
    ("complete", "filled"),
    ("filled", "filled"),
    ("rejected", "rejected"),
    ("cancel", "cancelled"),
    ("cancel_req", "cancelled"),
    ("open_resp", "pending"),
    ("open", "working"),
    ("pending", "pending"),
    ("sent", "pending"),
    ("posted", "pending"),
    ("modify_resp", "working"),
    ("modify", "working"),
    ("validated", "pending"),
]


def normalize_order_status(raw_status, qty, filled_qty):
    s = str(raw_status or "").strip().lower()
    for needle, out in _STATUS_MAP:
        if needle in s:
            return out
    # Fallback: any known fill revenue overrides an opaque status.
    if _num(filled_qty, 0) >= _num(qty, 0) and _num(qty, 0) > 0:
        return "filled"
    if s:
        return "working"
    return "pending"


def _num(v, default=None):
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _int(v, default=0):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return default


_ORDER_TIME_KEYS = ("ts", "si")


def _parse_noren_ts(row):
    """Noren book rows carry 'ts' as 'HH:MM:SS dd-mm-yyyy' (IST). Parse to
    UTC seconds (the unit bar times use, and ExecutionSpec requires)."""
    raw = None
    for key in _ORDER_TIME_KEYS:
        raw = row.get(key)
        if isinstance(raw, str) and raw.strip():
            break
    if not raw:
        return time.time()
    txt = str(raw).strip()
    from datetime import datetime
    # Exact shapes: "HH:MM:SS dd-mm-yyyy"; sometimes date comes first.
    for fmt in ("%H:%M:%S %d-%m-%Y", "%d-%m-%Y %H:%M:%S"):
        try:
            naive = datetime.strptime(txt, fmt)
            return IST.localize(naive).timestamp()
        except (ValueError, TypeError):
            continue
    return time.time()


def normalize_order_row(row):
    """Noren orderbook row -> the package's `Order` + wire extras."""
    qty = _num(row.get("qty"), 0)
    filled = _num(row.get("qty_filled"), None)
    if filled is None:
        filled = _num(row.get("filled_qty"), None)
    if filled is None:
        # COMPLETE rows carry the fill in avgprc; older books in 'qx'? —
        # default by status: complete = whole qty.
        filled = qty if "complete" in str(row.get("status") or "").lower() else 0
    status = normalize_order_status(row.get("status"), qty, filled)
    prctyp = str(row.get("prctyp") or "").upper()
    if prctyp.startswith("SL"):
        order_type = "SL-M" if prctyp == "SL-M" else "SL"
    elif prctyp in ("LMT", "LIMIT"):
        order_type = "LIMIT"
    elif prctyp in ("MKT", "MARKET"):
        order_type = "MARKET"
    else:
        order_type = "LIMIT"
    trantype = str(row.get("trantype") or "").upper().startswith("S") and "SELL" or "BUY"
    price = _num(row.get("prc"), 0)
    trigger = _num(row.get("trgprc"), None)
    return {
        "order_id": str(row.get("norenorderno") or ""),
        "symbol": str(row.get("tsym") or ""),
        "exchange": str(row.get("exch") or "").upper(),
        "token": str(row.get("token") or ""),
        "side": trantype,
        "type": order_type,
        "qty": int(qty),
        "filledQty": int(filled),
        "price": price or 0.0,
        "triggerPrice": trigger if trigger not in (None, 0) else None,
        "status": status,
        "avgFillPrice": _num(row.get("avgprc"), None),
        "product": str(row.get("prd") or row.get("prdTYPE") or row.get("ordtype") or ""),
        "rejmessage": row.get("rejreason") or None,
        # the dock's Orders table wants both ids and the entry remarks
        "exchordid": str(row.get("exchordid") or ""),
        "remarks": str(row.get("remarks") or ""),
        "time": _parse_noren_ts(row),
        "noren": row,  # raw row for the order panel's details
    }


def normalize_position_row(row):
    """Noren positions row -> the package's `Position` + wire extras."""
    net_qty = _int(row.get("netqty"), 0)
    # Noren's own per-side rows: netavg is the position average; daybuyavg /
    # daysellavg are the day legs.
    avg = _num(row.get("netavg"), None)
    if avg in (None, 0):
        side_avg = row.get("daybuyavg") if net_qty > 0 else row.get("daysellavg")
        avg = _num(side_avg, 0)
    ltp = _num(row.get("lp"), None)
    return {
        "symbol": str(row.get("tsym") or ""),
        "exchange": str(row.get("exch") or "").upper(),
        "token": str(row.get("token") or ""),
        "netQty": net_qty,
        "avgPrice": _num(avg, 0) or 0.0,
        "ltp": ltp if ltp not in (None, 0) else None,
        "product": str(row.get("product") or row.get("prd") or ""),
        "lotSize": _int(row.get("ls"), 1),
        "buyQty": _num(row.get("BuyQty"), 0),
        "sellQty": _num(row.get("SellQty"), 0),
        "buyAvg": _num(row.get("daybuyavg"), None),
        "sellAvg": _num(row.get("daysellavg"), None),
        "realizedPnl": _num(row.get("rpnl"), 0),
        "unrealizedPnl": _num(row.get("urmtom"), 0),
        "npnl": _num(row.get("npnl"), None),
        "raw": row,
    }


def normalize_execution_row(row, account_id):
    """Noren tradebook row -> the package's `Execution`."""
    trantype = str(row.get("trantype") or "").upper().startswith("S") and "SELL" or "BUY"
    return {
        "id": str(row.get("trannum") or row.get("norenorderno") or ""),
        "accountId": account_id,
        "orderId": str(row.get("norenorderno") or ""),
        "symbol": str(row.get("tsym") or ""),
        "exchange": str(row.get("exch") or "").upper(),
        "side": trantype,
        "qty": _num(row.get("qty"), 0),
        "price": _num(row.get("prc") or row.get("avgprc"), 0) or 0.0,
        "time": _parse_noren_ts(row),
        # extra: the /api/v1 tradebook remap needs the dock's product column
        "product": str(row.get("prd") or row.get("product") or ""),
    }


# ============================================================
# Book fetches — books stay readable even with CHART_TRADING=0
# ============================================================

def instance_manager_broker():
    """The shared BrokerSession singleton (late import avoids load-order
    cycles: instance_manager wires the broker lazily too)."""
    from services.instance_manager import instance_manager
    return instance_manager.broker


def _ok_rows(result, *, empty_markers=("no data", "no record", "no record in")):
    """Rows from a Noren book call: `values` on Ok-object or a bare list.
    'no data' refusals are empty books, not errors."""
    if isinstance(result, list):
        return [r for r in result if isinstance(r, dict)]
    if isinstance(result, dict):
        if result.get("stat") == "Not_Ok":
            emsg = str(result.get("emsg") or "").lower()
            if any(m in emsg for m in empty_markers):
                return []
            return None
        return [r for r in (result.get("values") or []) if isinstance(r, dict)]
    return None


def get_orders():
    rows = _ok_rows(instance_manager_broker().get_order_book())
    if rows is None:
        # Same SDK collapse as positions — re-issue once so an empty book
        # (`Not_Ok` "no data") is not indistinguishable from a dead session.
        rows = _ok_rows(_raw_orders())
    if rows is None:
        return None
    orders = [normalize_order_row(r) for r in rows]
    # Most recent on top, exactly like OpenAlgo's orderbook display.
    orders.sort(key=lambda o: o["time"] or 0, reverse=True)
    return orders


def _raw_orders():
    """The Noren OrderBook POST re-issued with the SDK session's credentials
    (the SDK's own call sends exactly this: uid + susertoken)."""
    try:
        import requests
        api = instance_manager_broker().api
        cfg = api._NorenApi__service_config
        url = cfg["host"] + cfg["routes"]["orderbook"]
        payload = ('jData=' + json.dumps({
                        "ordersource": "API",
                        "uid": api._NorenApi__username})
                   + '&jKey=' + api._NorenApi__susertoken)
        resp = requests.post(url, data=payload, timeout=10)
        return resp.json()
    except Exception as e:
        logging.warning("[terminal_service] raw orderbook re-read failed: %s", e)
        return None


def get_working_orders():
    if (orders := get_orders()) is None:
        return None
    live = [o for o in orders if o["status"] in ("pending", "working", "partial")]
    return live


def get_all_positions():
    rows = _ok_rows(instance_manager_broker().get_positions())
    if rows is None:
        # The SDK's get_positions collapses EVERY non-list answer to None —
        # including the engine's own empty-book reply (`Not_Ok`, emsg
        # `Error Occurred : 5 "no data"`), so a calm empty book and a dead
        # session reach us identically. Re-issue the same POST once and let
        # _ok_rows read the emsg it collapsed away.
        rows = _ok_rows(_raw_positions())
    if rows is None:
        return None
    return [normalize_position_row(r) for r in rows if _int(r.get("netqty"), 0) != 0]


def _raw_positions():
    """The Noren PositionBook POST the SDK makes, issued with its own session
    credentials. Returns the parsed body — `{"stat":"Not_Ok", "emsg": ...}`
    for both the empty book and real refusals, `{"stat":"Ok", ...}` never
    (the SDK path answers that)."""
    try:
        import requests
        api = instance_manager_broker().api
        cfg = api._NorenApi__service_config
        url = cfg["host"] + cfg["routes"]["positions"]
        payload = ('jData=' + json.dumps({"uid": api._NorenApi__username,
                                          "actid": api._NorenApi__accountid})
                   + '&jKey=' + api._NorenApi__susertoken)
        resp = requests.post(url, data=payload, timeout=10)
        return resp.json()
    except Exception as e:
        logging.warning("[terminal_service] raw positions re-read failed: %s", e)
        return None


def get_executions(account_id="default"):
    rows = _ok_rows(instance_manager_broker().get_trade_book())
    if rows is None:
        return None
    execs = [normalize_execution_row(r, account_id) for r in rows]
    execs.sort(key=lambda e: e["time"], reverse=True)
    return execs


# ============================================================
# Writes — place / modify / cancel / close
# ============================================================

def _outcome(resp, request_summary=""):
    """Translate a Noren write answer into the feed's transport semantics."""
    if resp is None:
        # The SDK collapses every error object to None — ambiguous transport.
        return {"stat": "Not_Ok", "rejected": False,
                "error": "no answer from broker (request may or may not be live)"}
    if isinstance(resp, dict) and resp.get("stat") == "Ok":
        return {"stat": "Ok", "order_id": str(resp.get("norenorderno") or ""),
                "norenorderno": resp.get("norenorderno")}
    emsg = (resp.get("emsg") if isinstance(resp, dict) else None) or str(resp)
    rejected = not any(m in str(emsg).lower() for m in ("susertoken", "session", 
                     "not logged in", "timeout", "socket", "connect"))
    return {"stat": "Not_Ok", "rejected": rejected, "error": str(emsg)[:400]}


def place_order(*, symbol, exchange, side, order_type, qty, product="MIS",
                price=None, trigger_price=None, remarks="cognix-chart"):
    """One order through the shared broker session. Returns the outcome dict;
    quantity is in UNITS (the page converts lots x lotSize before calling)."""
    if not chart_trading_enabled():
        return {"stat": "Not_Ok", "rejected": True,
                "error": "chart trading is disabled (CHART_TRADING=0)"}
    if side not in _SIDE_TO_NOREN:
        raise ValueError(f"side must be BUY or SELL, got {side!r}")
    if order_type not in _TYPE_TO_NOREN:
        raise ValueError(f"order_type must be MARKET/LIMIT/SL/SL-M, got {order_type!r}")
    prd = str(product or "MIS").upper()
    if prd not in _VALID_PRODUCTS:
        raise ValueError(f"product must be CNC/NRML/MIS, got {prd!r}")
    qty = int(qty)
    if qty <= 0:
        raise ValueError(f"quantity must be >= 1, got {qty}")
    price = float(price) if price not in (None, "", 0) else 0.0
    trigger = float(trigger_price) if trigger_price not in (None, "", 0) else 0.0
    if order_type in ("LIMIT", "SL") and price <= 0:
        raise ValueError(f"{order_type} needs price > 0")
    if order_type == "SL-M" and trigger <= 0:
        # SL-M's trigger is simply where the market flips volume.
        raise ValueError("SL-M needs trigger_price > 0")
    with _TRADE_LOCK:
        resp = instance_manager_broker().place_order(
            buy_or_sell=_SIDE_TO_NOREN[side],
            product_type=prd,
            exchange=str(exchange).upper(),
            tradingsymbol=str(symbol),
            quantity=qty,
            discloseqty=0,
            price_type=_TYPE_TO_NOREN[order_type],
            price=price,
            trigger_price=trigger if trigger else None,
            retention="DAY",
            remarks=str(remarks)[:30],
        )
    outcome = _outcome(resp)
    logging.info("[TradingTerminal] place %s %s %sx%s %s %s -> %s", side, symbol,
                 qty, exchange, order_type, prd, outcome)
    return outcome


def modify_order(*, order_id, exchange, symbol, qty=None, price=None,
                 trigger_price=None, order_type=None):
    if not chart_trading_enabled():
        return {"stat": "Not_Ok", "rejected": True,
                "error": "chart trading is disabled (CHART_TRADING=0)"}
    prctyp = _TYPE_TO_NOREN.get(order_type) if order_type else None
    with _TRADE_LOCK:
        # SDK arg names verified against the vendored wheel:
        # modify_order(orderno, exchange, tradingsymbol, newquantity,
        #              newprice_type, newprice, newtrigger_price)
        resp = instance_manager_broker().modify_order(
            orderno=str(order_id),
            exchange=str(exchange).upper(),
            tradingsymbol=str(symbol),
            newquantity=int(qty) if qty else 0,
            newprice_type=prctyp or "LMT",
            newprice=float(price) if price not in (None, "") else 0.0,
            newtrigger_price=(float(trigger_price)
                              if trigger_price not in (None, "") else None),
        )
    outcome = _outcome(resp)
    logging.info("[TradingTerminal] modify %s -> %s", order_id, outcome)
    return outcome


def cancel_order(*, order_id):
    if not chart_trading_enabled():
        return {"stat": "Not_Ok", "rejected": True,
                "error": "chart trading is disabled (CHART_TRADING=0)"}
    with _TRADE_LOCK:
        # SDK arg names verified against the vendored wheel:
        # cancel_order(orderno) — BrokerSession forwards kwargs (see trading_engine)
        resp = instance_manager_broker().cancel_order(orderno=str(order_id))
    outcome = _outcome(resp)
    logging.info("[TradingTerminal] cancel %s -> %s", order_id, outcome)
    return outcome


def close_position(*, symbol, exchange, net_qty, product="MIS", price_type="MARKET",
                   price=None, trigger_price=None):
    """Square a position off by placing the OPPOSITE side. qty = |net|; a
    shortcut leg like MIS carries away the day's side; NRML closes carry."""
    net = int(net_qty)
    if net == 0:
        return {"stat": "Not_Ok", "rejected": True, "error": "position already flat"}
    return place_order(
        symbol=symbol, exchange=exchange,
        side="SELL" if net > 0 else "BUY",
        order_type=price_type, qty=abs(net), product=product,
        price=price, trigger_price=trigger_price,
        remarks="cognix-chart-close",
    )
