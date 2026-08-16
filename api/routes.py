# -*- coding: utf-8 -*-
"""
api/routes.py
==============
REST endpoints consumed by the dashboard (static/app.js).
"""

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

from config.settings import settings
from models.symbol_config import SymbolConfig
from services import access_token_generator
from services.instance_manager import instance_manager
from utils.session_auth import create_session_token, verify_login, SESSION_MAX_AGE_SECONDS

router = APIRouter(prefix="/api")


class SymbolPayload(BaseModel):
    config: SymbolConfig


class LoginPayload(BaseModel):
    username: str
    password: str
    totp_code: str = ""


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
        # secure=True belongs here once this is served over HTTPS (e.g.
        # behind a reverse proxy with TLS) — left off since a bare
        # SSH-tunnel/private-IP deployment is plain HTTP by default.
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
        # Login likely failed against the broker with this token — still
        # saved, so the dashboard reflects what was entered, but surface
        # the failure so the user knows to double check it.
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
