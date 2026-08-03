# -*- coding: utf-8 -*-
"""
database/db.py
================
Thin SQLite layer. One table: `symbols`. Config is stored as JSON so the
schema doesn't need a migration every time a new strategy field is added.
"""

import json
import sqlite3
import threading
import uuid
from datetime import datetime

from config.settings import settings

_lock = threading.Lock()


def _connect():
    conn = sqlite3.connect(settings.DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _lock:
        conn = _connect()
        conn.execute("""
            CREATE TABLE IF NOT EXISTS symbols (
                id          TEXT PRIMARY KEY,
                config_json TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            )
        """)
        conn.commit()
        conn.close()


def list_symbols():
    with _lock:
        conn = _connect()
        rows = conn.execute("SELECT * FROM symbols ORDER BY created_at ASC").fetchall()
        conn.close()
    return [_row_to_dict(r) for r in rows]


def get_symbol(symbol_id):
    with _lock:
        conn = _connect()
        row = conn.execute("SELECT * FROM symbols WHERE id = ?", (symbol_id,)).fetchone()
        conn.close()
    return _row_to_dict(row) if row else None


def create_symbol(config_dict):
    symbol_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    with _lock:
        conn = _connect()
        conn.execute(
            "INSERT INTO symbols (id, config_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (symbol_id, json.dumps(config_dict), now, now)
        )
        conn.commit()
        conn.close()
    return get_symbol(symbol_id)


def update_symbol(symbol_id, config_dict):
    now = datetime.utcnow().isoformat()
    with _lock:
        conn = _connect()
        cur = conn.execute(
            "UPDATE symbols SET config_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(config_dict), now, symbol_id)
        )
        conn.commit()
        updated = cur.rowcount > 0
        conn.close()
    return get_symbol(symbol_id) if updated else None


def delete_symbol(symbol_id):
    with _lock:
        conn = _connect()
        cur = conn.execute("DELETE FROM symbols WHERE id = ?", (symbol_id,))
        conn.commit()
        deleted = cur.rowcount > 0
        conn.close()
    return deleted


def _row_to_dict(row):
    return {
        "id": row["id"],
        "config": json.loads(row["config_json"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
