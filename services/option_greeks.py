# -*- coding: utf-8 -*-
"""Option pricing for the option chain: Black-76 and spot Black-Scholes.

Why this exists: Flattrade's PiConnect exposes /GetOptionGreek, but it takes
implied volatility as an INPUT — no Flattrade endpoint returns IV. To display
IV + Greeks per leg the leg's market price must be inverted first, so the
volatility is computed here regardless; /GetOptionGreek then supplies the
Greeks for that volatility from the broker's own engine (the chain route
calls it per leg, see api/routes.py optionchain_chain), with the local
closed-form values as the fallback when a leg's call is refused.

Two models live here:
- `black76` / `implied_vol` — options-on-futures, F given, r only discounts.
  Correct when the reference price is the underlying FUTURES LTP (the chain's
  ATM anchor is a futures quote).
- `black_scholes` / `implied_vol_spot` — the SPOT model PiConnect's
  GetOptionGreek evaluates (its `sptprc` is a spot; live-probed, see the
  section comment below). The chain inverts IV with this one whenever the
  underlying index spot is resolvable, so the broker's Greeks line up with
  the market price.

Conventions:
- theta is returned PER DAY (divided by 365), as traders read it.
- vega is per 1% of volatility (raw ∂price/∂σ / 100), the conventional
  quote and the scale PiConnect's own engine reports (live probed).
- Everything downstream of a missing quote or a degenerate strike/expiry is
  None — the panel renders "-" rather than a fabricated zero, mirroring
  OpenAlgo's metricOf.
"""
import math
import os
from datetime import datetime, timedelta

import pytz

IST = pytz.timezone("Asia/Kolkata")

# India's short-term risk-free rate as a decimal fraction (6.5%); GetOptionGreek
# takes the same input shape ("0.065"). Override the panel's pricing without a
# code change via FT_OC_INT_RATE in .env.
_RISK_FREE = float(os.getenv("FT_OC_INT_RATE", "0.065"))

# Never price an expiring-time option with T <= 0: floor it at one minute of
# calendar time so ATM legs still carry a (high) IV at close.
_MIN_T_YEARS = 1.0 / (365.0 * 24.0 * 60.0)

# Implied-vol search range: far-dated low-priced wings can sit above this, but
# beyond 400% the quote is stale garbage — refuse rather than fabricate.
_VOL_MIN = 1e-4
_VOL_MAX = 4.0


def risk_free_rate():
    return _RISK_FREE


def parse_expiry(s):
    """Chain/security expiry strings are seen as 'DD-MON-YYYY', 'YYYY-MM-DD'
    and 'DD-MM-YYYY' across Flattrade surfaces (GetSecurityInfo exd, SearchScrip
    exp, scrip masters). Return a datetime.date or None."""
    if not s:
        return None
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%B-%Y"):
        try:
            return datetime.strptime(str(s).strip(), fmt).date()
        except ValueError:
            continue
    return None


def years_to_expiry(exd, now=None):
    """Calendar-year wire time from now (IST) to the chain expiry's 15:30 IST
    close — expiry day itself keeps one minute so same-day options price."""
    d = parse_expiry(exd) if not hasattr(exd, "year") else exd
    if d is None:
        return None
    now = now or datetime.now(IST)
    expiry = IST.localize(datetime(d.year, d.month, d.day, 15, 30))
    t = (expiry - now).total_seconds()
    if t <= 0:
        return _MIN_T_YEARS
    return max(_MIN_T_YEARS, t / (365.0 * 24.0 * 3600.0))


def _n(x):
    """Standard normal CDF via erf — no scipy dependency."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _phi(x):
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _black76_price(F, K, T, sigma, r, optt):
    df = math.exp(-r * T)
    d1 = (math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    if optt == "C":
        return df * (F * _n(d1) - K * _n(d2))
    return df * (K * _n(-d2) - F * _n(-d1))


def black76(F, K, T, sigma, r, optt):
    """Price + Greeks for one leg. optt 'C' or 'P'. Returns None when the
    inputs are out of the model's domain (T/sigma/F must be positive)."""
    optt = "C" if str(optt).upper().startswith("C") else "P"
    if F is None or K is None or T is None or sigma is None:
        return None
    if F <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return None
    df = math.exp(-r * T)
    d1 = (math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    if optt == "C":
        price = df * (F * _n(d1) - K * _n(d2))
        delta = df * _n(d1)
        theta_r = r * df * (F * _n(d1) - K * _n(d2))
    else:
        price = df * (K * _n(-d2) - F * _n(-d1))
        delta = -df * _n(-d1)
        theta_r = -r * df * (K * _n(-d2) - F * _n(-d1))
    gamma = df * _phi(d1) / (F * sigma * math.sqrt(T))
    vega = F * df * _phi(d1) * math.sqrt(T) / 100.0  # per 1% of volatility
    # Options on futures: the forward is fixed, so rate only enters through
    # the discount factor → dPrice/dr = -T * price.
    rho = -T * price / 100.0  # per 1% of rate, same convention as vega
    # Per-day theta (the usual way a panel reports it).
    theta = -(F * df * _phi(d1) * sigma / (2.0 * math.sqrt(T))) / 365.0 + theta_r / 365.0
    return {"price": price, "delta": delta, "gamma": gamma,
            "theta": theta, "vega": vega, "rho": rho}


def implied_vol(F, K, T, price, r, optt):
    """Invert the leg's market price through Black-76. Monotone in sigma, so a
    bracketing bisection is exact and derivative-free; refuses prices outside
    the discounted-intrinsic/cap band instead of inventing a volatility for
    stale or crossed quotes."""
    optt = "C" if str(optt).upper().startswith("C") else "P"
    if F is None or K is None or T is None or price is None or price <= 0:
        return None
    if F <= 0 or K <= 0 or T <= 0:
        return None
    df = math.exp(-r * T)
    lo = df * max(0.0, (F - K) if optt == "C" else (K - F))
    hi = df * (F if optt == "C" else K)
    if price < lo - 1e-9 or price > hi + 1e-9:
        return None

    def err(sigma):
        return _black76_price(F, K, T, sigma, r, optt) - price

    a, b = _VOL_MIN, _VOL_MAX
    fa, fb = err(a), err(b)
    if fa > 0:          # even the floor vol overshoots: hyper-short deep wing
        return None if fb <= 0 else None
    if fb < 0:          # whole band under the price: above _VOL_MAX
        return None
    for _ in range(80):
        mid = 0.5 * (a + b)
        e = err(mid)
        if abs(e) < 1e-10:
            return mid
        if e < 0:
            a = mid
        else:
            b = mid
    return 0.5 * (a + b)


def compute_leg_greeks(spot, strike, t_years, optt, price, rate=None):
    """One leg's IV + Greeks from its market price. Returns
    {iv, delta, gamma, theta, vega, rho} — any member may be None."""
    rate = _RISK_FREE if rate is None else rate
    out = {"iv": None, "delta": None, "gamma": None,
           "theta": None, "vega": None, "rho": None}
    iv = implied_vol(spot, strike, t_years, price, rate, optt)
    if iv is None:
        return out
    out["iv"] = iv
    g = black76(spot, strike, t_years, iv, rate, optt)
    if g:
        out.update({k: g[k] for k in ("delta", "gamma", "theta", "vega", "rho")})
    return out


# ============================================================
# Spot-based Black-Scholes — the model PiConnect's GetOptionGreek evaluates
# ============================================================
# GetOptionGreek's `sptprc` is a SPOT, not a forward: live-probed on
# BANKNIFTY23NOV26C54500 (S 54,541.2, K 54,500, T 0.0706y, r 6.5%, vol 0.16)
# it answers cal_price 1,103.18 / cal_delta 0.5595 / cal_gamma 0.000166 /
# cal_theta -22.58 / cal_vega 58.52 — a plain Black-Scholes call, not the
# Black-76 call on the futures price (941.14 / 0.5132 / 0.000171). Feeding a
# futures LTP into `sptprc` therefore shifts every Greek by the rT drift.
#
# The option-chain route inverts each leg's market price with THIS model and
# then asks GetOptionGreek for the Greeks, so the panel's numbers come from
# the broker's own engine and agree with Flattrade's UI. Conventions match
# black76 exactly (theta per day, vega/rho per 1%) — live-verified against
# the same probe.


def _bs_price(S, K, T, sigma, r, optt):
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    df = math.exp(-r * T)
    if optt == "C":
        return S * _n(d1) - K * df * _n(d2)
    return K * df * _n(-d2) - S * _n(-d1)


def black_scholes(S, K, T, sigma, r, optt):
    """Price + Greeks for one leg under the spot model. Same keys and
    conventions as black76; None when the inputs leave the model's domain."""
    optt = "C" if str(optt).upper().startswith("C") else "P"
    if S is None or K is None or T is None or sigma is None:
        return None
    if S <= 0 or K <= 0 or T <= 0 or sigma <= 0:
        return None
    df = math.exp(-r * T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    if optt == "C":
        price = S * _n(d1) - K * df * _n(d2)
        delta = _n(d1)
        theta_r = -r * K * df * _n(d2)
        rho = K * T * df * _n(d2) / 100.0
    else:
        price = K * df * _n(-d2) - S * _n(-d1)
        delta = -_n(-d1)
        theta_r = r * K * df * _n(-d2)
        rho = -K * T * df * _n(-d2) / 100.0
    gamma = _phi(d1) / (S * sigma * math.sqrt(T))
    vega = S * _phi(d1) * math.sqrt(T) / 100.0
    theta = -(S * _phi(d1) * sigma / (2.0 * math.sqrt(T))) / 365.0 + theta_r / 365.0
    return {"price": price, "delta": delta, "gamma": gamma,
            "theta": theta, "vega": vega, "rho": rho}


def implied_vol_spot(S, K, T, price, r, optt):
    """Inverse of black_scholes — same bracketing bisection as implied_vol,
    so both models refuse (None) rather than invent a volatility for a price
    outside the arbitrage band."""
    optt = "C" if str(optt).upper().startswith("C") else "P"
    if S is None or K is None or T is None or price is None or price <= 0:
        return None
    if S <= 0 or K <= 0 or T <= 0:
        return None
    df = math.exp(-r * T)
    lo = max(0.0, S - K * df) if optt == "C" else max(0.0, K * df - S)
    hi = S if optt == "C" else K * df
    if price < lo - 1e-9 or price > hi + 1e-9:
        return None

    def err(sigma):
        return _bs_price(S, K, T, sigma, r, optt) - price

    a, b = _VOL_MIN, _VOL_MAX
    fa, fb = err(a), err(b)
    if fa > 0 or fb < 0:
        return None
    for _ in range(80):
        mid = 0.5 * (a + b)
        e = err(mid)
        if abs(e) < 1e-10:
            return mid
        if e < 0:
            a = mid
        else:
            b = mid
    return 0.5 * (a + b)


def compute_leg_greeks_spot(spot, strike, t_years, optt, price, rate=None):
    """One leg's IV + Greeks under the spot model (GetOptionGreek parity).
    Returns {iv, price, delta, gamma, theta, vega, rho}; iv is a DECIMAL
    fraction (0.16 = 16%) — the unit GetOptionGreek's `volatility` takes."""
    rate = _RISK_FREE if rate is None else rate
    out = {"iv": None, "price": None, "delta": None, "gamma": None,
           "theta": None, "vega": None, "rho": None}
    iv = implied_vol_spot(spot, strike, t_years, price, rate, optt)
    if iv is None:
        return out
    out["iv"] = iv
    g = black_scholes(spot, strike, t_years, iv, rate, optt)
    if g:
        out.update(g)
    return out
