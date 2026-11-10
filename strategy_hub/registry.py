# -*- coding: utf-8 -*-
"""
strategy_hub/registry.py — one managed "strategy process" per exchange.

Port of strategy_hub_package/strategy_hub/registry.py. There the process was an
OS SUBPROCESS registered with OpenAlgo's /python page — that page owned the
schedule, start/stop/restart, armed states and the auto-start. NexAlgo has no
/python system, so the process is an in-process body owned HERE with the same
semantics:

* One process per exchange (renko_NFO, renko_MCX, ...). OpenAlgo gates a whole
  strategy on one exchange's sessions; exchanges must not share one.
* Schedule (IST): NSE/BSE/NFO/BFO 09:00–15:35, CDS/BCD 09:00–17:05,
  MCX/NCO 09:00–23:35. The stop must stay later than every squareoff time
  (service.validate_config enforces that from the panel).
* A start outside the schedule / on a non-trading day ARMS the process: the body
  runs, holds its instances stopped, and reports when it auto-starts.
* Crossing the schedule stop stops the instances (broker orders left untouched).
* A manual stop cancels the scheduled auto-start (persisted in `process_state`)
  until an explicit start clears it.
* After a platform boot, every exchange that still has ENABLED symbols and is not
  manually stopped is started again (autostart_from_db, called by main's lifespan).
"""

import logging
import threading
import time
from datetime import datetime

import pytz

from strategy_hub import db as hub_db
from strategy_hub.service import EXCHANGES, managed_id

logger = logging.getLogger(__name__)

MANAGED_BY = "strategy_hub"
IST = pytz.timezone("Asia/Kolkata")
CONFIG_POLL_SEC = 2          # config / command / status cycle (renko_multi parity)

# (schedule start, schedule stop) IST. The stop must be later than every squareoff time.
SCHEDULE_DEFAULTS = {
    "NSE": ("09:00", "15:35"), "BSE": ("09:00", "15:35"),
    "NFO": ("09:00", "15:35"), "BFO": ("09:00", "15:35"),
    "CDS": ("09:00", "17:05"), "BCD": ("09:00", "17:05"),
    "MCX": ("09:00", "23:35"), "NCO": ("09:00", "23:35"),
}
DEFAULT_DAYS = ["mon", "tue", "wed", "thu", "fri"]


def schedule_stop_for(exchange):
    """The schedule stop that applies to this exchange's strategy (squareoff validation)."""
    return SCHEDULE_DEFAULTS.get(str(exchange).upper(), ("09:00", "15:35"))[1]


def _is_trading_day(now):
    # The package used OpenAlgo's trading-calendar service; the weekly calendar
    # only here — bank holidays arm as "started" and the instances just see
    # no market data.
    return now.weekday() < 5


def _within_schedule(now, start, stop):
    t = now.strftime("%H:%M")
    return start <= t < stop


class ExchangeProcess:
    """The body of one exchange's managed strategy: a thread driving SymbolManager."""

    def __init__(self, exchange):
        self.exchange = exchange
        self.strategy_id = managed_id(exchange)
        from strategy_hub.manager import SymbolManager
        self.manager = SymbolManager(self.strategy_id)
        self.stop_event = threading.Event()
        self.thread = None
        self.is_running = False      # inside schedule (not necessarily "has instances")
        self.message = "Starts when you enable a symbol"
        self.error = None

    # ---- state ----
    def alive(self):
        return bool(self.thread and self.thread.is_alive())

    def start(self):
        if self.alive():
            return True, "Strategy already running", "already"
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, daemon=True, name=f"hub-{self.exchange}")
        self.thread.start()
        return True, "Strategy started", "started"

    def stop(self, persist_manual=True):
        cancelled = False
        if self.alive():
            self.stop_event.set()
            self.thread.join(timeout=10)
            self.thread = None
        else:
            cancelled = True
        try:
            self.manager.stop_all()
        except Exception:
            logger.exception("hub stop_all failed for %s", self.strategy_id)
        self.is_running = False
        self.message = "Stopped (broker orders and positions left untouched)" if not cancelled \
            else "Scheduled auto-start cancelled"
        if persist_manual:
            self._set_manual(True)
        return True, self.message, "stopped"

    # ---- schedule enforcement (the /python scheduler's job in the package) ----
    def _demote(self, msg):
        """Hold outside the schedule: keep the body alive, stop every instance."""
        for rid in list(self.manager.instances):
            try:
                self.manager._stop_instance(rid)
            except Exception:
                logger.exception("hub instance stop failed during demote")
        if not self.manager.instances:
            self.manager.versions.clear()
        self.is_running = False
        self.message = msg

    def _run(self):
        start, stop = SCHEDULE_DEFAULTS.get(self.exchange, ("09:00", "15:35"))
        while not self.stop_event.is_set():
            try:
                now = datetime.now(IST)
                if not _is_trading_day(now):
                    self._demote(f"{self.exchange} is closed today. It starts automatically on the "
                                 f"next trading day at {start} IST.")
                elif not _within_schedule(now, start, stop):
                    self._demote(f"Outside {start}-{stop} IST. It starts automatically at {start} IST.")
                else:
                    self.is_running = True
                    self.message = "Running"
                    self.error = None
                    self.manager.tick()
            except Exception:
                logger.exception("hub process %s tick failed", self.strategy_id)
                self.error = self.message = "strategy process error (see server log)"
            self.stop_event.wait(CONFIG_POLL_SEC)
        self.is_running = False

    # ---- manual-stop persistence ----
    def _set_manual(self, value):
        hub_db.write(
            "INSERT INTO process_state (exchange, manually_stopped, updated_at) VALUES (?,?,?) "
            "ON CONFLICT(exchange) DO UPDATE SET manually_stopped=excluded.manually_stopped, "
            "updated_at=excluded.updated_at",
            (self.exchange, 1 if value else 0, time.time()),
        )


# ---------------------------------------------------------------- module registry
_processes = {}
_lock = threading.Lock()


def _get_process(exchange):
    with _lock:
        p = _processes.get(exchange)
        if p is None:
            p = ExchangeProcess(exchange)
            _processes[exchange] = p
        return p


def manually_stopped(exchange):
    row = hub_db.fetchone("SELECT manually_stopped FROM process_state WHERE exchange=?",
                          (exchange,))
    return bool(row and row.get("manually_stopped"))


# ---------------------------------------------------------------- start / stop
def start_process(exchange):
    """Start (or arm) the exchange's managed strategy. Returns (ok, message, state)
    with state in started | armed | already | error — the package's shape."""
    if exchange not in EXCHANGES:
        raise ValueError(f"Unsupported exchange {exchange}")
    p = _get_process(exchange)
    start, stop = SCHEDULE_DEFAULTS.get(exchange, ("09:00", "15:35"))
    now = datetime.now(IST)
    p._set_manual(False)               # an explicit start resumes the scheduled auto-start
    ok, message, state = p.start()
    if state == "started":
        if not _is_trading_day(now):
            message = f"{exchange} is closed today. It starts automatically on the next trading day at {start} IST."
            state = "armed"
        elif not _within_schedule(now, start, stop):
            message = f"Outside {start}-{stop} IST. It starts automatically at {start} IST."
            state = "armed"
    return ok, message, state


def stop_process(exchange):
    """Stop the exchange's managed strategy (broker orders are left untouched)."""
    p = _get_process(exchange)
    return p.stop(persist_manual=True)


def restart_process(exchange):
    ok, message, state = stop_process(exchange)
    if not ok:
        return ok, message, state
    return start_process(exchange)


# ---------------------------------------------------------------- status
def process_info(exchange, total=0, enabled=0):
    """The ProcessInfo row the panel paints (package shape parity)."""
    p = _processes.get(exchange)
    start, stop = SCHEDULE_DEFAULTS.get(exchange, ("09:00", "15:35"))
    info = {
        "exchange": exchange, "strategy_id": managed_id(exchange), "registered": True,
        "is_running": False, "manually_stopped": manually_stopped(exchange),
        "schedule_start": start, "schedule_stop": stop,
        "status": "stopped", "status_message": "Starts when you enable a symbol",
        "symbols": total, "enabled": enabled,
    }
    if p is None:
        if info["manually_stopped"]:
            info["status_message"] = "Stopped (scheduled auto-start cancelled)"
        return info
    info["is_running"] = bool(p.alive() and p.is_running)
    if p.error:
        info["status"], info["status_message"] = "error", p.message
    elif info["is_running"]:
        info["status"], info["status_message"] = "running", "Running"
    else:
        info["status_message"] = p.message
    return info


# ---------------------------------------------------------------- bootstrap
def autostart_from_db():
    """After a platform boot: start every exchange that still has ENABLED symbols
    and was not manually stopped (each respects the schedule → armed outside it)."""
    hub_db.init_db()
    from strategy_hub import service
    started = []
    for exchange, (_total, enabled) in service.exchange_counts().items():
        if enabled > 0 and exchange in EXCHANGES and not manually_stopped(exchange):
            try:
                start_process(exchange)
                started.append(exchange)
            except Exception:
                logger.exception("hub autostart failed for %s", exchange)
    return started


def shutdown_all():
    """Platform shutdown: stop every process body WITHOUT persisting a manual stop —
    the next boot re-arms whatever is still enabled (autostart_from_db)."""
    for exchange in list(_processes):
        try:
            _processes[exchange].stop(persist_manual=False)
        except Exception:
            logger.exception("hub shutdown failed for %s", exchange)
