/**
 * static/trading/terminal_feed.mjs
 * =================================
 * Data plumbing for the OpenAlgoNew trading-terminal replica (/trading).
 *
 * The engine tier this page feeds is the package's LOW-LEVEL `createChart`
 * (the tier OpenAlgoNew's terminal.ts drives), NOT the widget tier the
 * /charts page uses. The feed below implements the package's `DataFeed`
 * contract:
 *
 *   getBars(req)                       -> Promise<Bar[]>
 *   subscribeBars(req, onBar, opts)    -> UnsubscribeFn
 *   searchSymbols({ query })           -> Promise<SymbolMatch[]>
 *
 * Data path is the one /charts already runs (kept inline there for a zero-
 * regression guarantee; THIS copy belongs to the terminal):
 *   - history: /api/chart/history (TPSeries intraday + EODChartData daily;
 *     resolution, repair-retry hardening all live server-side)
 *   - live: one /ws connection with a desired-state funnel ("EXCH|TOKEN"
 *     wanted-map, replayed on every open) and session-anchored bucketing —
 *     seedFrom (the loaded history's last bar) keeps live buckets on the
 *     history's grid exactly (charts.html handleMarketData parity)
 *   - orders: `{"action":"subscribe_orders"}` frames surface through
 *     TerminalSocket.onOrderUpdate for the trade adapter (Round D).
 *
 * Symbols resolve to {token, exchange, tsym} — the exchange is the one the
 * token ACTUALLY resolved from (requested exchange first, then the chain).
 */

// Interval registry — codes Noren serves. "1d" rides EODChartData (server routes).
export const INTERVAL_SECONDS = {
  "1m": 60, "3m": 180, "5m": 300, "10m": 600, "15m": 900,
  "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
};
export const NOREN_INTRV = {
  "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15,
  "30m": 30, "1h": 60, "2h": 120, "4h": 240, "1d": "D",
};

const SEARCH_EXCHANGES = ["NSE", "NFO", "BFO", "BSE", "MCX", "CDS"];

// Noren index tokens — always resolvable without a broker search.
const TOKEN_MAP = new Map([
  ["NSE:NIFTY", "26000"],
  ["NSE:BANKNIFTY", "26009"],
  ["BSE:SENSEX", "4172"],
]);

/**
 * Contract lot sizes seen while resolving a symbol (`ls` on a broker search
 * row). The order wire takes UNITS, so a derivative's quantity chip means lots
 * and the page multiplies by this before placing. Absent = unknown → 1.
 */
const LOT_MAP = new Map();

/** The lot size a resolved symbol carried, or 1 when the master did not say. */
export function lotSizeFor(exchange, symbol) {
  const key = `${String(exchange || "").toUpperCase()}:${String(symbol || "").toUpperCase()}`;
  const n = Number(LOT_MAP.get(key));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

let FEED_SEQ = 0;

/** Seed well-known symbols externally (algo symbols etc. — same hook as /charts). */
export function registerTokens(symbols) {
  for (const s of symbols || []) {
    const cfg = s.config || s;
    if (cfg && cfg.exchange && cfg.token && cfg.trading_symbol) {
      TOKEN_MAP.set(
        `${String(cfg.exchange).toUpperCase()}:${String(cfg.trading_symbol).toUpperCase()}`,
        String(cfg.token)
      );
    }
  }
}

/**
 * CI substring search across every segment — the symbol-search dialog's
 * wire (charts.html NorenFeed.searchShapes parity).
 */
export async function searchSymbols(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const settled = await Promise.allSettled(SEARCH_EXCHANGES.map((exch) =>
    fetch("/api/search-symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, exchange: exch }),
    }).then((r) => r.json()).then((p) => (p && p.values) || [])
  ));
  const seen = new Set();
  const out = [];
  for (const res of settled) {
    const values = res.status === "fulfilled" ? (res.value || []) : [];
    for (const v of values) {
      const symbol = v.tsym || v.ts;
      if (!symbol) continue;
      const vExch = String(v.exch || "").toUpperCase() || "NSE";
      const mapKey = `${vExch}:${String(symbol).toUpperCase()}`;
      if (seen.has(mapKey)) continue;
      seen.add(mapKey);
      TOKEN_MAP.set(mapKey, String(v.token));
      const text = (v.cname || v.name || v.text || symbol).toUpperCase();
      let assetClass = "Equity";
      if (v.optt === "CE" || v.optt === "PE") assetClass = "Options";
      else if (text.includes("FUT")) assetClass = "Futures";
      else if (vExch !== "NSE" && vExch !== "BSE") assetClass = "Derivatives";
      out.push({ symbol, exchange: vExch, name: v.cname || v.name || symbol, assetClass, token: String(v.token), tsym: symbol });
    }
  }
  return out.slice(0, 50);
}

/**
 * Resolve {token, exchange, tsym} — the exchange the token ACTUALLY resolved
 * from. The search tries the REQUESTED exchange first, then the chain
 * (NSE→NFO→BFO→MCX→BSE). Exact tsym match wins; a single result is trusted;
 * several candidates without an exact match refuse (silent wrong-symbol
 * trades are the alternative).
 */
export async function resolveToken(exchange, symbol) {
  const sym = String(symbol || "").toUpperCase();
  const reqEx = String(exchange || "").toUpperCase();
  const k = `${reqEx}:${sym}`;
  if (TOKEN_MAP.has(k)) {
    return { token: TOKEN_MAP.get(k), exchange: reqEx, tsym: sym, lotsize: lotSizeFor(reqEx, sym) };
  }
  const chain = [...new Set([reqEx || "NSE", "NSE", "NFO", "BFO", "MCX", "BSE"])];
  for (const exchFallback of chain) {
    try {
      const res = await fetch("/api/search-symbols", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: sym, exchange: exchFallback }),
      });
      const payload = await res.json();
      const values = (payload && payload.values) || [];
      const exact = values.find((v) => String(v.tsym || v.ts || "").toUpperCase() === sym);
      const v = exact || (values.length === 1 ? values[0] : null);
      if (v) {
        const tok = String(v.token);
        const exch = String(v.exch || exchFallback).toUpperCase();
        const tsym = String(v.tsym || v.ts || sym).toUpperCase();
        TOKEN_MAP.set(`${exch}:${tsym}`, tok);
        const lotsize = Number(v.ls);
        if (Number.isFinite(lotsize) && lotsize > 0) LOT_MAP.set(`${exch}:${tsym}`, lotsize);
        return { token: tok, exchange: exch, tsym, lotsize: lotSizeFor(exch, tsym) };
      }
    } catch (e) { /* next exchange */ }
  }
  throw new Error(
    `No instrument token found for ${exchange}:${symbol} — is your broker session active?`
  );
}

// ============================================================
// TerminalSocket — one /ws connection, desired-state market data,
// order stream, 45s/60s heartbeat watchdog (OpenAlgo page parity).
// ============================================================
export class TerminalSocket {
  constructor() {
    this._wanted = new Map();      // "EXCH|TOKEN" -> {exchange, token, mode}
    this._tickHandlers = [];
    this._orderHandlers = [];
    this._stateHandlers = [];
    this._ws = null;
    this._retry = 0;
    this._lastInbound = Date.now();
    this._pingTimer = null;
    this._destroyed = false;
  }

  onTick(fn) { this._tickHandlers.push(fn); }
  onOrderUpdate(fn) { this._orderHandlers.push(fn); }
  onState(fn) { this._stateHandlers.push(fn); }
  get state() { return this._ws && this._ws.readyState === 1 ? "open" : "closed"; }

  /** Subscribe market data for one key. Repeated calls are idempotent (the
      desired map dedups); mdUnsubscribe releases exactly one consumer. */
  mdSubscribe(exchange, token, mode = "quote") {
    const key = `${exchange}|${token}`;
    const had = this._wanted.has(key);
    const entry = { exchange, token, mode };
    this._wanted.set(key, entry);
    if (this._ws && this._ws.readyState === 1 && !had) this._addBrokerSubscribe(entry);
  }

  mdUnsubscribe(exchange, token) {
    const key = `${exchange}|${token}`;
    if (!this._wanted.delete(key)) return;
    if (this._ws && this._ws.readyState === 1) {
      this._send({ action: "unsubscribe", symbols: [{ exchange, token }] });
    }
  }

  /** Account-level order stream (OpenAlgo order-stream parity). Idempotent —
      the server refcounts nothing; subscribing twice is harmless. */
  subscribeOrders() {
    this._ordersWanted = true;
    if (this._ws && this._ws.readyState === 1) this._send({ action: "subscribe_orders" });
  }

  connect() {
    if (this._destroyed) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = (this._ws = new WebSocket(`${proto}//${location.host}/ws`));
    this._emitState("connecting");
    ws.onopen = () => {
      this._retry = 0;
      this._lastInbound = Date.now();
      this._emitState("open");
      if (this._pingTimer) clearInterval(this._pingTimer);
      this._pingTimer = setInterval(() => {
        const quiet = Date.now() - this._lastInbound;
        if (quiet >= 60000) this._teardown();
        else if (quiet >= 45000) this._send({ action: "ping" });
      }, 5000);
      // Replay the FULL desired state on every open (OpenAlgo page parity).
      const syms = [...this._wanted.values()].map((v) => ({ exchange: v.exchange, token: v.token, mode: v.mode }));
      if (syms.length) this._send({ action: "subscribe", symbols: syms });
      if (this._ordersWanted) this._send({ action: "subscribe_orders" });
    };
    ws.onclose = () => {
      this._emitState("closed");
      this._retry = Math.min(this._retry + 1, 10);
      this._teardown();
      if (!this._destroyed) setTimeout(() => this.connect(), 1000 * this._retry);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) { /* closing */ } };
    ws.onmessage = (ev) => {
      this._lastInbound = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === "order_update") {
        for (const fn of this._orderHandlers) { try { fn(msg.data || msg); } catch (e) { /* handler */ } }
        return;
      }
      if (msg.type === "market_data") {
        const frame = {
          exchange: msg.exchange, token: msg.token,
          key: `${msg.exchange}|${msg.token}`, feed: msg.feed, data: msg.data,
        };
        for (const fn of this._tickHandlers) { try { fn(frame); } catch (e) { /* handler */ } }
      } else if (msg.type === "pong" && this._lastInbound < Date.now() - 30000) {
        this._lastInbound = Date.now();
      }
      // "status" frames (algo engine deltas) are ignored here.
    };
  }

  _send(obj) {
    if (this._ws && this._ws.readyState === 1) { this._ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  _addBrokerSubscribe(entry) {
    this._send({ action: "subscribe", symbols: [{ exchange: entry.exchange, token: entry.token, mode: entry.mode }] });
  }

  _emitState(s) { for (const fn of this._stateHandlers) { try { fn(s); } catch (e) { /* handler */ } } }

  _teardown() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
    try { if (this._ws) this._ws.close(); } catch (e) { /* closing */ }
    this._ws = null;
  }

  destroy() { this._destroyed = true; this._teardown(); }
}

// ============================================================
// TerminalFeed — the package `DataFeed` over Noren's wire. One live
// slot per (feed instance, hub key): two panes on the same symbol keep
// independent anchor/candle state, like the grid desk's per-cell feeds.
// ============================================================
export class TerminalFeed {
  constructor(socket) {
    this._socket = socket;
    this._fid = ++FEED_SEQ;
    this._subs = new Map();      // "EXCH|TOKEN" -> Map<slotKey, sub>
  }

  async getBars(req) {
    const resolved = await resolveToken(req.exchange, req.symbol);
    const params = new URLSearchParams({
      exchange: resolved.exchange,
      token: resolved.token,
      interval: NOREN_INTRV[req.interval] != null ? req.interval : "5m",
    });
    if (resolved.tsym) params.set("tsym", resolved.tsym); // daily (EOD) keys on this; intraday ignores it
    if (req.to) params.set("to_ts", String(Math.floor(req.to)));
    if (req.from) params.set("from_ts", String(Math.floor(req.from)));

    const res = await fetch(`/api/chart/history?${params.toString()}`);
    if (!res.ok) throw new Error(`History request failed: HTTP ${res.status}`);
    const payload = await res.json();
    if (payload.stat !== "Ok") throw new Error(payload.emsg || "No history returned");
    // Flattrade's EODChartData is empty for SOME symbols (wire-verified:
    // sym="NSE:NIFTY" answers [] while "NSE:RELIANCE-EQ" answers rows and
    // "BSE:SENSEX" answers rows). The route still returns today's quote-spliced
    // candle, which paints a ONE-candle daily chart - say so instead of
    // pretending the series is fine.
    if (req.interval === "1d" && Array.isArray(payload.bars) && payload.bars.length < 2) {
      throw new Error("No daily candles for this instrument — the broker EOD series is empty for it; pick an intraday interval");
    }
    return payload.bars
      .map((b) => ({
        time: b.time,
        open: b.open, high: b.high, low: b.low, close: b.close,
        ...(b.volume != null ? { volume: b.volume } : {}),
        ...(b.oi != null ? { oi: b.oi } : {}),
      }))
      .sort((a, b) => a.time - b.time);
  }

  /** Live bars with the /charts bucketing semantics. The history's last bar
      (opts.seedFrom) anchors the live bucket grid, so the forming bar
      continues the loaded history exactly.

      SYNCHRONOUS by the DataFeed contract: the engine's controller calls
      subscribeBars without awaiting, so the unsubscribe function returns
      immediately and the async token resolution completes inside; an early
      unsubscribe kills the pending resolution. */
  subscribeBars(req, onBar, opts) {
    let dead = false;
    let cleanup = null;
    resolveToken(req.exchange, req.symbol).then((r) => {
      if (dead) return;
      const hubKey = `${r.exchange}|${r.token}`;
      const slotKey = `${hubKey}|${this._fid}`;
      const intervalSec = INTERVAL_SECONDS[req.interval] || 300;
      const seed = opts && opts.seedFrom ? opts.seedFrom : null;
      const sub = {
        intervalSec,
        onBar,
        bar: null,
        lastDayVol: null,
        seed: seed || null,
        anchor: seed && Number.isFinite(seed.time) ? seed.time : null,
      };
      let slots = this._subs.get(hubKey);
      if (!slots) { slots = new Map(); this._subs.set(hubKey, slots); }
      slots.set(slotKey, sub);
      const tickHandler = (frame) => {
        if (frame.key === hubKey) this._absorb(frame, sub);
      };
      this._socket.onTick(tickHandler);
      this._socket.mdSubscribe(r.exchange, r.token);
      cleanup = () => {
        const set = this._subs.get(hubKey);
        if (set) { set.delete(slotKey); if (!set.size) this._subs.delete(hubKey); }
        this._dropTickHandler(tickHandler);
        this._socket.mdUnsubscribe(r.exchange, r.token);
      };
    }).catch((e) => {
      // Unresolvable instrument: surface as an error bar the chart shows once.
      try { onBar(null, { error: e }); } catch (e2) { /* consumer */ }
    });
    return () => {
      dead = true;
      if (cleanup) cleanup();
    };
  }

  _dropTickHandler(fn) {
    const handlers = this._socket._tickHandlers;
    const i = handlers.indexOf(fn);
    if (i >= 0) handlers.splice(i, 1);
  }

  /** Let the page hand the loaded history's last bar to the live slot as the
      anchor/seed (charts.html parity: the history's grid anchors the forming
      bucket). Adopted only while nothing live-forms yet, or when the forming
      bar landed off the history's grid (epoch alignment vs 09:15 anchor on
      1h/2h/4h grains). */
  adoptSeed(req, seedBar) {
    if (!seedBar || !Number.isFinite(seedBar.time)) return;
    resolveToken(req.exchange, req.symbol).then((r) => {
      const slots = this._subs.get(`${r.exchange}|${r.token}`);
      if (!slots) return;
      for (const sub of slots.values()) {
        const offGrid = sub.bar && sub.seed && sub.bar.time !== sub.seed.time &&
          seedBar.time % sub.intervalSec === 0 && sub.bar.time % sub.intervalSec !== 0;
        if (!sub.bar || offGrid) {
          sub.seed = { ...seedBar };
          sub.anchor = seedBar.time;
          if (sub.bar && sub.bar.time !== seedBar.time) {
            sub.bar = null;   // next live tick re-opens on the history's grid
          }
        }
      }
    }).catch(() => { /* slot gone — nothing to adopt */ });
  }

  /**
   * One market_data frame → one bar attempt (charts.html handleMarketData
   * parity, session-anchored):
   *   bucket = anchor == null ? floor(t/sec)*sec : anchor + floor(t-anchor / sec)*sec
   * Volume is a day-cumulative DELTA (Noren v is cumulative in touchline
   * frames), guarded against day rolls; ltp drives O/H/L/C.
   */
  _absorb(frame, sub) {
    const d = frame.data || {};
    const ltp = Number(d.ltp != null ? d.ltp : d.lp);
    if (!Number.isFinite(ltp) || ltp <= 0) return;
    const t = Number(d.ts);
    const nowSec = Math.floor(Date.now() / 1000);
    const evt = Number.isFinite(t) && t > 1e9 ? t : nowSec;
    const sec = sub.intervalSec;
    let bucket;
    if (sub.anchor != null && evt >= sub.anchor) {
      bucket = sub.anchor + Math.floor((evt - sub.anchor) / sec) * sec;
    } else {
      bucket = Math.floor(evt / sec) * sec;
    }
    // Cumulative → delta (v arrives as the day's running volume).
    const v = Number(d.volume != null ? d.volume : d.v);
    let volDelta = 0;
    if (Number.isFinite(v) && v >= 0) {
      if (sub.lastDayVol == null) volDelta = 0;           // first frame: unknown delta
      else if (v >= sub.lastDayVol) volDelta = v - sub.lastDayVol;
      else { sub.lastDayVol = v; volDelta = 0; }          // day rolled
      sub.lastDayVol = v;
    }
    if (sub.seed && sub.seed.time === bucket && !sub.bar) {
      // First live frame inside the seeded bucket: continue the history's bar.
      sub.bar = {
        time: bucket,
        open: sub.seed.open,
        high: Math.max(sub.seed.high, ltp),
        low: Math.min(sub.seed.low, ltp),
        close: ltp,
        volume: sub.seed.volume || 0,
      };
    } else if (!sub.bar || sub.bar.time !== bucket) {
      // New bucket: the previous bar's close opens for continuity.
      const prevClose = sub.bar ? sub.bar.close : ltp;
      sub.bar = {
        time: bucket,
        open: prevClose,
        high: Math.max(prevClose, ltp),
        low: Math.min(prevClose, ltp),
        close: ltp,
        volume: 0,
      };
    }
    const bar = sub.bar;
    bar.high = Math.max(bar.high, ltp);
    bar.low = Math.min(bar.low, ltp);
    bar.close = ltp;
    bar.volume = (bar.volume || 0) + volDelta;
    try { sub.onBar({ ...bar }); } catch (e) { /* consumer */ }
  }
}
