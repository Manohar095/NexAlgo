# -*- coding: utf-8 -*-
"""
services/access_token_generator.py
=====================================
This is the user's existing standalone access-token generator script,
integrated in place — same auth flow (session → TOTP login → auth
code → API token), same .env write-back. Two changes only:

  1. Credentials are read via config.settings (already parsed once,
     shared with the rest of the platform) instead of re-parsing .env
     locally, so there's one source of truth for FT_USER/FT_PWD/etc.
  2. The three network calls are wrapped in generate_and_save_token(),
     an async function the FastAPI route can simply `await` — no
     subprocess, no polling, real exceptions on failure instead of a
     silent "Failed" print.

The original script's standalone `python access_token_generator.py`
usage still works unchanged (see __main__ block at the bottom) for
anyone who prefers running it from a terminal / cron / Task Scheduler
instead of the dashboard button.
"""

import asyncio
import hashlib
import logging
import os
from urllib.parse import urlparse, parse_qs

import httpx
import pyotp

from config.settings import settings, ENV_PATH

HOST     = "https://auth.flattrade.in"
API_HOST = "https://authapi.flattrade.in"

routes = {
    "session":  f"{API_HOST}/auth/session",
    "ftauth":   f"{API_HOST}/ftauth",
    "apitoken": f"{API_HOST}/trade/apitoken",
}

headers = {
    "Accept":          "application/json",
    "Accept-Language": "en-US,en;q=0.5",
    "Host":            "authapi.flattrade.in",
    "Origin":          f"{HOST}",
    "Referer":         f"{HOST}/",
}


def _encode_item(item):
    return hashlib.sha256(item.encode()).hexdigest()


def _require_credentials():
    missing = [name for name, val in [
        ("FT_USER", settings.FT_USER),
        ("FT_PWD", settings.FT_PWD),
        ("FT_TOTP_KEY", settings.FT_TOTP_KEY),
        ("FT_API_KEY", settings.FT_API_KEY),
        ("FT_API_SECRET", settings.FT_API_SECRET),
    ] if not val]
    if missing:
        raise RuntimeError(
            f"Missing credential(s) in .env: {', '.join(missing)}. "
            "Fill these in before generating a token."
        )


# ================= AUTH (same flow as the original script) =================
async def _get_authcode(client):
    r1 = await client.post(routes["session"])
    if r1.status_code != 200:
        raise RuntimeError(f"Session error ({r1.status_code}): {r1.text}")
    sid = r1.text

    payload = {
        "UserName": settings.FT_USER,
        "Password": _encode_item(settings.FT_PWD),
        "App":      "",
        "ClientID": "",
        "Key":      "",
        "APIKey":   settings.FT_API_KEY,
        "PAN_DOB":  pyotp.TOTP(settings.FT_TOTP_KEY).now(),
        "Sid":      sid,
        "Override": ""
    }

    r2 = await client.post(routes["ftauth"], json=payload)
    if r2.status_code != 200:
        raise RuntimeError(f"Auth error ({r2.status_code}): {r2.text}")

    response_data = r2.json()

    if response_data.get("emsg") == "DUPLICATE":
        logging.info("[TokenGen] Duplicate session detected → overriding...")
        payload["Override"] = "Y"
        r2 = await client.post(routes["ftauth"], json=payload)
        if r2.status_code != 200:
            raise RuntimeError(f"Override error ({r2.status_code}): {r2.text}")
        response_data = r2.json()

    redirect_url = response_data.get("RedirectURL", "")
    query_params = parse_qs(urlparse(redirect_url).query)

    if "code" not in query_params:
        raise RuntimeError(f"No auth code in redirect URL: {redirect_url}")

    code = query_params["code"][0]
    logging.info("[TokenGen] Auth code obtained ✅")
    return code


async def _get_apitoken(client, code):
    r = await client.post(
        routes["apitoken"],
        json={
            "api_key":      settings.FT_API_KEY,
            "request_code": code,
            "api_secret":   _encode_item(f"{settings.FT_API_KEY}{code}{settings.FT_API_SECRET}")
        }
    )
    if r.status_code != 200:
        raise RuntimeError(f"Token error ({r.status_code}): {r.text}")

    token = r.json().get("token", "")
    if not token:
        raise RuntimeError(f"No token in response: {r.text}")
    return token


# ================= SAVE TOKEN TO .env (unchanged from original script) ======
def save_token_to_env(token):
    lines = []
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH, "r") as f:
            lines = f.readlines()

    new_lines = []
    token_written = False

    for line in lines:
        if line.startswith("FT_ACCESS_TOKEN"):
            new_lines.append(f'FT_ACCESS_TOKEN="{token}"\n')
            token_written = True
        else:
            new_lines.append(line)

    if not token_written:
        new_lines.append(f'FT_ACCESS_TOKEN="{token}"\n')

    with open(ENV_PATH, "w") as f:
        f.writelines(new_lines)

    logging.info("[TokenGen] ✅ Access token saved to %s", ENV_PATH)


# ================= PUBLIC ENTRY POINT =================
async def generate_and_save_token():
    """
    Runs the full headless login flow and writes the resulting token
    to .env. Returns the new token on success; raises RuntimeError with
    a clear message on any failure, for the API route to surface to
    the dashboard.
    """
    _require_credentials()

    logging.info("[TokenGen] 🔐 Generating Flattrade access token...")
    async with httpx.AsyncClient(http2=True, headers=headers, timeout=30) as client:
        code = await _get_authcode(client)
        token = await _get_apitoken(client, code)

    save_token_to_env(token)
    logging.info("[TokenGen] 🚀 Done — access token refreshed")
    return token


# ================= STANDALONE CLI USAGE (unchanged behaviour) =================
async def _main():
    print("🔐 Generating Flattrade access token...")
    try:
        await generate_and_save_token()
        print("🚀 Done! You can now start the trading bot.")
    except Exception as e:
        print(f"❌ {e}")


if __name__ == "__main__":
    asyncio.run(_main())
