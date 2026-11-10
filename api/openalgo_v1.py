# -*- coding: utf-8 -*-
"""api/openalgo_v1.py
====================
OpenAlgo-compatible API surface for the hosted trading chart.

Why this exists
---------------
`frontend/` is OpenAlgoNew's trading page (React + the `openalgo-charts`
package) compiled as a sub-app. That page has no idea NexAlgo exists: its data
plane is the *package's* `OpenAlgoDataFeed` / `OpenAlgoWsFeed` /
`OpenAlgoTradeFeed`, which speak OpenAlgo's public API:

    POST /api/v1/history      {apikey, symbol, exchange, interval, start_date, end_date}
    POST /api/v1/search       {apikey, query, exchange?}
    POST /api/v1/quotes       {apikey, symbol, exchange}
    POST /api/v1/multiquotes  {apikey, symbols:[...]}
    POST /api/v1/depth        {apikey, symbol, exchange}
    POST /api/v1/placeorder   {apikey, strategy, symbol, action, exchange, pricetype,
                               product, quantity, price, trigger_price, disclosed_quantity}
    POST /api/v1/modifyorder  / cancelorder / orderbook / tradebook / positionbook
    GET  /api/websocket/apikey -> {status, api_key}
    GET  /api/websocket/config -> {status, websocket_url}
    ...

Every handler below is a thin adapter onto the services NexAlgo already owns
(`chart_history`, `terminal_service`, `BrokerSession`, `_normalized_quote_data`,
`symbol_index`). No business logic is duplicated: this module only renames and
reshapes.

Auth: the OpenAlgo `apikey` is accepted and ignored on purpose — the real gate
is `utils/auth_middleware.py` (session cookie on both HTTP and the WS
handshake), exactly like every other page in this app.
"""
import asyncio
import json
import logging
import os
import threading
import time
from datetime import datetime, timezone, timedelta

import pytz
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from services import symbol_index, terminal_service

router = APIRouter()

IST = pytz.timezone("Asia/Kolkata")

_ALERTS_LOG = os.path.join("database", "alerts_log.json")
_alerts_lock = threading.Lock()


# ---------------------------------------------------------------- helpers


def _ok(data, **extra):
    payload = {"status": "success", "data": data}
    payload.update(extra)
    return payload


def _err(message, **extra):
    payload = {"status": "error", "message": str(message)}
    payload.update(extra)
    return payload


async def _call(fn, *args, **kwargs):
    """Run a blocking broker/SDK call off the event loop.

    Every data path here bottoms out in the synchronous Noren SDK (a
    ``requests.post``), which blocks for seconds when the token expired or the
    broker throttles. Called inline from an ``async def`` handler it freezes
    the whole ASGI loop — no HTTP, no ``/ws``, no log output, i.e. the app
    looks hung while the process is fine. Always go through this.
    """
    return await asyncio.to_thread(fn, *args, **kwargs)


async def _body(request: Request) -> dict:
    try:
        raw = await request.body()
        if not raw:
            return {}
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _num(v, default=None):
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


_IST = timezone(timedelta(hours=5, minutes=30))


def _ist_ts(epoch):
    """Epoch seconds → the Noren `tm` clock shape the dock's parser reads
    (`parseTimestamp` in dock/format.ts handles `HH:MM:SS DD-MM-YYYY`)."""
    try:
        if not epoch or int(epoch) <= 0:
            return ""
        return datetime.fromtimestamp(int(epoch), _IST).strftime("%H:%M:%S %d-%m-%Y")
    except (TypeError, ValueError, OSError):
        return ""


def _order_counts(orders):
    """The OrderStats the dock's header strip counts, over the mapped rows.
    `open` here means still working (`pending`/`working`/`partial` map to
    open/trigger_pending in _OA_STATUS; cancelled is neither open nor rejected)."""
    return {
        "total_buy_orders": sum(1 for o in orders if o["action"] == "BUY"),
        "total_sell_orders": sum(1 for o in orders if o["action"] == "SELL"),
        "total_completed_orders": sum(1 for o in orders if o["order_status"] == "complete"),
        "total_open_orders": sum(
            1 for o in orders if o["order_status"] in ("open", "trigger_pending")),
        "total_rejected_orders": sum(1 for o in orders if o["order_status"] == "rejected"),
    }


def _resolve(exchange, symbol):
    """(exchange, symbol) → scrip row. Raises ValueError with a readable text."""
    row = symbol_index.resolve(exchange, symbol)
    if not row:
        raise ValueError(
            f"{symbol} is not on the {str(exchange or '').upper()} scrip master"
        )
    return row


def _instrument_of(row):
    inst = str(row.get("instrument") or "").upper()
    if inst.endswith("_INDEX") or inst == "INDEX":
        return "INDEX"
    if inst.startswith("OPT"):
        return "OPTION"
    if inst.startswith("FUT"):
        return "FUTURE"
    return "EQ"


def _date_to_epoch(value, end_of_day=False):
    """'YYYY-MM-DD' (or an epoch) → UTC seconds on the IST session grid."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d-%m-%Y"):
        try:
            naive = datetime.strptime(text, fmt)
        except ValueError:
            continue
        if end_of_day and fmt == "%Y-%m-%d":
            naive = naive.replace(hour=15, minute=30)
        return naive.replace(tzinfo=IST).timestamp()
    return None


# ---------------------------------------------------------------- history

_INTERVAL_ALIASES = {
    "1": "1m", "1m": "1m", "3m": "3m", "5": "5m", "5m": "5m",
    "10m": "10m", "15": "15m", "15m": "15m", "30": "30m", "30m": "30m",
    "60": "1h", "1h": "1h", "2h": "2h", "4h": "4h", "1d": "1d", "D": "1d",
    "d": "1d", "1D": "1d",
}


def _aggregate(bars, seconds):
    """Fold 1d bars into week/month buckets (the package asks for 'W'/'M')."""
    out = []
    bucket = None
    cur = None
    for bar in bars:
        t = int(bar["time"])
        if seconds >= 28 * 86400:
            dt = datetime.fromtimestamp(t, tz=timezone.utc)
            key = (dt.year, dt.month)
        else:  # Monday-based weeks, IST calendar
            dt = datetime.fromtimestamp(t, tz=IST)
            start = dt - timedelta(days=dt.weekday())
            key = (start.year, start.month, start.day)
        if key != bucket:
            if cur:
                out.append(cur)
            bucket = key
            cur = {
                "time": t,
                "open": bar["open"],
                "high": bar["high"],
                "low": bar["low"],
                "close": bar["close"],
                "volume": bar.get("volume") or 0,
            }
        else:
            cur["high"] = max(cur["high"], bar["high"])
            cur["low"] = min(cur["low"], bar["low"])
            cur["close"] = bar["close"]
            if bar.get("volume"):
                cur["volume"] = (cur.get("volume") or 0) + bar["volume"]
    if cur:
        out.append(cur)
    return out


@router.post("/api/v1/history")
async def history(request: Request):
    """OpenAlgo history → our Noren TPSeries/EODChartData pipeline.

    The package sends `{symbol, exchange, interval, start_date, end_date}` with
    dates as `YYYY-MM-DD`; it renders whatever rows come back in `data`, so the
    bar dicts are exactly our own `{time, open, high, low, close, volume, oi}`.
    """
    from api.routes import chart_history  # local import: avoids a cycle

    body = await _body(request)
    symbol = body.get("symbol")
    exchange = (body.get("exchange") or "NSE").upper()
    interval_raw = str(body.get("interval") or "5m")
    interval = _INTERVAL_ALIASES.get(interval_raw, interval_raw)
    try:
        row = _resolve(exchange, symbol)
    except ValueError as e:
        return _err(e)

    start_ts = _date_to_epoch(body.get("start_date"))
    end_ts = _date_to_epoch(body.get("end_date"), end_of_day=True) or time.time()

    try:
        if interval in ("W", "w", "1w"):
            daily = await _call(chart_history, exchange=exchange, token=row["token"], interval="1d",
                                from_ts=start_ts, to_ts=end_ts, tsym=row["tsym"])
            if daily.get("stat") != "Ok":
                return _err(daily.get("emsg") or "no daily candles")
            return _ok(_aggregate(daily.get("bars") or [], 7 * 86400))
        if interval in ("M", "1M"):
            daily = await _call(chart_history, exchange=exchange, token=row["token"], interval="1d",
                                from_ts=start_ts, to_ts=end_ts, tsym=row["tsym"])
            if daily.get("stat") != "Ok":
                return _err(daily.get("emsg") or "no daily candles")
            return _ok(_aggregate(daily.get("bars") or [], 30 * 86400))

        res = await _call(chart_history, exchange=exchange, token=row["token"], interval=interval,
                          from_ts=start_ts, to_ts=end_ts, tsym=row["tsym"])
        if res.get("stat") != "Ok":
            return _err(res.get("emsg") or "history request failed")
        return _ok(res.get("bars") or [])
    except Exception as e:
        logging.error("[oa-v1] history %s|%s %s → %s", exchange, symbol, interval, e)
        return _err(e)


# ---------------------------------------------------------------- search


@router.post("/api/v1/search")
async def search(request: Request):
    """Symbol search over the scrip master (tsym is the symbol, like Flattrade)."""
    body = await _body(request)
    query = str(body.get("query") or "").strip()
    exchange = body.get("exchange")
    if not query:
        return _ok([])
    try:
        # The first search also unzips/loads the 167k-row index (~1.5 MB of
        # CSVs on a cold start) — never on the event loop.
        rows = await _call(symbol_index.search, query, exchange=exchange,
                           limit=int(body.get("limit") or 50))
    except Exception as e:
        logging.error("[oa-v1] search %s → %s", query, e)
        return _err(e)
    data = []
    for row in rows:
        item = {
            "symbol": row["tsym"],
            "exchange": row["exch"],
            "name": row["symbol"] or row["tsym"],
            "token": row["token"],
            "lotsize": int(_num(row["lotsize"], 1) or 1),
            "instrument": row["instrument"],
        }
        if row["expiry"]:
            item["expiry"] = row["expiry"]
        if row["strike"] not in ("", "0", "0.0", None):
            item["strike"] = _num(row["strike"])
        if row["opttype"]:
            item["option_type"] = row["opttype"]
        data.append(item)
    return _ok(data)


# ---------------------------------------------------------------- quotes


@router.post("/api/v1/symbol")
async def symbol_info(request: Request):
    """Instrument metadata for one (exchange, symbol) pair.

    The package calls this on every symbol load (`terminal.ts` `runLoadSymbol`)
    for the authoritative lot size / tick size / freeze quantity. `strict`
    mode (workspace restore) rejects the answer unless `data.symbol` and
    `data.exchange` are EXACTLY the pair it asked for, so both are echoed
    verbatim from the request while the values come from the broker.

    GetSecurityInfo is the only source of the real tick size (`ti`); it is a
    blocking SDK call, so it runs in a worker thread. A broker refusal is not
    fatal — the scrip master still gives lotsize, and the tick falls back to
    the segment default (never worse than the search row the page already has).
    """
    import asyncio

    body = await _body(request)
    symbol = str(body.get("symbol") or "")
    exchange = str(body.get("exchange") or "").upper()
    try:
        row = _resolve(exchange, symbol)
    except Exception as e:
        return _err(e)

    tick = None
    freeze = None
    if row["token"]:
        try:
            from services.instance_manager import instance_manager

            info = await asyncio.to_thread(
                instance_manager.broker.get_scrip_info, row["exch"], row["token"]
            )
            if isinstance(info, dict) and str(info.get("stat") or "Ok") == "Ok":
                tick = _num(info.get("ti"))
                freeze = _num(info.get("freeze_qty") or info.get("frzqty"))
        except Exception as e:
            logging.debug("[oa-v1] symbol %s:%s scrip info → %s", exchange, symbol, e)

    if tick is None or tick <= 0:
        tick = 0.01 if exchange in ("CDS", "MCX") else 0.05

    data = {
        "symbol": symbol,
        "exchange": exchange,
        "name": row["symbol"] or row["tsym"],
        "token": row["token"],
        "lotsize": int(_num(row["lotsize"], 1) or 1),
        "tick_size": tick,
        "freeze_qty": int(freeze) if freeze and freeze > 0 else 0,
        "instrument": row["instrument"],
        "brsymbol": row["tsym"],
    }
    if row["expiry"]:
        data["expiry"] = row["expiry"]
    if row["strike"] not in ("", "0", "0.0", None):
        data["strike"] = _num(row["strike"])
    if row["opttype"]:
        data["option_type"] = row["opttype"]
    return _ok(data)


@router.post("/api/v1/quotes")
async def quotes(request: Request):
    from api.routes import _normalized_quote_data

    body = await _body(request)
    try:
        row = _resolve(body.get("exchange"), body.get("symbol"))
        return _ok(await _call(_normalized_quote_data, row["exch"], row["token"]))
    except Exception as e:
        return _err(e)


@router.post("/api/v1/multiquotes")
async def multiquotes(request: Request):
    from api.routes import _normalized_quote_data

    body = await _body(request)
    items = body.get("symbols") or []
    out = []
    for item in items:
        if isinstance(item, str) and ":" in item:
            exch, sym = item.split(":", 1)
        elif isinstance(item, dict):
            exch, sym = item.get("exchange"), item.get("symbol")
        else:
            continue
        try:
            row = _resolve(exch, sym)
            out.append(await _call(_normalized_quote_data, row["exch"], row["token"]))
        except Exception:
            continue
    return _ok(out)


@router.post("/api/v1/depth")
async def depth(request: Request):
    from api.routes import normalized_depth  # the /api/depth route function

    body = await _body(request)
    try:
        row = _resolve(body.get("exchange"), body.get("symbol"))
        res = await _call(normalized_depth, exchange=row["exch"], token=row["token"])
        return res if isinstance(res, dict) else _err("depth unavailable")
    except Exception as e:
        return _err(e)


@router.post("/api/v1/intervals")
async def intervals_compat(request: Request):
    """Broker interval catalogue in the shape `intervalGroups()` expects.

    `lib/trading/intervals.ts` takes `{seconds, minutes, hours, days, weeks,
    months}` — NOT a flat list. A flat list produced `nativeIntervals =
    [undefined]`, so the chart's timeframe resolver threw
    ``No compatible source for D`` and the pane never drew a candle.
    """
    return _ok({
        "seconds": [],
        "minutes": ["1m", "3m", "5m", "10m", "15m", "30m"],
        "hours": ["1h", "2h", "4h"],
        "days": ["D"],
        "weeks": [],
        "months": [],
    })


# ---------------------------------------------------------------- orders

_OA_STATUS = {
    "pending": "open",
    "working": "open",
    "partial": "trigger_pending",
    "filled": "complete",
    "complete": "complete",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "rejected": "rejected",
}


def _oa_trade(e):
    """terminal_service `Execution` → the dock's `Trade` (values, not strings)."""
    qty = int(_num(e.get("qty"), 0) or 0)
    price = _num(e.get("price"), 0) or 0
    return {
        "trade_id": str(e.get("id") or ""),
        "orderid": str(e.get("orderId") or ""),
        "symbol": str(e.get("symbol") or ""),
        "exchange": str(e.get("exchange") or "").upper(),
        "action": str(e.get("side") or "").upper(),
        "product": str(e.get("product") or "").upper(),
        "quantity": qty,
        "average_price": price,
        "trade_value": round(qty * price, 2),
        "timestamp": _ist_ts(e.get("time")),
    }


def _oa_order(o):
    qty = int(_num(o.get("qty"), 0) or 0)
    filled = int(_num(o.get("filledQty"), 0) or 0)
    return {
        "orderid": str(o.get("order_id") or ""),
        "symbol": str(o.get("symbol") or ""),
        "exchange": str(o.get("exchange") or "").upper(),
        "action": str(o.get("side") or "BUY").upper(),
        "pricetype": str(o.get("type") or "LIMIT").upper(),
        "product": str(o.get("product") or "MIS").upper(),
        "quantity": qty,
        "filled_quantity": filled,
        "pending_quantity": max(qty - filled, 0),
        "price": _num(o.get("price"), 0) or 0,
        "trigger_price": _num(o.get("triggerPrice"), 0) or 0,
        "average_price": _num(o.get("avgFillPrice"), 0) or 0,
        "order_status": _OA_STATUS.get(str(o.get("status") or "").lower(), "open"),
        "rejection_reason": o.get("rejmessage") or "",
        "timestamp": _ist_ts(o.get("time")),
        # the dock's Orders table carries both ids + entry remarks
        "order_no": str(o.get("order_id") or ""),
        "exchange_order_id": str(o.get("exchordid") or ""),
        "remarks": str(o.get("remarks") or ""),
    }


@router.post("/api/v1/orderbook")
async def orderbook(request: Request):
    try:
        rows = await _call(terminal_service.get_orders)
        if rows is None:
            return _err("broker answered no order book")
        # The dock (useBlotter) reads res.data.orders + res.data.statistics; the
        # vendored OpenAlgoTradeFeed tolerates both shapes (array or .orders).
        orders = [_oa_order(o) for o in rows]
        return _ok({"orders": orders, "statistics": _order_counts(orders)})
    except Exception as e:
        return _err(e)


@router.post("/api/v1/tradebook")
async def tradebook(request: Request):
    try:
        rows = await _call(terminal_service.get_executions) or []
        # The dock's Trade shape (orderid/action/product/average_price/
        # trade_value/timestamp) — the raw Execution rows are not it.
        return _ok([_oa_trade(e) for e in rows])
    except Exception as e:
        return _err(e)


@router.post("/api/v1/positionbook")
async def positionbook(request: Request):
    try:
        rows = await _call(terminal_service.get_all_positions)
        if rows is None:
            return _err("broker answered no positions")
        return _ok([
            {
                "symbol": p.get("symbol"),
                "exchange": p.get("exchange"),
                "product": p.get("product"),
                "quantity": p.get("netQty"),
                "average_price": p.get("avgPrice"),
                "ltp": p.get("ltp"),
                "pnl": p.get("unrealizedPnl"),
            }
            for p in rows
        ])
    except Exception as e:
        return _err(e)


@router.post("/api/v1/placeorder")
async def placeorder(request: Request):
    body = await _body(request)
    symbol = body.get("symbol")
    exchange = (body.get("exchange") or "NSE").upper()
    try:
        row = symbol_index.resolve(exchange, symbol)
        tsym = row["tsym"] if row else symbol
        outcome = await _call(
            terminal_service.place_order,
            symbol=tsym,
            exchange=exchange,
            side=str(body.get("action") or "BUY").upper(),
            order_type=str(body.get("pricetype") or "MARKET").upper(),
            qty=int(_num(body.get("quantity"), 0) or 0),
            product=str(body.get("product") or "MIS").upper(),
            price=_num(body.get("price"), 0) or 0,
            trigger_price=_num(body.get("trigger_price"), 0) or 0,
            remarks=str(body.get("strategy") or "cognix")[:30],
        )
    except Exception as e:
        return _err(e)
    if outcome.get("stat") == "Ok":
        return {"status": "success", "orderid": outcome.get("order_id")}
    return {"status": "error", "message": outcome.get("error") or "order rejected"}


@router.post("/api/v1/modifyorder")
async def modifyorder(request: Request):
    body = await _body(request)
    order_id = str(body.get("orderid") or body.get("order_id") or "")
    if not order_id:
        return _err("orderid is required")
    try:
        outcome = await _call(
            terminal_service.modify_order,
            order_id=order_id,
            exchange=(body.get("exchange") or "NSE").upper(),
            symbol=body.get("symbol") or "",
            qty=int(_num(body.get("quantity"), 0) or 0) or None,
            price=_num(body.get("price"), None),
            trigger_price=_num(body.get("trigger_price"), None),
            order_type=str(body.get("pricetype") or "LIMIT").upper(),
        )
    except Exception as e:
        return _err(e)
    if outcome.get("stat") == "Ok":
        return {"status": "success", "orderid": order_id}
    return {"status": "error", "message": outcome.get("error") or "modify rejected"}


@router.post("/api/v1/cancelorder")
async def cancelorder(request: Request):
    body = await _body(request)
    order_id = str(body.get("orderid") or body.get("order_id") or "")
    if not order_id:
        return _err("orderid is required")
    try:
        outcome = await _call(terminal_service.cancel_order, order_id=order_id)
    except Exception as e:
        return _err(e)
    if outcome.get("stat") == "Ok":
        return {"status": "success", "orderid": order_id}
    return {"status": "error", "message": outcome.get("error") or "cancel rejected"}


@router.post("/api/v1/gttorderbook")
async def gttorderbook(request: Request):
    """The dock's GTT tab. Flattrade's API surface carries no GTT book and no
    trigger engine is modelled server-side, so the honest answer is an empty
    book (the tab then shows "No GTT orders" instead of a failed fetch)."""
    return _ok([])


# ---------------------------------------------------------------- web writes
# The dock's row actions POST to OpenAlgo's WEB endpoints — root paths, session
# cookie, an X-CSRFToken header /auth/csrf-token already serves (accepted, not
# validated: Cookie-auth middleware is the gate). They bridge to the same
# terminal_service writes the chart uses, which keeps the CHART_TRADING kill
# switch authoritative. Blocking broker calls run through _call, never inline.


def _web_outcome(outcome, default_verb, ok_data=None):
    if isinstance(outcome, dict) and outcome.get("stat") == "Ok":
        return {"status": "success", "data": ok_data or {}}
    return {"status": "error",
            "message": (outcome.get("error") if isinstance(outcome, dict) else None)
            or f"{default_verb} rejected"}


@router.post("/modify_order")
async def web_modify_order(request: Request):
    body = await _body(request)
    order_id = str(body.get("orderid") or body.get("order_id") or "")
    if not order_id:
        return {"status": "error", "message": "orderid is required"}
    try:
        outcome = await _call(
            terminal_service.modify_order,
            order_id=order_id,
            exchange=(body.get("exchange") or "NSE").upper(),
            symbol=body.get("symbol") or "",
            qty=int(_num(body.get("quantity"), 0) or 0) or None,
            price=_num(body.get("price"), None),
            trigger_price=_num(body.get("trigger_price"), None),
            order_type=str(body.get("pricetype") or "LIMIT").upper(),
        )
    except Exception as e:
        return {"status": "error", "message": str(e)}
    return _web_outcome(outcome, "modify", {"orderid": order_id})


@router.post("/cancel_order")
async def web_cancel_order(request: Request):
    body = await _body(request)
    order_id = str(body.get("orderid") or body.get("order_id") or "")
    if not order_id:
        return {"status": "error", "message": "orderid is required"}
    try:
        outcome = await _call(terminal_service.cancel_order, order_id=order_id)
    except Exception as e:
        return {"status": "error", "message": str(e)}
    return _web_outcome(outcome, "cancel", {"orderid": order_id})


@router.post("/close_position")
async def web_close_position(request: Request):
    body = await _body(request)
    symbol = str(body.get("symbol") or "")
    exchange = str(body.get("exchange") or "NSE").upper()
    product = str(body.get("product") or "MIS").upper()
    if not symbol:
        return {"status": "error", "message": "symbol is required"}
    try:
        positions = await _call(terminal_service.get_all_positions) or []
        row = next(
            (p for p in positions
             if p.get("symbol") == symbol and p.get("exchange") == exchange
             and str(p.get("product") or "").upper() == product),
            None)
        if row is None:
            return {"status": "error",
                    "message": f"no open {product} position on {exchange}:{symbol}"}
        outcome = await _call(
            terminal_service.close_position,
            symbol=symbol, exchange=exchange, net_qty=int(row.get("netQty") or 0),
            product=product or (str(row.get("product") or "MIS").upper() or "MIS"),
        )
    except Exception as e:
        return {"status": "error", "message": str(e)}
    return _web_outcome(outcome, "close")


@router.post("/close_all_positions")
async def web_close_all_positions(request: Request):
    try:
        positions = await _call(terminal_service.get_all_positions) or []
    except Exception as e:
        return {"status": "error", "message": str(e)}
    failures = []
    for p in positions:
        try:
            outcome = await _call(
                terminal_service.close_position,
                symbol=str(p.get("symbol") or ""), exchange=str(p.get("exchange") or "NSE").upper(),
                net_qty=int(p.get("netQty") or 0),
                product=str(p.get("product") or "MIS").upper() or "MIS",
            )
            if not (isinstance(outcome, dict) and outcome.get("stat") == "Ok"):
                failures.append(f"{p.get('exchange')}:{p.get('symbol')}: "
                                f"{outcome.get('error') if isinstance(outcome, dict) else outcome}")
        except Exception as e:
            failures.append(f"{p.get('exchange')}:{p.get('symbol')}: {e}")
    if failures:
        return {"status": "error", "message": "; ".join(failures)}
    return {"status": "success", "data": {"closed": len(positions)}}


@router.post("/cancel_all_orders")
async def web_cancel_all_orders(request: Request):
    try:
        working = await _call(terminal_service.get_working_orders) or []
    except Exception as e:
        return {"status": "error", "message": str(e)}
    failures = []
    for o in working:
        order_id = str(o.get("order_id") or "")
        if not order_id:
            continue
        try:
            outcome = await _call(terminal_service.cancel_order, order_id=order_id)
            if not (isinstance(outcome, dict) and outcome.get("stat") == "Ok"):
                failures.append(f"{order_id}: "
                                f"{outcome.get('error') if isinstance(outcome, dict) else outcome}")
        except Exception as e:
            failures.append(f"{order_id}: {e}")
    if failures:
        return {"status": "error", "message": "; ".join(failures)}
    return {"status": "success", "data": {"cancelled": len(working)}}


@router.post("/cancel_gtt_order")
async def web_cancel_gtt_order(request: Request):
    """No GTT trigger engine exists server-side (see /api/v1/gttorderbook)."""
    return {"status": "error",
            "message": "GTT triggers are not supported on this broker adapter"}


@router.post("/modify_gtt_order")
async def web_modify_gtt_order(request: Request):
    return {"status": "error",
            "message": "GTT triggers are not supported on this broker adapter"}


# ---------------------------------------------------------------- account


@router.post("/api/v1/funds")
async def funds(request: Request):
    try:
        from services.instance_manager import instance_manager
        limits = await _call(instance_manager.broker.get_limits) if hasattr(
            instance_manager.broker, "get_limits") else None
        data = limits if isinstance(limits, dict) else {}
        return _ok({
            "availablecash": _num(data.get("cash") or data.get("availablecash"), 0),
            "collateral": _num(data.get("collateral"), 0),
            "utiliseddebits": _num(data.get("utilizeddebits") or data.get("utiliseddebits"), 0),
        })
    except Exception as e:
        return _err(e)


@router.post("/api/v1/holdings")
async def holdings(request: Request):
    try:
        from services.instance_manager import instance_manager
        rows = await _call(instance_manager.broker.get_holdings) if hasattr(
            instance_manager.broker, "get_holdings") else []
        return _ok(rows if isinstance(rows, list) else [])
    except Exception as e:
        return _err(e)


@router.post("/api/v1/margin")
async def margin(request: Request):
    return _err("margin calculator is not wired to this broker session yet")


@router.post("/api/v1/syntheticfuture")
async def synthetic_future(request: Request):
    return _err("synthetic future is not implemented for this broker session")


# ---------------------------------------------------------------- option chain

@router.post("/api/v1/optionchain")
async def optionchain(request: Request):
    """Delegates to the chain route the charts page already uses."""
    from api.routes import optionchain_chain  # type: ignore

    body = await _body(request)
    try:
        row = _resolve(body.get("exchange"), body.get("symbol") or body.get("underlying"))
        return await _call(
            optionchain_chain,
            exchange=row["exch"],
            underlying=row["tsym"],
            token=row["token"],
            count=int(_num(body.get("count") or body.get("cnt"), 10) or 10),
            expiry=body.get("expiry") or "",
            atm=_num(body.get("atm"), None),
        )
    except Exception as e:
        return _err(e)


@router.post("/api/v1/optionsymbol")
async def optionsymbol(request: Request):
    return _err("option symbol resolution is served by /api/optionchain/chain")


@router.post("/api/v1/optiongreeks")
async def optiongreeks(request: Request):
    return _err("Greeks are computed by /api/optionchain/chain")


@router.post("/api/v1/multioptiongreeks")
async def multioptiongreeks(request: Request):
    return _err("Greeks are computed by /api/optionchain/chain")


# ---------------------------------------------------------------- misc surface


@router.get("/api/websocket/apikey")
async def websocket_apikey():
    """The page's `apikey` is cosmetic here (session cookie is the gate)."""
    return {"status": "success", "api_key": "cognix-local"}


@router.get("/api/websocket/config")
async def websocket_config(request: Request):
    host = request.headers.get("host") or "127.0.0.1:8000"
    scheme = "wss" if request.url.scheme == "https" else "ws"
    return {"status": "success", "websocket_url": f"{scheme}://{host}/ws"}


@router.get("/api/broker/capabilities")
async def broker_capabilities():
    return _ok({
        "broker_name": "flattrade",
        "broker_type": "IN_stock",
        "supported_exchanges": ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS"],
        "leverage_config": False,
    })


@router.get("/admin/api/timings")
async def admin_timings():
    """Session hours per exchange, minutes after IST midnight (OpenAlgo shape)."""
    rows = [
        {"id": 1, "exchange": ex, "start_time": "09:15", "end_time": "15:30",
         "start_offset": 555, "end_offset": 930}
        for ex in ("NSE", "BSE", "NFO", "BFO")
    ]
    rows.append({"id": 5, "exchange": "MCX", "start_time": "09:00", "end_time": "23:30",
                 "start_offset": 540, "end_offset": 1410})
    rows.append({"id": 6, "exchange": "CDS", "start_time": "09:00", "end_time": "17:00",
                 "start_offset": 540, "end_offset": 1020})
    return {"status": "success", "data": rows}


@router.get("/admin/api/holidays")
async def admin_holidays():
    return {"status": "success", "data": []}


@router.post("/api/v1/market/holidays")
async def market_holidays(request: Request):
    """Exchange holidays for a year. Empty list = weekday calendar only."""
    return {"status": "success", "data": []}


@router.get("/auth/csrf-token")
async def csrf_token():
    return {"status": "success", "csrf_token": "cognix"}


@router.get("/auth/analyzer-mode")
async def analyzer_mode():
    return {"status": "success", "mode": "live", "analyze_mode": False}


@router.post("/auth/analyzer-toggle")
async def analyzer_toggle():
    return {"status": "success", "mode": "live", "analyze_mode": False}


@router.get("/auth/broker/{broker}")
async def auth_broker(broker: str):
    return {"status": "success", "broker": broker}


@router.post("/auth/logout")
async def auth_logout(request: Request):
    return {"status": "success"}


# ---------------------------------------------------------------- alerts log
# The page evaluates alerts in the browser and reports each firing here so a
# closed tab does not take the day's history with it (lib/trading/alertLog.ts).


def _read_alerts():
    try:
        with open(_ALERTS_LOG, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_alerts(rows):
    try:
        os.makedirs(os.path.dirname(_ALERTS_LOG), exist_ok=True)
        tmp = _ALERTS_LOG + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rows[-500:], f)
        os.replace(tmp, _ALERTS_LOG)
    except Exception as e:
        logging.warning("[oa-v1] alerts log write failed → %s", e)


@router.post("/alerts/fired")
async def alert_fired(request: Request):
    body = await _body(request)
    row = {
        "id": int(time.time() * 1000),
        "alertId": str(body.get("alertId") or ""),
        "title": str(body.get("title") or ""),
        "kind": str(body.get("kind") or ""),
        "condition": str(body.get("condition") or ""),
        "symbol": str(body.get("symbol") or ""),
        "exchange": str(body.get("exchange") or ""),
        "interval": str(body.get("interval") or ""),
        "price": _num(body.get("price"), None),
        "message": str(body.get("message") or ""),
        "delivered": body.get("delivered") if isinstance(body.get("delivered"), list) else [],
        "firedAt": int(time.time()),
    }
    with _alerts_lock:
        rows = _read_alerts()
        rows.append(row)
        _write_alerts(rows)
    return {"status": "success", "id": row["id"]}


@router.get("/alerts/log")
async def alert_log():
    with _alerts_lock:
        return {"status": "success", "fires": list(reversed(_read_alerts()))}


@router.delete("/alerts/log")
async def alert_log_clear():
    with _alerts_lock:
        _write_alerts([])
    return {"status": "success"}
