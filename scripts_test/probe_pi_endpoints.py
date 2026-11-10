"""Probe the two DOCUMENTED PiConnect endpoints (GetOptionChain,
GetOptionGreek) before building the standalone option-chain page.

Answers:
  1. What fields does GetOptionChain actually return (doc says metadata
     only - the wire may carry more, e.g. quotes)?
  2. Does it behave differently keyed on a FUTURE vs an OPTION tsym?
  3. Does strprc need to sit on a strike grid, or is any mid price fine?
     Does a strike OUTSIDE the board still return?
  4. GetOptionGreek: exd format the engine wants, response units, and
     whether the prices it returns can double as quotes.
"""
import json
import sys
import urllib.parse
sys.path.insert(0, r"F:\NexAlgo")

from config.settings import settings
from api_helper import NorenApiPy

api = NorenApiPy()
api.set_session(userid=settings.FT_USER, password=settings.FT_PWD,
                usertoken=settings.FT_ACCESS_TOKEN)
print("== login ok ==")
print("susertoken head:", (api._NorenApi__susertoken or "")[:12])


def raw_chain(exch, tsym, strprc, cnt):
    values = {
        "uid": settings.FT_USER,
        "exch": exch,
        "tsym": urllib.parse.quote_plus(tsym),
        "strprc": str(strprc),
        "cnt": str(cnt),
    }
    payload = ("jData=" + json.dumps(values) +
               "&jKey=" + (api._NorenApi__susertoken or ""))
    import requests
    res = requests.post("https://piconnect.flattrade.in/PiConnectAPI/GetOptionChain",
                        data=payload, headers={"Content-Type": "application/json"})
    try:
        return res.json()
    except ValueError:
        return {"_raw": res.text[:300]}


def raw_greek(exd, strprc, sptprc, int_rate, vol, optt):
    values = {
        "exd": exd, "strprc": str(strprc), "sptprc": str(sptprc),
        "int_rate": str(int_rate), "volatility": str(vol), "optt": optt,
    }
    payload = ("jData=" + json.dumps(values) +
               "&jKey=" + (api._NorenApi__susertoken or ""))
    import requests
    res = requests.post("https://piconnect.flattrade.in/PiConnectAPI/GetOptionGreek",
                        data=payload, headers={"Content-Type": "application/json"})
    try:
        return res.json()
    except ValueError:
        return {"_raw": res.text[:300]}


dump = lambda tag, d: print(f"\n--- {tag} ---\n{json.dumps(d, indent=1)[:1600]}")

# 1) keyed on the FUTURES tsym, mid price off-grid
r = raw_chain("NFO", "BANKNIFTY23NOV26F", 54501.25, 3)
dump("chain, futures key, odd strprc, cnt=3", r)
rows = r.get("values") or []
if rows:
    print("row keys:", sorted(rows[0].keys()))
    print("n rows:", len(rows), "| stats:",
          sorted({rr.get("optt") for rr in rows}),
          sorted({rr.get("strprc") for rr in rows})[:8], "...")

# 2) keyed on the OPTION tsym (nearest CE)
r2 = raw_chain("NFO", "BANKNIFTY23NOV26C54500", 54501.25, 3)
dump("chain, option key, cnt=3", r2)
rows2 = (r2.get("values") or [])
print("n rows opt-key:", len(rows2), "| same fields:",
      rows and sorted(rows[0].keys()) == sorted(rows2[0].keys()))

# 3) strike far off-board (deep strike that may not exist)
r3 = raw_chain("NFO", "BANKNIFTY23NOV26F", 1.0, 2)
dump("chain, strprc=1.0", r3)

# 4) empty strprc - does the engine accept "" for nearest ATM?
r4 = raw_chain("NFO", "BANKNIFTY23NOV26F", "", 2)
dump("chain, empty strprc", r4)

# 5) GetOptionGreek - both exd spellings
g1 = raw_greek("2026-11-23", 54500, 54541.2, 0.065, 0.17, "C")
dump("greek, exd=2026-11-23", g1)
g2 = raw_greek("23-NOV-2026", 54500, 54541.2, 0.065, 0.17, "C")
dump("greek, exd=23-NOV-2026", g2)

# 6) Greek with volatility 0 - does it degrade gracefully?
g3 = raw_greek("23-NOV-2026", 54500, 54541.2, 0.065, 0, "C")
dump("greek, vol=0", g3)

# 7) Greek optt as long spelling "CE" (doc says C)
g4 = raw_greek("23-NOV-2026", 54500, 54541.2, 0.065, 0.17, "CE")
dump("greek, optt=CE", g4)
