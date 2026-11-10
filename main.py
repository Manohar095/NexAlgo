# -*- coding: utf-8 -*-
"""
main.py
========
Entry point. Run with:  python main.py
Then open:               http://localhost:8000
"""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from utils.logging_setup import configure_logging
configure_logging()  # console + logs/renko_platform.log (rotated daily) — set up before anything else logs

from api.routes import router as api_router
from api.openalgo_v1 import router as openalgo_v1_router
from config.settings import settings
from database import db
from services.instance_manager import instance_manager
from strategy_hub import registry as _strategy_hub
from strategy_hub import manager as _strategy_hub_manager
from strategy_hub.routes import router as strategy_hub_router
from utils.auth_middleware import SessionAuthMiddleware
from utils import win_accept_patch
from ws_broadcast.ws_manager import ws_manager

# Windows: stop a client abort during accept from closing the HTTP listener
# (see utils/win_accept_patch.py — otherwise the process looks "hung" while
# still running). Must run before the asyncio loop is created.
win_accept_patch.apply()


def _int_or_zero(value):
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return 0


def _float_or_zero(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _oa_snapshot_frame(exchange, token, snapshot, mode="quote"):
    """One broker snapshot in the hosted page's frame shape (see `forward`)."""
    data = dict(snapshot or {})
    tsym = str(data.get("tsym") or "")
    if tsym:
        data.setdefault("symbol", tsym)
    data.setdefault("exchange", exchange)
    data.setdefault("timestamp", int(time.time()))
    return {
        "type": "market_data",
        "exchange": exchange,
        "token": str(token),
        "symbol": data.get("symbol") or tsym,
        "feed": mode,
        "cached": True,
        "data": data,
    }


def _wire_market_data_forwarding():
    """OpenAlgo market-data parity: funnel every broker frame to the /ws
    sockets as a normalized market_data frame, and account order updates as
    an order_update stream. Both taps run on the broker's SDK websocket
    thread, so they must stay cheap and error-swallowing.

    The WSManager fans each frame only to the connections that subscribed
    to that instrument (OpenAlgo proxy subscription_index model).
    """
    ORDER_FIELDS = (
        "status", "norenordno", "tsym", "exch", "trantype", "qty",
        "fillshares", "prc", "flprc", "stoploss_trigger_price",
        "triggerprice", "rejreason", "remarks", "reporttype", "uid",
        "ordertype", "product", "rms_reject_code",
    )

    def forward(md):
        try:
            data = dict(md.get("data") or {})
            # The hosted OpenAlgo page reads frames in the package's own shape
            # (`{data:{symbol, exchange, ltp, volume, depth:{buy,sell}}}`),
            # our vanilla pages read the same snapshot plus `feed`. One frame
            # satisfies both: add the symbol aliases here, once.
            exchange = str(md.get("exchange") or "").upper()
            token = str(md.get("token") or "")
            tsym = str(data.get("tsym") or "")
            if tsym:
                data.setdefault("symbol", tsym)
            data.setdefault("exchange", exchange)
            # The package buckets the forming bar on the frame's time; Noren's
            # `ltt` is a string the browser cannot always parse, so stamp the
            # server's epoch second (IST == UTC epoch, same instant).
            data.setdefault("timestamp", int(time.time()))
            frame = {
                "type": "market_data",
                "exchange": exchange,
                "token": token,
                "symbol": data.get("symbol") or tsym,
                "feed": md.get("feed") or "quote",
                "data": data,
            }
            ws_manager.broadcast_market_data(frame)
        except Exception:
            pass  # a malformed frame must never kill the feed handler

    # Noren order status → OpenAlgo order status (the package's map).
    _OA_ORDER_STATUS = {
        "complete": "complete", "completed": "complete", "filled": "complete",
        "open": "open", "trigger_pending": "trigger_pending",
        "pending": "pending", "partially_filled": "open",
        "cancelled": "cancelled", "canceled": "cancelled",
        "rejected": "rejected",
    }

    def order_forward(msg):
        try:
            payload = {k: msg.get(k) for k in ORDER_FIELDS if k in msg}
            payload["ts"] = int(time.time() * 1000)
            # Flat OpenAlgo order frame for the hosted page (openalgo-charts
            # `OpenAlgoTradeFeed` parses these top-level fields), plus `data`
            # for our own pages.
            raw_status = str(msg.get("status") or msg.get("reporttype") or "").lower()
            flat = {
                "type": "order_update",
                "data": payload,
                "orderid": str(msg.get("norenordno") or msg.get("orderid") or ""),
                "symbol": msg.get("tsym") or msg.get("symbol") or "",
                "exchange": str(msg.get("exch") or msg.get("exchange") or "").upper(),
                "action": "SELL" if str(msg.get("trantype") or "").upper().startswith("S") else "BUY",
                "quantity": _int_or_zero(msg.get("qty")),
                "price": _float_or_zero(msg.get("prc")),
                "trigger_price": _float_or_zero(msg.get("triggerprice") or msg.get("stoploss_trigger_price")),
                "pricetype": str(msg.get("prctyp") or msg.get("ordertype") or "LIMIT").upper(),
                "product": str(msg.get("product") or "MIS").upper(),
                "order_status": _OA_ORDER_STATUS.get(raw_status, raw_status),
                "filled_quantity": _int_or_zero(msg.get("fillshares")),
                "pending_quantity": max(_int_or_zero(msg.get("qty")) - _int_or_zero(msg.get("fillshares")), 0),
                "average_price": _float_or_zero(msg.get("avgprc") or msg.get("flprc")),
                "rejection_reason": str(msg.get("rejreason") or ""),
            }
            ws_manager.broadcast_order_update(flat)
        except Exception:
            pass

    instance_manager.broker.set_tick_listener(forward)
    instance_manager.broker.set_order_listener(order_forward)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    ws_manager.set_loop(asyncio.get_event_loop())
    instance_manager.set_callbacks(on_log=ws_manager.on_log, on_status=ws_manager.on_status)
    # The hub's per-exchange engines broadcast through the same shape
    # ({type:"status", instance_id:"hub_<row_id>", status:{...}}).
    _strategy_hub_manager.DEFAULT_ON_LOG = ws_manager.on_log
    _strategy_hub_manager.DEFAULT_ON_STATUS = ws_manager.on_status
    _wire_market_data_forwarding()
    # Restore saved symbols; auto-start the ones flagged autostart=True
    instance_manager.load_from_db(autostart_saved=True)
    # Strategy hub: (re)start one managed process per exchange that still has
    # ENABLED symbols and was not manually stopped (each arms outside its
    # schedule instead of running instances).
    _strategy_hub.autostart_from_db()
    if settings.DASHBOARD_USER and settings.DASHBOARD_PASSWORD:
        if settings.DASHBOARD_TOTP_SECRET:
            logging.info("🔒 Dashboard login enabled with 2FA (user: %s)", settings.DASHBOARD_USER)
        else:
            logging.info("🔒 Dashboard login enabled, no 2FA (user: %s)", settings.DASHBOARD_USER)
    else:
        logging.warning("🔓 Dashboard login is DISABLED — set DASHBOARD_USER/DASHBOARD_PASSWORD in .env to enable it")
    logging.info("🚀 CogniX Algo ready at http://localhost:8000")
    yield
    logging.info("🛑 Shutting down — stopping all running symbols")
    for status in instance_manager.all_statuses():
        if status["status"] == "RUNNING":
            try:
                instance_manager.stop(status["id"])
            except Exception as e:
                logging.error("Error stopping %s during shutdown → %s", status["id"], e)
    _strategy_hub.shutdown_all()


app = FastAPI(title="CogniX Algo", lifespan=lifespan)

app.add_middleware(SessionAuthMiddleware)
app.include_router(api_router)
# Algo-symbols strategy hub (`/strategy-hub/api/*`) — the right-pane panel's
# enable/disable flow, one managed strategy-process per exchange.
app.include_router(strategy_hub_router)
# OpenAlgo-compatible surface (`/api/v1/*`, `/api/websocket/*`, `/alerts/*`,
# `/admin/api/*`, `/auth/*`) — the hosted React trading page's data plane.
app.include_router(openalgo_v1_router)
class RevalidatedStaticFiles(StaticFiles):
    """Static mounts that the browser must REVALIDATE instead of cache.

    StaticFiles ships Last-Modified/ETag but no Cache-Control, so browsers
    apply heuristic caching (~10% of the file's age) and can serve a stale
    JS module for hours/days without ever asking the server — that is how a
    rebuilt `right_panel.mjs` or a stale `/charts` page stays invisible until
    a hard reload. `no-cache` allows the byte-level 304s; every load asks.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", RevalidatedStaticFiles(directory="static"), name="static")


def _page(path: str) -> FileResponse:
    """A Jinja-independent HTML page (templates are read per request): the
    response must revalidate for the same reason the static mounts do —
    a heuristically cached /charts or /trading index hides every server-side
    page edit behind a hard reload."""
    return FileResponse(path, headers={"Cache-Control": "no-cache"})


@app.get("/")
async def index():
    return _page("templates/index.html")


@app.get("/login")
async def login_page():
    return _page("templates/login.html")


@app.get("/logs")
async def logs_page():
    return _page("templates/logs.html")


@app.get("/charts")
async def charts_page():
    """Live broker charts page"""
    return _page("templates/charts.html")


@app.get("/trading")
async def trading_page():
    """OpenAlgoNew's own trading page, compiled as a sub-app (React).

    Built from `frontend/` (Vite) into `static/trading-app/`; the data plane is
    the OpenAlgo-compatible adapter in `api/openalgo_v1.py` plus the `/ws`
    compatibility layer at the bottom of this file.
    """
    return _page("static/trading-app/index.html")


@app.get("/trading-legacy")
async def trading_page_legacy():
    """The previous vanilla chart desk, kept for side-by-side comparison."""
    return _page("templates/trading.html")


@app.get("/option-chain")
async def option_chain_page():
    return _page("templates/option_chain.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Browser WS channel with an OpenAlgo-style client action protocol:

      {"action":"subscribe","symbols":[{"exchange","token"}],"mode":"ltp"|"quote"|"depth"}
      {"action":"unsubscribe","symbols":[...]}
      {"action":"subscribe_orders"} / {"action":"unsubscribe_orders"}
      {"action":"ping"}                    → {"type":"pong","server_timestamp":...}

    The server keeps a per-connection subscription index and fans market
    data / order updates only to the sockets that declared them, exactly
    like the OpenAlgo websocket proxy. Legacy text keepalives still work.
    """
    await ws_manager.connect(websocket)
    broker = instance_manager.broker
    # Fallback only: the lifespan already wires the loop on startup. This
    # covers embedded/TestClient runs where lifespan never fired.
    if ws_manager.loop is None:
        ws_manager.set_loop(asyncio.get_running_loop())

    def _symbols_from(msg):
        out = []
        for s in (msg.get("symbols") or []):
            if not isinstance(s, dict):
                continue
            exchange = str(s.get("exchange") or "").upper()
            token = str(s.get("token") or "")
            if exchange and token and token not in ("None", "null", "undefined"):
                out.append((exchange, token, s.get("symbol")))
        return out

    _MODE_BY_NUMBER = {1: "ltp", 2: "quote", 3: "depth", "1": "ltp", "2": "quote", "3": "depth"}

    def _mode_of(msg):
        """OpenAlgo proxy mode numbers (1 LTP / 2 Quote / 3 Depth) or our names."""
        raw = msg.get("mode")
        if raw in _MODE_BY_NUMBER:
            return _MODE_BY_NUMBER[raw]
        mode = str(raw or "ltp").lower()
        return mode if mode in ("ltp", "quote", "depth") else "quote"

    async def _resolve_symbol(exchange, symbol):
        """(exchange, tradingsymbol) → token, off the event loop (first call
        may download the scrip master)."""
        from services import symbol_index
        row = await asyncio.to_thread(symbol_index.resolve, exchange, symbol)
        return (row or {}).get("token")

    def _broker_subscribe(exchange, token, mode):
        """Broker refcount + feed start. Blocking (network + a thread join on a
        stale SDK loop), so callers run it in a worker thread — doing it inline
        stalls the ASGI event loop for seconds per subscribe."""
        broker.register_passive_subscriber(exchange, token, mode)
        broker.start_websocket()

    async def _subscribe_keys(pairs, mode):
        """Register one broker ref per (exchange, token) and stream the cache."""
        acks = []
        for exchange, token, symbol in pairs:
            try:
                ws_manager.add_subscription(websocket, exchange, token, mode)
                # One broker ref per subscribe action; register also upgrades
                # the key to snapquote when mode=depth.
                await asyncio.to_thread(_broker_subscribe, exchange, token, mode)
                acks.append({"status": "success", "exchange": exchange,
                             "token": token, "symbol": symbol, "mode": mode})
                snapshot = broker.get_md_snapshot(exchange, token)
                if snapshot:
                    await websocket.send_text(json.dumps(
                        _oa_snapshot_frame(exchange, token, snapshot, mode)))
            except Exception as e:
                logging.warning("WS subscribe %s|%s failed → %s", exchange, token, e)
                acks.append({"status": "error", "exchange": exchange,
                             "token": token, "symbol": symbol, "message": str(e)})
        return acks

    try:
        while True:
            raw = await websocket.receive_text()
            if raw == "ping":
                continue  # legacy keepalive
            try:
                client_msg = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(client_msg, dict):
                continue
            action = client_msg.get("action")

            if action == "authenticate":
                # The hosted page's `OpenAlgoWsFeed` sends
                # {action:"authenticate", api_key} on open and waits for this
                # ack (`auth.requireAck` is on). The cookie already gated the
                # handshake, so the key is only echoed as accepted.
                await websocket.send_text(json.dumps({
                    "type": "auth", "status": "success",
                    "message": "authenticated",
                }))

            elif action == "pong":
                continue  # answer to a server probe; nothing to do

            elif action == "ping":
                await websocket.send_text(json.dumps({
                    "type": "pong",
                    "server_timestamp": int(time.time() * 1000),
                }))

            elif action == "subscribe":
                mode = _mode_of(client_msg)
                pairs = _symbols_from(client_msg)
                # Singular form — the openalgo-charts feed subscribes one
                # symbol per action: {action, symbol, exchange, mode:1|2|3}.
                if not pairs:
                    exchange = str(client_msg.get("exchange") or "").upper()
                    symbol = client_msg.get("symbol")
                    if exchange and symbol:
                        token = await _resolve_symbol(exchange, symbol)
                        if token:
                            pairs = [(exchange, str(token), symbol)]
                        else:
                            await websocket.send_text(json.dumps({
                                "type": "subscribe", "status": "error",
                                "message": f"{symbol} is not on the {exchange} scrip master",
                                "exchange": exchange, "symbol": symbol,
                            }))
                            continue
                acks = await _subscribe_keys(pairs, mode)
                await websocket.send_text(json.dumps({
                    "type": "subscribe", "status": "success",
                    "subscriptions": acks, "mode": mode,
                }))

            elif action == "unsubscribe":
                pairs = _symbols_from(client_msg)
                if not pairs:
                    exchange = str(client_msg.get("exchange") or "").upper()
                    symbol = client_msg.get("symbol")
                    if exchange and symbol:
                        token = await _resolve_symbol(exchange, symbol)
                        if token:
                            pairs = [(exchange, str(token), symbol)]
                for exchange, token, _sym in pairs:
                    mode = ws_manager.remove_subscription(websocket, exchange, token)
                    if mode is not None:
                        try:
                            # Broker unsubscribe is a blocking SDK call — keep it
                            # off the event loop (see `_broker_subscribe`).
                            await asyncio.to_thread(
                                broker.unregister_passive_subscriber,
                                exchange, token, mode or "ltp")
                        except Exception as e:
                            logging.warning("WS unsubscribe %s|%s failed → %s", exchange, token, e)

            elif action == "subscribe_orders":
                ws_manager.enable_orders(websocket)
                await websocket.send_text(json.dumps({"type": "subscribe_orders", "status": "success"}))

            elif action == "unsubscribe_orders":
                ws_manager.disable_orders(websocket)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logging.debug("WS socket error → %s", e)
    finally:
        for exchange, token, mode in ws_manager.release_on_disconnect(websocket):
            try:
                await asyncio.to_thread(
                    broker.unregister_passive_subscriber, exchange, token, mode)
            except Exception as e:
                logging.warning("WS release %s|%s failed → %s", exchange, token, e)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=False)