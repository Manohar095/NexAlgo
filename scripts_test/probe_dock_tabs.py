# -*- coding: utf-8 -*-
"""Headless probe: the /trading page's Orders/Positions/Trades/GTT dock tabs.

Wires a session cookie in, boots the page, records every /api/v1 request +
console exception, opens each dock tab, and prints the row counts seen in
the DOM. Run with the repo venv while the app is on :8000.
"""
import json
import subprocess
import sys
import tempfile
import time
import urllib.request

import websocket

BASE = "http://127.0.0.1:8000"
SESSION = ("TWFub2hhcjA5NToxNzkzMzAzODE1."
           "52bd6328c8f2de7f3647bffed5564c4aaae3cb5aaf322930319c91f0d2b75fc7")
PORT = 9333

# All named CDP ids; =True responses are not awaited one-by-one.
_next_id = [0]


def _json_rpc(ws, method, params=None, timeout=30):
    _next_id[0] += 1
    mid = _next_id[0]
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        ws.settimeout(max(0.5, deadline - time.time()))
        try:
            msg = json.loads(ws.recv())
        except websocket.WebSocketTimeoutException:
            break
        if msg.get("id") == mid:
            return msg.get("result", {})
        events.append(msg)
    return {}


events = []


def new_page(ws):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/json/new?about:blank",
                                 method="PUT")
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def main():
    profile = tempfile.mkdtemp(prefix="cdp-dock-")
    chrome = subprocess.Popen([
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        "--headless=new", "--disable-gpu", "--no-first-run",
        f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
        "--window-size=1600,1000", "--disable-frame-rate-limit",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(4)

    try:
        page = new_page(chrome)
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30,
                                         suppress_origin=True)
        # network + console listeners
        _json_rpc(ws, "Network.enable", {"maxResourceBufferSize": 1 << 22})
        _json_rpc(ws, "Runtime.enable")
        _json_rpc(ws, "Page.enable")
        cookie = {"name": "session", "value": SESSION, "path": "/",
                  "domain": "127.0.0.1", "httpOnly": True, "secure": False}
        _json_rpc(ws, "Network.setCookie", cookie)
        _json_rpc(ws, "Page.navigate", {"url": f"{BASE}/trading"})

        # let the app boot (data + websocket rounds)
        end = time.time() + 30
        while time.time() < end:
            ws.settimeout(end - time.time())
            try:
                events.append(json.loads(ws.recv()))
            except websocket.WebSocketTimeoutException:
                break

        def js(expr, timeout=20):
            res = _json_rpc(ws, "Runtime.evaluate",
                            {"expression": expr, "returnByValue": True,
                             "awaitPromise": True}, timeout=timeout)
            return res.get("result", {}).get("value")

        # ---- dock strip: does it exist, what do the badges read?
        strip = js("""(() => {
            const badges = [...document.querySelectorAll('button')]
              .map(b => (b.textContent || '').trim())
              .filter(t => /^(Orders|Positions|Trades|GTT)\\s*\\d+/.test(t));
            return badges.join(' | ') || 'NO DOCK BUTTONS';
        })()""")
        print("DOCK STRIP:", strip)

        # ---- open each tab, count rendered rows, observe network
        tabs = ["Orders", "Positions", "Trades", "GTT"]
        for tab in tabs:
            before = len(events)
            js("""((label) => {
                const btn = [...document.querySelectorAll('button')]
                  .find(b => (b.textContent || '').trim().startsWith(label));
                if (btn) btn.click();
            })(%s)""" % json.dumps(tab))
            time.sleep(4)
            rows = js("""(() => {
                const t = [...document.querySelectorAll('table')];
                const best = t.sort((a, b) =>
                  b.querySelectorAll('tbody tr').length -
                  a.querySelectorAll('tbody tr').length)[0];
                if (!best) return 'no table';
                const n = best.querySelectorAll('tbody tr').length;
                const first = best.querySelector('tbody tr');
                return n + ' rows; first: ' +
                  (first ? first.textContent.slice(0, 150) : '-');
            })()""")
            print(f"TAB {tab}: rows -> {rows}")

        # ---- network/dot evidence
        book_reqs, errs = [], []
        for e in events:
            if e.get("method") == "Network.responseReceived":
                u = (e["params"].get("response") or {}).get("url", "")
                if "/api/v1/" in u or "/csrf" in u or "/modify_order" in u \
                        or "/cancel" in u or "/close" in u:
                    book_reqs.append(
                        (u.split(BASE)[-1],
                         (e["params"].get("response") or {}).get("status")))
            if e.get("method") == "Runtime.exceptionThrown":
                exc = e["params"].get("exceptionDetails") or {}
                errs.append(str(exc.get("exception", {}).get("description")
                                or exc.get("text"))[:200])
        print("BOOK/NAV REQUESTS:")
        for u, s in book_reqs:
            print(f"   {s} {u}")
        print("PAGE EXCEPTIONS:", len(errs))
        for x in errs[:8]:
            print("   !", x)
    finally:
        chrome.terminate()
        try:
            chrome.wait(5)
        except Exception:
            chrome.kill()


if __name__ == "__main__":
    main()
    sys.exit(0)
