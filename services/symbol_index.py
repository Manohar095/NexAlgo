# -*- coding: utf-8 -*-
"""services/symbol_index.py
==========================
Flattrade scrip-master **symbol index** for the OpenAlgo-compatible API layer.

The OpenAlgo frontend we host (`frontend/`, OpenAlgoNew's trading page) speaks
the *symbol* language, not the token language: `/api/v1/history` posts
`{symbol:"RELIANCE-EQ", exchange:"NSE"}`, the chart's WebSocket subscribes with
`{symbol, exchange}` and `/api/v1/quotes` does the same. NexAlgo's own pages talk
tokens (see `services/scrip_master.py`, which only builds the option-chain
universe). This module is the missing bridge: it downloads the SAME eight
master CSVs OpenAlgo's flattrade adapter downloads and keeps a
`(exchange, tradingsymbol) -> row` map plus a substring search.

    Exchange,Token,Lotsize,Symbol,Tradingsymbol,Instrument,Expiry,Strike,Optiontype

Sources (OpenAlgo `broker/flattrade/database/master_contract_db.py`, verbatim):

    NSE   NSE_Equity.csv              BSE   BSE_Equity.csv
    NFO   Nfo_Index_Derivatives.csv   BFO   Bfo_Index_Derivatives.csv
          Nfo_Equity_Derivatives.csv         Bfo_Equity_Derivatives.csv
    MCX   Commodity.csv               CDS   Currency_Derivatives.csv

Cache: one JSON on disk under `database/scripmaster/` with a 12h TTL, loaded
into memory on first use. Never a hot-path cost after the first request.
"""
import csv
import io
import json
import logging
import os
import threading
import time

import requests

_BASE = "https://flattrade.s3.ap-south-1.amazonaws.com/scripmaster/"

# (file, exchange) — later files never override an earlier row for one key.
MASTER_FILES = (
    ("NSE_Equity.csv", "NSE"),
    ("BSE_Equity.csv", "BSE"),
    ("Nfo_Index_Derivatives.csv", "NFO"),
    ("Nfo_Equity_Derivatives.csv", "NFO"),
    ("Bfo_Index_Derivatives.csv", "BFO"),
    ("Bfo_Equity_Derivatives.csv", "BFO"),
    ("Commodity.csv", "MCX"),
    ("Currency_Derivatives.csv", "CDS"),
)

_CACHE_DIR = os.path.join("database", "scripmaster")
_CACHE_FILE = os.path.join(_CACHE_DIR, "openalgo_symbol_index.json")
_TTL_SECONDS = 12 * 3600

_lock = threading.Lock()
_state = {"ts": 0.0, "key": {}, "rows": []}   # rows: compact lists, see _compact()
_loading = threading.Lock()

# Index keys as a compact list: [exch, token, tsym, symbol, lotsize,
# instrument, expiry, strike, opttype] — small enough to keep ~100k of them.
_FIELDS = ("exch", "token", "tsym", "symbol", "lotsize", "instrument",
           "expiry", "strike", "opttype")


def _download(name):
    res = requests.get(_BASE + name, timeout=60)
    if res.status_code != 200:
        raise RuntimeError(f"Scrip master {name} HTTP {res.status_code}")
    return res.text


def _parse(text, exchange, key, rows):
    reader = csv.DictReader(io.StringIO(text))
    for r in reader:
        tsym = (r.get("Tradingsymbol") or "").strip()
        token = (r.get("Token") or "").strip()
        if not tsym or not token:
            continue
        exch = (r.get("Exchange") or exchange).strip().upper() or exchange
        row = [
            exch,
            token,
            tsym,
            (r.get("Symbol") or "").strip(),
            (r.get("Lotsize") or "1").strip() or "1",
            (r.get("Instrument") or "").strip().upper(),
            (r.get("Expiry") or "").strip().upper(),
            (r.get("Strike") or "").strip(),
            (r.get("Optiontype") or "").strip().upper(),
        ]
        k = f"{exch}|{tsym.upper()}"
        if k not in key:          # first file wins, like OpenAlgo's upsert order
            key[k] = len(rows)
            rows.append(row)


def _build():
    key, rows = {}, []
    for name, exchange in MASTER_FILES:
        _parse(_download(name), exchange, key, rows)
    return {"ts": time.time(), "key": key, "rows": rows}


def _load_disk():
    try:
        if not os.path.exists(_CACHE_FILE):
            return None
        if time.time() - os.path.getmtime(_CACHE_FILE) > _TTL_SECONDS:
            return None
        with open(_CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not data.get("rows"):
            return None
        return data
    except Exception as e:      # a corrupt cache is just a cache miss
        logging.warning("[symbol_index] cache read failed → %s", e)
        return None


def _save_disk(data):
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        tmp = _CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
        os.replace(tmp, _CACHE_FILE)
    except Exception as e:
        logging.warning("[symbol_index] cache write failed → %s", e)


def _ensure():
    """Load the index once (memory → disk → download)."""
    if _state["rows"]:
        return _state
    with _loading:
        if _state["rows"]:
            return _state
        data = _load_disk()
        if data is None:
            try:
                data = _build()
                _save_disk(data)
                logging.info("[symbol_index] built %d symbols from the scrip master", len(data["rows"]))
            except Exception as e:
                logging.error("[symbol_index] build failed → %s", e)
                data = {"ts": time.time(), "key": {}, "rows": []}
        _state["ts"] = data.get("ts") or time.time()
        _state["key"] = data.get("key") or {}
        _state["rows"] = data.get("rows") or []
    return _state


def refresh():
    """Force a re-download (manual/debug)."""
    with _loading:
        data = _build()
        _save_disk(data)
        _state["ts"] = data["ts"]
        _state["key"] = data["key"]
        _state["rows"] = data["rows"]
    return len(_state["rows"])


def _as_row(row):
    return dict(zip(_FIELDS, row))


def resolve(exchange, symbol):
    """`(exchange, tradingsymbol)` → index row, or None.

    Tolerates the spelling differences between OpenAlgo symbols and Flattrade
    tradingsymbols: case, a stray space, and the NSE `-EQ` suffix (`RELIANCE`
    vs `RELIANCE-EQ`) / the BSE one that never has it.
    """
    idx = _ensure()
    exch = (exchange or "").strip().upper()
    sym = (symbol or "").strip()
    if not exch or not sym:
        return None
    up = sym.upper()
    candidates = [up]
    if not up.endswith("-EQ"):
        candidates.append(up + "-EQ")
    if up.endswith("-EQ"):
        candidates.append(up[:-3])
    for cand in candidates:
        pos = idx["key"].get(f"{exch}|{cand}")
        if pos is not None:
            return _as_row(idx["rows"][pos])
    return None


def search(query, exchange=None, limit=50):
    """Substring search over tradingsymbol/symbol, exchange optional.

    Ordered: exact tsym, tsym prefix, symbol prefix, then substring — the same
    expectation the chart's symbol box has (typing `RELI` must put
    `RELIANCE-EQ` first, not a random option chain).
    """
    q = (query or "").strip().upper()
    if not q:
        return []
    idx = _ensure()
    exch = (exchange or "").strip().upper()
    exact, pref_tsym, pref_sym, contains = [], [], [], []
    for row in idx["rows"]:
        e, _tok, tsym, symbol = row[0], row[1], row[2], row[3]
        if exch and e != exch:
            continue
        t = tsym.upper()
        s = symbol.upper()
        if t == q:
            exact.append(row)
        elif t.startswith(q):
            pref_tsym.append(row)
        elif s.startswith(q):
            pref_sym.append(row)
        elif q in t or q in s:
            contains.append(row)
        if len(exact) + len(pref_tsym) + len(pref_sym) + len(contains) > 4000:
            break
    out = []
    for row in (exact + pref_tsym + pref_sym + contains):
        out.append(_as_row(row))
        if len(out) >= limit:
            break
    return out
