# -*- coding: utf-8 -*-
"""
config/settings.py
===================
Shared, process-wide settings — broker credentials and platform-level
defaults. Per-symbol strategy settings live in models/symbol_config.py
and are stored per-row in SQLite, NOT here.
"""

import os
from dotenv import load_dotenv

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(BASE_DIR, ".env")
load_dotenv(dotenv_path=ENV_PATH, override=True)


def _get_env(var_name, default=""):
    value = os.getenv(var_name, default)
    return value.strip().replace('"', '').replace("'", "") if value else value


class Settings:
    # ---- Broker (Flattrade / Noren) — shared login for ALL symbols ----
    FT_USER        = _get_env("FT_USER")
    FT_PWD         = _get_env("FT_PWD")
    FT_TOTP_KEY    = _get_env("FT_TOTP_KEY")
    FT_API_KEY     = _get_env("FT_API_KEY")
    FT_API_SECRET  = _get_env("FT_API_SECRET")
    FT_RURL        = _get_env("FT_RURL")
    FT_ACCESS_TOKEN = _get_env("FT_ACCESS_TOKEN")

    # ---- Platform ----
    DB_PATH        = os.path.join(BASE_DIR, "database", "renko_platform.db")
    HOST           = _get_env("APP_HOST", "0.0.0.0")
    PORT           = int(_get_env("APP_PORT", "8000") or "8000")

    # ---- Dashboard login (optional) ----
    # If both are set, every request (including the WebSocket) requires
    # HTTP Basic Auth. If either is blank, auth is skipped entirely —
    # useful for local dev / SSH-tunnel-only setups that don't need it.
    DASHBOARD_USER     = _get_env("DASHBOARD_USER")
    DASHBOARD_PASSWORD = _get_env("DASHBOARD_PASSWORD")

    # ---- Defaults (used only when a new symbol config omits a field) ----
    DEFAULT_TICK_SIZE     = 0.05
    DEFAULT_SL_LMT_BUFFER = 0.10
    USE_IST_TIMEZONE      = True


settings = Settings()
