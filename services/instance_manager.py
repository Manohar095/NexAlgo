# -*- coding: utf-8 -*-
"""
services/instance_manager.py
==============================
Owns the in-memory dict of running/stopped TradingEngine instances and
keeps SQLite in sync. This is the only place that creates or destroys
a TradingEngine — the API layer never touches strategy internals
directly.
"""

import logging
import threading

from database import db
from models.symbol_config import SymbolConfig
from strategy.broker import BrokerSession
from strategy.trading_engine import TradingEngine


class InstanceManager:
    def __init__(self):
        self.broker = BrokerSession.get()
        self._instances = {}  # id -> TradingEngine
        self._lock = threading.Lock()
        self.on_log = None      # callback(instance_id, entry) for ws broadcast
        self.on_status = None   # callback(instance_id, status_dict) for ws broadcast
        self.on_watchlist_status = None  # callback(watchlist_id, status_dict) for ws broadcast

    def set_callbacks(self, on_log=None, on_status=None, on_watchlist_status=None):
        self.on_log = on_log
        self.on_status = on_status
        self.on_watchlist_status = on_watchlist_status

    # -------- bootstrap --------
    def load_from_db(self, autostart_saved=True):
        db.init_db()
        records = db.list_symbols()
        for rec in records:
            cfg = SymbolConfig(**rec["config"])
            self._create_instance(rec["id"], cfg)
            if autostart_saved and cfg.autostart:
                try:
                    self.start(rec["id"])
                except Exception as e:
                    logging.error("Autostart failed for %s → %s", rec["id"], e)

    def _create_instance(self, instance_id, cfg):
        engine = TradingEngine(
            instance_id=instance_id,
            cfg=cfg,
            broker=self.broker,
            on_log=self.on_log,
            on_status=self.on_status,
        )
        with self._lock:
            self._instances[instance_id] = engine
        return engine

    # -------- CRUD --------
    def create_symbol(self, config_dict):
        cfg = SymbolConfig(**config_dict)  # validate
        rec = db.create_symbol(cfg.model_dump(mode="json"))
        self._create_instance(rec["id"], cfg)
        return rec

    def update_symbol(self, instance_id, config_dict):
        cfg = SymbolConfig(**config_dict)  # validate
        rec = db.update_symbol(instance_id, cfg.model_dump(mode="json"))
        if rec is None:
            return None

        was_running = False
        with self._lock:
            existing = self._instances.get(instance_id)
            if existing:
                was_running = existing.status == "RUNNING"
                if was_running:
                    existing.stop()

        self._create_instance(instance_id, cfg)
        if was_running:
            self.start(instance_id)
        return rec

    def delete_symbol(self, instance_id):
        with self._lock:
            engine = self._instances.pop(instance_id, None)
        if engine and engine.status == "RUNNING":
            engine.stop()
        return db.delete_symbol(instance_id)

    def list_symbols(self):
        return db.list_symbols()

    # -------- lifecycle --------
    def get_engine(self, instance_id):
        with self._lock:
            return self._instances.get(instance_id)

    def start(self, instance_id):
        engine = self.get_engine(instance_id)
        if not engine:
            raise KeyError(f"No instance for id {instance_id}")
        engine.start()
        return engine.get_status()

    def stop(self, instance_id):
        engine = self.get_engine(instance_id)
        if not engine:
            raise KeyError(f"No instance for id {instance_id}")
        engine.stop()
        return engine.get_status()

    def restart(self, instance_id):
        engine = self.get_engine(instance_id)
        if not engine:
            raise KeyError(f"No instance for id {instance_id}")
        engine.restart()
        return engine.get_status()

    def squareoff(self, instance_id):
        engine = self.get_engine(instance_id)
        if not engine:
            raise KeyError(f"No instance for id {instance_id}")
        return engine.squareoff()

    # -------- dashboard --------
    def all_statuses(self):
        with self._lock:
            engines = list(self._instances.values())
        return [e.get_status() for e in engines]

    def get_logs(self, instance_id):
        engine = self.get_engine(instance_id)
        if not engine:
            raise KeyError(f"No instance for id {instance_id}")
        return list(engine.log_buffer)

    def global_logs(self, limit=200):
        with self._lock:
            engines = list(self._instances.values())
        merged = []
        for e in engines:
            for entry in e.log_buffer:
                merged.append({**entry, "symbol": e.cfg.strategy_name, "id": e.id})
        merged.sort(key=lambda x: x["time"])
        return merged[-limit:]

    # -------- Watchlist Management --------
    def add_to_watchlist(self, exchange, token, symbol, callback_id=None):
        """
        Add a symbol to watchlist for real-time tracking.
        Returns a watchlist_id that can be used to reference this item.
        """
        if callback_id is None:
            callback_id = f"wl_{exchange}_{token}"
        
        # Register with broker to receive feed updates
        self.broker.register_watchlist_feed(
            exchange=exchange,
            token=token,
            callback_id=callback_id,
            callback=self._handle_watchlist_tick
        )
        
        # Get initial status
        initial_status = self.broker.get_watchlist_status(exchange, token)
        if initial_status:
            initial_status['symbol'] = symbol
            initial_status['exchange'] = exchange
            initial_status['token'] = token
            if self.on_watchlist_status:
                self.on_watchlist_status(callback_id, initial_status)
        
        return callback_id
    
    def remove_from_watchlist(self, exchange, token, callback_id=None):
        """Remove a symbol from watchlist"""
        if callback_id is None:
            callback_id = f"wl_{exchange}_{token}"
        self.broker.unregister_watchlist_feed(exchange, token, callback_id)
    
    def _handle_watchlist_tick(self, callback_id, status_data):
        """Handle incoming watchlist tick data and broadcast"""
        if self.on_watchlist_status:
            self.on_watchlist_status(callback_id, status_data)

    def get_watchlist_status(self, exchange, token):
        """Get current watchlist status for a symbol"""
        return self.broker.get_watchlist_status(exchange, token)


instance_manager = InstanceManager()