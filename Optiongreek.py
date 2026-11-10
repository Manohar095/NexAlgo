
import requests
import json
from urllib.parse import quote
import getpass

# ============================================================
# FLATTRADE CONFIGURATION
# ============================================================

UID = "FZ36721"
BASE_URL = "https://piconnect.flattrade.in/PiConnectAPI"

OPTION_SYMBOL = "NIFTY26N0322950CE"
OPTION_EXCHANGE = "NFO"

# NIFTY 50 index
SPOT_EXCHANGE = "NSE"
SPOT_TOKEN = "26000"

# Assumptions: verify against the contract master
EXPIRY_DATE = "2026-11-03"
STRIKE_PRICE = "22950"
OPTION_TYPE = "C"

# Greek calculation inputs
INTEREST_RATE = "0.05"
VOLATILITY = "0.20"


# ============================================================
# COMMON FLATTRADE API REQUEST
# ============================================================

def api_post(endpoint, jdata, jkey):
    url = f"{BASE_URL}/{endpoint}"

    request_body = (
        "jData="
        + json.dumps(jdata, separators=(",", ":"))
        + "&jKey="
        + quote(jkey, safe="")
    )

    headers = {"Content-Type": "application/json"}

    try:
        response = requests.post(
            url,
            headers=headers,
            data=request_body,
            timeout=15
        )

        print(f"\n{endpoint} HTTP Status: {response.status_code}")

        try:
            result = response.json()
        except ValueError:
            print("Invalid response:", response.text)
            return None

        if not response.ok:
            print("HTTP error:", result)
            return None

        if result.get("stat", "").lower() != "ok":
            print("API error:", result.get("emsg", result))
            return None

        return result

    except requests.RequestException as error:
        print("Request failed:", error)
        return None


# ============================================================
# SEARCH OPTION CONTRACT
# ============================================================

def search_option(jkey):
    result = api_post(
        "SearchScrip",
        {
            "uid": UID,
            "stext": OPTION_SYMBOL,
            "exch": OPTION_EXCHANGE
        },
        jkey
    )

    if not result:
        return None

    matches = [
        item for item in result.get("values", [])
        if item.get("tsym") == OPTION_SYMBOL
        and item.get("exch") == OPTION_EXCHANGE
    ]

    if len(matches) != 1:
        print("Could not uniquely identify option contract.")
        print("Search results:", result.get("values", []))
        return None

    contract = matches[0]
    print("Option:", contract.get("tsym"))
    print("Option token:", contract.get("token"))

    return contract


# ============================================================
# FETCH OPTION LTP
# ============================================================

def get_option_ltp(jkey, contract):
    result = api_post(
        "GetQuotes",
        {
            "uid": UID,
            "exch": contract["exch"],
            "token": str(contract["token"])
        },
        jkey
    )

    if not result:
        return None

    try:
        ltp = float(result["lp"])
        if ltp <= 0:
            raise ValueError("Non-positive LTP")
        return ltp
    except (KeyError, ValueError, TypeError):
        print("Valid option LTP unavailable:", result)
        return None


# ============================================================
# FETCH NIFTY 50 SPOT PRICE
# ============================================================

def get_nifty_spot(jkey):
    result = api_post(
        "GetQuotes",
        {
            "uid": UID,
            "exch": SPOT_EXCHANGE,
            "token": SPOT_TOKEN
        },
        jkey
    )

    if not result:
        return None

    try:
        spot = float(result["lp"])
        if spot <= 0:
            raise ValueError("Non-positive spot")
        return spot
    except (KeyError, ValueError, TypeError):
        print("Valid NIFTY spot price unavailable:", result)
        return None


# ============================================================
# CALCULATE OPTION GREEKS
# ============================================================

def get_option_greeks(jkey, spot):
    greek_data = {
        "exd": EXPIRY_DATE,
        "strprc": STRIKE_PRICE,
        "sptprc": str(spot),
        "int_rate": INTEREST_RATE,
        "volatility": VOLATILITY,
        "optt": OPTION_TYPE
    }

    return api_post("GetOptionGreek", greek_data, jkey)


# ============================================================
# MAIN
# ============================================================

def main():
    print("=" * 55)
    print("       FLATTRADE OPTION GREEKS")
    print("=" * 55)

    jkey = '46a5ea11a81653ddd40eb99d17c5f32fc6dbd6597254e4c64ad3e6abe56a2357'

    if not jkey:
        print("jKey is required.")
        return

    # 1. Find the specified option contract
    contract = search_option(jkey)
    if not contract:
        return

    # 2. Fetch option premium
    option_ltp = get_option_ltp(jkey, contract)
    if option_ltp is None:
        return

    print(f"\n{OPTION_SYMBOL} LTP: {option_ltp:.2f}")

    # 3. Fetch underlying NIFTY spot price
    spot = get_nifty_spot(jkey)
    if spot is None:
        return

    print(f"NIFTY 50 Spot: {spot:.2f}")

    # 4. Calculate Greeks
    result = get_option_greeks(jkey, spot)
    if not result:
        print("Option Greek calculation failed.")
        return

    # 5. Display results
    print("\n" + "=" * 55)
    print("             OPTION GREEKS RESULT")
    print("=" * 55)
    print("Contract      :", OPTION_SYMBOL)
    print("Option LTP    :", option_ltp)
    print("Underlying    :", spot)
    print("Strike        :", STRIKE_PRICE)
    print("Expiry        :", EXPIRY_DATE)
    print("Option Type   :", OPTION_TYPE)
    print("Volatility    :", VOLATILITY)
    print("-" * 55)

    fields = [
        ("Call Price", "cal_price"),
        ("Put Price", "put_price"),
        ("Call Delta", "cal_delta"),
        ("Put Delta", "put_delta"),
        ("Call Gamma", "cal_gamma"),
        ("Put Gamma", "put_gamma"),
        ("Call Theta", "cal_theta"),
        ("Put Theta", "put_theta"),
        ("Call Rho", "cal_rho"),
        ("Put Rho", "put_rho"),
        ("Call Vega", "cal_vego"),
        ("Put Vega", "put_vego")
    ]

    for label, key in fields:
        print(f"{label:<16}: {result.get(key, 'N/A')}")

    print("=" * 55)


if __name__ == "__main__":
    main()
