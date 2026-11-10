# -*- coding: utf-8 -*-
"""Focused probe: the /trading dock's GTT tab — its fetch + rendered text."""
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
PORT = 9334
events = []
_mid = [0]


def rpc(ws, method, params=None, timeout=30):
    _mid[0] += 1
    mid = _mid[0]
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


def main():
    profile = tempfile.mkdtemp(prefix="cdp-gtt-")
    chrome = subprocess.Popen([
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        "--headless=new", "--disable-gpu", "--no-first-run",
        f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
        "--window-size=1600,1000", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(4)
    try:
        req = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/json/new?about:blank", method="PUT")
        with urllib.request.urlopen(req, timeout=10) as r:
            page = json.loads(r.read().decode())
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30,
                                         suppress_origin=True)
        rpc(ws, "Network.enable")
        rpc(ws, "Runtime.enable")
        rpc(ws, "Page.enable")
        rpc(ws, "Network.setCookie",
            {"name": "session", "value": SESSION, "path": "/",
             "domain": "127.0.0.1", "httpOnly": True})
        rpc(ws, "Page.navigate", {"url": f"{BASE}/trading"})
        end = time.time() + 25
        while time.time() < end:
            ws.settimeout(end - time.time())
            try:
                events.append(json.loads(ws.recv()))
            except websocket.WebSocketTimeoutException:
                break

        def js(expr, timeout=20):
            res = rpc(ws, "Runtime.evaluate",
                      {"expression": expr, "returnByValue": True,
                       "awaitPromise": True}, timeout=timeout)
            return res.get("result", {}).get("value")

        def click(label):
            return js("""((label) => {
                const btn = [...document.querySelectorAll('button')]
                  .find(b => (b.textContent || '').trim().startsWith(label));
                if (btn) { btn.click(); return 'clicked'; }
                return 'not found';
            })(%s)""" % json.dumps(label))

        print("click GTT:", click("GTT"))
        # keep draining frames while the tab loads (each rpc call pumps events)
        end = time.time() + 10
        while time.time() < end:
            js("1")
            time.sleep(0.4)

        def panel_text(label):
            return js("""((label) => {
                const tabs = [...document.querySelectorAll('button')]
                  .filter(b => (b.textContent || '').trim().startsWith(label));
                const btn = tabs[0];
                if (!btn) return 'NO BUTTON';
                const aria = document.querySelector(
                  '[role=tabpanel]:not([hidden])');
                if (aria) return 'PANEL: ' + aria.innerText.slice(0, 400);
                return 'no panel role';
            })(%s)""" % json.dumps(label))

        print("GTT panel text:", panel_text("GTT"))
        print("Positions panel:", click("Positions"))
        time.sleep(3)
        end = time.time() + 6
        while time.time() < end:
            js("1")
            time.sleep(0.4)
        print("POS panel text:", panel_text("Positions"))
        xhrs = []
        for e in events:
            if e.get("method") == "Network.requestWillBeSent":
                u = e["params"].get("request", {}).get("url", "")
                if "/api/" in u:
                    m = (e["params"].get("request") or {}).get("postData") or ""
                    xhrs.append((u.split(BASE)[-1], m[:60]))
        for u, b in xhrs:
            if "orderbook" in u or "gtt" in u or b:
                print("  REQ", u, "|", b)
    finally:
        chrome.terminate()
        try:
            chrome.wait(5)
        except Exception:
            chrome.kill()


if __name__ == "__main__":
    main()
    sys.exit(0)
