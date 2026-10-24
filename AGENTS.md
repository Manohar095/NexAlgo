# AGENTS.md

## What this is

CogniX Algo — a Python 3.11 algorithmic trading platform built on FastAPI. Manages multiple symbol instances with Renko-based strategies against the Flattrade/Noren Indian broker API. Single-process app (not a monorepo).

## Run

```bash
python main.py            # starts FastAPI on http://localhost:8000
```

No Makefile, no npm scripts, no CI. That is the only way to start the app.

## Dependencies

```bash
pip install -r requirements.txt
```

One dependency is a **vendored wheel** (`dist/norenrestapi-0.0.30-py3-none-any.whl`) — referenced as a local path in `requirements.txt`. Do not replace it with a PyPI package.

## Configuration

All config lives in `.env` (loaded via `python-dotenv` in `config/settings.py`). Copy `.env.example` to `.env`. Key values:

- `FT_USER`, `FT_PWD`, `FT_TOTP_KEY`, `FT_API_KEY`, `FT_API_SECRET` — broker credentials
- `FT_ACCESS_TOKEN` — regenerated daily; updated at runtime without restart
- `DASHBOARD_USER` / `DASHBOARD_PASSWORD` — if both set, login is required; if blank, auth is skipped entirely
- `DASHBOARD_TOTP_SECRET` — optional 2FA (generate with `python -m utils.session_auth`)
- `SESSION_SECRET_KEY` — if blank, random key per restart (logs everyone out)

`.env` is gitignored. Never commit it.

## Architecture

```
main.py                     entry point, lifespan, WebSocket route
api/routes.py               all REST endpoints (prefix /api)
api_helper.py               low-level Noren broker wrapper (NorenApiPy)
config/settings.py          .env-loaded singleton
database/db.py              SQLite (single `symbols` table, JSON config column)
models/symbol_config.py     Pydantic model — per-symbol strategy settings
services/instance_manager.py  owns all TradingEngine instances, bridges API ↔ strategy
services/access_token_generator.py  headless TOTP-based token generation
strategy/broker.py          singleton BrokerSession — one shared login + WebSocket
strategy/trading_engine.py  per-symbol engine (runs in its own thread)
strategy/renko.py           Renko brick calculation
ws_broadcast/ws_manager.py  bridges strategy threads → FastAPI async for live UI updates
utils/auth_middleware.py    ASGI session-cookie auth
utils/logging_setup.py     console + daily rotating file (logs/cognix_algo.log)
static/                    vanilla JS frontend (no framework)
templates/                 Jinja2 HTML (index.html, login.html)
dist/                      vendored norenrestapi wheel (do not touch)
```

**Key invariant:** `BrokerSession` is a singleton shared by every `TradingEngine`. It owns the single broker login and single WebSocket connection. Feed/order callbacks are dispatched by key (exchange|token / exchange+tsym). Each engine's state is fully independent — only the connection is shared.

**Persistence:** SQLite at `database/renko_platform.db`. Config is stored as JSON blobs so schema changes never require migrations. The `db` module uses `threading.Lock` for thread safety.

**Auth middleware:** Custom ASGI middleware (`utils/auth_middleware.py`) — not Starlette's `BaseHTTPMiddleware` — because it must also gate WebSocket handshakes. Enabled only when both `DASHBOARD_USER` and `DASHBOARD_PASSWORD` are set. `/login`, `/api/auth/*`, and `/static/` are always public.

## Startup sequence

1. `configure_logging()` runs first (console + daily rotating file in `logs/`)
2. FastAPI `lifespan` initialises the database, sets the asyncio loop on `ws_manager`, wires up log/status broadcast callbacks, then calls `instance_manager.load_from_db(autostart_saved=True)` which restores saved symbols and auto-starts any flagged `autostart=True`
3. On shutdown, every RUNNING symbol is stopped gracefully

## WebSocket & live updates

The frontend connects to `/ws` on page load. `ws_manager` bridges strategy threads (which are plain `threading.Thread` daemons) into FastAPI's asyncio loop via `asyncio.run_coroutine_threadsafe`. Strategy code never touches asyncio directly — it calls `on_log`/`on_status` callbacks that schedule sends on the main loop.

**Market data is OpenAlgo websocket-proxy parity (single-process adaptation):**
- `/ws` speaks a client **action protocol**: `{"action":"subscribe","symbols":[{exchange,token}],"mode":"ltp"|"quote"|"depth"}`, `{"action":"unsubscribe"}`, `{"action":"subscribe_orders"}`, `{"action":"ping"}` (→ `{"type":"pong","server_timestamp":...}`). Legacy raw-text keepalives still work.
- Every subscribe action increments a **broker feed refcount per (connection, key)** (`BrokerSession.register_passive_subscriber(exch, token, mode)`); `ws_manager` keeps the per-connection subscription index and **fans `market_data` frames out only to the sockets that subscribed to that `EXCH|TOKEN`** — no more "every tick to every client". Socket drop auto-releases refcounts (`release_on_disconnect`).
- `BrokerSession` maintains a **normalized per-key snapshot cache** (`_md_cache`): partial Noren frames (`tk`/`dk`) merge into the running snapshot (ltp, o/h/l, prev_close from `c`, volume, oi, bid/ask, 5-level depth, tick_size, tsym, derived change%), and every queued WS subscriber gets the cached snapshot instantly, OpenAlgo-style.
- **Feed types per key** follow the OpenAlgo flattrade adapter: Noren touchline (`t`) while anyone is subscribed, plus the snapquote (`d`) only while a depth viewer exists — both can co-exist at the broker; deregistration removes the exact types no longer wanted. `_resubscribe_all_feed_types` replays the full desired state on socket (re)open.
- Engines keep using the raw Noren frame via `register_feed`; UI consumers get normalized frames via `set_tick_listener` / `set_order_listener` (wired in `main.py:_wire_market_data_forwarding`), which fan out as `{"type":"market_data", exchange, token, feed, data}` and `{"type":"order_update", data}`.
- Frontends (charts page module script + dashboard `app.js`) keep a **desired-state map** of their subscriptions and replay it on every reconnect, run a **45s/5s ping watchdog** (quiet ≥45s → ping probes, ≥60s → reconnect), and fall back to **5s `/api/multiquotes` polling** only while the socket is down. The charts page also repaints **live option-chain legs** from `market_data` frames and polls the chain for OI/IV every 30s.

`BrokerSession` has a heartbeat watchdog: if no WebSocket message arrives for 45 seconds during market hours (weekdays 09:15–15:30 IST) while symbols are subscribed, it forces a reconnect with capped exponential backoff (3s → 60s max).

## Tests

There is **no pytest suite**. Files in `tests/` are standalone demo scripts that require manual credential setup (editing `usersession`/`userid` values in the script). They are not automated.

## Deployment

Two options, both in `deploy/`:

- **PM2:** `pm2 start deploy/ecosystem.config.js` (edit `interpreter` and `cwd` in the config first)
- **systemd (Linux):** `deploy/cognix_algo.service` or `deploy/renko-platform.service`

The app runs as a single process. Each trading symbol runs in its own daemon thread managed by `InstanceManager`.

## REST API

All endpoints are under `/api` prefix (defined in `api/routes.py`). Key routes:

- `GET/POST /api/symbols` — list all symbols / create a new symbol
- `GET/PUT/DELETE /api/symbols/{id}` — individual symbol CRUD
- `POST /api/symbols/{id}/start|stop|restart` — lifecycle control
- `POST /api/symbols/{id}/squareoff` — manual SQUAREOFF: cancels SL + pending entries, flattens the position with a marketable LMT, then blocks trading until the symbol is stopped and started again (OpenAlgo cmd parity)
- `GET /api/broker/settings` / `POST /api/broker/settings` — access token status / manual update
- `POST /api/broker/generate-token` — headless TOTP token generation
- `GET /api/chart/history` — broker candle history (Noren TPSeries) for the charts page
- `POST /api/chart/watch` — refcounted per-tab broker funnel subscription for chart symbols
- `GET /api/optionchain/underlyings` — the full OpenAlgo `all_underlyings`-style universe per derivative exchange from the published Flattrade scrip master (`services/scrip_master.py`; NFO/BFO 2 files, MCX Commodity.csv, CDS Currency_Derivatives.csv). One entry per options-bearing underlying (MCX/CDS keep futures-only names too), indices first, each carrying its nearest futures tsym/token + `expiries[]` + per-expiry representative option tsym/token; disk-cached 12h under `database/scripmaster/`. `?q=` does a case-insensitive substring filter server-side; the charts panel fetches the full list once per exchange and filters client-side (no broker search per keystroke)
- `GET /api/optionchain/chain` — option chain around ATM (`?exchange=NFO&underlying=BANKNIFTY27OCT26F&token=...&count=10&expiry=27-OCT-2026`; `count` = strikes PER SIDE, PiConnect `cnt`, wire returns 4×cnt contracts; pass `&atm=` to skip ATM resolution). `expiry` selects a non-nearest series: the call is keyed on that expiry's representative option tsym from the picker universe (verified live — GetOptionChain returns the tsym's own series). Pipeline: SPEC-verbatim `GetOptionChain` (metadata-only) → board expiry (user-selected `expiry` wins, else one `GetSecurityInfo` on the futures for `exd`, cached) → per-leg quotes (WS `_md_cache` snapshot first, normalized `GetQuotes` fallback with one 0.15s retry, ThreadPool(8)) → IV + Greeks inverted/derived locally via Black-76 (`services/option_greeks.py`; theta/day, vega+rho per-1%, rate `FT_OC_INT_RATE` default 0.065). Response adds `expiry`/`int_rate`; legs get `prev_close` + iv/delta/gamma/theta/vega (rounded 6dp; refused/stale prices stay null). ATM quote retries once (0.3s) against PiConnect burst throttling; a futures-keyed call that comes back `No Data` (MCX) is retried once keyed on the nearest expiry's option rep
- `POST /api/optionchain/greek` — one leg through the official PiConnect `GetOptionGreek` (body `{exd, strprc, sptprc, int_rate, volatility, optt}`, numerics as strings); used for on-demand cross-checks — the panel computes Greeks locally, see the pipeline note above
- `GET /api/status` — all engine statuses
- `POST /api/quotes` — normalized single quote (OpenAlgo `/quotes` shape: `bid/ask/open/high/low/ltp/prev_close/change/change_percent/volume/oi/tick_size`; Noren `c` maps to `prev_close`)
- `POST /api/depth` — normalized 5-level depth (`bids[]/asks[] {price,quantity,orders}` + totals)
- `POST /api/multiquotes` — batched normalized quotes `{symbols:[{exchange,token}]}` (≤40), used as the 5s REST fallback while a client's WebSocket is down
- `GET /api/intervals` — candle intervals the chart engine serves (`{code, seconds}`)
- Legacy raw endpoints stay: `/api/get-quotes` (raw Noren), `/api/chart/watch` (old REST funnel — the charts page now subscribes over WS, but the funnel remains functional)

## Gotchas

- **Charts page right panel** (`templates/charts.html`) is a vanilla-JS port of the OpenAlgo trading-page right panel (`F:\OpenAlgo\openalgo\frontend\src\components\trading\`): icon rail + `PanelShell` + Watchlist / Option Chain / Algo Symbols tabs. Scoped `--oa-*` tokens replicate OpenAlgo's dark theme; stored keys are the `cognix_*` / `cognix_wl_*` / `cognix_oc_*` localStorage entries.
- **Option-chain tab layout is an exact `OptionChainPanel.tsx` replica:** fixed px tracks (LTP 68 / OI 60 / Vol 60 / IV·Δ·Γ·Θ·V 56, gap 6 + px-2), NO flexible slack column; the call side renders the same column list REVERSED with its one horizontal scroller auto-pinned fully right (`repinCallScroll`, rAF) so LTP meets the strike; one measured pane width `floor((body-64)/2)` (ResizeObserver → `ocApplyPaneWidths`) is shared by header panes, body panes and pinned-bar pans; the thin pinned bottom strips (8px webkit bar + 64px bordered strike spacer) are the only visible horizontal bars; per-side `syncing` guards wire body↔head↔pinned two ways. Body states = Loading / empty text / error+Retry; footer `#ocStatus` shows "Not updating…" (error after a load) / "Not streaming…" (market hours + `window.__wsConnected()` false) / "Market closed…" — amber/muted 10px. Spot is tri-colored vs the underlying's prev_close captured from live frames (`ocSpotPrevClose`), never a tick flash. B/S order pills are deliberately NOT ported (there is no PlaceOrderDialog in NexAlgo).
- **WS subscribe model** (charts page + dashboard): the classic-script panels on charts.html never touch the WebSocket directly — they call `window.__wsSubKey(exch, token)` / `__wsUnsubKey` hooks exported by the module script's market-data client, which owns the desired-state map and all send/reconnect logic. Tick routing to the page happens through `window.__pageTick(market_data_frame)`; candle bucketing stays in the module.
- **Noren `c` field maps to `prev_close`** everywhere (legacy funnel, `_md_snapshot_from_msg`, `/api/quotes`) — but the connector also derives `change`/`change_percent` from `ltp - prev_close`, so UI consumers should prefer the derived fields over Noren's `pc` (percent-change, a different thing).
- **Snapquote frames are engine-safe:** upgrading a key to the Noren `d` feed (while a depth viewer is present) also streams `df`/`dk` frames into engine feed handlers — engines only read `msg["lp"]`, which every frame type carries. Depth sides in `_md_cache` are replaced wholesale per frame (never merged), so stale levels can't linger.
- **Feed-refcount release ordering:** sockets release broker refcounts in the `/ws` `finally` via `ws_manager.release_on_disconnect` → `broker.unregister_passive_subscriber(exch, token, stored_mode)` — the stored per-connection mode matters because `unregister` must decrement the SAME mode it registered with.
- **Symbol settings dialog** (port of algo-hub `SymbolSettingsDialog.tsx`, same file): Add symbol = debounced broker search (`POST /api/search-symbols` → `tsym`/`token`/`exch`/`ti`/`ls`) → `POST /api/symbols {config}`; ⋮ → "Edit settings" (disabled while RUNNING, like OpenAlgo) prefills from the saved config → `PUT /api/symbols/{id}`. Fields map 1:1 onto `models/symbol_config.py` — no atr/ltp_pct brick methods (engine is fixed `brick_size`), squareoff time input splits to `squareoff_hour`/`squareoff_minute`, `limit_offset`/`entry_trail_brick_number` left blank = backend defaults.
- **PiConnect option-chain endpoints (`api_helper.py:pi_get_option_chain` / `pi_get_option_greek`) use RAW-JSON `jData`, never URL-encoded** — URL-encoding it answers `Not_Ok: jData is not valid json object` (the doc's prose says to URL-encode; its own curl and the wire disagree — wire won). The documented `Content-Type: application/json` header WITH the form body is a real quirk and is set verbatim; stat is compared case-insensitively; Not_Ok + session-expiry language triggers `login(force=True)` + one retry in `broker.get_pi_option_greek`.
- **GetOptionChain rows are metadata-ONLY** (exch/tsym/token/optt/strprc/pp/ti/ls) — no quotes, no expiry, no IV, no Greeks. The chain route therefore layers: expiry from ONE `GetSecurityInfo` on the underlying futures (`exd`, cached in `_chain_expiry_cache`), quotes per leg from `_md_cache` (WS) or `GetQuotes`, and IV+Greeks from local Black-76 inversion of each leg's price — because `GetOptionGreek` takes volatility as an *input* and no Flattrade endpoint returns IV. GetOptionGreek is exposed via `POST /api/optionchain/greek` (spec quirks: its documented `YYYY-MM-DD` exd is rejected by the live engine with `"nan"` rows — the engine wants `DD-MON-YYYY` (`_pi_exd_format` normalizes); live keys are `cal_vega`/`put_vega` though the doc spells `vego`, both parsed; stale `"nan"`/INT64-min numerics map to None).
- **OC picker = OpenAlgo `all_underlyings` parity:** the charts-page option-chain combobox loads the FULL universe once per exchange (`ocUniverseCache` map, `loadOcUniverse`) and filters client-side per keystroke (substring, no debounce/network); indices first, `✓` marks the selected underlying. Strikes are FIXED at `OC_STRIKE_COUNT = 10` per side (`STRIKE_COUNT = 10` in `OptionChainPanel.tsx`; the ±strikes select was removed; backend keeps `?count=`). Band-2 shows an **expiry select** (`ocExpiry`) populated from the universe entry's `expiries[]`, nearest auto-selected, refetching the chain on change; the chain route keys the chosen series' representative option — GetOptionChain returns the series of the tsym it is keyed on (verified live: `BANKNIFTY23NOV26C58900` → NOV board). Exchange switch keeps the old underlying when the new segment has it, else auto-selects the first entry and loads its chain (OA fallback rule).
- **Master-CSV tsyms can be strike-truncated and GetOptionChain rejects them** — the published CDS master lists `USDINR28OCT26C97.12` while the scrip is `97.1250` (`GetSecurityInfo.strprc` is the 4dp truth; CSV Strike/Tradingsymbol truncate to 2dp). The chain route repairs such keys once from scrip info (`_repaired_chain_key`, cached per tsym in `_chain_key_repair_cache`) and retries. MCX is the opposite quirk: futures-keyed GetOptionChain answers `No Data :` — chains for MCX MUST key on an option tsym (route falls back to the nearest expiry's rep; MCX bases with no option expiries in the master (~20 of 31) cannot serve a chain). PiConnect occasionally burst-throttles GetQuotes/GetOptionChain — leg quotes and the ATM quote each retry once.

- **No linter, no formatter, no typecheck, no CI.** There is no automated quality gate.
- **No lockfile.** Dependencies are unpinned ranges (except the vendored wheel). Builds are not reproducible.
- **Access token rotation** happens daily. The dashboard's "Generate Access Token" button runs TOTP headless login and writes the new token to `.env` + applies it live. No restart needed.
- **`reload=False`** in `uvicorn.run` — the app does not auto-reload on code changes.
- **SQLite + threads:** `database/db.py` uses `check_same_thread=False` and a global lock. Fine for this workload but worth knowing.
- **Timezone:** Strategy logic uses IST (`Asia/Kolkata`) via pytz. Square-off defaults are 15:15 IST.
- **Frontend** is vanilla JS in `static/app.js` — no build step, no bundler.
- **Log location:** Rotating logs at `logs/cognix_algo.log` (7-day retention). PM2 logs go to `logs/pm2_out.log` / `logs/pm2_error.log`.
- **Symbol config updates:** Updating a running symbol stops it, recreates the engine with the new config, and restarts it — this is safe and expected. The `update_symbol` call in `instance_manager.py` handles the stop-recreate-restart cycle.
