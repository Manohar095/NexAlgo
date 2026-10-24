# -*- coding: utf-8 -*-
"""
services/chart_feed.py
=======================
Refcount bridge between the dashboard charts page and BrokerSession's
chart funnel subscriptions.

The charts page opens broker subscriptions for instruments it wants to
follow that are not necessarily part of any running trading engine.
Each open tab registers itself under a client id, and a given
(exchange, token) maps to exactly ONE broker feed subscription no matter
how many tabs are watching it — hence the bookkeeping here, with every
mutation guarded by a threading.Lock like database/db.py.
"""

import logging
import threading

from strategy.broker import BrokerSession


class ChartFeedManager:
    def __init__(self, broker: BrokerSession):
        self._broker = broker
        self._views = {}  # (exchange, token) -> set(client_id)
        self._lock = threading.Lock()

    def subscribe(self, exchange: str, token: str, client_id: str = "default"):
        exchange = (exchange or "").upper()
        token = str(token)
        with self._lock:
            viewers = self._views.setdefault((exchange, token), set())
            viewers.add(client_id)
            count = len(viewers)
        self._broker.register_passive_subscriber(exchange, token)
        logging.info("📈 [ChartFeed] subscribe %s|%s (%s) → %s viewer(s)", exchange, token, client_id, count)
        return count

    def unsubscribe(self, exchange: str, token: str, client_id: str = "default"):
        exchange = (exchange or "").upper()
        token = str(token)
        with self._lock:
            viewers = self._views.get((exchange, token))
            if viewers is not None:
                viewers.discard(client_id)
                count = len(viewers)
                if not viewers:
                    self._views.pop((exchange, token), None)
            else:
                count = 0
        self._broker.unregister_passive_subscriber(exchange, token)
        logging.info("📉 [ChartFeed] unsubscribe %s|%s (%s) → %s left", exchange, token, client_id, count)
        return count


chart_feed_manager = ChartFeedManager(BrokerSession.get())
