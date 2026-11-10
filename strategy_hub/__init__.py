# -*- coding: utf-8 -*-
"""
strategy_hub — the "Algo symbols" hub method (port of the strategy_hub_package).

The package ran ONE OS subprocess per exchange (masters/renko_multi.py registered
with OpenAlgo's /python page) that polled a config DB and hosted one RenkoStrategy
instance per ENABLED symbol row. NexAlgo is a single-process app with one shared
BrokerSession, so the same method runs IN-PROCESS:

  db.py       own SQLite store (database/strategy_hub.db, WAL): strategy_symbol /
              symbol_status / symbol_command / process_state
  runtime.py  stdlib-only config/status/command channel (same file — kept so the
              body could later be lifted into a real subprocess unchanged)
  service.py  validation + CRUD (squareoff-before-schedule-stop, lot-multiple,
              tick parity, edits only while disabled, version bumps)
  manager.py  SymbolManager: one TradingEngine instance per enabled row, config
              poll → start/stop, SQUAREOFF command dispatch, status publishing
  registry.py one managed "process" per exchange (thread), schedules, start/stop/
              restart, armed states, auto-start after platform boot
  routes.py   FastAPI router at /strategy-hub/api/* (blueprint.py parity)
"""
