# -*- coding: utf-8 -*-
"""
utils/session_auth.py
========================
Minimal signed-session helper for the dashboard login. No new
dependency — just stdlib hmac/hashlib for the signature, and pyotp
(already a dependency, used by the access-token generator) for TOTP.

A session token is: base64(username:expiry_ts).hex_hmac_signature
Verifying it re-computes the HMAC and checks it matches (constant-time)
AND that expiry_ts hasn't passed. That's the whole trust model — no
server-side session store needed, which keeps this stateless and simple
for a single-operator tool.

SESSION_SECRET_KEY should be set in .env for sessions to survive a
process restart. If it's not set, a random one is generated at startup
instead — a safe default (nothing breaks) but it means every restart
invalidates all existing sessions, forcing a fresh login. That's a
reasonable trade-off for a trading dashboard; worth knowing about
rather than being surprised by it.
"""

import base64
import hashlib
import hmac
import logging
import secrets
import time

import pyotp

from config.settings import settings

SESSION_MAX_AGE_SECONDS = 8 * 60 * 60  # 8 hours — roughly one trading day

if settings.SESSION_SECRET_KEY:
    _SECRET_KEY = settings.SESSION_SECRET_KEY.encode()
else:
    _SECRET_KEY = secrets.token_bytes(32)
    logging.warning(
        "⚠️ SESSION_SECRET_KEY not set in .env — using a random one for this run. "
        "Every restart will log everyone out. Set SESSION_SECRET_KEY in .env for "
        "sessions to persist across restarts."
    )


def _sign(payload: bytes) -> str:
    return hmac.new(_SECRET_KEY, payload, hashlib.sha256).hexdigest()


def create_session_token(username: str) -> str:
    expiry = int(time.time()) + SESSION_MAX_AGE_SECONDS
    payload = f"{username}:{expiry}".encode()
    payload_b64 = base64.urlsafe_b64encode(payload).decode()
    signature = _sign(payload)
    return f"{payload_b64}.{signature}"


def verify_session_token(token: str) -> bool:
    if not token or "." not in token:
        return False
    try:
        payload_b64, signature = token.rsplit(".", 1)
        payload = base64.urlsafe_b64decode(payload_b64.encode())
        expected_signature = _sign(payload)
        if not hmac.compare_digest(signature, expected_signature):
            return False
        username, expiry_str = payload.decode().rsplit(":", 1)
        if int(time.time()) > int(expiry_str):
            return False  # expired
        return True
    except Exception:
        return False


def verify_login(username: str, password: str, totp_code: str) -> tuple[bool, str]:
    """Returns (ok, error_message)."""
    if not (
        secrets.compare_digest(username or "", settings.DASHBOARD_USER)
        and secrets.compare_digest(password or "", settings.DASHBOARD_PASSWORD)
    ):
        return False, "Invalid username or password."

    if settings.DASHBOARD_TOTP_SECRET:
        totp_code = (totp_code or "").strip().replace(" ", "")
        if not totp_code:
            return False, "Enter the 6-digit code from your authenticator app."
        totp = pyotp.TOTP(settings.DASHBOARD_TOTP_SECRET)
        if not totp.verify(totp_code, valid_window=1):  # ±30s clock drift tolerance
            return False, "Invalid or expired authenticator code."

    return True, ""


if __name__ == "__main__":
    # python -m utils.session_auth
    # One-time setup helper: generates a fresh TOTP secret and shows both
    # the raw key (for "enter manually" in any authenticator app) and a
    # standard otpauth:// URI (paste into any free QR-code generator if
    # you'd rather scan than type — nothing here calls out to the network,
    # so it's your choice whether to use an online QR tool or not).
    new_secret = pyotp.random_base32()
    uri = pyotp.totp.TOTP(new_secret).provisioning_uri(
        name=settings.DASHBOARD_USER or "dashboard-user",
        issuer_name="CogniX Algo",
    )
    print("=" * 70)
    print("New TOTP secret generated — add ONE of these to your authenticator app:")
    print()
    print(f"  Manual entry key : {new_secret}")
    print(f"  otpauth:// URI   : {uri}")
    print()
    print("Then add this line to your .env:")
    print(f"  DASHBOARD_TOTP_SECRET={new_secret}")
    print()
    print("Restart the app after saving .env, then 2FA is required on every login.")
    print("=" * 70)
