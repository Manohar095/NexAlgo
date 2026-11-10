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
                   "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400}
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
# TRADING TERMINAL ROUTES (OpenAlgoNew /trading replica)
# ============================================================
# The page's TradeFeed adapter (static/trading/trading_orders.mjs)
# consumes these. Shapes follow openalgo-charts' charts/trade contract:
#   place  -> {stat:'Ok', order_id} | {stat:'Not_Ok', rejected, error}
#   orders -> package `Order` rows (order lines + order panel)
#   positions -> package `Position` rows (position marker on chart)
# Kill switch: CHART_TRADING=0 in .env blocks every write while the
# books keep reading live.

try:
    from services import terminal_service
except Exception as _term_err:          # pragma: no cover
    terminal_service = None
    logging.error("terminal_service failed to import → %s", _term_err)


class TerminalOrderPayload(BaseModel):
    symbol: str
    exchange: str
    side: str                    # "BUY" | "SELL"
    type: str                    # "MARKET" | "LIMIT" | "SL" | "SL-M"
    qty: float                   # UNITS (page already multiplied by lotSize)
    product: str = "MIS"         # "CNC" | "NRML" | "MIS"
    price: float | None = None
    triggerPrice: float | None = None
    clientToken: str | None = None


class TerminalModifyPayload(BaseModel):
    orderId: str
    exchange: str
    symbol: str
    qty: float | None = None
    price: float | None = None
    triggerPrice: float | None = None
    type: str | None = None      # new ORDER TYPE (optional; none keeps the wire type)


class TerminalCancelPayload(BaseModel):
    orderId: str


class TerminalClosePayload(BaseModel):
    symbol: str
    exchange: str
    netQty: float
    product: str = "MIS"
    priceType: str = "MARKET"    # MARKET default; LIMIT/SL/SL-M also accepted
    price: float | None = None
    triggerPrice: float | None = None


def _terminal_unavailable():
    if terminal_service is None:
        return {"stat": "Not_Ok", "rejected": False,
                "error": "terminal service failed to load — see server logs"}
    return None


@router.post("/terminal/order")
def terminal_place_order(payload: TerminalOrderPayload):
    blocked = _terminal_unavailable()
    if blocked:
        return blocked
    try:
        return terminal_service.place_order(
            symbol=payload.symbol, exchange=payload.exchange,
            side=payload.side, order_type=payload.type,
            qty=payload.qty, product=payload.product,
            price=payload.price, trigger_price=payload.triggerPrice)
    except (ValueError, TypeError) as e:
        # Validation failure — nothing left this process (preflight).
        return {"stat": "Not_Ok", "rejected": False, "error": str(e)}
    except Exception as e:
        logging.exception("[TradingTerminal] place_order failed")
        return {"stat": "Not_Ok", "rejected": False, "error": str(e)}


@router.post("/terminal/order/modify")
def terminal_modify_order(payload: TerminalModifyPayload):
    blocked = _terminal_unavailable()
    if blocked:
        return blocked
    try:
        return terminal_service.modify_order(
            order_id=payload.orderId, exchange=payload.exchange,
            symbol=payload.symbol, qty=payload.qty, price=payload.price,
            trigger_price=payload.triggerPrice, order_type=payload.type)
    except (ValueError, TypeError) as e:
        return {"stat": "Not_Ok", "rejected": False, "error": str(e)}
    except Exception as e:
        logging.exception("[TradingTerminal] modify_order failed")
        return {"stat": "Not_Ok", "rejected": False, "error": str(e)}


@router.post("/terminal/order/cancel")
def terminal_cancel_order(payload: TerminalCancelPayload):
    blocked = _terminal_unavailable()
    if blocked:
        return blocked
    try:
        return terminal_service.cancel_order(order_id=payload.orderId)
    except Exception as e:
        logging.exception("[TradingTerminal] cancel_order failed")
        return {"stat": "Not_Ok", "rejected": False, "error": str(e)}


@router.post("/terminal/position/close")
def terminal_close_position(payload: TerminalClosePayload):
    blocked = _terminal_unavailable()
    if blocked:
        return blocked
    try:
        return terminal_service.close_position(
            symbol=payload.symbol, exchange=payload.exchange,
            net_qty=payload.netQty, product=payload.product,
            price_type=payload.priceType, price=payload.price,
            trigger_price=payload.triggerPrice)
    except (ValueError, TypeError) as e:
        return {"stat": "Not_Ok", "rejected": False, "error": str(e)}
    except Exception as e:
        logging.exception("[TradingTerminal] close_position failed")
        return {"stat": "Not_Ok", "rejected": False, "error": str(e)}


@router.get("/terminal/orders")
def terminal_orders():
    """Order book normalized to the package's `Order` rows."""
    if terminal_service is None:
        return {"stat": "Not_Ok", "error": "terminal service failed to load"}
    rows = terminal_service.get_orders()
    if rows is None:
        return {"stat": "Not_Ok", "error": "order book unavailable"}
    return {"stat": "Ok", "orders": rows}


@router.get("/terminal/positions")
def terminal_positions():
    """Position book normalized to the package's `Position` rows."""
    if terminal_service is None:
        return {"stat": "Not_Ok", "error": "terminal service failed to load"}
    rows = terminal_service.get_all_positions()
    if rows is None:
        return {"stat": "Not_Ok", "error": "position book unavailable"}
    return {"stat": "Ok", "positions": rows}


@router.post("/terminal/trading-status")
def terminal_trading_status():
    if terminal_service is None:
        return {"enabled": False, "reason": "terminal service failed to load"}
    if terminal_service.chart_trading_enabled():
        return {"enabled": True}
    return {"enabled": False, "reason": "CHART_TRADING=0"}


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
    # The wire's high/low are `inth`/`intl` (TPSeries carries into/inth/intl/
    # intc/intv/ssboe — verified live on MCX 5m and NSE 15m rows; e.g. RELIANCE
    # 09:15 bar: into 1194.00 / inth 1195.40 / intl 1187.00 / intc 1187.60).
    # `inoh`/`inol` exist on no Noren build: keying them alone made high/low
    # fall through to max/min(open, close) on EVERY intraday bar — candles
    # rendered body-only, no wicks, on all desks (openalgo reads inth/intl
    # and skips rows with any missing price, so its charts always showed
    # wicks). Keep the variants as fallbacks for odd SDK builds.
    high = _num("inth", "inoh")
    low = _num("intl", "inol")
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


def _eod_row_to_bar(row):
    """Normalize one EODChartData row into an openalgo-charts Bar.

    Daily rows carry `ssboe` (epoch seconds stamped 05:30 IST, i.e. the
    00:00-UTC daily grid the chart library buckets 1d on) + the same
    into/inth/intl/intc/intv/oi family as TPSeries. Row objects may
    arrive as JSON Strings (Noren quirk, openalgo re-parses too) —
    pre-decoded by the helper. Skipped rows: no ssboe, no OHLC, or an
    all-zero candle. Like openalgo, a close outside the day's hi/lo
    (BSE index feed quirk) widens the band to contain it.
    """
    if isinstance(row, str):  # usually pre-decoded; belt-and-braces
        return None
    if not isinstance(row, dict):
        return None

    from datetime import datetime as _dt
    from datetime import timezone as _tz_utc

    ssboe = row.get("ssboe")
    try:
        utc_seconds = int(float(ssboe))
    except (ValueError, TypeError):
        # ssboe is the documented primary time (doc sample: "ssboe":"1663718400"
        # for "21-SEP-2022" = 00:00 UTC grid). Defensive fallback: the `time`
        # field, in its two documented shapes.
        t = str(row.get("time") or "").strip()
        naive = None
        for fmt in ("%d-%b-%Y", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y"):
            try:
                naive = _dt.strptime(t, fmt)
                break
            except (ValueError, TypeError):
                continue
        if naive is None:
            return None
        if naive.hour == 0 and naive.minute == 0 and naive.second == 0:
            # date-only row: land it on the ssboe grid (00:00 UTC)
            utc_seconds = int(naive.replace(tzinfo=_tz_utc.utc).timestamp())
        else:
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

    open_ = _num("into")
    high = _num("inth", "inoh")
    low = _num("intl", "inol")
    close = _num("intc")
    if open_ is None or close is None:
        return None
    if open_ == 0 and close == 0:
        return None
    if high is None:
        high = max(open_, close)
    if low is None:
        low = min(open_, close)
    # openalgo's guard for BSE indices: EOD hi/lo can sit outside the
    # actual traded band; the close (and open) are the truth.
    high = max(high, open_, close)
    low = min(low, open_, close)

    volume = _num("intv", "inivot", "iv")
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
    days: float = None,
    from_ts: float = None,
    to_ts: float = None,
    tsym: str = None,
):
    """
    Broker candle history for the charts page. Returns openalgo-charts Bar
    objects: { time: UTC seconds, open, high, low, close, volume?, oi? }

    Two broker paths, openalgo/flattrade parity:
      intraday (1m|3m|5m|10m|15m|30m|1h|2h|4h) → Noren TPSeries
        (exch/token/st/et/intrv; `time` "dd-mm-yyyy HH:MM:SS" parsed as IST;
        the 09:14 pre-open discovery bar is dropped on NSE/BSE/NFO/BFO)
      daily ("1d") → Noren EODChartData
        (sym=EXCH:TRADINGSYMBOL, epoch from/to; `ssboe` epoch rows stamped
        05:30 IST (00:00 UTC), the same grid the chart library natively
        buckets 1d on; today's candle spliced from live quotes when the
        server has not cut it yet — skipped on weekends instead of the
        phantom bar openalgo appends)

    Query params:
      exchange / token — broker identifiers (NSE|26000 style)
      tsym             — the scripmaster Tradingsymbol the token resolved
                         from; REQUIRED for daily (EODChartData keys on it,
                         e.g. "NSE:RELIANCE-EQ"); falls back to GetSecurityInfo
      from_ts / to_ts  — optional UTC-seconds window; falls back to `days`
                         (intraday default 5 clamped to 8, daily default/par
                         3 years clamped to 10)
    """
    is_daily = interval in ("1d", "D", "1D")
    interval_label = "1d" if is_daily else interval
    if not is_daily and interval not in _CHART_INTERVALS:
        return {"stat": "Not_Ok", "emsg": f"interval must be one of {sorted(_CHART_INTERVALS) + ['1d']}"}

    broker = instance_manager.broker
    try:
        broker.login()

        import time as _time
        from datetime import datetime as _dt

        end_ts = to_ts if (to_ts and to_ts > 0) else _time.time()
        if is_daily:
            # OA lookbackDays('D') = 3 years; window clamped to 10y (their
            # own history guard's D ceiling).
            start_ts_d = from_ts if (from_ts and from_ts > 0) else end_ts - 3 * 365 * 86400
            if end_ts - start_ts_d > 10 * 366 * 86400:
                start_ts_d = end_ts - 10 * 366 * 86400
            # EODChartData keys on exchange:tsym — the token alone is not
            # part of that wire contract. `tsym` rides in from the chart
            # feed (the resolved scripmaster Tradingsymbol); if absent,
            # ask GetSecurityInfo once.
            daily_tsym = (tsym or "").strip()
            if not daily_tsym:
                info = broker.get_scrip_info(exchange, token)
                daily_tsym = str(info.get("ts") or info.get("tsym") or "").strip() if isinstance(info, dict) else ""
            if not daily_tsym:
                return {"stat": "Not_Ok", "emsg": f"daily candles need the scripmaster tsym for {exchange}|{token}"}

            rows = broker.get_eod_chart_data(exchange, daily_tsym, start_ts_d, end_ts)
            if not isinstance(rows, list):
                emsg = rows.get("emsg", "EODChartData returned no series") if isinstance(rows, dict) else "EODChartData returned no series"
                return {"stat": "Not_Ok", "emsg": emsg}

            bars = []
            for row in rows:
                b = _eod_row_to_bar(row)
                if b is not None:
                    bars.append(b)
            bars.sort(key=lambda b: b["time"])

            # Today's candle spliced from live quotes when the EOD server has
            # not cut one yet. openalgo parity: their splice lands today at
            # 00:00 UTC + 5:30 = 05:30 IST — that IS the ssboe grid (daily
            # rows are stamped 05:30 IST, verified live: Friday 2026-10-23
            # arrived as 1792713600). So the chart's live daily bucket
            # (epoch-aligned 86400 = the same grid) continues it seamlessly.
            # Deviation from OA: weekend guard — zero session on Sat/Sun IST →
            # no phantom bar from stale quotes (OA appends one anyway).
            today_ts = int(_time.time() // 86400) * 86400
            if start_ts_d <= today_ts <= end_ts and _time.gmtime(_time.time() + 19800).tm_wday < 5:
                if not bars or bars[-1]["time"] < today_ts:
                    try:
                        q = broker.api.get_quotes(exchange=exchange, token=str(token))
                        if isinstance(q, dict) and q.get("lp"):
                            try:
                                o = float(q["o"]); h = float(q["h"]); l = float(q["l"])
                                bar = {
                                    "time": today_ts,
                                    "open": o, "high": max(h, o, float(q["lp"])),
                                    "low": min(l, o, float(q["lp"])),
                                    "close": float(q["lp"]),
                                }
                                v = float(q.get("v") or 0)
                                if v > 0:
                                    bar["volume"] = int(v)
                                bars.append(bar)
                            except (KeyError, ValueError, TypeError):
                                pass  # quotes too incomplete — leave EOD as-is
                    except Exception as e:
                        # A failed splice must not sink the whole daily load
                        logging.warning("[ChartHistory] today-splice quotes failed %s|%s → %s", exchange, token, e)

            return {"stat": "Ok", "bars": bars, "count": len(bars), "interval": interval_label}

        # intraday — TPSeries
        endtime = to_ts if (to_ts and to_ts > 0) else None
        if from_ts and from_ts > 0:
            starttime = from_ts
        else:
            # Include the latest session even on weekends: walk back until
            # the window start lands on a weekday.
            span = min(max(days or 5, 0.5), _CHART_MAX_DAYS) * 86400
            starttime = _time.time() - span
            start_tm = _time.localtime(starttime)
            if _time.strftime("%a", start_tm) == "Sat":
                starttime -= 1 * 86400
            elif _time.strftime("%a", start_tm) == "Sun":
                starttime -= 2 * 86400

        # BrokerSession wrapper: retries once after a forced re-login — Noren
        # answers every TPSeries error as a JSON object and the SDK collapses
        # all of them to None, so a transient (throttle / session race /
        # socket hiccup) must be retried here. Still None after the retry →
        # the real Noren emsg is lost; say so instead of a bare "no data".
        rows = broker.get_time_price_series(
            exchange=exchange,
            token=str(token),
            starttime=starttime,
            endtime=endtime,
            interval=_CHART_INTERVALS[interval],
        )
        if not isinstance(rows, list):
            emsg = (
                rows.get("emsg", "No series returned")
                if isinstance(rows, dict) and rows.get("emsg")
                else "No series returned — broker answered no candles; check the broker session/feed and Retry"
            )
            return {"stat": "Not_Ok", "emsg": emsg}

        bars = []
        seen_unknown = False
        for row in rows:
            if not isinstance(row, dict) or not row.get("time"):
                continue
            # NSE/BSE/NFO/BFO TPSeries emits a 09:14 candle holding the
            # pre-open discovered price: flat OHLC, no volume. The session
            # opens at 09:15 — drop it (openalgo QA HS-07 parity).
            if exchange in ("NSE", "BSE", "NFO", "BFO") and " 09:14:" in row.get("time", ""):
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
    resolved = False
    try:
        info = broker.get_scrip_info(exchange, str(token)) or {}
        strprc = info.get("strprc") or info.get("strike") or info.get("stprc")
        if strprc:
            resolved = True
            strike = f"{float(strprc):.4f}".rstrip("0").rstrip(".")
            if strike and strike != m.group(3):
                repaired = f"{m.group(1)}{m.group(2).upper()}{strike}"
    except Exception as e:
        logging.debug(f"Chain-key repair lookup failed for {exchange}|{tsym}|{token}: {e}")
    if not resolved:
        # Nothing authoritative came back — don't remember the un-repaired key.
        return repaired
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
    if not exd:
        # A failed lookup must not be cached — the next load retries instead
        # of serving a chain with no expiry (and therefore no Greeks) forever.
        return None
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
    # A leg the broker refuses (throttle / no session) must never sink the
    # whole chain: `_normalized_quote_data` raises, both attempts leave snap
    # None, and the leg simply renders '-' until the WS frame fills it in.
    if not isinstance(snap, dict):
        return
    for src, dst in (("ltp", "ltp"), ("prev_close", "prev_close"), ("oi", "oi"),
                     ("volume", "volume"), ("bid", "bid"), ("ask", "ask")):
        v = snap.get(src)
        if v is not None:
            leg[dst] = v


# ------------------------------------------------------------
# Greeks through the documented PiConnect endpoints
# ------------------------------------------------------------
# GetOptionChain returns contract METADATA ONLY (exch/tsym/token/optt/strprc/
# pp/ti/ls — exactly the doc's `values` array), so the quotes are layered in
# from the WS/GetQuotes. GetOptionGreek is the documented Greeks call, but its
# `volatility` is an INPUT and no Flattrade endpoint returns IV: the leg's
# market price is inverted here first (spot Black-Scholes, the model
# GetOptionGreek itself evaluates), then the broker's engine answers with
# cal_*/put_* delta/gamma/theta/rho/vega for that leg.
#
# Its `sptprc` is a SPOT, so the futures LTP the chain is anchored on is NOT
# the right input — GetSecurityInfo on a leg carries `und_exch`/`und_tk`
# (e.g. NSE 26009 = BANKNIFTY), which is what the broker's own UI prices.
_chain_spot_cache = {}   # "EXCH|TOKEN" → (monotonic, spot)
_CHAIN_SPOT_TTL = 60.0

# Greek results are cached briefly: the panel polls OI/IV every 30s and the
# same leg at the same volatility answers identically, so the poll must not
# fan 4×cnt GetOptionGreek calls at the broker every time.
_greek_cache = {}        # "TSYM|EXD" → (monotonic, {delta…rho})
_GREEK_TTL = 60.0
_GREEK_KEYS = ("delta", "gamma", "theta", "vega", "rho")


def _chain_spot(broker, exchange: str, token: str):
    """The SPOT behind an option contract — GetSecurityInfo's und_exch/und_tk
    (the index for NFO/BFO index options), quoted once and cached for a
    minute. Returns None when the underlying cannot be resolved (the caller
    then prices off the futures LTP)."""
    if not token:
        return None
    key = f"{str(exchange).upper()}|{str(token)}"
    hit = _chain_spot_cache.get(key)
    now = time.monotonic()
    if hit and now - hit[0] < _CHAIN_SPOT_TTL:
        return hit[1]
    spot = None
    try:
        info = broker.get_scrip_info(exchange, str(token)) or {}
        und_exch = info.get("und_exch") or info.get("uexch")
        und_tk = info.get("und_tk") or info.get("utoken")
        if und_exch and und_tk:
            q = broker.get_quotes(exchange=str(und_exch).upper(), token=str(und_tk))
            if isinstance(q, dict) and str(q.get("stat") or "").lower() == "ok":
                spot = float(q.get("lp") or 0) or None
    except Exception as e:
        logging.debug(f"Underlying spot lookup failed for {key}: {e}")
    if len(_chain_spot_cache) > 500:
        _chain_spot_cache.clear()
    _chain_spot_cache[key] = (now, spot)
    return spot


def _official_leg_greeks(leg: dict, exd: str, spot: float, iv: float, rate: float):
    """One leg's Greeks from the documented GetOptionGreek call. Returns None
    when the broker refuses (the caller keeps the locally computed values).
    `iv` is the decimal volatility the model inverted (0.16 = 16%)."""
    tsym = leg.get("tsym") or ""
    strike = leg.get("strike")
    if not tsym or not strike:
        return None
    # Keyed on the contract, not the volatility: the panel re-asks on every
    # chain load and a minute-old Greek is still the number a trader reads.
    key = f"{tsym}|{exd}"
    now = time.monotonic()
    hit = _greek_cache.get(key)
    if hit and now - hit[0] < _GREEK_TTL:
        return hit[1]
    resp = instance_manager.broker.get_pi_option_greek(
        exd=exd, strprc=str(strike), sptprc=str(spot),
        int_rate=str(rate), volatility=str(iv), optt=leg.get("optt") or "CE")
    if not isinstance(resp, dict) or str(resp.get("stat") or "").upper() != "OK":
        return None
    side = "cal" if str(leg.get("optt") or "").upper().startswith("C") else "put"
    out = {}
    for k in _GREEK_KEYS:
        v = resp.get(f"{side}_{k}")
        out[k] = float(v) if isinstance(v, (int, float)) else None
    if len(_greek_cache) > 4000:
        _greek_cache.clear()
    _greek_cache[key] = (now, out)
    return out


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
      4. IV + Greeks inverted locally through Black-76 (the chain is anchored
         on the futures LTP, a forward price). These keep the first paint
         fast; POST /api/optionchain/greeks upgrades them to the broker's own
         GetOptionGreek numbers for the legs on screen.
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
            # The panel streams the underlying over WS, so its cached snapshot
            # is usually already here — that is one broker call saved and the
            # one source that cannot be burst-throttled. GetQuotes (with a
            # couple of retries) only when nothing is streaming.
            atm = 0.0
            snap = broker.get_md_snapshot(str(exchange).upper(), str(token))
            if snap and snap.get("ltp") is not None:
                try:
                    atm = float(snap.get("ltp") or 0)
                except (ValueError, TypeError):
                    atm = 0.0
            quote = None
            if atm <= 0:
                for attempt in range(3):
                    quote = broker.get_quotes(exchange=exchange, token=str(token))
                    if isinstance(quote, dict) and quote.get("stat") == "Ok":
                        break
                    emsg_d = (quote or {}).get("emsg", "Quote failed") if isinstance(quote, dict) else "Quote failed"
                    logging.debug(f"ATM quote failed for {exchange}|{token} (try {attempt + 1}): {emsg_d}")
                    if attempt < 2:
                        time.sleep(0.3 if attempt == 0 else 0.7)
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
            def _safe_leg_quote(leg):
                # One leg's quote must never sink the chain (the panel retries
                # silently, but a 40-leg fan-out is the worst place to lose it).
                try:
                    _fill_leg_quote(leg, exchange)
                except Exception as e:
                    logging.debug(f"OC leg quote failed for {leg.get('tsym')}: {e}")
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(_safe_leg_quote, legs))

        # 4. IV + Greeks per leg from its own market price. These are the
        #    local closed-form values (fast, no broker round-trip); the panel
        #    upgrades them to the broker's own numbers through
        #    POST /api/optionchain/greeks (documented GetOptionGreek) when a
        #    Greek column is on screen. The chain's reference price is the
        #    underlying FUTURES LTP, so the forward model (Black-76) applies.
        spot = atm
        rate = option_greeks.risk_free_rate()
        for row in chain:
            for side in ("ce", "pe"):
                leg = row[side]
                if not leg or not (leg.get("ltp") or 0) > 0 or not t_years:
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
                    if v is None:
                        continue
                    # The panel prints IV with a '%' suffix (OptionChainPanel
                    # metricOf), so the wire unit is percent; the model works
                    # in decimals (GetOptionGreek's `volatility` unit).
                    leg[k] = round(v * 100.0, 2) if k == "iv" else round(v, 6)
                leg["greeks_source"] = "local"

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


class OptionGreeksLeg(BaseModel):
    """One chain leg as the panel already has it — the contract identity plus
    the market price whose implied volatility the model inverts."""
    tsym: str
    token: str = ""
    strike: float
    optt: str = "CE"
    ltp: float = 0


class OptionGreeksPayload(BaseModel):
    """POST /api/optionchain/greeks — the documented GetOptionGreek call for
    the legs currently on screen. `expiry` is the chain's board expiry
    ("DD-MON-YYYY"); `spot` is optional (the underlying's index/spot is
    resolved server-side when it is omitted)."""
    exchange: str = "NFO"
    expiry: str
    legs: list[OptionGreeksLeg] = []
    spot: float = None


@router.post("/optionchain/greeks")
def optionchain_greeks(payload: OptionGreeksPayload):
    """
    Greeks for the chain legs the panel is showing, through the documented
    PiConnect GetOptionGreek endpoint (one call per leg).

    GetOptionGreek takes VOLATILITY as an input and no Flattrade endpoint
    returns IV, so each leg's own market price is inverted first — with the
    spot Black-Scholes model GetOptionGreek itself evaluates (`sptprc` is a
    SPOT, live-probed; see services/option_greeks.py) — and the broker's
    engine then answers with cal_*/put_* delta/gamma/theta/rho/vega for that
    volatility. Legs whose call is refused keep the locally computed values,
    tagged `source: "local"` so the panel can tell the two apart.

    Batched on purpose: the chain route stays a single fast pass, and the
    panel asks for these in small groups after the chain has painted.
    """
    try:
        ex = (payload.exchange or "NFO").upper()
        legs = [l for l in (payload.legs or [])
                if l.tsym and l.strike and (l.ltp or 0) > 0][:64]
        if not legs:
            return {"stat": "Ok", "greeks": {}, "count": 0}
        t_years = option_greeks.years_to_expiry(payload.expiry) if payload.expiry else None
        if not t_years:
            return {"stat": "Not_Ok", "emsg": "expiry is required (DD-MON-YYYY)"}
        broker = instance_manager.broker
        broker.login()
        rate = option_greeks.risk_free_rate()
        spot = payload.spot or None
        spot_source = "request" if spot else ""
        if not spot:
            spot = _chain_spot(broker, ex, legs[0].token)
            spot_source = "spot" if spot else ""
        if not spot:
            return {"stat": "Not_Ok", "emsg": "underlying spot unavailable"}
        out = {}

        def _one(leg: OptionGreeksLeg):
            try:
                g = option_greeks.compute_leg_greeks_spot(
                    spot=spot, strike=leg.strike, t_years=t_years,
                    optt=leg.optt or "CE", price=leg.ltp, rate=rate)
            except Exception as e:
                logging.debug(f"OC greeks: model failed for {leg.tsym}: {e}")
                return
            if g.get("iv") is None:
                return
            entry = {"iv": round(g["iv"] * 100.0, 2), "source": "local"}
            for k in _GREEK_KEYS:
                v = g.get(k)
                entry[k] = round(v, 6) if isinstance(v, (int, float)) else None
            off = _official_leg_greeks(
                {"tsym": leg.tsym, "strike": leg.strike, "optt": leg.optt},
                payload.expiry, spot, g["iv"], rate)
            if off:
                for k in _GREEK_KEYS:
                    v = off.get(k)
                    entry[k] = round(v, 6) if isinstance(v, (int, float)) else None
                entry["source"] = "piconnect"
            out[leg.tsym] = entry

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(legs))) as pool:
            list(pool.map(_one, legs))

        return {"stat": "Ok", "exchange": ex, "expiry": payload.expiry,
                "spot": spot, "spot_source": spot_source, "int_rate": rate,
                "greeks": out, "count": len(out)}
    except Exception as e:
        logging.error(f"Optionchain greeks error {payload.exchange} → {e}")
        return {"stat": "Not_Ok", "emsg": str(e), "greeks": {}}


@router.post("/optionchain/greek")
def optionchain_greek(payload: OptionGreekPayload):
    """
    One leg's Greeks through the official PiConnect GetOptionGreek.
    The option-chain panel uses the batched /optionchain/greeks for the legs
    on screen; this single-leg form exists for on-demand / manual checks.
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


# ------------------------------------------------------------
# PiConnect chain — the standalone "Pi chain" panel
# ------------------------------------------------------------
# The new panel is built ONLY on the two documented PiConnect endpoints:
#   GetOptionChain → contract metadata (exch/tsym/token/optt/strprc/pp/ti/ls)
#   GetOptionGreek → the Greeks, one call per leg at an inverted volatility
# GetOptionChain carries NO quotes (probe-verified 29-10-2026 — the wire
# answers exactly the doc's fields), and GetOptionGreek computes from given
# inputs rather than fetching market prices, so prices/spot arrive through
# the platform's own /ws market-data stream. `strprc` is only the MID the
# board centres on (probe: odd values snap, degenerate values clamp, "" is
# rejected) — the live spot from the WS is exactly the right value for it.
@router.get("/pichain/chain")
def pichain_chain(
    exchange: str,
    tsym: str,
    cnt: int = 10,
    strprc: str = "",
):
    """
    One GetOptionChain round, spec-verbatim. `tsym` is ANY scrip of the
    series to display — a futures key or one option of the board both key
    the same series (probe-verified live: both answer the identical board).
    `strprc` is the mid the board centres on; when the panel has no live
    spot yet, the shared WS snapshot cache answers for it — and only the
    contract metadata ever comes back, so the panel paints the rows from
    GetOptionChain alone and lets the WS fill the quotes in.
    """
    try:
        exch = str(exchange).upper()
        broker = instance_manager.broker
        broker.login()
        # cnt is strikes PER SIDE (doc); the wire returns cnt*4 contracts.
        cnt = min(max(1, cnt), 20)

        mid = str(strprc).strip()
        if not mid:
            return {"stat": "Not_Ok", "emsg": "strprc mid unavailable — waiting for a live spot"}
        meta = broker.get_pi_option_chain(exch, tsym, mid, cnt)
        if not (isinstance(meta, dict) and str(meta.get("stat") or "").upper() == "OK"):
            emsg = (meta or {}).get("emsg", "") if isinstance(meta, dict) else ""
            return {"stat": "Not_Ok", "emsg": emsg or "GetOptionChain refused — retrying"}
        rows = []
        for row in meta.get("values") or []:
            if not isinstance(row, dict):
                continue
            norm = _normalize_oc_row(row)
            if norm.get("tsym"):
                rows.append(norm)
        # mid back as a number so the panel can pick the nearest strike (ATM)
        try:
            mid_f = float(mid)
        except (ValueError, TypeError):
            mid_f = None
        return {"stat": "Ok", "exchange": exch, "mid": mid_f, "cnt": cnt,
                "contracts": rows, "count": len(rows)}
    except Exception as e:
        logging.error(f"Pichain chain error {exchange}|{tsym} → {e}")
        return {"stat": "Not_Ok", "emsg": str(e)}


class PiGreeksLeg(BaseModel):
    """One Pi-chain leg: the contract plus its LIVE price (from the WS)."""
    tsym: str
    token: str = ""
    strike: float
    optt: str = "CE"
    ltp: float = 0


class PiGreeksPayload(BaseModel):
    """POST /api/pichain/greeks — GetOptionGreek per leg, batched. The spot
    (`sptprc`) is the live underlying price from the WS; the expiry is the
    board's "DD-MON-YYYY" string as the picker universe lists it."""
    exchange: str = "NFO"
    expiry: str
    spot: float
    legs: list[PiGreeksLeg] = []


@router.post("/pichain/greeks")
def pichain_greeks(payload: PiGreeksPayload):
    """
    Greeks for the Pi-chain legs THROUGH THE DOCUMENTED ENDPOINT ONLY:
    each leg's live LTP (WS) is inverted with the spot Black-Scholes model
    GetOptionGreek itself evaluates, then GetOptionGreek answers the leg's
    cal_*/put_* numbers at that volatility. One broker round-trip per leg —
    the panel asks in groups of 8 after the chain has painted, and a leg
    that has no live price yet is simply not sent until the WS delivers one.
    """
    try:
        legs = [l for l in (payload.legs or [])
                if l.tsym and l.strike and (l.ltp or 0) > 0][:64]
        if not legs:
            return {"stat": "Ok", "greeks": {}, "count": 0}
        if not payload.spot:
            return {"stat": "Not_Ok", "emsg": "spot is required (live underlying price)"}
        t_years = option_greeks.years_to_expiry(payload.expiry) if payload.expiry else None
        if not t_years:
            return {"stat": "Not_Ok", "emsg": "expiry is required (DD-MON-YYYY)"}
        broker = instance_manager.broker
        broker.login()
        rate = option_greeks.risk_free_rate()
        out = {}

        def _one(leg: PiGreeksLeg):
            try:
                g = option_greeks.compute_leg_greeks_spot(
                    spot=payload.spot, strike=leg.strike, t_years=t_years,
                    optt=leg.optt or "CE", price=leg.ltp, rate=rate)
            except Exception as e:
                logging.debug(f"Pi greeks: model failed for {leg.tsym}: {e}")
                return
            if g.get("iv") is None:
                return
            entry = {"iv": round(g["iv"] * 100.0, 2), "source": "local"}
            for k in _GREEK_KEYS:
                v = g.get(k)
                entry[k] = round(v, 6) if isinstance(v, (int, float)) else None
            off = _official_leg_greeks(
                {"tsym": leg.tsym, "strike": leg.strike, "optt": leg.optt},
                payload.expiry, payload.spot, g["iv"], rate)
            if off:
                for k in _GREEK_KEYS:
                    v = off.get(k)
                    entry[k] = round(v, 6) if isinstance(v, (int, float)) else None
                entry["source"] = "piconnect"
            out[leg.tsym] = entry

        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(legs))) as pool:
            list(pool.map(_one, legs))

        return {"stat": "Ok", "exchange": str(payload.exchange).upper(),
                "expiry": payload.expiry, "spot": payload.spot,
                "int_rate": rate, "greeks": out, "count": len(out)}
    except Exception as e:
        logging.error(f"Pichain greeks error {payload.exchange} → {e}")
        return {"stat": "Not_Ok", "emsg": str(e), "greeks": {}}


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