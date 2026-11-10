# -*- coding: utf-8 -*-
"""
strategy_hub/db.py — the hub's own SQLite store.

Port of strategy_hub_package/strategy_hub/db.py on stdlib sqlite3 (NexAlgo has no
SQLAlchemy). Same tables:

  strategy_symbol  one row per configured symbol: settings + enabled + version +
                   tag_base (order tag prefix, stable per row)
  symbol_status    live status, written by the exchange process every ~2 s
  symbol_command   one-shot commands (SQUAREOFF), claimed by the process (max age 30 s)
  process_state    registry state that survives a platform restart (manually_stopped)

WAL mode + busy_timeout so the FastAPI threads and the manager loops share the
file concurrently; every call opens a short-lived connection guarded by a
process-wide lock (same pattern as database/db.py).
"""

import os
import sqlite3
import threading
import time

DB_FILE = os.getenv("STRATEGY_HUB_DB_URL", "sqlite:///database/strategy_hub.db").replace("sqlite:///", "", 1) \
    or "database/strategy_hub.db"

# Tables
_MS = ("id INTEGER PRIMARY KEY AUTOINCREMENT, "
       "strategy_id TEXT NOT NULL, "
       "symbol TEXT NOT NULL, "
       "exchange TEXT NOT NULL, "
       "enabled INTEGER NOT NULL DEFAULT 0, "
       "version INTEGER NOT NULL DEFAULT 1, "          # bumped on every edit
       "tag_base TEXT NOT NULL UNIQUE, "               # order tag prefix, stable per row
       "strategy_name TEXT, "                          # display name (search dname)
       "token TEXT, "                                  # broker instrument token (engine needs it)
       "product TEXT NOT NULL DEFAULT 'MIS', "
       "quantity INTEGER NOT NULL DEFAULT 1, "
       "lot_size INTEGER, "                            # informational, from the scrip master
       "brick_size REAL NOT NULL DEFAULT 1.0, "
       "brick_method TEXT NOT NULL DEFAULT 'fixed', "   # fixed | atr | ltp_pct
       "atr_period INTEGER NOT NULL DEFAULT 14, "
       "atr_multiplier REAL NOT NULL DEFAULT 1.0, "
       "ltp_percent REAL NOT NULL DEFAULT 0.25, "
       "g2r INTEGER NOT NULL DEFAULT 2, "
       "r2g INTEGER NOT NULL DEFAULT 2, "
       "buy_brick_no INTEGER NOT NULL DEFAULT 1, "
       "sell_brick_no INTEGER NOT NULL DEFAULT -1, "
       "limit_buy_brick_no INTEGER NOT NULL DEFAULT 1, "   # limit = brick_price + N * brick_size
       "limit_sell_brick_no INTEGER NOT NULL DEFAULT 1, "  # limit = brick_price - N * brick_size
       "entry_trail_bricks REAL NOT NULL DEFAULT 2, "      # pending entry pinned N bricks from live brick
       "sl_trail_bricks REAL NOT NULL DEFAULT 2, "         # SL pinned N bricks from live brick
       "tick_size REAL NOT NULL DEFAULT 0.05, "
       "limit_offset REAL NOT NULL DEFAULT 0.05, "         # offset between SL trigger and SL limit
       "sl_lmt_buffer REAL NOT NULL DEFAULT 0.05, "        # marketable-limit buffer used at squareoff
       "trade_mode TEXT NOT NULL DEFAULT 'LONG_ONLY', "
       "max_position_per_side INTEGER NOT NULL DEFAULT 0, "  # 0 => quantity
       "squareoff_time TEXT NOT NULL DEFAULT '15:15', "
       "created_at REAL, updated_at REAL, "
       "UNIQUE(symbol, exchange)")                     # one process per exchange → one row per contract

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS strategy_symbol ({_MS});

CREATE TABLE IF NOT EXISTS symbol_status (
    symbol_id INTEGER PRIMARY KEY,
    updated_at REAL,
    pid INTEGER,
    state TEXT,                -- RUNNING | HALTED | STOPPED | ERROR
    message TEXT,
    ltp REAL,
    brick_color TEXT,
    brick_no INTEGER,
    long_qty INTEGER,
    short_qty INTEGER,
    buy_pending REAL,
    sell_pending REAL,
    sl_long REAL,
    sl_short REAL,
    trades_blocked INTEGER
);

CREATE TABLE IF NOT EXISTS symbol_command (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol_id INTEGER NOT NULL,
    command TEXT NOT NULL,
    created_at REAL,
    done_at REAL,
    result TEXT
);

CREATE TABLE IF NOT EXISTS process_state (
    exchange TEXT PRIMARY KEY,
    manually_stopped INTEGER NOT NULL DEFAULT 0,
    updated_at REAL
);
"""

_lock = threading.RLock()


def connect():
    directory = os.path.dirname(os.path.abspath(DB_FILE))
    if directory:
        os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(DB_FILE, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db():
    with _lock:
        conn = connect()
        try:
            conn.executescript(SCHEMA)
            # Existing database? append-only column migration: add any of the
            # newer config columns the CREATE above carries but the live
            # table lacks (ALTER ADD defaults backfill every row).
            cols = {r[1] for r in conn.execute("PRAGMA table_info(strategy_symbol)")}
            for name, ddl in (("brick_method", "TEXT NOT NULL DEFAULT 'fixed'"),
                              ("atr_period", "INTEGER NOT NULL DEFAULT 14"),
                              ("atr_multiplier", "REAL NOT NULL DEFAULT 1.0"),
                              ("ltp_percent", "REAL NOT NULL DEFAULT 0.25")):
                if name not in cols:
                    conn.execute(f"ALTER TABLE strategy_symbol ADD COLUMN {name} {ddl}")
            conn.commit()
        finally:
            conn.close()


def fetchall(sql, params=()):
    with _lock:
        conn = connect()
        try:
            return [dict(r) for r in conn.execute(sql, params).fetchall()]
        finally:
            conn.close()


def fetchone(sql, params=(), default=None):
    with _lock:
        conn = connect()
        try:
            row = conn.execute(sql, params).fetchone()
            return dict(row) if row is not None else default
        finally:
            conn.close()


def write(sql, params=()):
    """One statement; returns lastrowid for INSERTs."""
    with _lock:
        conn = connect()
        try:
            cur = conn.execute(sql, params)
            conn.commit()
            return cur.lastrowid
        finally:
            conn.close()


def write_many(statements):
    """A list of (sql, params) in ONE transaction."""
    with _lock:
        conn = connect()
        try:
            for sql, params in statements:
                conn.execute(sql, params)
            conn.commit()
        finally:
            conn.close()


def now():
    return time.time()
