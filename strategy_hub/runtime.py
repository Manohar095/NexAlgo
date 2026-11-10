# -*- coding: utf-8 -*-
"""
strategy_hub/runtime.py — the config/status/command channel the strategy body uses.

Port of strategy_hub_package/strategy_hub/runtime.py. There it was deliberately
stdlib-only because the master strategy ran as a SUBPROCESS and could not import
the Flask app. The NexAlgo manager (`manager.py`) runs in-process but is written
against exactly this interface, so the body could later be lifted into a real
subprocess unchanged.
"""

import os
import sqlite3
import time
from contextlib import closing

COMMAND_MAX_AGE_SEC = 30      # a queued command older than this is expired, never replayed

_STATUS_COLS = (
    "symbol_id", "updated_at", "pid", "state", "message", "ltp", "brick_color", "brick_no",
    "long_qty", "short_qty", "buy_pending", "sell_pending", "sl_long", "sl_short", "trades_blocked",
)


def db_path():
    url = os.getenv("STRATEGY_HUB_DB_URL", "sqlite:///database/strategy_hub.db")
    path = url.replace("sqlite:///", "", 1)
    return path if os.path.isabs(path) else os.path.join(os.getcwd(), path)


def _conn():
    conn = sqlite3.connect(db_path(), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def load_symbols(strategy_id):
    """All symbol rows (enabled or not) for one strategy, as plain dicts."""
    with closing(_conn()) as c:
        rows = c.execute(
            "SELECT * FROM strategy_symbol WHERE strategy_id = ? ORDER BY id", (strategy_id,)
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["enabled"] = bool(d.get("enabled"))
        out.append(d)
    return out


def write_status(rows):
    """rows: list of dicts with the keys in _STATUS_COLS (updated_at / pid are added here)."""
    if not rows:
        return
    now, pid = time.time(), os.getpid()
    values = []
    for r in rows:
        r = dict(r)
        r["updated_at"], r["pid"] = now, pid
        values.append(tuple(r.get(k) for k in _STATUS_COLS))
    sql = (
        f"INSERT OR REPLACE INTO symbol_status ({', '.join(_STATUS_COLS)}) "
        f"VALUES ({', '.join('?' * len(_STATUS_COLS))})"
    )
    with closing(_conn()) as c:
        c.executemany(sql, values)
        c.commit()


def pop_commands(strategy_id):
    """Claim pending commands for this strategy. Returns [(symbol_id, command)].
    Stale commands are marked expired and NOT returned."""
    now = time.time()
    fresh = []
    with closing(_conn()) as c:
        rows = c.execute(
            "SELECT c.id, c.symbol_id, c.command, c.created_at FROM symbol_command c "
            "JOIN strategy_symbol s ON s.id = c.symbol_id "
            "WHERE s.strategy_id = ? AND c.done_at IS NULL ORDER BY c.id",
            (strategy_id,),
        ).fetchall()
        for r in rows:
            if now - float(r["created_at"] or 0) > COMMAND_MAX_AGE_SEC:
                c.execute("UPDATE symbol_command SET done_at=?, result=? WHERE id=?", (now, "expired", r["id"]))
            else:
                c.execute("UPDATE symbol_command SET done_at=?, result=? WHERE id=?", (now, "dispatched", r["id"]))
                fresh.append((r["symbol_id"], r["command"]))
        c.commit()
    return fresh
