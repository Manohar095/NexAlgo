# -*- coding: utf-8 -*-
"""
utils/auth_middleware.py
===========================
Pure-ASGI session-cookie auth. Covers every request type — regular
HTTP routes, static files, AND the WebSocket handshake (Starlette's
usual BaseHTTPMiddleware only wraps HTTP requests, not WebSocket
scopes, so this is implemented at the raw ASGI level instead).

Enabled only when both DASHBOARD_USER and DASHBOARD_PASSWORD are set in
.env — if either is blank, every request passes through unauthenticated
(e.g. for local dev, or a deployment that only allows access via an SSH
tunnel and doesn't need a second layer on top of that).

Unlike HTTP Basic Auth, this checks a signed session cookie (see
utils/session_auth.py) issued by POST /login — which is what makes real
2FA possible: the TOTP code is checked ONCE at login time, not resent
on every request the way Basic Auth credentials are. /login itself
(GET to show the form, POST to submit it) is always allowed through
unauthenticated, since otherwise there'd be no way to reach the login
page in the first place.
"""

from config.settings import settings
from utils.session_auth import verify_session_token

PUBLIC_PATHS = {"/login", "/api/auth/login", "/api/auth/status", "/api/auth/logout"}
PUBLIC_PREFIXES = ("/static/",)


class SessionAuthMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        if not (settings.DASHBOARD_USER and settings.DASHBOARD_PASSWORD):
            return await self.app(scope, receive, send)  # auth not configured — skip

        if scope["type"] == "http":
            path = scope.get("path", "")
            if path in PUBLIC_PATHS or path.startswith(PUBLIC_PREFIXES):
                return await self.app(scope, receive, send)

        if self._is_authorized(scope):
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return

        # HTTP: send the browser to the login page rather than a bare 401,
        # so navigating to the dashboard while logged out is a normal
        # redirect instead of a dead page. API calls made while logged out
        # (e.g. a stale tab) still just get a redirect — the frontend's
        # fetch() calls will follow it and land on the login HTML, which
        # is a reasonable, safe failure mode for this single-operator tool.
        await send({
            "type": "http.response.start",
            "status": 303,
            "headers": [(b"location", b"/login")],
        })
        await send({"type": "http.response.body", "body": b""})

    @staticmethod
    def _is_authorized(scope):
        headers = dict(scope.get("headers") or [])
        cookie_header = headers.get(b"cookie", b"").decode()
        token = None
        for part in cookie_header.split(";"):
            part = part.strip()
            if part.startswith("session="):
                token = part[len("session="):]
                break
        return verify_session_token(token) if token else False
