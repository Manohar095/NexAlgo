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
        # Chart feed "funnel" subscribers. The dashboard chart needs broker
        # subscriptions for symbols that are NOT being traded, but it must
        # never steal the callback slot an engine owns for the same key.
        # key: "EXCH|TOKEN" -> refcount
        self._passive_counts = {}
        # key: "EXCH|TOKEN" -> True when the callback slot is OUR no-op
        # (cleared if a real subscriber later claims the same key)
        self._passive_owns_slot = set()
        # key: callback_id -> {"exchange": str, "token": str, "callback": function}
        self.watchlist_subscribers = {}
        # key: (EXCH, TSYM) -> callback(msg)
        self.order_subscribers = {}
        self.prev_close_cache = {}  # (key: "EXCH|TOKEN" -> previous close)
        self._watchlist_status_cache = {}  # key: "EXCH|TOKEN" -> status dict

        # -------- normalized market data (OpenAlgo market-data port) --------
        # Noren partial frames (tk / dk) carry ONLY the fields that changed,
        # so every frame refines a running per-key snapshot and WS clients
        # always receive the latest complete set. This mirrors the merge
        # cache the OpenAlgo websocket proxy keeps in its broker adapters.
        self._md_cache = {}          # key "EXCH|TOKEN" -> snapshot dict
        # key -> {"ltp": n, "quote": n, "depth": n} — passive refcounts BY
        # MODE. Desired broker feed types derive from these + engines.
        self._passive_modes = {}
        # key -> set of feed types the broker has actually been TOLD to send
        # (touchline 't' = 1, snapquote 'd' = 2). Socket-open resubscription
        # replays this desired state; registry mutations diff against it.
        self._key_feed_types = {}

        # -------- optional global taps (set by main.py) --------
        # Market-data tap: called per feed frame with
        # {"exchange","token","key","feed","data"} — WS clients get the
        # normalized payload. Must return fast and swallow its own errors;
        # it runs on the SDK's websocket thread.
        self._tick_listener = None
        # Order-update tap: called once per incoming order frame ('om') so
        # subscribed UIs can refresh themselves (OpenAlgo's order stream).
        self._order_listener = None

        # Noren feed-type ids (mirrors NorenApi.FeedType)
        self.TOUCHLINE_FEED = 1  # 't'  — touchline, LTP/quote fields
        self.SNAPQUOTE_FEED  = 2  # 'd' — 5-level snapshot quote

        # -------- connection health --------
        self.ws_connected = False
        self._last_msg_time = 0
        self._reconnecting = threading.Event()
        self._watchdog_started = False

        # -------- access token bookkeeping --------
        self._token_updated_at = None  # set whenever this process applies a new token

        # -------- dashboard chart tick tap --------
        # Optional hook set by main.py: called once per incoming tick so the
        # charts page gets live prices over the dashboard /ws socket. Must
        # return fast and swallow its own errors — it runs on the SDK's
        # websocket thread.
        self._tick_listener = None

    def set_tick_listener(self, fn):
        self._tick_listener = fn

    def set_order_listener(self, fn):
        self._order_listener = fn

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
            # When an engine takes over a slot the chart funnel only
            # borrowed (the no-op callback), the slot passes to the engine.
            # Otherwise the funnel's later release would pop the engine's
            # callback and drop its touchline subscription.
            if self._passive_counts.get(key, 0) > 0:
                self._passive_owns_slot.discard(key)
        self._sync_broker_feed_types(key)

    def unregister_feed(self, exchange, token):
        key = f"{exchange}|{token}"
        gone = True
        with self._lock:
            self.feed_subscribers.pop(key, None)
            # The dashboard chart may still be watching this instrument even
            # though the engine stopped — re-claim the callback slot with our
            # no-op so the UI funnel keeps receiving ticks.
            still_passive = self._passive_counts.get(key, 0) > 0
            if still_passive:
                self._passive_owns_slot.add(key)
                self.feed_subscribers[key] = self._passive_noop
                gone = False
        self._sync_broker_feed_types(key)
        if gone:
            self._md_cache.pop(key, None)

    # -------- chart funnel / passive subscriptions --------
    # A no-op callback for the shared feed_subscribers slot — chart ticks
    # are delivered globally by the tick tap, not via this callback.
    def _passive_noop(self, msg):
        pass

    # -------- broker feed-type maintenance (OpenAlgo adapter parity) --------
    def _desired_feed_types(self, key):
        """Touchline while anyone (engine or UI funnel) is subscribed;
        additionally the 5-level snapquote while any passive depth viewer
        exists. Exactly how the OpenAlgo flattrade adapter keeps touchline
        and snapshot ('d') refcounts coexisting for one scrip."""
        desired = set()
        with self._lock:
            if key in self.feed_subscribers:
                desired.add(self.TOUCHLINE_FEED)
            if (self._passive_modes.get(key) or {}).get("depth", 0) > 0:
                desired.add(self.SNAPQUOTE_FEED)
        return desired

    def _sync_broker_feed_types(self, key):
        """Send/unsend exactly the feed types the broker should be streaming
        for this key right now. No-ops while the socket is down — socket-open
        resubscription replays the whole desired state instead."""
        with self._lock:
            current = set(self._key_feed_types.get(key, set()))
        desired = self._desired_feed_types(key)
        add = desired - current
        drop = current - desired
        with self._lock:
            if desired:
                self._key_feed_types[key] = desired
            else:
                self._key_feed_types.pop(key, None)
        if not self._ws_started or not self.ws_connected:
            return
        try:
            for ft in sorted(add):
                self.api.subscribe(key, feed_type=ft)
            for ft in sorted(drop):
                self.api.unsubscribe(key, feed_type=ft)
            if add or drop:
                logging.info("📡 [Broker] Feed types for %s → %s", key,
                             ",".join(str(ft) for ft in sorted(desired)) or "none")
        except Exception as e:
            logging.warning("Broker feed-type sync error for %s → %s", key, e)

    def _resubscribe_all_feed_types(self):
        """Socket (re)open: replay the full desired state per key."""
        with self._lock:
            keys = set(self.feed_subscribers.keys()) | set(self._passive_modes.keys())
        replay = {}
        for key in sorted(keys):
            replay[key] = self._desired_feed_types(key)
        with self._lock:
            self._key_feed_types = dict(replay)
        for key, feed_types in replay.items():
            for ft in sorted(feed_types):
                try:
                    self.api.subscribe(key, feed_type=ft)
                except Exception as e:
                    logging.error("Resubscribe error for %s (feed type %s) → %s", key, ft, e)

    # -------- normalized market data --------
    @staticmethod
    def _num(v):
        if v is None or v == "":
            return None
        try:
            f = float(v)
            return f
        except (TypeError, ValueError):
            return None

    def _md_snapshot_from_msg(self, msg):
        """Merge a (possibly partial) Noren touchline (tf/tk) or snapquote
        (df/dk) frame into the running per-key snapshot and return
        (key, snapshot). Field mapping follows the OpenAlgo flattrade
        adapter's normalized market-data payload; `c` is mapped to
        prev_close the way both this codebase's legacy funnel and OpenAlgo's
        data adapter treat it."""
        key = f"{msg.get('e')}|{msg.get('tk')}"
        with self._lock:
            snap = dict(self._md_cache.get(key) or {})
        m = {
            "ltp": self._num(msg.get("lp")),
            "open": self._num(msg.get("o")),
            "high": self._num(msg.get("h")),
            "low": self._num(msg.get("l")),
            "prev_close": self._num(msg.get("c")),
            "change_percent": self._num(msg.get("pc")),
            "volume": self._num(msg.get("v")),
            "oi": self._num(msg.get("oi")),
            "bid": self._num(msg.get("bp1")),
            "ask": self._num(msg.get("sp1")),
            "bid_qty": self._num(msg.get("bq1")),
            "ask_qty": self._num(msg.get("sq1")),
            "tick_size": self._num(msg.get("ti")),
            "last_qty": self._num(msg.get("ltq")),
            "last_trade_time": msg.get("ltt"),
            "ts": int(msg.get("ft") or 0) or None,
        }
        for k, v in m.items():
            if v is not None:
                snap[k] = v
        tsym = msg.get("ts") or msg.get("tsym")
        if tsym:
            snap["tsym"] = tsym

        # Depth levels arrive on snapquote frames; a frame that carries the
        # side's best level is treated as a fresh 5-level snapshot of that
        # side (Noren depth frames are whole-side), never merged with stale
        # levels.
        if msg.get("bp1"):
            rows = []
            for i in range(1, 6):
                p = self._num(msg.get(f"bp{i}"))
                if p is None or p <= 0:
                    continue
                rows.append({
                    "price": p,
                    "quantity": self._num(msg.get(f"bq{i}")) or 0.0,
                    "orders": self._num(msg.get(f"bo{i}")) or 0.0,
                })
            if rows:
                d = dict(snap.get("depth") or {})
                d["buy"] = rows
                snap["depth"] = d
        if msg.get("sp1"):
            rows = []
            for i in range(1, 6):
                p = self._num(msg.get(f"sp{i}"))
                if p is None or p <= 0:
                    continue
                rows.append({
                    "price": p,
                    "quantity": self._num(msg.get(f"sq{i}")) or 0.0,
                    "orders": self._num(msg.get(f"so{i}")) or 0.0,
                })
            if rows:
                d = dict(snap.get("depth") or {})
                d["sell"] = rows
                snap["depth"] = d

        # Derived change fields (OpenAlgo clients expect both).
        lp = snap.get("ltp")
        pc0 = snap.get("prev_close")
        if lp is not None and pc0:
            snap["change"] = round(lp - pc0, 4)
            if pc0 != 0:
                snap["change_percent"] = round((lp - pc0) / pc0 * 100.0, 4)

        with self._lock:
            self._md_cache[key] = snap
        return key, snap

    def get_md_snapshot(self, exchange=None, token=None, key=None):
        """Latest merged snapshot for "EXCH|TOKEN" (copy) — delivered to a
        new WS subscriber immediately, before the next raw frame."""
        k = key or f"{exchange}|{token}"
        with self._lock:
            snap = self._md_cache.get(k)
        return dict(snap) if snap else None

    def register_passive_subscriber(self, exchange, token, mode="quote"):
        """Chart/UI-only feed subscription: refcounted per connection and per
        MODE (OpenAlgo proxy parity), never steals an engine's callback slot.
        Ticks reach the UI via set_tick_listener, not via a callback.
        mode: "ltp" | "quote" | "depth" — a depth viewer upgrades the broker
        feed to 5-level snapshots (Noren `d`), exactly like the OpenAlgo
        flattrade adapter's depth refcount."""
        mode = mode if mode in ("ltp", "quote", "depth") else "quote"
        key = f"{exchange}|{token}"
        with self._lock:
            modes = self._passive_modes.setdefault(key, {"ltp": 0, "quote": 0, "depth": 0})
            modes[mode] += 1
            self._passive_counts[key] = self._passive_counts.get(key, 0) + 1
            had_callback = key in self.feed_subscribers
            if not had_callback:
                self._passive_owns_slot.add(key)
                self.feed_subscribers[key] = self._passive_noop
        self._sync_broker_feed_types(key)
        return key

    def unregister_passive_subscriber(self, exchange, token, mode="quote"):
        mode = mode if mode in ("ltp", "quote", "depth") else "quote"
        key = f"{exchange}|{token}"
        with self._lock:
            modes = self._passive_modes.get(key)
            if not modes:  # unknown already — cleanup defensively
                self._passive_counts.pop(key, None)
                return
            if (modes.get(mode) or 0) > 0:
                modes[mode] -= 1
            count = max(self._passive_counts.get(key, 0) - 1, 0)
            if count > 0:
                self._passive_counts[key] = count
            else:
                self._passive_counts.pop(key, None)
                self._passive_modes.pop(key, None)
                if key in self._passive_owns_slot:
                    self._passive_owns_slot.discard(key)
                    self.feed_subscribers.pop(key, None)
        self._sync_broker_feed_types(key)
        if count <= 0:
            self._md_cache.pop(key, None)

    # -------- watchlist feed registry --------
    def register_watchlist_feed(self, exchange, token, callback_id, callback):
        """Register a watchlist feed callback without starting a trading engine"""
        key = f"{exchange}|{token}"
        with self._lock:
            self.watchlist_subscribers[callback_id] = {
                "exchange": exchange,
                "token": token,
                "key": key,
                "callback": callback
            }
        
        # Register as a normal feed subscriber to get ticks
        # We wrap the callback to pass status objects instead of raw ticks
        self.register_feed(exchange, token, self._create_watchlist_wrapper(callback_id))
        
        logging.info("👁️ [Broker] Watchlist registered for %s", key)

    def unregister_watchlist_feed(self, exchange, token, callback_id):
        """Unregister a watchlist feed"""
        key = f"{exchange}|{token}"
        with self._lock:
            self.watchlist_subscribers.pop(callback_id, None)
        self.unregister_feed(exchange, token)
        logging.info("👁️ [Broker] Watchlist unregistered for %s", key)

    def _create_watchlist_wrapper(self, callback_id):
        """Create a wrapper that converts raw ticks to status objects"""
        def wrapper(msg):
            if 'lp' not in msg or 'tk' not in msg or 'e' not in msg:
                return
            
            key = f"{msg.get('e')}|{msg.get('tk')}"
            
            # Build status object
            status = {
                'ltp': float(msg.get('lp', 0)),
                'prev_close': self.prev_close_cache.get(key, 0),
                'high': float(msg.get('h', 0)) if msg.get('h') else None,
                'low': float(msg.get('l', 0)) if msg.get('l') else None,
                'volume': float(msg.get('v', 0)) if msg.get('v') else None,
                'open': float(msg.get('o', 0)) if msg.get('o') else None,
                'bid': float(msg.get('bp1', 0)) if msg.get('bp1') else None,
                'ask': float(msg.get('sp1', 0)) if msg.get('sp1') else None,
                'last_updated': msg.get('ltt') or msg.get('exd') or datetime.now().isoformat(),
                'exchange': msg.get('e'),
                'token': msg.get('tk')
            }
            
            # Cache it
            self._watchlist_status_cache[key] = status
            
            # Call the watchlist subscriber
            with self._lock:
                subscriber = self.watchlist_subscribers.get(callback_id)
            if subscriber:
                try:
                    subscriber['callback'](callback_id, status)
                except Exception as e:
                    logging.error(f"Watchlist callback error for {key} → {e}")
        
        return wrapper

    def get_watchlist_status(self, exchange, token):
        """Get current status for a watchlist symbol"""
        key = f"{exchange}|{token}"
        
        # First try cache
        if key in self._watchlist_status_cache:
            return self._watchlist_status_cache[key]
        
        # Fall back to REST quote
        try:
            quote = self.get_quotes(exchange, token)
            if quote and quote.get('stat') == 'Ok':
                status = {
                    'ltp': float(quote.get('lp', 0)),
                    'prev_close': float(quote.get('c') or quote.get('o') or 0),
                    'high': float(quote.get('h', 0)) if quote.get('h') else None,
                    'low': float(quote.get('l', 0)) if quote.get('l') else None,
                    'volume': float(quote.get('v', 0)) if quote.get('v') else None,
                    'open': float(quote.get('o', 0)) if quote.get('o') else None,
                    'bid': float(quote.get('bp1', 0)) if quote.get('bp1') else None,
                    'ask': float(quote.get('sp1', 0)) if quote.get('sp1') else None,
                    'last_updated': quote.get('ltt') or quote.get('exd') or datetime.now().isoformat(),
                    'exchange': exchange,
                    'token': token
                }
                self._watchlist_status_cache[key] = status
                return status
        except Exception as e:
            logging.error(f"Failed to get watchlist status for {key}: {e}")
        
        return None

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

        # Cache previous close
        if 'c' in msg and 'tk' in msg and 'e' in msg:
            key = f"{msg.get('e')}|{msg.get('tk')}"
            try:
                self.prev_close_cache[key] = float(msg.get('c', 0))
            except (ValueError, TypeError):
                pass

        # Normalized market-data tap — runs for EVERY frame type (touchline
        # tf/tk AND snapquote df/dk), not only `lp` ticks, so depth viewers
        # get depth levels too. Runs before the lp early-return below.
        if self._tick_listener is not None and ("e" in msg and "tk" in msg):
            try:
                key, snap = self._md_snapshot_from_msg(msg)
                self._tick_listener({
                    "exchange": msg.get("e"),
                    "token": str(msg.get("tk")),
                    "key": key,
                    "feed": "depth" if msg.get("t") in ("df", "dk") else "quote",
                    "data": snap,
                })
            except Exception as e:
                logging.debug("Market-data tap error → %s", e)

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

        # Global order-update tap (OpenAlgo order-stream parity): subscribed
        # UIs refresh themselves from this. Cheap, error-swallowing.
        if self._order_listener is not None:
            try:
                self._order_listener(msg)
            except Exception as e:
                logging.debug("Order tap error → %s", e)

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
        self._resubscribe_all_feed_types()

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
        result = self.api.get_quotes(exchange=exchange, token=token)
        
        # Inject previous close from cache
        if result and result.get('stat') == 'Ok':
            key = f"{exchange}|{token}"
            if key in self.prev_close_cache:
                result['c'] = str(self.prev_close_cache[key])
        
        return result

    def search_symbols(self, exchange, search_text):
        self.login()
        return self.api.searchscrip(
            exchange=exchange,
            searchtext=search_text
        )    

    # ------------------------------------------------------------------
    # PiConnect doc endpoints (GetOptionChain / GetOptionGreek) + scrip info
    # ------------------------------------------------------------------
    @staticmethod
    def _session_expired(emsg):
        """PiConnect reports session expiry as Not_Ok with explanatory emsg
        (SPEC) — any of these shapes is a re-auth trigger."""
        e = str(emsg or "").lower()
        return any(p in e for p in ("session", "susertoken", "invalid token",
                                    "token expired", "not logged in", "unauthorised", "unauthorized"))

    def get_pi_option_chain(self, exchange, tsym, strprc, cnt):
        self.login()
        return self.api.pi_get_option_chain(
            exch=exchange, tsym=tsym, strprc=strprc, cnt=cnt)

    def get_pi_option_greek(self, exd, strprc, sptprc, int_rate, volatility, optt):
        self.login()
        resp = self.api.pi_get_option_greek(
            exd=exd, strprc=strprc, sptprc=sptprc,
            int_rate=int_rate, volatility=volatility, optt=optt)
        if resp.get("stat") == "Not_Ok" and self._session_expired(resp.get("emsg")):
            logging.warning("[Broker] GetOptionGreek reports session expiry — re-applying session and retrying once")
            self.login(force=True)
            resp = self.api.pi_get_option_greek(
                exd=exd, strprc=strprc, sptprc=sptprc,
                int_rate=int_rate, volatility=volatility, optt=optt)
        return resp

    def get_scrip_info(self, exchange, token):
        """GetSecurityInfo — the chain expiry (`exd`) comes from the
        underlying futures scrip, one call covers the whole chain."""
        self.login()
        return self.api.get_security_info(exchange=exchange, token=str(token))

    def place_order(self, **kwargs):
        self.login()
        return self.api.place_order(**kwargs)

    def modify_order(self, **kwargs):
        self.login()
        return self.api.modify_order(**kwargs)

    def cancel_order(self, **kwargs):
        self.login()
        return self.api.cancel_order(**kwargs)

    def get_trade_book(self):
        """Get tradebook using the broker API"""
        self.login()
        if hasattr(self.api, 'get_trade_book'):
            return self.api.get_trade_book()
        elif hasattr(self.api, 'get_tradebook'):
            return self.api.get_tradebook()
        else:
            try:
                return self.api.get_trade_book()
            except AttributeError:
                logging.error("Trade book method not available in API")
                return {"stat": "Not_Ok", "emsg": "Trade book method not available"}

    def get_holdings(self, prd="C"):
        """Get holdings using the broker API"""
        self.login()
        if hasattr(self.api, 'get_holdings'):
            return self.api.get_holdings(prd=prd)
        else:
            try:
                return self.api.get_holdings()
            except AttributeError:
                logging.error("Holdings method not available in API")
                return {"stat": "Not_Ok", "emsg": "Holdings method not available"}