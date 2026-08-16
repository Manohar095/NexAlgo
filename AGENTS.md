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
- `GET /api/broker/settings` / `POST /api/broker/settings` — access token status / manual update
- `POST /api/broker/generate-token` — headless TOTP token generation
- `GET /api/status` — all engine statuses

## Gotchas

- **No linter, no formatter, no typecheck, no CI.** There is no automated quality gate.
- **No lockfile.** Dependencies are unpinned ranges (except the vendored wheel). Builds are not reproducible.
- **Access token rotation** happens daily. The dashboard's "Generate Access Token" button runs TOTP headless login and writes the new token to `.env` + applies it live. No restart needed.
- **`reload=False`** in `uvicorn.run` — the app does not auto-reload on code changes.
- **SQLite + threads:** `database/db.py` uses `check_same_thread=False` and a global lock. Fine for this workload but worth knowing.
- **Timezone:** Strategy logic uses IST (`Asia/Kolkata`) via pytz. Square-off defaults are 15:15 IST.
- **Frontend** is vanilla JS in `static/app.js` — no build step, no bundler.
- **Log location:** Rotating logs at `logs/cognix_algo.log` (7-day retention). PM2 logs go to `logs/pm2_out.log` / `logs/pm2_error.log`.
- **Symbol config updates:** Updating a running symbol stops it, recreates the engine with the new config, and restarts it — this is safe and expected. The `update_symbol` call in `instance_manager.py` handles the stop-recreate-restart cycle.
