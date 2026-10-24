# -*- coding: utf-8 -*-
"""
api/routes.py
==============
REST endpoints consumed by the dashboard (static/app.js).
"""
import concurrent.futures
import json
import logging
import pytz
import re
import time
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from config.settings import settings
from models.symbol_config import SymbolConfig
from services import access_token_generator
from services import option_greeks
from services import scrip_master
from services.chart_feed import chart_feed_manager
from services.instance_manager import instance_manager
from utils.session_auth import create_session_token, verify_login, SESSION_MAX_AGE_SECONDS

router = APIRouter(prefix="/api")


class SymbolPayload(BaseModel):
    config: SymbolConfig


class LoginPayload(BaseModel):
    username: str
    password: str
    totp_code: str = ""


class SearchSymbolsPayload(BaseModel):
    query: str
    exchange: str = "NSE"


class GetQuotesPayload(BaseModel):
    exchange: str
    token: str


@router.get("/auth/status")
def auth_status():
    """Tells the login page whether auth is even enabled, and whether to
    show the TOTP field, without requiring auth itself to check."""
    return {
        "auth_enabled": bool(settings.DASHBOARD_USER and settings.DASHBOARD_PASSWORD),
        "totp_required": bool(settings.DASHBOARD_TOTP_SECRET),
    }


@router.post("/auth/login")
def auth_login(payload: LoginPayload, response: Response):
    ok, error = verify_login(payload.username, payload.password, payload.totp_code)
    if not ok:
        raise HTTPException(status_code=401, detail=error)

    token = create_session_token(payload.username)
    response.set_cookie(
        key="session",
        value=token,
        max_age=SESSION_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
    )
    return {"success": True}


@router.post("/auth/logout")
def auth_logout(response: Response):
    response.delete_cookie("session")
    return {"success": True}


class BrokerTokenPayload(BaseModel):
    access_token: str


@router.get("/broker/settings")
def get_broker_settings():
    return instance_manager.broker.get_access_token_status()


@router.post("/broker/settings")
def update_broker_settings(payload: BrokerTokenPayload):
    try:
        instance_manager.broker.update_access_token(payload.access_token)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Token saved, but broker login failed: {e}")
    return instance_manager.broker.get_access_token_status()


@router.post("/broker/generate-token")
async def generate_broker_token():
    """Runs the TOTP-based headless login flow, writes the resulting
    token to .env, and applies it to the running broker session —
    triggered by the dashboard's "Generate Access Token" button."""
    try:
        new_token = await access_token_generator.generate_and_save_token()
        instance_manager.broker.apply_generated_token(new_token)
    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Token generation failed: {e}")
    return {
        "message": "Access token generated and applied.",
        "access_token": new_token,
        **instance_manager.broker.get_access_token_status()
    }


@router.get("/symbols")
def list_symbols():
    """All saved symbols (config + id), merged with live status if running."""
    records = instance_manager.list_symbols()
    statuses = {s["id"]: s for s in instance_manager.all_statuses()}
    out = []
    for rec in records:
        item = dict(rec)
        item["live_status"] = statuses.get(rec["id"])
        out.append(item)
    return out


@router.post("/symbols")
def create_symbol(payload: SymbolPayload):
    try:
        return instance_manager.create_symbol(payload.config.model_dump(mode="json"))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/symbols/{symbol_id}")
def get_symbol(symbol_id: str):
    for rec in instance_manager.list_symbols():
        if rec["id"] == symbol_id:
            engine = instance_manager.get_engine(symbol_id)
            rec = dict(rec)
            rec["live_status"] = engine.get_status() if engine else None
            return rec
    raise HTTPException(status_code=404, detail="Symbol not found")


@router.put("/symbols/{symbol_id}")
def update_symbol(symbol_id: str, payload: SymbolPayload):
    rec = instance_manager.update_symbol(symbol_id, payload.config.model_dump(mode="json"))
    if rec is None:
        raise HTTPException(status_code=404, detail="Symbol not found")
    return rec


@router.delete("/symbols/{symbol_id}")
def delete_symbol(symbol_id: str):
    ok = instance_manager.delete_symbol(symbol_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Symbol not found")
    return {"deleted": True}


@router.post("/symbols/{symbol_id}/start")
def start_symbol(symbol_id: str):
    try:
        return instance_manager.start(symbol_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Symbol not found")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/symbols/{symbol_id}/stop")
def stop_symbol(symbol_id: str):
    try:
        return instance_manager.stop(symbol_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Symbol not found")


@router.post("/symbols/{symbol_id}/restart")
def restart_symbol(symbol_id: str):
    try:
        return instance_manager.restart(symbol_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Symbol not found")


@router.post("/symbols/{symbol_id}/squareoff")
def squareoff_symbol(symbol_id: str):
    """
    Manual SQUAREOFF command: cancels the SL order and both pending entries,
    closes the open position with a marketable LMT, and blocks trading for
    the symbol until it is stopped and started again (OpenAlgo parity).
    """
    try:
        return instance_manager.squareoff(symbol_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Symbol not found")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/symbols/{symbol_id}/logs")
def get_logs(symbol_id: str):
    try:
        return instance_manager.get_logs(symbol_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Symbol not found")


@router.get("/status")
def all_statuses():
    return instance_manager.all_statuses()


@router.get("/logs")
def global_logs(limit: int = 200):
    return instance_manager.global_logs(limit=limit)


# ============================================================
# SEARCH AND GET QUOTES ENDPOINTS
# ============================================================

@router.post("/search-symbols")
def search_symbols(payload: SearchSymbolsPayload):
    """
    Search for symbols using the broker's search functionality.
    Expects: { "query": "RELIANCE", "exchange": "NSE" }
    """
    try:
        result = instance_manager.broker.search_symbols(
            exchange=payload.exchange,
            search_text=payload.query
        )
        
        if result and isinstance(result, dict):
            if 'values' in result:
                return result
            for key, value in result.items():
                if isinstance(value, list):
                    return {'stat': 'Ok', 'values': value}
        
        if isinstance(result, list):
            return {'stat': 'Ok', 'values': result}
        
        return {'stat': 'Ok', 'values': []}
        
    except Exception as e:
        logging.error(f"Search symbols error: {e}")
        return {
            'stat': 'Not_Ok',
            'emsg': str(e)
        }


@router.post("/get-quotes")
def get_quotes(exchange: str, token: str):
    """
    Get quotes for a specific token using the broker session.
    Returns ALL fields from the Get Quotes API response.
    """
    try:
        result = instance_manager.broker.get_quotes(
            exchange=exchange, 
            token=token
        )
        
        if result and result.get('stat') == 'Ok':
            return {
                'success': True,
                'data': result
            }
        else:
            error_msg = result.get('emsg', 'Failed to get quotes') if result else 'No response from broker'
            return {
                'success': False,
                'error': error_msg
            }
            
    except Exception as e:
        logging.error(f"Get quotes error: {e}")
        return {
            'success': False,
            'error': str(e)
        }


# ============================================================
# NORMALIZED MARKET DATA (OpenAlgo data-adapter parity)
#   POST /api/quotes   → {status:"success", data:{bid,ask,open,high,low,
#                        ltp,prev_close,change,change_percent,volume,oi,
#                        tick_size,tsym,...}}
#   POST /api/depth    → 5-level depth book, OpenAlgo shape
#   POST /api/multiquotes → batch snapshot (REST fallback for WS storms)
#   GET  /api/intervals → the candle intervals this engine can serve
# ============================================================

def _num_or_none(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _normalized_quote_data(exchange: str, token: str) -> dict:
    q = instance_manager.broker.get_quotes(exchange=exchange, token=token)
    if not q or q.get("stat") != "Ok":
        emsg = (q or {}).get("emsg") or "No response from broker"
        raise HTTPException(status_code=502, detail=emsg)
    ltp = _num_or_none(q.get("lp"))
    prev_close = _num_or_none(q.get("c"))
    data = {
        "exchange": (q.get("exch") or exchange).upper(),
        "token": str(q.get("tk") or token),
        "tsym": q.get("ts") or q.get("tsym"),
        "name": q.get("cname") or q.get("dname"),
        "ltp": ltp,
        "prev_close": prev_close,
        # `c` is mapped to prev_close for parity with the legacy funnel and
        # OpenAlgo's flattrade adapter; the change fields derive from the pair.
        "change": round(ltp - prev_close, 4) if (ltp is not None and prev_close) else None,
        "change_percent": round((ltp - prev_close) / prev_close * 100, 4)
                         if (ltp is not None and prev_close) else None,
        "open": _num_or_none(q.get("o")),
        "high": _num_or_none(q.get("h")),
        "low": _num_or_none(q.get("l")),
        "volume": _num_or_none(q.get("v")),
        "oi": _num_or_none(q.get("oi")),
        "bid": _num_or_none(q.get("bp1")),
        "ask": _num_or_none(q.get("sp1")),
        "bid_qty": _num_or_none(q.get("bq1")),
        "ask_qty": _num_or_none(q.get("sq1")),
        "tick_size": _num_or_none(q.get("ti")),
        "lot_size": _num_or_none(q.get("ls")),
        "upper_circuit": _num_or_none(q.get("uc")),
        "lower_circuit": _num_or_none(q.get("lc")),
        "last_qty": _num_or_none(q.get("ltq")),
        "last_trade_time": q.get("ltt"),
    }
    return data


@router.post("/quotes")
def normalized_quotes(exchange: str, token: str):
    """Normalized single quote (OpenAlgo /quotes shape)."""
    data = _normalized_quote_data(exchange, token)
    return {"status": "success", "data": data}


@router.post("/depth")
def normalized_depth(exchange: str, token: str):
    """
    Normalized 5-level depth (OpenAlgo /depth shape). Flattrade GetQuotes
    carries the whole book; bp1..5/bq1..5/bo1..5 and sp/sq/so are mapped here.
    """
    q = instance_manager.broker.get_quotes(exchange=exchange, token=token)
    if not q or q.get("stat") != "Ok":
        emsg = (q or {}).get("emsg") or "No response from broker"
        raise HTTPException(status_code=502, detail=emsg)
    ltp = _num_or_none(q.get("lp"))
    prev_close = _num_or_none(q.get("c"))
    bids, asks = [], []
    for i in range(1, 6):
        p = _num_or_none(q.get(f"bp{i}"))
        if p is not None and p > 0:
            bids.append({
                "price": p,
                "quantity": _num_or_none(q.get(f"bq{i}")) or 0.0,
                "orders": _num_or_none(q.get(f"bo{i}")) or 0.0,
            })
        p = _num_or_none(q.get(f"sp{i}"))
        if p is not None and p > 0:
            asks.append({
                "price": p,
                "quantity": _num_or_none(q.get(f"sq{i}")) or 0.0,
                "orders": _num_or_none(q.get(f"so{i}")) or 0.0,
            })
    data = {
        "exchange": (q.get("exch") or exchange).upper(),
        "token": str(q.get("tk") or token),
        "tsym": q.get("ts") or q.get("tsym"),
        "ltp": ltp,
        "prev_close": prev_close,
        "open": _num_or_none(q.get("o")),
        "high": _num_or_none(q.get("h")),
        "low": _num_or_none(q.get("l")),
        "volume": _num_or_none(q.get("v")),
        "oi": _num_or_none(q.get("oi")),
        "bids": bids,
        "asks": asks,
        "totalbuyqty": _num_or_none(q.get("tbq")),
        "totalsellqty": _num_or_none(q.get("tsq")),
        "last_qty": _num_or_none(q.get("ltq")),
        "tick_size": _num_or_none(q.get("ti")),
    }
    return {"status": "success", "data": data}


class MultiQuoteItem(BaseModel):
    exchange: str
    token: str


class MultiQuotePayload(BaseModel):
    symbols: list[MultiQuoteItem]


@router.post("/multiquotes")
def multiquotes(payload: MultiQuotePayload):
    """
    Batched normalized quotes (OpenAlgo multiquotes parity) — used by the
    frontends as the REST fallback while their WebSocket is down.
    Per-symbol errors are reported per-symbol, never fail the batch.
    """
    symbols = payload.symbols[:40]
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            pool.submit(_normalized_quote_data, s.exchange, s.token): s for s in symbols
        }
        done = {}
        for fut, s in futures.items():
            done[fut] = s
        for fut in concurrent.futures.as_completed(futures):
            s = done[fut]
            try:
                results.append({"status": "success", **fut.result()})
            except HTTPException as e:
                results.append({"status": "error", "exchange": s.exchange.upper(),
                                "token": str(s.token), "message": e.detail})
            except Exception as e:
                results.append({"status": "error", "exchange": s.exchange.upper(),
                                "token": str(s.token), "message": str(e)})
    return {"status": "success", "quotes": results}


@router.get("/intervals")
def intervals():
    """Intervals the candle engine serves (OpenAlgo /intervals parity)."""
    seconds_map = {"1m": 60, "3m": 180, "5m": 300, "10m": 600, "15m": 900,
                   "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400}
    return {
        "status": "success",
        "intervals": [{"code": code, "seconds": seconds}
                      for code, seconds in sorted(seconds_map.items(), key=lambda kv: kv[1])],
    }


@router.get("/charts")
async def get_charts():
    from fastapi.responses import FileResponse
    return FileResponse("templates/charts.html")

# Add these new routes after the existing get_quotes route

# ============================================================
# ORDERBOOK ROUTES
# ============================================================

@router.post("/orderbook")
def get_orderbook():
    """Get orderbook using the broker session"""
    try:
        result = instance_manager.broker.get_order_book()
        
        if isinstance(result, list):
            return {
                'success': True,
                'data': result,
                'count': len(result)
            }
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            return {
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            }
        else:
            error_msg = result.get('emsg', 'Failed to fetch orderbook') if isinstance(result, dict) else 'Unknown error'
            # Check for "no data" error - treat as empty
            if "no data" in error_msg.lower() or "no record" in error_msg.lower():
                return {
                    'success': True,
                    'data': [],
                    'count': 0,
                    'message': 'No orders found'
                }
            return {
                'success': False,
                'error': error_msg
            }
            
    except Exception as e:
        logging.error(f"Orderbook error: {e}")
        return {
            'success': False,
            'error': str(e)
        }


# ============================================================
# TRADEBOOK ROUTES
# ============================================================

@router.post("/tradebook")
def get_tradebook():
    """Get tradebook using the broker session"""
    try:
        result = instance_manager.broker.get_trade_book()
        
        if isinstance(result, list):
            return {
                'success': True,
                'data': result,
                'count': len(result)
            }
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            return {
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            }
        else:
            error_msg = result.get('emsg', 'Failed to fetch tradebook') if isinstance(result, dict) else 'Unknown error'
            if "no data" in error_msg.lower() or "no record" in error_msg.lower():
                return {
                    'success': True,
                    'data': [],
                    'count': 0,
                    'message': 'No trades found'
                }
            return {
                'success': False,
                'error': error_msg
            }
            
    except Exception as e:
        logging.error(f"Tradebook error: {e}")
        return {
            'success': False,
            'error': str(e)
        }


# ============================================================
# POSITIONBOOK ROUTES
# ============================================================

@router.post("/positionbook")
def get_positionbook():
    """Get positionbook using the broker session"""
    try:
        result = instance_manager.broker.get_positions()
        
        if isinstance(result, list):
            return {
                'success': True,
                'data': result,
                'count': len(result)
            }
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            return {
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            }
        else:
            error_msg = result.get('emsg', 'Failed to fetch positions') if isinstance(result, dict) else 'Unknown error'
            if "no data" in error_msg.lower() or "no record" in error_msg.lower():
                return {
                    'success': True,
                    'data': [],
                    'count': 0,
                    'message': 'No positions found'
                }
            return {
                'success': False,
                'error': error_msg
            }
            
    except Exception as e:
        logging.error(f"Positionbook error: {e}")
        return {
            'success': False,
            'error': str(e)
        }


# ============================================================
# HOLDINGS ROUTES
# ============================================================

@router.post("/holdings")
def get_holdings(prd: str = "C"):
    """Get holdings using the broker session"""
    try:
        result = instance_manager.broker.get_holdings(prd=prd)
        
        if isinstance(result, list):
            return {
                'success': True,
                'data': result,
                'count': len(result)
            }
        elif isinstance(result, dict) and result.get('stat') == 'Ok':
            return {
                'success': True,
                'data': result.get('values', []),
                'count': len(result.get('values', []))
            }
        else:
            error_msg = result.get('emsg', 'Failed to fetch holdings') if isinstance(result, dict) else 'Unknown error'
            if "no data" in error_msg.lower() or "no record" in error_msg.lower():
                return {
                    'success': True,
                    'data': [],
                    'count': 0,
                    'message': 'No holdings found'
                }
            return {
                'success': False,
                'error': error_msg
            }
            
    except Exception as e:
        logging.error(f"Holdings error: {e}")
        return {
            'success': False,
            'error': str(e)
        }


# ============================================================
# CHART ROUTES (openalgo-charts data feed)
# ============================================================

# Noren TPSeries supports these minute resolutions only.
_CHART_INTERVALS = {"1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "1h": 60, "2h": 120, "4h": 240}

# Farthest lookback the broker will serve for intraday candles. Noren
# rejects more than ~8 days, so clamp before calling the API.
_CHART_MAX_DAYS = 8

_IST = pytz.timezone("Asia/Kolkata")


class ChartWatchPayload(BaseModel):
    exchange: str
    token: str
    action: str  # "sub" | "unsub"
    client: str = "default"  # per-tab id so two tabs don't kill each other's feed


def _noren_row_to_bar(row: dict):
    """Normalize one TPSeries row into an openalgo-charts Bar.

    Noren candles come back as IST wall-clock strings ('dd-mm-yyyy
    HH:MM:SS') plus float OHLCV using the `in*` key family. Field names
    vary between SDK builds / response modes (tick rows vs candle rows),
    so every field falls back across the known variants instead of
    keying on exactly one. Timestamps are parsed as IST explicitly — do
    NOT use time.mktime like the raw scripts do, that silently depends
    on the host machine's timezone.
    """
    from datetime import datetime as _dt

    try:
        naive = _dt.strptime(row.get("time", ""), "%d-%m-%Y %H:%M:%S")
    except (ValueError, TypeError):
        return None

    utc_seconds = int(_IST.localize(naive).timestamp())

    def _num(*keys):
        for k in keys:
            v = row.get(k)
            if v not in (None, ""):
                try:
                    return float(v)
                except (ValueError, TypeError):
                    continue
        return None

    open_ = _num("into", "ino")
    high = _num("inoh")
    low = _num("inol")
    close = _num("intc", "into")
    if close is None:
        close = open_
    if open_ is None:
        open_ = close
    if open_ is None or close is None:
        return None
    if high is None:
        high = max(open_, close)
    if low is None:
        low = min(open_, close)

    volume = _num("intv", "inivot", "iv")
    if volume is None:
        volume = _num("v")  # fallback, brokers vary
    bar = {
        "time": utc_seconds,
        "open": open_,
        "high": high,
        "low": low,
        "close": close,
    }
    if volume is not None and volume > 0:
        bar["volume"] = volume
    oi = _num("oi")
    if oi is not None and oi > 0:
        bar["oi"] = oi
    return bar


@router.get("/chart/history")
def chart_history(
    exchange: str,
    token: str,
    interval: str = "5m",
    days: float = 5,
    from_ts: float = None,
    to_ts: float = None,
):
    """
    Broker candle history for the charts page, straight from the Noren
    TPSeries (get_time_price_series). Returns openalgo-charts Bar objects:
    { time: UTC seconds, open, high, low, close, volume? }

    Query params:
      exchange / token — broker identifiers (NSE|26000 style)
      interval         — 1m|3m|5m|10m|15m|30m|1h|2h|4h
      from_ts / to_ts  — optional UTC-seconds window; falls back to `days`
    """
    if interval not in _CHART_INTERVALS:
        return {"stat": "Not_Ok", "emsg": f"interval must be one of {sorted(_CHART_INTERVALS)}"}

    broker = instance_manager.broker
    try:
        broker.login()

        import time as _time
        endtime = to_ts if (to_ts and to_ts > 0) else None
        if from_ts and from_ts > 0:
            starttime = from_ts
        else:
            # Include the latest session even on weekends: walk back until
            # the window start lands on a weekday.
            span = min(max(days, 0.5), _CHART_MAX_DAYS) * 86400
            starttime = _time.time() - span
            start_tm = _time.localtime(starttime)
            if _time.strftime("%a", start_tm) == "Sat":
                starttime -= 1 * 86400
            elif _time.strftime("%a", start_tm) == "Sun":
                starttime -= 2 * 86400

        rows = broker.api.get_time_price_series(
            exchange=exchange,
            token=str(token),
            starttime=starttime,
            endtime=endtime,
            interval=_CHART_INTERVALS[interval],
        )
        if not isinstance(rows, list):
            emsg = rows.get("emsg", "No series returned") if isinstance(rows, dict) else "No series returned"
            return {"stat": "Not_Ok", "emsg": emsg}

        bars = []
        seen_unknown = False
        for row in rows:
            if not isinstance(row, dict) or not row.get("time"):
                continue
            bar = _noren_row_to_bar(row)
            if bar is not None:
                bars.append(bar)
            elif not seen_unknown:
                seen_unknown = True
                logging.warning("[ChartHistory] unrecognized TPSeries row keys: %s", sorted(row.keys()))

        bars.sort(key=lambda b: b["time"])
        return {"stat": "Ok", "bars": bars, "count": len(bars), "interval": interval}

    except Exception as e:
        logging.error(f"Chart history error {exchange}|{token} {interval} → {e}")
        return {"stat": "Not_Ok", "emsg": str(e)}


# ============================================================
# OPTION CHAIN ROUTES (dashboard option-chain panel)
# ============================================================
#
# Built on the PiConnect option-chain surface (GetOptionChain through the
# broker session) plus the Flattrade scrip-master universe for the picker
# (services/scrip_master.py) and get_quotes for ATM resolution. Responses
# are normalized defensively because the row field names vary slightly
# across Noren builds.


@router.get("/optionchain/underlyings")
def optionchain_underlyings(q: str = "", exchange: str = "NFO"):
    """
    Underlyings for the option-chain picker — OpenAlgo `all_underlyings`
    parity. The published Flattrade scrip master, one entry per underlying
    that carries options (MCX/CDS keep futures-only names too), indices
    first, each with its nearest futures tsym/token (ATM spot resolution),
    lot size and the option expiries it carries.

    `?q=` filters names client-style (case-insensitive substring); without
    it the FULL list is returned and the panel filters locally.
    """
    try:
        exchange = (exchange or "NFO").upper()
        univ = scrip_master.option_universe(exchange)
        entries = univ["bases"]
        qn = (q or "").strip().upper()
        if qn:
            entries = [e for e in entries if qn in e["base"].upper()]
        return {"stat": "Ok", "underlyings": entries,
                "ts": univ.get("ts"), "count": len(entries)}
    except Exception as e:
        logging.error(f"Optionchain underlyings error ({exchange} q={q!r}) → {e}")
        return {"stat": "Not_Ok", "emsg": str(e), "underlyings": []}


def _normalize_oc_row(row: dict):
    tsym = row.get("tsym") or row.get("ts") or ""
    optt = (row.get("optt") or ("CE" if tsym.endswith("CE") else "PE" if tsym.endswith("PE") else "")).upper()

    def num(*keys):
        for k in keys:
            v = row.get(k)
            if v not in (None, ""):
                try:
                    return float(v)
                except (ValueError, TypeError):
                    continue
        return None

    data = {
        "tsym": tsym,
        "optt": optt,
        "strike": num("strprc", "strike"),
        "ltp": num("lp", "ltp"),
        "prev_close": num("c", "prev_close"),
        "oi": num("oi"),
        "volume": num("v", "vol", "volume"),
        "bid": num("bp1"),
        "ask": num("sp1"),
        "iv": num("iv"),
        "delta": num("delta"),
        "gamma": num("gamma"),
        "theta": num("theta"),
        "vega": num("vega"),
        # Doc-quirk strings pp/ti/ls ride along for contract metadata.
        "pp": row.get("pp"),
        "ti": row.get("ti"),
        "ls": row.get("ls"),
    }
    token = row.get("token") or row.get("tk")
    if token:
        data["token"] = str(token)
    return data


# Per-process expiry cache: futures token → its chain expiry string.
# One GetSecurityInfo covers EVERY leg of the chain (they share the expiry);
# the underlying's contract is stable for weeks, so this is cached.
_chain_expiry_cache = {}


_OC_TSYM_STRIKE = re.compile(r"^(.*?\d{1,2}[A-Z]{3}\d{0,4}?)(CE|PE|C|P)(\d.*)$", re.I)
_chain_key_repair_cache = {}


def _repaired_chain_key(broker, exchange: str, tsym: str, token: str):
    """Fix master scrip-master tsyms whose strike is truncated to 2dp
    ("USDINR28OCT26C97.12" — the scrip is 97.1250), which GetOptionChain
    rejects as an invalid trading symbol. GetSecurityInfo on the rep token
    carries the authoritative `strprc`; the strike side of the tsym is
    re-formatted from it and the repaired key is cached per tsym."""
    m = _OC_TSYM_STRIKE.match((tsym or "").upper().strip())
    if not m or not token:
        return tsym
    cache_key = f"{str(exchange).upper()}|{tsym}"
    if cache_key in _chain_key_repair_cache:
        return _chain_key_repair_cache[cache_key]
    repaired = tsym
    try:
        info = broker.get_scrip_info(exchange, str(token)) or {}
        strprc = info.get("strprc") or info.get("strike") or info.get("stprc")
        if strprc:
            strike = f"{float(strprc):.4f}".rstrip("0").rstrip(".")
            if strike and strike != m.group(3):
                repaired = f"{m.group(1)}{m.group(2).upper()}{strike}"
    except Exception as e:
        logging.debug(f"Chain-key repair lookup failed for {exchange}|{tsym}|{token}: {e}")
    if len(_chain_key_repair_cache) > 500:
        _chain_key_repair_cache.clear()
    _chain_key_repair_cache[cache_key] = repaired
    return repaired


def _chain_expiry(broker, exchange: str, token: str):
    key = f"{str(exchange).upper()}|{str(token)}"
    if key in _chain_expiry_cache:
        return _chain_expiry_cache[key]
    exd = None
    try:
        info = broker.get_scrip_info(exchange, token) or {}
        exd = info.get("exd") or info.get("exp") or None
    except Exception as e:
        logging.warning(f"Optionchain expiry lookup failed for {key}: {e}")
    if len(_chain_expiry_cache) > 500:
        _chain_expiry_cache.clear()
    _chain_expiry_cache[key] = exd
    return exd


def _fill_leg_quote(leg: dict, exchange: str):
    """One leg's live market data: the WS snapshot cache first (the charts
    page streams every chain leg), one normalized GetQuotes only when no
    streaming snapshot exists (first load). A failed quote is skipped, never
    fatal — the leg renders '-' and the WS will fill it in ~instantly.
    One quick retry for the occasional PiConnect burst-throttle."""
    token = leg.get("token")
    if not token:
        return
    ex = str(exchange).upper()
    snap = instance_manager.broker.get_md_snapshot(ex, str(token))
    if not (snap and snap.get("ltp") is not None):
        for attempt in range(2):
            try:
                snap = _normalized_quote_data(ex, str(token))
            except Exception as e:
                snap = None
                logging.debug(f"OC leg quote failed for {ex}|{token}: {e}")
                if token is not None and attempt == 0:
                    time.sleep(0.15)
                    continue
            break
    for src, dst in (("ltp", "ltp"), ("prev_close", "prev_close"), ("oi", "oi"),
                     ("volume", "volume"), ("bid", "bid"), ("ask", "ask")):
        v = snap.get(src)
        if v is not None:
            leg[dst] = v


@router.get("/optionchain/chain")
def optionchain_chain(
    exchange: str,
    underlying: str,
    token: str = "",
    count: int = 5,
    atm: float = None,
    expiry: str = "",
):
    """
    Full option chain around the ATM strike. `underlying` is the broker
    tradingsymbol of the underlying futures scrip (from /optionchain/underlyings),
    `token` is its token for the spot/ATM resolution. Pass ?atm=<strike>
    to skip resolution. `count` = strikes on each side of ATM (PiConnect's
    `cnt` — PER SIDE; the wire returns 4 x cnt contracts). `expiry`
    ("DD-MMON-YYYY", as the underlyings endpoint lists them) selects a
    non-nearest option series: GetOptionChain is keyed on ANY scrip of the
    chosen series, so an option of that expiry (from the picker's universe)
    drives the chain while the ATM spot stays on the futures.

    Pipeline (probed live against piconnect.flattrade.in):
      1. GetOptionChain → contract metadata only (tsym/token/optt/strprc/
         pp/ti/ls) — the endpoint carries no quotes and no Greeks;
      2. GetSecurityInfo on the underlying → the chain expiry (`exd`,
         "DD-MON-YYYY"), one call for the whole board;
      3. per-leg quotes — WS snapshot cache first, one GetQuotes each only
         where no stream exists;
      4. IV + Greeks inverted locally through Black-76 (GetOptionGreek takes
         volatility as an INPUT and no Flattrade endpoint returns IV);
         /api/optionchain/greek routes a single leg through the official
         PiConnect call for on-demand checks.
    """
    try:
        if count < 1:
            count = 1
        count = min(count, 20)
        broker = instance_manager.broker
        broker.login()

        if atm is None:
            if not token:
                return {"stat": "Not_Ok", "emsg": "token or atm required"}
            quote = None
            for attempt in range(2):
                quote = broker.get_quotes(exchange=exchange, token=str(token))
                if isinstance(quote, dict) and quote.get("stat") == "Ok":
                    break
                emsg_d = (quote or {}).get("emsg", "Quote failed") if isinstance(quote, dict) else "Quote failed"
                logging.debug(f"ATM quote failed for {exchange}|{token} (try {attempt + 1}): {emsg_d}")
                if attempt == 0:
                    time.sleep(0.3)  # PiConnect occasionally bursts-throttles
            if not isinstance(quote, dict) or quote.get("stat") != "Ok":
                emsg = (quote or {}).get("emsg", "Quote failed") if isinstance(quote, dict) else "Quote failed"
                return {"stat": "Not_Ok", "emsg": f"ATM resolution failed: {emsg}"}
            try:
                atm = float(quote.get("lp") or 0)
            except (ValueError, TypeError):
                atm = 0.0
            if atm <= 0:
                return {"stat": "Not_Ok", "emsg": "Underlying LTP unavailable right now"}

        # 1. Chain metadata — SPEC-verbatim GetOptionChain (emsg preserved,
        #    stat compared case-insensitively so "Ok"/"OK" both pass). A
        #    selected non-nearest expiry keys the call on that series'
        #    representative option (the panel lists them per underlying).
        chain_key = underlying
        chain_tok = ""
        entry = None
        try:
            univ = scrip_master.option_universe(exchange)
            entry = next((e for e in univ["bases"]
                          if e["base"] == underlying or e["tsym"] == underlying), None)
        except Exception as e:
            logging.warning(f"Optionchain universe lookup failed ({exchange}|{underlying}): {e}")
        if expiry and entry:
            tsym, tok = scrip_master.representative_for_expiry(entry, expiry)
            if tsym:
                chain_key, chain_tok = tsym, tok or ""
        meta = broker.get_pi_option_chain(exchange, chain_key, str(atm), count)

        def _pi_ok(m):
            return isinstance(m, dict) and str(m.get("stat") or "").upper() == "OK"

        if not _pi_ok(meta) and chain_key != underlying:
            # Some master tsyms truncate the strike to 2dp (CDS: "…C97.12"
            # vs the scrip's 97.1250) and GetOptionChain rejects them as
            # "Invalid Trading Symbol". The rep token's scrip info carries
            # the authoritative strprc — rebuild the key ONCE, cached.
            k2 = _repaired_chain_key(broker, exchange, chain_key, chain_tok)
            if k2 and k2 != chain_key:
                meta = broker.get_pi_option_chain(exchange, k2, str(atm), count)
                chain_key = k2

        if not _pi_ok(meta) and chain_key == underlying and entry:
            # MCX serves GetOptionChain for OPTION scrips only — a failed
            # futures-keyed call falls back to the nearest series the master
            # knows, and that series becomes the board expiry for the Greeks.
            exps = entry.get("expiries") or []
            if exps:
                tsym, tok = scrip_master.representative_for_expiry(entry, exps[0])
                if tsym and tsym != chain_key:
                    logging.info(f"Optionchain futures key empty for {exchange}|{underlying} — retrying on series {exps[0]}")
                    meta = broker.get_pi_option_chain(exchange, tsym, str(atm), count)
                    if _pi_ok(meta):
                        chain_key, chain_tok, expiry = tsym, tok or "", exps[0]
                    else:
                        k2 = _repaired_chain_key(broker, exchange, tsym, tok or "")
                        if k2 and k2 != tsym:
                            meta = broker.get_pi_option_chain(exchange, k2, str(atm), count)
                            if _pi_ok(meta):
                                chain_key, expiry = k2, exps[0]

        if not _pi_ok(meta):
            emsg = (meta or {}).get("emsg", "Chain unavailable for this underlying")
            return {"stat": "Not_Ok", "emsg": emsg}
        values = meta.get("values") or []

        grouped = {}
        for row in values:
            if not isinstance(row, dict):
                continue
            norm = _normalize_oc_row(row)
            if not norm["tsym"]:
                continue
            strike = norm["strike"]
            if strike is None:
                continue
            entry = grouped.setdefault(strike, {"strike": strike, "ce": None, "pe": None})
            if norm["optt"] in ("CE", "C") and entry["ce"] is None:
                entry["ce"] = norm
            elif norm["optt"] in ("PE", "P") and entry["pe"] is None:
                entry["pe"] = norm

        chain = [grouped[k] for k in sorted(grouped)]

        # 2. Board expiry: the user-selected one wins; otherwise ONE
        #    GetSecurityInfo on the futures token covers the whole series.
        board_expiry = (expiry or "").strip() or None
        if not board_expiry and token:
            board_expiry = _chain_expiry(broker, exchange, token)
        t_years = option_greeks.years_to_expiry(board_expiry) if board_expiry else None

        # 3. Legs' quotes: WS snapshot first, GetQuotes only where missing.
        legs = [leg for row in chain for leg in (row["ce"], row["pe"]) if leg]
        if legs:
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda leg: _fill_leg_quote(leg, exchange), legs))

        # 4. IV + Greeks per leg, computed from each leg's own market price
        #    (F = the underlying futures LTP, the model's forward price).
        spot = atm
        rate = option_greeks.risk_free_rate()
        for row in chain:
            for side in ("ce", "pe"):
                leg = row[side]
                if not leg or not (leg.get("ltp") or 0) > 0:
                    continue
                try:
                    greeks = option_greeks.compute_leg_greeks(
                        spot=spot, strike=leg["strike"],
                        t_years=t_years, optt=leg.get("optt") or side,
                        price=leg["ltp"], rate=rate,
                    )
                except Exception as e:
                    logging.debug(f"Greek computation failed for {leg.get('tsym')}: {e}")
                    continue
                for k, v in greeks.items():
                    if v is not None:
                        leg[k] = round(v, 6)

        return {
            "stat": "Ok",
            "underlying": underlying,
            "exchange": exchange.upper(),
            "underlying_ltp": atm,
            "atm_strike": round(atm, 2),
            "expiry": board_expiry,
            "int_rate": rate,
            "chain": chain,
            "count": len(chain),
        }
    except Exception as e:
        logging.error(f"Optionchain chain error {exchange}|{underlying} → {e}")
        return {"stat": "Not_Ok", "emsg": str(e)}


class OptionGreekPayload(BaseModel):
    """GetOptionGreek request — every numeric travels as a string (doc
    quirk); rates/vol are decimal fractions ("0.05"), not percentages."""
    exd: str
    strprc: str
    sptprc: str
    int_rate: str = "0.065"
    volatility: str
    optt: str  # "C" or "P" (CE/PE accepted, normalized by the helper)


@router.post("/optionchain/greek")
def optionchain_greek(payload: OptionGreekPayload):
    """
    One leg's Greeks through the official PiConnect GetOptionGreek.
    The option-chain panel computes Greeks locally (they follow from the
    IV it already had to invert); this endpoint exists for on-demand /
    cross-checks with the broker's own Black-Scholes engine.
    """
    try:
        resp = instance_manager.broker.get_pi_option_greek(
            exd=payload.exd, strprc=payload.strprc, sptprc=payload.sptprc,
            int_rate=payload.int_rate, volatility=payload.volatility,
            optt=payload.optt)
        if not isinstance(resp, dict) or str(resp.get("stat") or "").upper() != "OK":
            emsg = (resp or {}).get("emsg") or "GetOptionGreek failed"
            raise HTTPException(status_code=502, detail=emsg)
        return {"status": "success", "stat": resp.get("stat"),
                "request_time": resp.get("request_time"), "data": resp}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Optionchain greek error: {e}")
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/chart/watch")
def chart_watch(payload: ChartWatchPayload):
    """
    Subscribe / unsubscribe the chart's broker funnel for a symbol that
    is open in the charts page but not necessarily part of any engine.
    Refcounted — two tabs on the same instrument share one broker feed.
    """
    try:
        if payload.action == "sub":
            count = chart_feed_manager.subscribe(payload.exchange, payload.token, payload.client)
        elif payload.action == "unsub":
            count = chart_feed_manager.unsubscribe(payload.exchange, payload.token, payload.client)
        else:
            raise ValueError("action must be 'sub' or 'unsub'")
        # Ensure the shared broker websocket exists before relying on it.
        if payload.action == "sub":
            instance_manager.broker.start_websocket()
        return {"stat": "Ok", "viewers": count}
    except Exception as e:
        logging.error(f"Chart watch error {payload.exchange}|{payload.token} → {e}")
        return {"stat": "Not_Ok", "emsg": str(e)}