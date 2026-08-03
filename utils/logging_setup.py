# -*- coding: utf-8 -*-
"""
utils/logging_setup.py
=========================
Configures the ROOT logger once, at process startup, with two handlers:

1. Console (stdout) — same as before, useful when running in a
   terminal or under `systemd`/PM2 (both capture stdout anyway).
2. Rotating file — every log line (including every TradingEngine's
   per-symbol `_log()` calls, since they go through `logging.info(...)`
   etc.) is also written to logs/renko_platform.log, rotated daily,
   with 30 days of history kept.

This means the 500-entry in-memory ring buffer used by the dashboard
is just a live view — the full history survives a crash or restart on
disk, for post-mortem debugging or compliance/audit purposes.
"""

import logging
import os
from logging.handlers import TimedRotatingFileHandler

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG_DIR  = os.path.join(BASE_DIR, "logs")


def configure_logging(level=logging.INFO, backup_days=30):
    os.makedirs(LOG_DIR, exist_ok=True)

    fmt = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()  # avoid duplicate handlers on reload

    console_handler = logging.StreamHandler()
    console_handler.setFormatter(fmt)
    root.addHandler(console_handler)

    file_handler = TimedRotatingFileHandler(
        filename=os.path.join(LOG_DIR, "renko_platform.log"),
        when="midnight",
        backupCount=backup_days,
        encoding="utf-8",
        utc=False,
    )
    file_handler.setFormatter(fmt)
    file_handler.suffix = "%Y-%m-%d"
    root.addHandler(file_handler)

    logging.info("📝 Logging configured — console + %s (rotated daily, %s days kept)",
                 os.path.join(LOG_DIR, "renko_platform.log"), backup_days)
    return root
