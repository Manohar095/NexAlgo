# -*- coding: utf-8 -*-
"""
utils/auth_middleware.py
===========================
Pure-ASGI HTTP Basic Auth. Covers every request type — regular HTTP
routes, static files, AND the WebSocket handshake (Starlette's usual
BaseHTTPMiddleware only wraps HTTP requests, not WebSocket scopes, so
this is implemented at the raw ASGI level instead).

Enabled only when both DASHBOARD_USER and DASHBOARD_PASSWORD are set in
.env — if either is blank, every request passes through unauthenticated
(e.g. for local dev, or a deployment that only allows access via an SSH
tunnel and doesn't need a second layer on top of that).

Browsers cache Basic Auth credentials per-origin after the first
successful login, so the native username/password prompt only appears
once per browser session — including for the WebSocket connection,
since it reuses the same cached credentials automatically.
"""

import base64
import secrets

from config.settings import settings

UNAUTHORIZED_BODY = b"401 Unauthorized"


class BasicAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        if not (settings.DASHBOARD_USER and settings.DASHBOARD_PASSWORD):
            return await self.app(scope, receive, send)  # auth not configured — skip

        if self._is_authorized(scope):
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return

        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"www-authenticate", b'Basic realm="Zenith Trading Terminal"'),
                (b"content-type", b"text/plain"),
            ],
        })
        await send({"type": "http.response.body", "body": UNAUTHORIZED_BODY})

    @staticmethod
    def _is_authorized(scope):
        headers = dict(scope.get("headers") or [])
        auth_header = headers.get(b"authorization")
        if not auth_header:
            return False
        try:
            scheme, _, creds = auth_header.decode().partition(" ")
            if scheme.lower() != "basic":
                return False
            decoded = base64.b64decode(creds).decode("utf-8")
            username, _, password = decoded.partition(":")
        except Exception:
            return False

        return (
            secrets.compare_digest(username, settings.DASHBOARD_USER)
            and secrets.compare_digest(password, settings.DASHBOARD_PASSWORD)
        )
