from NorenRestApiPy.NorenApi import  NorenApi
from threading import Timer
import json
import math
import urllib.parse
import pandas as pd
import requests
import time
import concurrent.futures

api = None
class Order:
     def __init__(self, buy_or_sell:str = None, product_type:str = None,
                 exchange: str = None, tradingsymbol:str =None, 
                 price_type: str = None, quantity: int = None, 
                 price: float = None,trigger_price:float = None, discloseqty: int = 0,
                 retention:str = 'DAY', remarks: str = "tag",
                 order_id:str = None):
        self.buy_or_sell=buy_or_sell
        self.product_type=product_type
        self.exchange=exchange
        self.tradingsymbol=tradingsymbol
        self.quantity=quantity
        self.discloseqty=discloseqty
        self.price_type=price_type
        self.price=price
        self.trigger_price=trigger_price
        self.retention=retention
        self.remarks=remarks
        self.order_id=None


    #print(ret)

    


def get_time(time_string):
    data = time.strptime(time_string,'%d-%m-%Y %H:%M:%S')

    return time.mktime(data)


class NorenApiPy(NorenApi):
    def __init__(self):
        # NorenApi.__init__(self, host='https://piconnect.flattrade.in/PiConnectTP/', websocket='wss://piconnect.flattrade.in/PiConnectWSTp/', eodhost='https://web.flattrade.in/chartApi/getdata/')
        #NorenApi.__init__(self, host='https://piconnect.flattrade.in/PiConnectAPI/', websocket='wss://piconnect.flattrade.in/PiConnectWSAPI/')
        NorenApi.__init__(self, host='https://piconnect.flattrade.in/PiConnectAPI/', websocket='wss://ftkambalaweb.flattrade.in/NorenWSWeb/')

        global api
        api = self
    def place_basket(self, orders):

        resp_err = 0
        resp_ok  = 0
        result   = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:

            future_to_url = {executor.submit(self.place_order, order): order for order in  orders}
            for future in concurrent.futures.as_completed(future_to_url):
                url = future_to_url[future]
            try:
                result.append(future.result())
            except Exception as exc:
                print(exc)
                resp_err = resp_err + 1
            else:
                resp_ok = resp_ok + 1

        return result
                
    def placeOrder(self,order: Order):
        ret = NorenApi.place_order(self, buy_or_sell=order.buy_or_sell, product_type=order.product_type,
                            exchange=order.exchange, tradingsymbol=order.tradingsymbol, 
                            quantity=order.quantity, discloseqty=order.discloseqty, price_type=order.price_type, 
                            price=order.price, trigger_price=order.trigger_price,
                            retention=order.retention, remarks=order.remarks)
        #print(ret)


        return ret


    # ============================================================
    # PiConnect doc endpoints (GetOptionChain / GetOptionGreek)
    # ============================================================
    # Wire facts validated live against piconnect.flattrade.in (2026-10-24):
    # - body MUST be raw serialized JSON in jData (URL-encoded jData answers
    #   "Invalid Input :  jData is not valid json object") even though the
    #   written rule says to URL-encode it — the doc's own curl agrees with
    #   the wire, the prose does not;
    # - "Content-Type: application/json" with the form-encoded body is
    #   accepted exactly as documented (quirk preserved);
    # - GetOptionGreek REJECTS the documented YYYY-MM-DD exd as "nan" rows —
    #   it wants DD-MON-YYYY ("27-OCT-2026"), so exd is normalized internally;
    # - the LIVE Greek keys are cal_vega/put_vega even though the doc spells
    #   vego — both spellings are parsed.
    _PI_GREEK_FLOAT_KEYS = (
        "cal_price", "put_price", "cal_delta", "put_delta",
        "cal_gamma", "put_gamma", "cal_theta", "put_theta",
        "cal_rho", "put_rho", "cal_vega", "put_vega",
        "cal_vego", "put_vego",
    )
    _PI_OPTION_CHAIN_OPTS = ("NFO", "BFO", "BSE", "CDS", "MCX", "NSE")

    def _pi_post(self, path, values):
        """Shared PiConnect POST: raw-JSON jData + jKey form body, the
        documented Content-Type header, case-insensitive stat comparison."""
        config = NorenApi._NorenApi__service_config
        url = f"{config['host']}{path}"
        payload = ("jData=" + json.dumps(values) +
                   "&jKey=" + (self._NorenApi__susertoken or ""))
        res = requests.post(url, data=payload,
                            headers={"Content-Type": "application/json"})
        try:
            data = res.json()
        except (ValueError, TypeError):
            return {"stat": "Not_Ok",
                    "emsg": f"Bad response from {path}: {res.text[:160]}"}
        st = str(data.get("stat") or "").strip().upper()
        if st != "OK":
            return {"stat": "Not_Ok",
                    "emsg": data.get("emsg") or f"{path} returned stat={data.get('stat')!r}"}
        data["stat"] = st  # normalize "Ok"/"OK" casing for callers
        return data

    def pi_get_option_chain(self, exch, tsym, strprc, cnt):
        """GetOptionChain (SPEC-verbatim quirks): string numerics, tsym
        URL-encoded inside the JSON, cnt = strikes PER SIDE (total contracts
        = 4 x cnt). NEVER call without an exchange that carries options."""
        exch = str(exch).upper()
        if exch not in self._PI_OPTION_CHAIN_OPTS:
            return {"stat": "Not_Ok", "emsg": f"GetOptionChain: exchange {exch} does not carry options"}
        values = {
            "uid": self._NorenApi__username,
            "exch": exch,
            # "M&M" must travel as "M%26M" or the request breaks.
            "tsym": urllib.parse.quote_plus(str(tsym)),
            "strprc": str(strprc),
            "cnt": str(cnt),
        }
        data = self._pi_post("/GetOptionChain", values)
        if data.get("stat") != "OK":
            return data
        # values passed through verbatim: exch/tsym/token/optt/strprc along
        # with pp/ti/ls, which the broker returns as STRINGS per the doc.
        return data

    def pi_get_option_greek(self, exd, strprc, sptprc, int_rate, volatility, optt):
        """GetOptionGreek: all request numerics as strings; stat returns as
        "OK" (uppercase, per the doc). Numeric reply fields — strings on the
        wire — are parsed to float here, with "nan"/INT-min garbage mapped
        to None. cal_*/vego field spellings preserved per the doc while the
        live cal_vega spelling is accepted too."""
        if str(optt).upper().startswith("C"):
            optt = "C"
        elif str(optt).upper().startswith("P"):
            optt = "P"
        else:
            return {"stat": "Not_Ok", "emsg": "GetOptionGreek: optt must be C or P"}
        values = {
            "exd": _pi_exd_format(exd),      # live engine wants DD-MON-YYYY
            "strprc": str(strprc),
            "sptprc": str(sptprc),
            "int_rate": str(int_rate),
            "volatility": str(volatility),
            "optt": optt,
        }
        data = self._pi_post("/GetOptionGreek", values)
        if data.get("stat") != "OK":
            return data
        # Doc spells vego; the live engine returns vega — parse either and
        # expose BOTH keys under the parsed value.
        for key in self._PI_GREEK_FLOAT_KEYS:
            raw = data.pop(key, None)
            if not isinstance(raw, str) and not isinstance(raw, (int, float)):
                data[key] = None
                continue
            try:
                val = float(raw)
            except (ValueError, TypeError):
                data[key] = None
                continue
            if not math.isfinite(val) or abs(val) > 1e15:   # "nan", INT64-min sentinel
                data[key] = None
                continue
            data[key] = val
        for side in ("cal", "put"):
            vega = data.get(f"{side}_vega")
            if vega is None:
                vega = data.get(f"{side}_vego")
            data[f"{side}_vega"] = vega
            data[f"{side}_vego"] = vega
        return data


def _pi_exd_format(exd):
    """GetOptionGreek's documented YYYY-MM-DD sample is REJECTED by the live
    engine (it answers nan rows); DD-MON-YYYY is accepted. Normalize any
    recognizable input to the accepted format; pass through otherwise."""
    from datetime import datetime
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%B-%Y"):
        try:
            return datetime.strptime(str(exd).strip(), fmt).strftime("%d-%b-%Y")
        except (ValueError, TypeError):
            continue
    return str(exd)
