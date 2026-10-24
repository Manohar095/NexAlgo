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
from config.settings import settings
from database import db
from services.instance_manager import instance_manager
from utils.auth_middleware import SessionAuthMiddleware
from ws_broadcast.ws_manager import ws_manager


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
            frame = {
                "type": "market_data",
                "exchange": md.get("exchange"),
                "token": str(md.get("token") or ""),
                "feed": md.get("feed") or "quote",
                "data": md.get("data") or {},
            }
            ws_manager.broadcast_market_data(frame)
        except Exception:
            pass  # a malformed frame must never kill the feed handler

    def order_forward(msg):
        try:
            payload = {k: msg.get(k) for k in ORDER_FIELDS if k in msg}
            payload["ts"] = int(time.time() * 1000)
            ws_manager.broadcast_order_update({"type": "order_update", "data": payload})
        except Exception:
            pass

    instance_manager.broker.set_tick_listener(forward)
    instance_manager.broker.set_order_listener(order_forward)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    ws_manager.set_loop(asyncio.get_event_loop())
    instance_manager.set_callbacks(on_log=ws_manager.on_log, on_status=ws_manager.on_status)
    _wire_market_data_forwarding()
    # Restore saved symbols; auto-start the ones flagged autostart=True
    instance_manager.load_from_db(autostart_saved=True)
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


app = FastAPI(title="CogniX Algo", lifespan=lifespan)

app.add_middleware(SessionAuthMiddleware)
app.include_router(api_router)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("templates/index.html")


@app.get("/login")
async def login_page():
    return FileResponse("templates/login.html")


@app.get("/logs")
async def logs_page():
    return FileResponse("templates/logs.html")


@app.get("/charts")
async def charts_page():
    """Live broker charts page"""
    return FileResponse("templates/charts.html")


@app.get("/option-chain")
async def option_chain_page():
    return FileResponse("templates/option_chain.html")


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

            if action == "ping":
                await websocket.send_text(json.dumps({
                    "type": "pong",
                    "server_timestamp": int(time.time() * 1000),
                }))

            elif action == "subscribe":
                mode = str(client_msg.get("mode") or "ltp").lower()
                if mode not in ("ltp", "quote", "depth"):
                    mode = "quote"
                acks = []
                for exchange, token, symbol in _symbols_from(client_msg):
                    try:
                        ws_manager.add_subscription(websocket, exchange, token, mode)
                        # One broker ref per subscribe action; register also
                        # upgrades the key to snapquote when mode=depth.
                        broker.register_passive_subscriber(exchange, token, mode)
                        broker.start_websocket()
                        acks.append({"status": "success", "exchange": exchange,
                                     "token": token, "symbol": symbol, "mode": mode})
                        # Cached snapshot first, like OpenAlgo's proxy serves
                        # subscribing clients instantly.
                        snapshot = broker.get_md_snapshot(exchange, token)
                        if snapshot:
                            await websocket.send_text(json.dumps({
                                "type": "market_data", "exchange": exchange,
                                "token": token, "mode": mode,
                                "cached": True, "data": snapshot,
                            }))
                    except Exception as e:
                        logging.warning("WS subscribe %s|%s failed → %s", exchange, token, e)
                        acks.append({"status": "error", "exchange": exchange,
                                     "token": token, "symbol": symbol, "message": str(e)})
                await websocket.send_text(json.dumps({
                    "type": "subscribe", "status": "success",
                    "subscriptions": acks, "mode": mode,
                }))

            elif action == "unsubscribe":
                for exchange, token, _sym in _symbols_from(client_msg):
                    mode = ws_manager.remove_subscription(websocket, exchange, token)
                    if mode is not None:
                        try:
                            broker.unregister_passive_subscriber(exchange, token, mode or "ltp")
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
                broker.unregister_passive_subscriber(exchange, token, mode)
            except Exception as e:
                logging.warning("WS release %s|%s failed → %s", exchange, token, e)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host=settings.HOST, port=settings.PORT, reload=False)