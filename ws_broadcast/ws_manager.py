# -*- coding: utf-8 -*-
"""
ws_broadcast/ws_manager.py
==========================
Bridges synchronous strategy threads (TradingEngine runs its own
worker/monitor threads) to the asyncio event loop that serves the
FastAPI WebSocket endpoint. Strategy code calls broadcast_threadsafe()
from a plain thread; this schedules the actual send on the main loop.

CHANNELS
--------
1. broadcast_threadsafe  — whole-fairwide frames for every client
   (engine logs, engine status). Unfiltered, like before.

2. broadcast_market_data — OpenAlgo websocket-proxy parity: every client
   declares WHICH instruments it wants via /ws subscribe actions; this
   manager keeps the per-connection subscription index and fans each
   keyed market-data frame out ONLY to those connections (instead of the
   old "every tick to every client" flood). A connection's broker feed
   refcount is released automatically when its socket drops.

3. broadcast_order_update — connections that opted in via
   {"action":"subscribe_orders"} receive account-level order updates
   (OpenAlgo's order stream), for UI refresh triggers.
"""

import asyncio
import json
import logging
import threading


class WSManager:
    def __init__(self):
        self.active_connections = set()
        self.loop = None  # set on app startup via set_loop()

        # OpenAlgo-style per-connection subscription index.
        self._md_lock = threading.Lock()
        self._conn_keys = {}        # ws -> set("EXCH|TOKEN")
        self._conn_key_modes = {}   # ws -> {key: mode it registered with}
        self._key_conns = {}        # key -> set(ws)
        self._order_conns = set()   # sockets that asked for order updates

    def set_loop(self, loop):
        self.loop = loop

    async def connect(self, websocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket):
        """Bookkeeping only — the caller drains broker refcounts via
        release_on_disconnect() (which also calls this)."""
        self.active_connections.discard(websocket)

    # ---------------- subscription index ----------------
    def add_subscription(self, websocket, exchange, token, mode="ltp"):
        """Record (ws, key). Returns the socket's view mode for bookkeeping;
        always O(1) work — the CALLER owns the broker refcount (one register
        per subscribe action, one unregister per remove)."""
        key = f"{(exchange or '').upper()}|{str(token)}"
        with self._md_lock:
            self._conn_key_modes.setdefault(websocket, {})[key] = mode
            self._conn_keys.setdefault(websocket, set()).add(key)
            self._key_conns.setdefault(key, set()).add(websocket)
        return mode

    def remove_subscription(self, websocket, exchange, token):
        """Drop the (ws, key) pair. Returns the mode this socket registered
        it with (needed to release the matching broker refcount), or None
        if the socket was not subscribed."""
        key = f"{(exchange or '').upper()}|{str(token)}"
        with self._md_lock:
            mode = self._conn_key_modes.get(websocket, {}).pop(key, None)
            ws_keys = self._conn_keys.get(websocket)
            if ws_keys is None:
                self._conn_key_modes.pop(websocket, None)  # drop stale entry
                return None  # unknown
            ws_keys.discard(key)
            if not ws_keys:
                self._conn_keys.pop(websocket, None)
                modes_left = self._conn_key_modes.get(websocket)
                if not modes_left:
                    self._conn_key_modes.pop(websocket, None)
            conns = self._key_conns.get(key)
            if conns is not None:
                conns.discard(websocket)
                if not conns:
                    self._key_conns.pop(key, None)
            return mode

    def release_on_disconnect(self, websocket):
        """Drop the socket's index entries. Returns (exchange, token, mode)
        for every key this socket must release its broker refcount for."""
        out = []
        with self._md_lock:
            mode_map = self._conn_key_modes.pop(websocket, {})
            ws_keys = self._conn_keys.pop(websocket, set())
            self._order_conns.discard(websocket)
            self.active_connections.discard(websocket)
            for key in ws_keys:
                conns = self._key_conns.get(key)
                if conns is not None:
                    conns.discard(websocket)
                    if not conns:
                        self._key_conns.pop(key, None)
                exchange, _, token = key.partition("|")
                out.append((exchange, token, mode_map.get(key, "ltp")))
        return out

    # ---------------- wanted-flags ----------------
    def enable_orders(self, websocket):
        self._order_conns.add(websocket)

    def disable_orders(self, websocket):
        self._order_conns.discard(websocket)

    # ---------------- sends ----------------
    async def _broadcast(self, message: dict):
        dead = []
        payload = json.dumps(message)
        for ws in list(self.active_connections):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.release_on_disconnect(ws)

    async def _broadcast_to(self, targets, message: dict):
        dead = []
        payload = json.dumps(message)
        for ws in targets:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.release_on_disconnect(ws)

    def broadcast_threadsafe(self, message: dict):
        """Global broadcast (logs/status). Safe from worker threads."""
        if self.loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast(message), self.loop)
        except Exception as e:
            logging.debug("WS broadcast skipped → %s", e)

    def broadcast_market_data(self, frame: dict):
        """Keyed fan-out: only sockets subscribed to the frame's instrument
        receive it (OpenAlgo proxy subscription_index behavior)."""
        if self.loop is None:
            return
        key = f"{(frame.get('exchange') or '').upper()}|{str(frame.get('token') or '')}"
        with self._md_lock:
            targets = [ws for ws in self._key_conns.get(key, set())
                       if ws in self.active_connections]
        if not targets:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast_to(targets, frame), self.loop)
        except Exception as e:
            logging.debug("WS market-data fanout skipped → %s", e)

    def broadcast_order_update(self, message: dict):
        """Order stream: only sockets that sent subscribe_orders."""
        if self.loop is None:
            return
        with self._md_lock:
            targets = [ws for ws in self._order_conns if ws in self.active_connections]
        if not targets:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast_to(targets, message), self.loop)
        except Exception as e:
            logging.debug("WS order fanout skipped → %s", e)

    # -------- convenience wrappers used as InstanceManager callbacks --------
    def on_log(self, instance_id, entry):
        self.broadcast_threadsafe({"type": "log", "instance_id": instance_id, "entry": entry})

    def on_status(self, instance_id, status_dict):
        self.broadcast_threadsafe({"type": "status", "instance_id": instance_id, "status": status_dict})


ws_manager = WSManager()
