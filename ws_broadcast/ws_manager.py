# -*- coding: utf-8 -*-
"""
websocket/ws_manager.py
=========================
Bridges synchronous strategy threads (TradingEngine runs its own
worker/monitor threads) to the asyncio event loop that serves the
FastAPI WebSocket endpoint. Strategy code calls broadcast_threadsafe()
from a plain thread; this schedules the actual send on the main loop.
"""

import asyncio
import json
import logging


class WSManager:
    def __init__(self):
        self.active_connections = set()
        self.loop = None  # set on app startup via set_loop()

    def set_loop(self, loop):
        self.loop = loop

    async def connect(self, websocket):
        await websocket.accept()
        self.active_connections.add(websocket)

    def disconnect(self, websocket):
        self.active_connections.discard(websocket)

    async def _broadcast(self, message: dict):
        dead = []
        payload = json.dumps(message)
        for ws in list(self.active_connections):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active_connections.discard(ws)

    def broadcast_threadsafe(self, message: dict):
        """Safe to call from any strategy worker thread."""
        if self.loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self._broadcast(message), self.loop)
        except Exception as e:
            logging.debug("WS broadcast skipped → %s", e)

    # -------- convenience wrappers used as InstanceManager callbacks --------
    def on_log(self, instance_id, entry):
        self.broadcast_threadsafe({"type": "log", "instance_id": instance_id, "entry": entry})

    def on_status(self, instance_id, status_dict):
        self.broadcast_threadsafe({"type": "status", "instance_id": instance_id, "status": status_dict})


ws_manager = WSManager()
