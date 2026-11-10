"""Probe raw broker EOD/TP rows for CRUDEOILM19NOV26 daily — where do zero-range
bars come from, and what does the wire really carry for those days?"""
import json
import sys
import datetime
import pytz

sys.path.insert(0, r"F:\NexAlgo")
from config.settings import settings
from api_helper import NorenApiPy

api = NorenApiPy()
api.set_session(userid=settings.FT_USER, password=settings.FT_PWD,
                usertoken=settings.FT_ACCESS_TOKEN)
print("== session set ==")

EXCH = "MCX"
SYM = "MCX:CRUDEOILM19NOV26"
ist = pytz.timezone("Asia/Kolkata")
want_zero = datetime.datetime(2026, 6, 10, tzinfo=ist).timestamp() - 19800   # 10-Jun zero day
want_good = datetime.datetime(2026, 10, 22, tzinfo=ist).timestamp() - 19800  # normal day

rows = api.pi_get_eod_chart_data(SYM, int(want_zero - 200 * 86400), int(want_good + 86400))
print("eod type:", type(rows).__name__)
if isinstance(rows, dict):
    print("eod stat:", rows.get("stat"), "emsg:", rows.get("emsg"))
    rows = rows.get("data") or []
rows = rows or []
print("eod rows:", len(rows))
if rows:
    print("ROW KEYS:", sorted(rows[0].keys()) if isinstance(rows[0], dict) else rows[0])

def dnum(r):
    for k in ("ssboe", "d", "date", "day"):
        v = r.get(k) if isinstance(r, dict) else None
        if v:
            return v
    return None

matched = 0
for i, r in enumerate(rows):
    if not isinstance(r, dict):
        continue
    ts = float(r.get("ssboe") or 0)
    day = datetime.datetime.fromtimestamp(ts + 19800, ist).strftime("%d-%b-%Y")
    if day in ("10-Jun-2026", "09-Jun-2026", "22-Oct-2026", "21-Oct-2026"):
        matched += 1
        print(day, "ssboe:", r.get("ssboe"), "time:", r.get("time"))
        print(json.dumps(r))
print("matched:", matched)

# TPSeries (intraday engine path) for the same days, interval EOD/1d
try:
    tps = api.get_time_price_series(exchange=EXCH, token="573423",
                                    starttime=want_zero - 5 * 86400, interval="D")
    print("\nTPSeries 'D' type:", type(tps).__name__, "n:", len(tps) if isinstance(tps, list) else tps)
    if isinstance(tps, list):
        print("TP keys:", sorted(tps[0].keys()))
        for r in tps:
            t = datetime.datetime.fromtimestamp(int(r.get("time", 0)) + 19800, ist)
            if t.strftime("%d-%b-%Y") in ("10-Jun-2026", "09-Jun-2026", "22-Oct-2026"):
                print(t.strftime('%d-%b'), json.dumps(r))
    else:
        print("TPSeries raw:", str(tps)[:300])
except Exception as e:
    print("TPSeries error:", e)
