# NexAlgo Trading Terminal

A locally hosted, web-based version of your single-symbol Flattrade
Renko bot (v3, SL-based exit) that can run **any number of symbols
simultaneously**, each with its own independent Renko engine, position,
stop-loss, and trailing-SL state — while every symbol still runs the
**exact same strategy logic** as the original script.

## What changed vs. the original bot — and what didn't

**Unchanged (byte-for-byte the same behaviour):**
- Renko brick engine (`strategy/renko.py` = original `LiveRenko`, untouched)
- SL-based exit model: entry fill → SL placed 2 bricks behind → trailed
  every brick, tighten-only
- Fresh-entry-only signal logic per `TRADE_MODE` (LONG_ONLY / SHORT_ONLY / LONG_SHORT)
- Hard-reversal cancellation of unfilled pending entries
- Deferred-order replay on placement-time conflicts
- Auto square-off at a configurable time, with marketable-LMT exit and validation
- Periodic safety-net thread that recomputes SL if a fill callback was missed
- Worker-queue architecture for order execution

**What changed (mechanical refactor only, to support multiple symbols):**
- Every former global constant (`SYMBOL`, `BRICK_SIZE`, `TRADE_MODE`, ...)
  is now a field on a `SymbolConfig`, one per symbol, stored in SQLite.
- The single global `bot` / `renko` pair is now a `TradingEngine`
  instance per symbol — its own position, pending order, SL state,
  worker thread, squareoff thread, safety-net thread, and log buffer.
- The only shared component is `strategy/broker.py`'s `BrokerSession`:
  **one login, one physical WebSocket**, which fans incoming ticks and
  order updates out to the correct symbol instance by
  `EXCHANGE|TOKEN` / `(EXCHANGE, TSYM)`.
- Starting/stopping/restarting one symbol only touches that symbol's
  threads and its feed/order-update registration — every other running
  symbol is untouched.

## Project layout

```
main.py                    FastAPI app entrypoint
config/settings.py         Shared broker credentials (.env), DB path
models/symbol_config.py    Per-symbol strategy configuration schema
database/db.py             SQLite persistence for symbol configs
strategy/renko.py          Renko brick engine (unchanged)
strategy/trading_engine.py Per-symbol strategy engine (unchanged logic, refactored)
strategy/broker.py         Shared broker session + single WebSocket, message routing
services/instance_manager.py       Creates/starts/stops/restarts symbol instances, DB sync
services/access_token_generator.py Your original token-generation script, integrated
utils/logging_setup.py     Console + rotating daily file logging
ws_broadcast/ws_manager.py Pushes live status/log events to the dashboard over WS
api/routes.py              REST API used by the dashboard
static/, templates/        Browser dashboard (vanilla JS, no build step)
deploy/                    PM2 / systemd configs for crash-recovery process supervision
```

> Note: the WebSocket-dispatch package is named `ws_broadcast/` rather
> than `websocket/` on purpose — Flattrade's `api_helper.py` typically
> depends on the third-party `websocket-client` package, and a local
> folder literally named `websocket` would shadow it.

## Setup

1. **Bring your existing broker SDK.** Copy your working `api_helper.py`
   (the one your original bot imported, wrapping Flattrade/Noren's
   `NorenApiPy`) into this project's root folder, next to `main.py`.
   It is not included here since it's your existing, working file.

2. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure credentials**
   ```bash
   cp .env.example .env
   # then fill in FT_USER, FT_PWD, FT_TOTP_KEY, FT_API_KEY, FT_API_SECRET, FT_RURL
   ```
   `FT_USER` / `FT_PWD` (and the TOTP/API key/secret used to generate a
   token) are static and belong in `.env`. Leave `FT_ACCESS_TOKEN` blank
   — see below, you'll generate it from the dashboard each morning
   instead of typing it into a file.

4. **Run**
   ```bash
   python main.py
   ```
   Open **http://localhost:8000**.

## Daily access token (🔑 Access Token button)

Flattrade/Noren access tokens expire and need regenerating every
trading day, unlike the user ID/password. There's a **single shared
token, stored in `.env`** (`FT_ACCESS_TOKEN`) — every symbol reads the
same value, exactly like user ID/password. Click **🔑 Access Token** in
the dashboard header to refresh it, two ways:

- **⚡ Generate Access Token** — runs your original TOTP-based headless
  login flow (`services/access_token_generator.py`, integrated
  unchanged: session → TOTP login → auth code → API token), writes the
  result straight into `.env`, and applies it to the running platform
  immediately. This is the same script you had before — just triggered
  from a button instead of run manually from a terminal each morning.
- **Save & Apply (manual paste)** — if you already have a token from
  somewhere else, paste it here instead. Also writes to `.env`.

Either path:
- Updates `FT_ACCESS_TOKEN` in `.env` on disk (so a restart still picks
  it up correctly).
- Applies the new token to the already-running process immediately —
  no restart needed.
- Forces an immediate re-login, and a WebSocket reconnect if it was
  already running.
- Every symbol picks up the same refreshed session automatically —
  there is exactly one token generation happening centrally, never one
  per symbol.

The modal shows a masked view of the current token, when it was last
updated, and whether the broker session is currently connected. If
generation fails (wrong TOTP secret, network issue, broker-side
rejection, etc.), the error message from the broker is shown directly
in the modal so you know what to fix — nothing is silently swallowed.

> `services/access_token_generator.py` still works standalone too —
> `python services/access_token_generator.py` from the project root
> runs the exact same flow from a terminal / cron / Task Scheduler, if
> you ever want that instead of clicking the button.

## Resilience — reconnect logic, disk logging, crash recovery

**WebSocket auto-reconnect** (`strategy/broker.py`): the single shared
broker WebSocket reconnects automatically if it drops, via two
mechanisms working together:
- Immediate reconnect if the SDK fires a close/error callback.
- A heartbeat watchdog that forces a reconnect if no messages have
  arrived for 45s during market hours (catches silent drops some SDKs
  don't report). Reconnects re-login and re-subscribe every registered
  symbol automatically — no manual restart needed, and no single
  symbol needs restarting either.

**Disk-persisted logs** (`utils/logging_setup.py`): every log line
(console output, all per-symbol strategy logs) is also written to
`logs/renko_platform.log`, rotated daily with 30 days kept. The
dashboard's in-memory log stream is just a live view — the full
history survives a crash or restart, for later review.

**Process supervision** (`deploy/`): the resilience above covers the
WebSocket and login, but if the whole Python process itself dies
(unhandled exception, OOM, terminal closed), something needs to
restart it. Two ready-to-use options:

- **PM2** (`deploy/ecosystem.config.js`) — cross-platform, works on
  Windows/Mac/Linux, good fit for your current dev machine:
  ```bash
  npm install -g pm2
  # edit ecosystem.config.js: set `interpreter` to your venv's python
  pm2 start deploy/ecosystem.config.js
  pm2 logs zenith-trading-terminal
  pm2 startup   # optional: auto-start PM2 itself on machine boot
  pm2 save
  ```
- **systemd** (`deploy/zenith-trading-terminal.service`) — for when you
  deploy to a Linux VPS (Linux-only; won't work on Windows):
  ```bash
  sudo cp deploy/zenith-trading-terminal.service /etc/systemd/system/
  sudo systemctl daemon-reload
  sudo systemctl enable --now zenith-trading-terminal
  journalctl -u zenith-trading-terminal -f
  ```

Either option gives you: if the process crashes, it's restarted
automatically within a few seconds, and on restart it reloads every
saved symbol from SQLite and auto-starts the ones flagged
`autostart` — so a crash mid-session is a brief gap in ticks, not a
lost configuration.

## Using the dashboard

- **+ Add Symbol** opens the same configuration form as the original
  bot's constants: General (symbol/token/qty/product type), Renko
  settings (brick size, G2R/R2G), Entry settings (brick numbers, limit
  offsets, cancel bricks), Stop Loss (brick multiplier, offset),
  Trading (trade mode, square-off time, SL-LMT buffer), plus an
  **Auto-start with platform** checkbox.
- Each row in the live table is one running (or stopped) symbol:
  LTP, current brick, trend, position, entry price, current SL,
  quantity, mode, status, and last-updated time — all pushed live over
  WebSocket, no page refresh needed.
- **Start / Stop / Restart** act on that symbol only.
- **Delete** stops the symbol (if running) and removes its saved config.
  It does **not** touch any open position or order at the broker —
  square-off / manual exit is still your call, exactly like the
  original bot never auto-flattened outside its own square-off window.
- The **log stream** at the bottom shows every symbol's log lines,
  filterable to one symbol via the dropdown — mirroring the
  `SENSEX CE` example log window from your spec, plus a combined
  chronological view.

## Persistence & restart behaviour

- All symbol configs are saved to `database/renko_platform.db`
  (SQLite) as soon as you click **Save Symbol** — no separate "save"
  step needed.
- On `python main.py` startup, every saved symbol is loaded; symbols
  flagged **Auto-start with platform** are started automatically.
  Symbols without that flag are loaded but left stopped, so you decide
  when to bring them live.

## Extending

The suggested structure leaves room for exactly what you called out —
additional brokers (swap `strategy/broker.py`'s internals, keep the
same `register_feed` / `register_order_handler` contract), analytics,
notifications, and paper trading (a second `TradingEngine`-like class
that shares the same `SymbolConfig` and dashboard, but calls a
simulated broker instead of `BrokerSession`).
