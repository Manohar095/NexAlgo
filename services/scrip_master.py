# -*- coding: utf-8 -*-
"""Flattrade scrip-master universe for the option-chain picker.

The option-chain panel lists underlyings the OpenAlgo way: the FULL list per
derivative exchange (indices first), picked over client-side, not a broker
search per keystroke. OpenAlgo sources that list from its downloaded scrip
master; Flattrade publishes the same data on a public S3 bucket
(`broker/flattrade/database/master_contract_db.py` in OpenAlgo points at the
same URLs), so we download and shape it here:

    Exchange,Token,Lotsize,Symbol,Tradingsymbol,Instrument,Expiry,Strike,Optiontype

Per underlying we keep exactly what the panel needs and nothing else:
  - the NEAREST futures row (token drives the ATM spot quote resolution),
  - the option expiries it carries, each with one representative option
    tsym/token (PiConnect GetOptionChain takes ANY option or future on the
    underlying, so one row per expiry is all the chain fetch needs).

Only derivative F&O files are touched. MCX/CDS keep futures-only names too —
their options reference the future (same rule as OpenAlgo's
all_underlyings). Cache: compact JSON on disk under database/scripmaster/
with a 12h TTL, rebuilt by refetching the CSVs when stale or missing —
never a hot-path cost beyond the first request after expiry.
"""
import csv
import io
import json
import logging
import os
import threading
import time
from datetime import datetime

import requests

_BASE = "https://flattrade.s3.ap-south-1.amazonaws.com/scripmaster/"

MASTER_FILES = {
    "NFO": ("Nfo_Index_Derivatives.csv", "Nfo_Equity_Derivatives.csv"),
    "BFO": ("Bfo_Index_Derivatives.csv", "Bfo_Equity_Derivatives.csv"),
    "MCX": ("Commodity.csv",),
    "CDS": ("Currency_Derivatives.csv",),
}

VALID_EXCHANGES = ("NFO", "BFO", "MCX", "CDS")

# Indices at the top of the picker, exactly like OpenAlgo's all_underlyings.
_INDEX_UNDERLYINGS = {
    "NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "INDIAVIX",
    "SENSEX", "BANKEX", "SENSEX50",
}

_CACHE_DIR = os.path.join("database", "scripmaster")
_TTL_SECONDS = 12 * 3600

_lock = threading.Lock()
_mem = {}  # exchange -> {"ts": float, "bases": [...]} (universes only, not raw rows)


def _expiry_key(s):
    """CSV expiry '28-SEP-2027' → sortable date (epoch) or +inf garbage."""
    try:
        return datetime.strptime((s or "").strip().upper(), "%d-%b-%Y").timestamp()
    except ValueError:
        return float("inf")


def _parse_csv(text):
    """Stream-parse one master file and fold its rows into the accumulator.

    Rows: futures kept per symbol (nearest expiry wins), option rows folded
    into per-(symbol, expiry) representatives. Returns
    (futures {sym: row}, options {(sym, expiry): row}).
    """
    futures, options = {}, {}
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        inst = (row.get("Instrument") or "").strip().upper()
        sym = (row.get("Symbol") or "").strip().upper()
        if not sym:
            continue
        strip = str(row.get("Strike", "")).strip()
        if inst.startswith("FUT"):
            exp = (row.get("Expiry") or "").strip().upper()
            cur = futures.get(sym)
            if cur is None or _expiry_key(exp) < _expiry_key(cur.get("Expiry")):
                row = dict(row, Expiry=exp, Strike=strip)
                futures[sym] = row
        elif inst.startswith("OPT"):
            exp = (row.get("Expiry") or "").strip().upper()
            if not exp:
                continue
            optt = (row.get("Optiontype") or "").strip().upper()
            key = (sym, exp)
            cur = options.get(key)
            # First call-side row as the expiry's representative.
            if cur is None or (optt == "CE" and cur.get("Optiontype") != "CE"):
                row = dict(row, Strike=strip)
                options[key] = row
    return futures, options


def _build_universe(exchange):
    """Download every master file for the exchange, fold into one universe."""
    files = MASTER_FILES[exchange]
    futures, options = {}, {}
    for name in files:
        url = _BASE + name
        res = requests.get(url, timeout=30)
        if res.status_code != 200:
            raise RuntimeError(f"Scrip master {name} HTTP {res.status_code}")
        f_rows, o_rows = _parse_csv(res.text)
        # Later files never override an earlier row for the same key.
        for sym, row in f_rows.items():
            futures.setdefault(sym, row)
        for key, row in o_rows.items():
            options.setdefault(key, row)

    # Options-bearing bases; MCX/CDS also keep futures-only underlyings.
    fut_bases, opt_bases = set(futures), {s for (s, _e) in options}
    if exchange in ("MCX", "CDS"):
        keep = fut_bases
    else:
        keep = fut_bases & opt_bases

    bases = []
    for sym in keep:
        fut = futures.get(sym)
        if not fut:
            continue
        expiries = sorted(
            (e for (s, e) in options if s == sym), key=_expiry_key
        )
        reps = {e: {"tsym": options[(sym, e)].get("Tradingsymbol", ""),
                    "token": str(options[(sym, e)].get("Token", ""))}
                for e in expiries}
        bases.append({
            "base": sym,
            "exchange": (fut.get("Exchange") or exchange).upper(),
            "tsym": str(fut.get("Tradingsymbol", "")).upper(),
            "token": str(fut.get("Token", "")),
            "instname": (fut.get("Instrument") or "").strip().upper(),
            "expiry": (fut.get("Expiry") or "").strip().upper(),
            "lotsize": fut.get("Lotsize"),
            "expiries": expiries,
            "option_by_expiry": reps,
        })

    indices = sorted((b for b in bases if b["base"] in _INDEX_UNDERLYINGS),
                     key=lambda b: b["base"])
    rest = sorted((b for b in bases if b["base"] not in _INDEX_UNDERLYINGS),
                  key=lambda b: b["base"])
    return {"ts": time.time(), "bases": indices + rest}


def _disk_path(exchange):
    safe = "".join(c for c in exchange if c.isalnum())
    return os.path.join(_CACHE_DIR, f"{safe.lower()}.json")


def option_universe(exchange, refresh=False):
    """Universe {ts, bases: [...]} for one derivative exchange, cached on disk
    with a 12h TTL. Raises on total failure so the caller can report it."""
    exchange = str(exchange or "NFO").strip().upper()
    if exchange not in MASTER_FILES:
        raise ValueError(f"Invalid exchange: {exchange} (options carry on {', '.join(VALID_EXCHANGES)})")

    with _lock:
        cached = _mem.get(exchange)
        if not refresh and cached and time.time() - cached["ts"] < _TTL_SECONDS:
            return cached

        path = _disk_path(exchange)
        if not refresh and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    data = json.load(fh)
                if time.time() - data["ts"] < _TTL_SECONDS:
                    _mem[exchange] = data
                    return data
            except (ValueError, KeyError, OSError) as e:
                logging.warning(f"Scrip master cache unreadable for {exchange}: {e}")

        universe = _build_universe(exchange)
        _mem[exchange] = universe
        try:
            os.makedirs(_CACHE_DIR, exist_ok=True)
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(universe, fh, ensure_ascii=False)
        except OSError as e:
            logging.warning(f"Scrip master cache write failed for {exchange}: {e}")
        return universe


def representative_for_expiry(entry, expiry=None):
    """The (tsym, token) the chain fetch should be keyed on for `entry`:
    an option of the chosen expiry when it has one, else the nearest future."""
    if entry and expiry:
        want = str(expiry).strip().upper()
        rep = (entry.get("option_by_expiry") or {}).get(want)
        if rep and rep.get("tsym"):
            return rep["tsym"], rep["token"]
    return (entry or {}).get("tsym"), (entry or {}).get("token")
