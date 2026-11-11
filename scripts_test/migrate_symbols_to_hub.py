# -*- coding: utf-8 -*-
"""
migrate_symbols_to_hub.py — one-time import of the legacy /api/symbols engine
rows into the strategy_hub registry, so the dashboard's Algo Symbols panel
(which reads ONLY /strategy-hub/api/overview) shows the strategies the old
strategy table carried.

Mapping (old config_json -> hub columns):
  product_type I/M/C           -> product MIS/NRML/CNC (hub stores the user form)
  limit_price_buy_brick_no     -> limit_buy_brick_no (same for sell)
  entry_trail_brick_number     -> entry_trail_bricks (None -> sl_trail default)
  sl_trail_brick_number        -> sl_trail_bricks
  squareoff_hour/minute        -> squareoff_time "HH:MM"
  brick_method                 -> "fixed" (the legacy engine had no methods);
                                  brick_size/revs/limits/trails/tick/offsets carry over.

Idempotent: rows whose (symbol, exchange) already exist in the hub are skipped.
Every migrated row is DISABLED — enabling (and therefore trading) stays a
deliberate dashboard action.

Run:  python scripts_test/migrate_symbols_to_hub.py
"""

import json
import os
import sqlite3
import sys
import time

PLATFORM_DB = os.path.join("database", "renko_platform.db")
HUB_DB = os.path.join("database", "strategy_hub.db")

PRODUCT_MAP = {"I": "MIS", "M": "NRML", "C": "CNC"}


def num(v, dflt):
    try:
        n = float(v)
        return n if n == n else dflt  # NaN guard
    except (TypeError, ValueError):
        return dflt


def iint(v, dflt):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return dflt


def main():
    if not os.path.exists(PLATFORM_DB):
        print(f"no platform database at {PLATFORM_DB} — nothing to migrate")
        return 0
    src = sqlite3.connect(PLATFORM_DB)
    src.row_factory = sqlite3.Row
    rows = src.execute("SELECT id, config_json FROM symbols").fetchall()

    hub = sqlite3.connect(HUB_DB, timeout=10)
    hub.execute("PRAGMA busy_timeout=5000")
    existing = {tuple(r) for r in hub.execute("SELECT symbol, exchange FROM strategy_symbol")}

    migrated, skipped = 0, 0
    for row in rows:
        try:
            cfg = json.loads(row["config_json"] or "{}")
        except json.JSONDecodeError:
            print(f"skip {row['id']}: unreadable config_json")
            skipped += 1
            continue
        symbol = str(cfg.get("trading_symbol") or "").strip()
        exchange = str(cfg.get("exchange") or "").strip().upper()
        if not symbol or not exchange:
            print(f"skip {row['id']}: no trading_symbol/exchange")
            skipped += 1
            continue
        if (symbol, exchange) in existing:
            print(f"skip {symbol} {exchange}: already in the hub")
            skipped += 1
            continue

        product = PRODUCT_MAP.get(str(cfg.get("product_type") or "MIS").upper(), "MIS")
        # Legacy blanks fall back exactly the way the engine's own defaults did.
        sl_trail = num(cfg.get("sl_trail_brick_number"), 2.0)
        entry_trail = num(cfg.get("entry_trail_brick_number"), sl_trail)
        sq_h = iint(cfg.get("squareoff_hour"), 15)
        sq_m = iint(cfg.get("squareoff_minute"), 15)
        trade_mode = str(cfg.get("trade_mode") or "LONG_ONLY")
        token = str(cfg.get("token") or "")

        cur = hub.execute(
            "INSERT INTO strategy_symbol (strategy_id, symbol, exchange, enabled, version, tag_base, "
            "strategy_name, token, product, quantity, lot_size, brick_size, brick_method, atr_period, "
            "atr_multiplier, ltp_percent, g2r, r2g, buy_brick_no, sell_brick_no, limit_buy_brick_no, "
            "limit_sell_brick_no, entry_trail_bricks, sl_trail_bricks, tick_size, limit_offset, "
            "sl_lmt_buffer, trade_mode, max_position_per_side, squareoff_time, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (f"renko_{exchange}", symbol, exchange, 0, 1, "tmp migrating",
             str(cfg.get("strategy_name") or symbol), token, product,
             iint(cfg.get("quantity"), 1), None,
             num(cfg.get("brick_size"), 1.0), "fixed", 14, 1.0, 0.25,
             iint(cfg.get("green_to_red_rev"), 2), iint(cfg.get("red_to_green_rev"), 2),
             iint(cfg.get("buy_brick_no"), 1), iint(cfg.get("sell_brick_no"), -1),
             iint(cfg.get("limit_price_buy_brick_no"), 1), iint(cfg.get("limit_price_sell_brick_no"), 1),
             entry_trail, sl_trail,
             num(cfg.get("tick_size"), 0.05), num(cfg.get("limit_offset"), 0.05),
             num(cfg.get("sl_lmt_buffer"), 0.05), trade_mode, 0,
             f"{sq_h:02d}:{sq_m:02d}", time.time(), time.time()),
        )
        row_id = cur.lastrowid
        # tag_base mirrors create_symbol(): renko_<row_id>, one per row.
        hub.execute("UPDATE strategy_symbol SET tag_base=? WHERE id=?", (f"renko_{row_id}", row_id))
        existing.add((symbol, exchange))
        migrated += 1
        print(f"migrated #{row_id}: {exchange} {symbol} ({product}, fixed {num(cfg.get('brick_size'), '?')}, {trade_mode})")

    hub.commit()
    hub.close()
    src.close()
    print(f"done: {migrated} migrated, {skipped} skipped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
