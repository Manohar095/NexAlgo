# -*- coding: utf-8 -*-
"""utils/win_accept_patch.py
============================
Keep the HTTP listener alive when a Windows client aborts mid-accept.

The problem
-----------
CPython's Proactor accept loop (``asyncio/proactor_events.py``
``BaseProactorEventLoop._start_serving``) treats ANY ``OSError`` from
``AcceptEx`` as fatal: it reports "Accept failed on a socket", **closes the
listening socket** and never re-arms the accept. On Windows a client that
resets the connection while the handshake is completing raises
``OSError(22, 'The specified network name is no longer available')`` —
i.e. ``ERROR_NETNAME_DELETED`` / WinError 64 — which is *normal* under load
(browser tab reloads, a page holding a dozen sockets, load tests).

The symptom in this app: ``INFO: ... "GET /api/..." 200 OK`` keeps flowing for
a moment, then every new request answers ``ERR_CONNECTION_REFUSED`` while
``python main.py`` is still running and its log is quiet. ``Get-NetTCPConnection``
still shows a LISTEN socket owned by the process (the kernel backlog
completes handshakes nobody accepts until it overflows and starts RST-ing).
Uvicorn's own "Accept failed on a socket" traceback in the log is the tell.

The fix
-------
Re-implement the accept loop with the same semantics EXCEPT that an
``OSError`` from a live listener re-arms the accept instead of closing the
socket. Genuine listener death (closed fd, closed loop) still exits; a
runaway error (a listener that fails forever) closes after
``MAX_CONSECUTIVE_FAILURES`` so a truly broken socket cannot spin the loop.

Applied at import time from ``main.py`` — before the event loop is created.
No-op on non-Windows platforms and on Python versions where the private
signature does not match.
"""

from __future__ import annotations

import asyncio
import logging
import sys

log = logging.getLogger(__name__)

# A listener that fails this many times in a row is not transient: let the
# original behaviour (close it) happen so a broken socket cannot spin.
MAX_CONSECUTIVE_FAILURES = 50
RETRY_DELAY = 0.05

_APPLIED = False


def apply() -> bool:
    """Patch the Windows proactor accept loop. Returns True when patched."""
    global _APPLIED
    if _APPLIED:
        return True
    if sys.platform != "win32":
        return False
    try:
        from asyncio import exceptions as asyncio_exceptions
        from asyncio import proactor_events
    except Exception:  # pragma: no cover - not a proactor build
        return False

    base = getattr(proactor_events, "BaseProactorEventLoop", None)
    if base is None or not hasattr(base, "_start_serving"):
        return False
    if getattr(base, "_cognix_accept_patch", False):
        _APPLIED = True
        return True

    def _start_serving(  # noqa: D401 - mirrors the stdlib signature
        self,
        protocol_factory,
        sock,
        sslcontext=None,
        server=None,
        backlog=100,
        ssl_handshake_timeout=None,
        ssl_shutdown_timeout=None,
    ):
        failures = [0]

        def loop(f=None):
            try:
                if f is not None:
                    conn, addr = f.result()
                    failures[0] = 0
                    protocol = protocol_factory()
                    if sslcontext is not None:
                        self._make_ssl_transport(
                            conn,
                            protocol,
                            sslcontext,
                            server_side=True,
                            extra={"peername": addr},
                            server=server,
                            ssl_handshake_timeout=ssl_handshake_timeout,
                            ssl_shutdown_timeout=ssl_shutdown_timeout,
                        )
                    else:
                        self._make_socket_transport(
                            conn,
                            protocol,
                            extra={"peername": addr},
                            server=server,
                        )
                if self.is_closed() or sock.fileno() == -1:
                    return
                f = self._proactor.accept(sock)
            except OSError as exc:
                if self.is_closed() or sock.fileno() == -1:
                    # Real shutdown / the socket is gone — nothing to keep.
                    try:
                        sock.close()
                    except Exception:
                        pass
                    return
                failures[0] += 1
                if failures[0] >= MAX_CONSECUTIVE_FAILURES:
                    log.error(
                        "Accept failed %d times in a row on %r — closing the listener: %s",
                        failures[0], sock, exc,
                    )
                    self.call_exception_handler({
                        "message": "Accept failed on a socket",
                        "exception": exc,
                        "socket": proactor_events.trsock.TransportSocket(sock),
                    })
                    try:
                        sock.close()
                    except Exception:
                        pass
                    return
                log.debug("Accept resumed after client abort: %s", exc)
                self.call_later(RETRY_DELAY, loop)
                return
            except asyncio_exceptions.CancelledError:
                try:
                    sock.close()
                except Exception:
                    pass
                return
            else:
                self._accept_futures[sock.fileno()] = f
                f.add_done_callback(loop)

        self.call_soon(loop)

    _start_serving._cognix_accept_patch = True  # type: ignore[attr-defined]
    base._start_serving = _start_serving
    _APPLIED = True
    log.info("🩹 Windows accept-loop patch applied (client aborts no longer kill the listener)")
    return True
