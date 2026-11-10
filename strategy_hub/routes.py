# -*- coding: utf-8 -*-
"""
strategy_hub/routes.py — /strategy-hub/api/* (port of strategy_hub/blueprint.py).

The UI is the "Algo symbols" panel in the right pane; there is no page served
from here. All handlers are sync `def` — FastAPI runs them in the threadpool
(the scrip search inside validate_instrument blocks for a second or two).
"""

import logging

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from strategy_hub import registry, service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/strategy-hub/api")


def _err(message, code=400, **extra):
    return JSONResponse(status_code=code, content={"status": "error", "message": message, **extra})


@router.get("/overview")
def api_overview():
    try:
        counts = service.exchange_counts()
        processes = [registry.process_info(ex, *counts[ex])
                     for ex in service.EXCHANGES if ex in counts]
        return {"status": "success",
                # NexAlgo trades the real account; there is no analyzer toggle to read.
                "analyze_mode": None,
                "processes": processes, "symbols": service.list_with_status()}
    except Exception:
        logger.exception("strategy-hub overview failed")
        return _err("Could not load symbols", 500)


@router.get("/defaults")
def api_defaults(exchange: str = "NFO"):
    exchange = (exchange or "NFO").upper()
    return {"status": "success", "data": service.default_config(exchange),
            "schedule_stop": registry.schedule_stop_for(exchange)}


@router.get("/search")
def api_search(q: str = "", exchange: str = ""):
    q = (q or "").strip()
    if len(q) < 2:
        return {"status": "success", "data": []}
    exchange = (exchange or "").upper() or None
    try:
        return {"status": "success", "data": service.search_symbols(q, exchange, limit=25)}
    except Exception:
        logger.exception("strategy-hub symbol search failed")
        return _err("Symbol search failed", 500)


@router.post("/symbols")
def api_create(payload: dict = Body(default={})):
    symbol = str(payload.get("symbol", "")).strip()
    exchange = str(payload.get("exchange", "")).strip().upper()
    if not symbol or exchange not in service.EXCHANGES:
        return _err("symbol and a supported exchange are required")

    cfg, errors = service.validate_config(payload, schedule_stop=registry.schedule_stop_for(exchange))
    instrument, inst_errors = service.validate_instrument(symbol, exchange, cfg)
    errors += inst_errors
    if errors:
        return _err("; ".join(errors), 400, errors=errors)

    row, dup = service.create_symbol(symbol, exchange, cfg, instrument,
                                     strategy_name=str(payload.get("strategy_name") or "").strip() or None)
    if dup:
        return _err(dup, 409)
    return {"status": "success", "message": f"{exchange}:{symbol} added (disabled)", "data": row}


@router.put("/symbols/{row_id}")
def api_update(row_id: int, payload: dict = Body(default={})):
    existing = service.get_symbol(row_id)
    if not existing:
        return _err("Symbol not found", 404)

    cfg, errors = service.validate_config(
        payload, schedule_stop=registry.schedule_stop_for(existing["exchange"]))
    instrument, inst_errors = service.validate_instrument(existing["symbol"], existing["exchange"], cfg)
    errors += inst_errors
    if errors:
        return _err("; ".join(errors), 400, errors=errors)

    row, message, code = service.update_symbol(row_id, cfg, instrument)
    if message:
        return _err(message, code)
    return {"status": "success", "message": "Settings saved", "data": row}


@router.delete("/symbols/{row_id}")
def api_delete(row_id: int):
    message, code = service.delete_symbol(row_id)
    if message:
        return _err(message, code)
    return {"status": "success", "message": "Symbol removed"}


@router.post("/symbols/{row_id}/enable")
def api_enable(row_id: int):
    row, message, code = service.set_enabled(row_id, True)
    if message:
        return _err(message, code)
    try:
        ok, note, state = registry.start_process(row["exchange"])
    except Exception:
        logger.exception("hub start_process failed")
        ok, note, state = False, "could not start the strategy process (see server log)", "error"
    if ok:
        return {"status": "success", "message": f"Enabled. {note}", "data": row, "process_state": state}
    return {"status": "success", "warning": True, "data": row, "process_state": state,
            "message": f"Enabled, but the strategy process did not start: {note}"}


@router.post("/symbols/{row_id}/disable")
def api_disable(row_id: int):
    row, message, code = service.set_enabled(row_id, False)
    if message:
        return _err(message, code)
    return {"status": "success", "data": row,
            "message": "Disabled. Broker orders and positions were left untouched."}


@router.post("/symbols/{row_id}/command")
def api_command(row_id: int, payload: dict = Body(default={})):
    command = str(payload.get("command", "")).upper()
    message, code = service.queue_command(row_id, command)
    if message:
        return _err(message, code)
    return {"status": "success", "message": f"{command} queued"}


@router.post("/process/{exchange}/{action}")
def api_process(exchange: str, action: str):
    exchange = exchange.upper()
    if exchange not in service.EXCHANGES:
        return _err("Unsupported exchange")
    try:
        if action == "start":
            ok, message, state = registry.start_process(exchange)
        elif action == "stop":
            ok, message, state = registry.stop_process(exchange)
        elif action == "restart":
            ok, message, state = registry.restart_process(exchange)
        else:
            return _err("Unknown action", 404)
    except Exception:
        logger.exception("strategy-hub process action failed")
        return _err("Process action failed (see server log)", 500)
    if not ok:
        return _err(message, 409)
    return {"status": "success", "message": message, "process_state": state}
