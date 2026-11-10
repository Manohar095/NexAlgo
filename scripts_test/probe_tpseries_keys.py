"""Probe raw TPSeries intraday rows: which OHLC keys does the wire carry?"""
import sys
import json

sys.path.insert(0, r"F:\NexAlgo")
from config.settings import settings
from api_helper import NorenApiPy

api = NorenApiPy()
api.set_session(userid=settings.FT_USER, password=settings.FT_PWD,
                usertoken=settings.FT_ACCESS_TOKEN)
print("== session set ==")

import time as _t
for exch, token in (("MCX", "573423"), ("NSE", "2885")):
    rows = api.get_time_price_series(exchange=exch, token=token,
                                     starttime=int(_t.time() - 2 * 86400), interval=5)
    print(exch, "type:", type(rows).__name__, "n:", len(rows) if isinstance(rows, list) else rows)
    if isinstance(rows, list) and rows:
        print("  KEYS:", sorted(rows[-1].keys()))
        print("  last:", json.dumps(rows[-1]))

rows = api.get_time_price_series(exchange="NSE", token="26000",
                                 starttime=int(_t.time() - 2 * 86400), interval=15)
if isinstance(rows, list) and rows:
    print("NSE NIFTY 15m KEYS:", sorted(rows[0].keys()))
    print("  sample:", json.dumps(rows[-1]))
