# -*- coding: utf-8 -*-
"""
strategy/broker.py
====================
The ONLY component shared across every symbol instance: broker
login/session and a single physical WebSocket connection.

Each SymbolInstance registers a feed callback (keyed by EXCH|TOKEN) and
an order-update callback (keyed by (EXCH, TSYM)). Incoming broker
messages are dispatched to the matching instance only — every other
piece of state (Renko engine, position, SL, pending orders, threads)
stays fully independent inside each SymbolInstance.

ACCESS TOKEN
------------
User ID and password are static — they stay in .env. The access token
is regenerated every trading day and is ALSO stored in .env
(FT_ACCESS_TOKEN) — it's the single shared value every symbol uses,
exactly like user id/password. It can be refreshed two ways from the
dashboard: "Generate Access Token" (runs the TOTP-based headless login
flow in services/access_token_generator.py and writes the result to
.env automatically) or pasting a token in manually. Either path updates
.env, applies the new token to this running process immediately (no
restart needed), and forces a re-login / WebSocket reconnect.

RECONNECTION
------------
Two independent mechanisms keep the single shared WebSocket alive:

1. Callback-based: if the SDK invokes a close/error callback, we react
   immediately and schedule a reconnect.
2. Heartbeat watchdog: some SDK versions don't reliably fire a close
   callback on a silent drop (e.g. the TCP connection just stalls). A
   background thread tracks the time of the last message received and,
   if nothing has arrived for HEARTBEAT_TIMEOUT seconds during market
   hours while symbols are subscribed, it forces a reconnect anyway.

Reconnects use capped exponential backoff and always re-login and
re-subscribe every currently-registered symbol — this is transparent
to every TradingEngine; they never see the drop, they just stop
getting ticks for a few seconds.
"""

import inspect
import logging
import threading
import time
from datetime import datetime, time as dtime

import pytz

from config.settings import settings
from api_helper import NorenApiPy

IST = pytz.timezone("Asia/Kolkata")

HEARTBEAT_TIMEOUT      = 45  # seconds of silence before we suspect a dead socket
HEARTBEAT_CHECK_EVERY  = 10  # how often the watchdog checks
RECONNECT_BACKOFF_START = 3
RECONNECT_BACKOFF_MAX   = 60


class BrokerSession:
    _instance = None
    _instance_lock = threading.Lock()

    def __init__(self):
        self.api = NorenApiPy()
        self._logged_in = False
        self._ws_started = False
        self._lock = threading.Lock()

        # key: "EXCH|TOKEN" -> callback(msg)
        self.feed_subscribers = {}
        # key: (EXCH, TSYM) -> callback(msg)
        self.order_subscribers = {}

        # -------- connection health --------
        self.ws_connected = False
        self._last_msg_time = 0
        self._reconnecting = threading.Event()
        self._watchdog_started = False

        # -------- access token bookkeeping --------
        self._token_updated_at = None  # set whenever this process applies a new token

    # -------- singleton accessor --------
    @classmethod
    def get(cls):
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = BrokerSession()
        return cls._instance

    # -------- access token (single value, stored in .env) --------
    def get_access_token(self):
        return settings.FT_ACCESS_TOKEN

    def get_access_token_status(self):
        raw = settings.FT_ACCESS_TOKEN or ""
        masked = f"{raw[:4]}••••{raw[-4:]}" if len(raw) > 8 else ("set" if raw else "")
        return {
            "is_set": bool(raw),
            "masked": masked,
            "updated_at": self._token_updated_at,
            "connected": self._logged_in,
            "ws_connected": self.ws_connected,
        }

    def _apply_token_change(self):
        """Common tail end of both the manual-paste and auto-generate
        paths: pick up the new token immediately in this running
        process (no restart needed), force a re-login, and reconnect
        the WebSocket if it was already running."""
        self._token_updated_at = datetime.now().isoformat()
        self._logged_in = False
        self.login(force=True)
        if self._ws_started:
            self.ws_connected = False
            self._schedule_reconnect()

    def update_access_token(self, new_token):
        """Manual-paste path: write straight to .env and apply."""
        new_token = (new_token or "").strip()
        if not new_token:
            raise ValueError("Access token cannot be empty")

        from services.access_token_generator import save_token_to_env
        save_token_to_env(new_token)
        settings.FT_ACCESS_TOKEN = new_token
        logging.info("🔑 [Broker] Access token updated manually and saved to .env")
        self._apply_token_change()

    def apply_generated_token(self, new_token):
        """Auto-generate path: services.access_token_generator has
        already written the token to .env itself (reusing the user's
        original script) — this just applies it to the running
        process."""
        settings.FT_ACCESS_TOKEN = new_token
        logging.info("🔑 [Broker] Access token generated and applied from .env")
        self._apply_token_change()

    # -------- login --------
    def login(self, force=False):
        with self._lock:
            if self._logged_in and not force:
                return
            token = self.get_access_token()
            if not token:
                raise RuntimeError(
                    "No broker access token configured. Use 'Generate Access Token' or "
                    "'Save & Apply' in the dashboard, or set FT_ACCESS_TOKEN in .env."
                )
            self.api.set_session(
                userid=settings.FT_USER,
                password=settings.FT_PWD,
                usertoken=token
            )
            self._logged_in = True
            logging.info("✅ [Broker] Shared session established for %s", settings.FT_USER)

    # -------- feed subscription registry --------
    def register_feed(self, exchange, token, callback):
        key = f"{exchange}|{token}"
        with self._lock:
            self.feed_subscribers[key] = callback
        if self._ws_started and self.ws_connected:
            try:
                self.api.subscribe(key)
                logging.info("📡 [Broker] Subscribed to %s", key)
            except Exception as e:
                logging.error("Broker subscribe error for %s → %s", key, e)

    def unregister_feed(self, exchange, token):
        key = f"{exchange}|{token}"
        with self._lock:
            self.feed_subscribers.pop(key, None)
        if self._ws_started and self.ws_connected:
            try:
                self.api.unsubscribe(key)
                logging.info("📴 [Broker] Unsubscribed from %s", key)
            except Exception as e:
                logging.warning("Broker unsubscribe error for %s → %s", key, e)

    # -------- order-update registry --------
    def register_order_handler(self, exchange, tsym, callback):
        with self._lock:
            self.order_subscribers[(exchange, tsym)] = callback

    def unregister_order_handler(self, exchange, tsym):
        with self._lock:
            self.order_subscribers.pop((exchange, tsym), None)

    # -------- central dispatch --------
    def _central_feed_handler(self, msg):
        self._last_msg_time = time.time()
        if "lp" not in msg:
            return
        key = f"{msg.get('e')}|{msg.get('tk')}"
        cb = self.feed_subscribers.get(key)
        if cb:
            try:
                cb(msg)
            except Exception as e:
                logging.error("Feed handler error for %s → %s", key, e)

    def _central_order_handler(self, msg):
        self._last_msg_time = time.time()
        key = (msg.get("exch"), msg.get("tsym"))
        cb = self.order_subscribers.get(key)
        if cb:
            try:
                cb(msg)
            except Exception as e:
                logging.error("Order handler error for %s → %s", key, e)
        else:
            logging.debug("⚠️ [Broker] Order update for unregistered symbol → %s", key)

    def _on_socket_open(self):
        self.ws_connected = True
        self._last_msg_time = time.time()
        logging.info("🚀 [Broker] WebSocket connected — resubscribing all symbols")
        with self._lock:
            keys = list(self.feed_subscribers.keys())
        for key in keys:
            try:
                self.api.subscribe(key)
                logging.info("📡 [Broker] Subscribed to %s", key)
            except Exception as e:
                logging.error("Resubscribe error for %s → %s", key, e)

    def _on_socket_close(self, *args, **kwargs):
        was_connected = self.ws_connected
        self.ws_connected = False
        if was_connected:
            logging.warning("🔌 [Broker] WebSocket closed → %s", args or kwargs or "no reason given")
        self._schedule_reconnect()

    def _on_socket_error(self, *args, **kwargs):
        self.ws_connected = False
        logging.error("⚡ [Broker] WebSocket error → %s", args or kwargs)
        self._schedule_reconnect()

    # -------- reconnect --------
    def _schedule_reconnect(self):
        if self._reconnecting.is_set():
            return  # a reconnect loop is already running
        threading.Thread(target=self._reconnect_loop, daemon=True, name="broker-reconnect").start()

    def _reconnect_loop(self):
        self._reconnecting.set()
        backoff = RECONNECT_BACKOFF_START
        try:
            while not self.ws_connected:
                with self._lock:
                    have_symbols = bool(self.feed_subscribers)
                if not have_symbols:
                    logging.info("💤 [Broker] No active symbols — pausing reconnect attempts")
                    return

                logging.warning("🔄 [Broker] Reconnecting in %ss...", backoff)
                time.sleep(backoff)

                try:
                    self.login(force=True)
                    self.api.start_websocket(
                        subscribe_callback=self._central_feed_handler,
                        order_update_callback=self._central_order_handler,
                        socket_open_callback=self._on_socket_open,
                        **self._optional_close_error_kwargs()
                    )
                    time.sleep(2)  # give the SDK a moment to actually open the socket
                    if self.ws_connected:
                        logging.info("✅ [Broker] Reconnected successfully")
                        break
                except Exception as e:
                    logging.error("Reconnect attempt failed → %s", e)

                backoff = min(backoff * 2, RECONNECT_BACKOFF_MAX)
        finally:
            self._reconnecting.clear()

    def _optional_close_error_kwargs(self):
        """Not every broker SDK version accepts socket_close_callback /
        socket_error_callback — probe the signature so we don't crash on
        SDKs that only support subscribe/order/open callbacks. The
        heartbeat watchdog below still catches silent drops either way."""
        try:
            sig = inspect.signature(self.api.start_websocket)
            kwargs = {}
            if "socket_close_callback" in sig.parameters:
                kwargs["socket_close_callback"] = self._on_socket_close
            if "socket_error_callback" in sig.parameters:
                kwargs["socket_error_callback"] = self._on_socket_error
            return kwargs
        except (TypeError, ValueError):
            return {}

    # -------- heartbeat watchdog (catches silent/uncallback'd drops) --------
    def _start_watchdog(self):
        if self._watchdog_started:
            return
        self._watchdog_started = True
        threading.Thread(target=self._watchdog_loop, daemon=True, name="broker-watchdog").start()

    def _watchdog_loop(self):
        while True:
            time.sleep(HEARTBEAT_CHECK_EVERY)
            with self._lock:
                have_symbols = bool(self.feed_subscribers)
            if not have_symbols or not self._ws_started:
                continue
            if not self._is_market_hours():
                continue
            if not self.ws_connected:
                continue  # reconnect loop already handling this

            idle = time.time() - self._last_msg_time
            if idle > HEARTBEAT_TIMEOUT:
                logging.warning(
                    "🫀 [Broker] No messages for %.0fs (>%ss) during market hours — forcing reconnect",
                    idle, HEARTBEAT_TIMEOUT
                )
                self.ws_connected = False
                self._schedule_reconnect()

    @staticmethod
    def _is_market_hours():
        now = datetime.now(IST)
        if now.weekday() >= 5:  # Sat/Sun — best-effort, doesn't account for holidays
            return False
        return dtime(9, 15) <= now.time() <= dtime(15, 30)

    def start_websocket(self):
        with self._lock:
            if self._ws_started:
                return
            self._ws_started = True

        self.login()
        self.api.start_websocket(
            subscribe_callback=self._central_feed_handler,
            order_update_callback=self._central_order_handler,
            socket_open_callback=self._on_socket_open,
            **self._optional_close_error_kwargs()
        )
        self._start_watchdog()

    # -------- REST passthroughs used by trading_engine --------
    def get_order_book(self):
        self.login()
        return self.api.get_order_book()

    def get_positions(self):
        self.login()
        return self.api.get_positions()

    def get_quotes(self, exchange, token):
        self.login()
        return self.api.get_quotes(exchange=exchange, token=token)

    def search_symbols(self, exchange, search_text):
        self.login()
        return self.api.searchscrip(
            exchange=exchange,
            searchtext=search_text
        )    

    def place_order(self, **kwargs):
        self.login()
        return self.api.place_order(**kwargs)

    def modify_order(self, **kwargs):
        self.login()
        return self.api.modify_order(**kwargs)

    def cancel_order(self, **kwargs):
        self.login()
        return self.api.cancel_order(**kwargs)
