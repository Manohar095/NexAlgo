# -*- coding: utf-8 -*-
"""
strategy/trading_engine.py
============================
This is the original FlattradeBot (v3, SL-based exit) strategy logic,
refactored so every symbol gets its own fully independent instance:
own Renko engine, own position/SL/pending-order state, own worker
thread, own squareoff scheduler, own periodic safety-net thread, own
log stream.

STRATEGY LOGIC IS UNCHANGED. Only the following were mechanical
refactors to support multiple simultaneous symbols:
  - All former global constants (SYMBOL, BRICK_SIZE, TRADE_MODE, ...)
    now come from self.cfg (a SymbolConfig).
  - The single shared `api` object is now `self.broker`, a shared
    BrokerSession — but every symbol still has its OWN pending/SL/
    position state, so nothing about the trading behaviour changes.
  - Thread loops now check a per-instance stop_event so a symbol can
    be cleanly Stopped/Restarted without touching any other symbol.
  - Logging now also feeds a per-instance ring buffer + optional
    callback, so the dashboard can show live per-symbol logs.
"""

import logging
import threading
import time
from collections import deque
from datetime import datetime
from queue import Queue, Empty

import pytz

from strategy.renko import LiveRenko


class TradingEngine:
    """One fully independent Renko strategy instance for one symbol."""

    def __init__(self, instance_id, cfg, broker, on_log=None, on_status=None):
        self.id     = instance_id
        self.cfg    = cfg          # models.symbol_config.SymbolConfig
        self.broker = broker       # strategy.broker.BrokerSession (shared)
        self.on_log = on_log       # callback(instance_id, level, message)
        self.on_status = on_status # callback(instance_id, status_dict)

        self.renko = LiveRenko(cfg.brick_size, cfg.green_to_red_rev, cfg.red_to_green_rev)

        # ---- Trading state (identical fields to the original bot) ----
        self.position_qty     = 0
        self.pending_order_id = None
        self.pending_side     = None

        self.deferred_order   = None
        self.deferred_for_oid = None

        self.sl_order_id      = None
        self.sl_trigger_price = None
        self.sl_limit_price   = None

        self.entry_price      = None

        self._skip_next_sync = False

        self.trades_blocked       = False
        self.squareoff_completed  = False
        self.squareoff_done_today = False
        self.squareoff_check_date = None

        self.last_ltp = None
        self.last_brick = None  # {"color":..,"brick_no":..,"brick_price":..}
        self.last_updated = None

        self.status = "STOPPED"  # STOPPED | RUNNING | ERROR

        self.state_lock  = threading.Lock()
        self.order_queue = Queue()
        self.last_sync_time = 0

        self.log_buffer = deque(maxlen=500)

        self._stop_event = threading.Event()
        self._threads = []

        self._log("INFO", f"Instance created for {cfg.exchange}:{cfg.trading_symbol}")

    # ================= LOGGING (per-instance) =================
    def _log(self, level, message):
        ts = datetime.now().strftime("%H:%M:%S")
        entry = {"time": ts, "level": level, "message": message}
        self.log_buffer.append(entry)
        getattr(logging, level.lower(), logging.info)(f"[{self.cfg.strategy_name}] {message}")
        if self.on_log:
            try:
                self.on_log(self.id, entry)
            except Exception:
                pass

    def _push_status(self):
        self.last_updated = datetime.now().strftime("%H:%M:%S")
        if self.on_status:
            try:
                self.on_status(self.id, self.get_status())
            except Exception:
                pass

    def get_status(self):
        return {
            "id": self.id,
            "strategy_name": self.cfg.strategy_name,
            "exchange": self.cfg.exchange,
            "trading_symbol": self.cfg.trading_symbol,
            "status": self.status,
            "broker_status": "CONNECTED" if self.broker._logged_in else "DISCONNECTED",
            "ltp": self.last_ltp,
            "brick": self.last_brick,
            "trend": self.renko.trend,
            "position_qty": self.position_qty,
            "entry_price": self.entry_price,
            "sl_trigger_price": self.sl_trigger_price,
            "quantity": self.cfg.quantity,
            "trade_mode": self.cfg.trade_mode,
            "trades_blocked": self.trades_blocked,
            "last_updated": self.last_updated,
        }

    # ================= LIFECYCLE =================
    def start(self):
        if self.status == "RUNNING":
            self._log("WARNING", "Start requested but already running")
            return

        self._stop_event.clear()
        self.status = "RUNNING"

        self.broker.register_feed(self.cfg.exchange, self.cfg.token, self.feed_handler)
        self.broker.register_order_handler(self.cfg.exchange, self.cfg.trading_symbol, self.order_handler)
        self.broker.start_websocket()  # no-op if already started

        self._threads = [
            threading.Thread(target=self._order_worker, daemon=True, name=f"{self.id}-worker"),
            threading.Thread(target=self._squareoff_monitor, daemon=True, name=f"{self.id}-squareoff"),
            threading.Thread(target=self._periodic_state_check, daemon=True, name=f"{self.id}-safetynet"),
        ]
        for t in self._threads:
            t.start()

        self.sync_state()
        self._log("INFO", f"🤖 Started | {self.cfg.exchange}:{self.cfg.trading_symbol} | Mode: {self.cfg.trade_mode}")
        self._push_status()

    def stop(self):
        if self.status == "STOPPED":
            self._log("WARNING", "Stop requested but already stopped")
            return

        self._stop_event.set()
        self.broker.unregister_feed(self.cfg.exchange, self.cfg.token)
        self.broker.unregister_order_handler(self.cfg.exchange, self.cfg.trading_symbol)

        # Drain any queued orders so the worker doesn't act after we say stopped
        with self.order_queue.mutex:
            self.order_queue.queue.clear()

        for t in self._threads:
            t.join(timeout=3)
        self._threads = []

        self.status = "STOPPED"
        self._log("INFO", "🛑 Stopped (open positions/orders at the broker are left untouched)")
        self._push_status()

    def restart(self):
        self._log("INFO", "🔄 Restarting...")
        self.stop()
        time.sleep(0.5)
        self.start()

    # ================= TIME UTILITIES =================
    def _get_current_time(self):
        return datetime.now(pytz.timezone('Asia/Kolkata'))

    def _is_squareoff_time(self):
        current = self._get_current_time()
        squareoff_dt = current.replace(
            hour=self.cfg.squareoff_hour,
            minute=self.cfg.squareoff_minute,
            second=0, microsecond=0
        )
        return current >= squareoff_dt

    # ================= PRICE ROUNDING =================
    def _round_price(self, price):
        return round(round(float(price) / self.cfg.tick_size) * self.cfg.tick_size, 2)

    def _round_tick(self, price):
        if price is None or price <= 0:
            return self.cfg.tick_size
        return round(round(float(price) / self.cfg.tick_size) * self.cfg.tick_size, 2)

    def _marketable_limit(self, side, ltp):
        if ltp is None or ltp <= 0:
            return self.cfg.tick_size
        buffer = self.cfg.sl_lmt_buffer
        if side == "B":
            return self._round_tick(ltp + buffer)
        return self._round_tick(ltp - buffer)

    def _get_squareoff_ltp(self):
        if self.last_ltp and self.last_ltp > 0:
            self._log("INFO", f"📊 Using stored LTP for squareoff: {self.last_ltp}")
            return self.last_ltp
        try:
            market_data = self.broker.get_quotes(exchange=self.cfg.exchange, token=self.cfg.token)
            if market_data and market_data.get("lp"):
                ltp = float(market_data["lp"])
                self._log("INFO", f"📊 Fallback quote LTP = {ltp}")
                return ltp
        except Exception as e:
            self._log("WARNING", f"⚠️ Could not fetch current price: {e}")
        if self.renko.last_close:
            self._log("INFO", f"📊 Using Renko last_close for squareoff: {self.renko.last_close}")
            return self.renko.last_close
        return None

    def _validate_squareoff(self, initial_position):
        self._log("INFO", "🔍 Validating squareoff...")
        time.sleep(3)
        self.sync_state()
        if self.position_qty == 0:
            self._log("INFO", "✅ Squareoff validated: Position closed successfully")
            return True
        self._log("WARNING", f"⚠️ Position still open after squareoff: qty={self.position_qty} (was {initial_position})")
        return False

    # ================= STATE SYNC =================
    def sync_state(self):
        if self._skip_next_sync:
            self._skip_next_sync = False
            return

        now = time.time()
        if now - self.last_sync_time < 1:
            return
        self.last_sync_time = now

        try:
            orders = self.broker.get_order_book()
            self.pending_order_id = None
            self.pending_side     = None
            self.sl_order_id      = None
            self.sl_trigger_price = None
            self.sl_limit_price   = None

            if orders:
                for o in orders:
                    if not (o.get("tsym") == self.cfg.trading_symbol and o.get("exch") == self.cfg.exchange):
                        continue
                    if o.get("status", "").upper() not in ["OPEN", "TRIGGER_PENDING"]:
                        continue

                    if o.get("remarks") == "RENKO_SL":
                        self.sl_order_id      = o.get("norenordno")
                        self.sl_trigger_price = float(o.get("trgprc", 0) or 0)
                        self.sl_limit_price   = float(o.get("prc", 0) or 0)
                    else:
                        self.pending_order_id = o.get("norenordno")
                        self.pending_side     = o.get("trantype")

            positions = self.broker.get_positions()
            self.position_qty = 0
            if positions:
                for p in positions:
                    if p.get("tsym") == self.cfg.trading_symbol and p.get("exch") == self.cfg.exchange:
                        self.position_qty = int(p.get("netqty", 0))
                        break

            self._log(
                "INFO",
                f"🔄 Sync → Position Qty: {self.position_qty}, Pending: {self.pending_order_id} "
                f"({self.pending_side}), SL: {self.sl_order_id} (trigger={self.sl_trigger_price})"
            )
            self._push_status()
        except Exception as e:
            self._log("ERROR", f"Sync error → {e}")

    # ================= SQUAREOFF MONITOR =================
    def _squareoff_monitor(self):
        while not self._stop_event.is_set():
            try:
                current = self._get_current_time()
                current_date = current.date()

                if self.squareoff_check_date != current_date:
                    self._log("INFO", f"📅 New day ({current_date}) detected → resetting squareoff state")
                    self.squareoff_completed = False
                    self.squareoff_done_today = False
                    self.squareoff_check_date = current_date

                    if not self._is_squareoff_time():
                        self.trades_blocked = False
                        self._log("INFO", "🔓 Trades unblocked for new day")
                    else:
                        self._log("WARNING", "⚠️ Started after squareoff time - marking as done")
                        self.squareoff_completed = True
                        self.squareoff_done_today = True
                        self.trades_blocked = True

                if (self._is_squareoff_time() and
                        not self.squareoff_done_today and
                        not self.squareoff_completed):

                    self._log("INFO", f"⏰ Squareoff time reached ({current.strftime('%H:%M')}) → initiating squareoff...")
                    with self.state_lock:
                        self.trades_blocked = True
                        self._execute_squareoff()

                    self.squareoff_completed = True
                    self.squareoff_done_today = True
                    self._log("INFO", f"✅ Squareoff completed for {current_date}")

                if self.squareoff_done_today:
                    self.trades_blocked = True

            except Exception as e:
                self._log("ERROR", f"Squareoff monitor error → {e}")

            self._stop_event.wait(30)

    def _execute_squareoff(self):
        try:
            self.sync_state()

            if self.sl_order_id:
                self._log("INFO", f"🗑️ Cancelling SL before squareoff: {self.sl_order_id}")
                self._cancel_order_direct(self.sl_order_id)
                time.sleep(1)

            if self.position_qty == 0:
                self._log("INFO", "📭 No open positions to square off")
                return

            initial_position = self.position_qty
            side = "S" if self.position_qty > 0 else "B"
            qty = abs(self.position_qty)

            ltp = self._get_squareoff_ltp()
            if ltp is None or ltp <= 0:
                self._log("ERROR", f"❌ Cannot squareoff — no valid LTP. Position qty={self.position_qty} remains OPEN.")
                return

            limit_px = self._marketable_limit(side, ltp)
            self._log("INFO", f"📤 SQUAREOFF | side={side}, qty={qty}, ltp={ltp:.2f}, limit={limit_px:.2f}")

            response = self.broker.place_order(
                buy_or_sell=side,
                product_type=self.cfg.product_type.value,
                exchange=self.cfg.exchange,
                tradingsymbol=self.cfg.trading_symbol,
                quantity=qty,
                discloseqty=0,
                price_type='LMT',
                price=limit_px,
                trigger_price=0.0,
                retention='DAY',
                remarks='api_order'
            )
            self._log("INFO", f"📤 Squareoff Order Response → {response}")

            if response and response.get("stat") == "Ok":
                self.pending_order_id = response.get("norenordno")
                self.pending_side = side
                self._log("INFO", f"✅ Squareoff LMT order placed. Order ID: {self.pending_order_id}")
                self._validate_squareoff(initial_position)
            else:
                self._log("ERROR", "❌ Squareoff order failed — position may still be open")

        except Exception as e:
            self._log("ERROR", f"Squareoff execution error → {e}")

    # ================= PERIODIC STATE CHECK (safety net) =================
    def _periodic_state_check(self):
        """
        Runs every 5s while the symbol is active. Unlike the old version,
        this ALWAYS reconciles from the broker first (sync_state() has its
        own internal 1s throttle, so this is cheap) rather than only
        syncing when local state already looked stale by some specific
        pattern. That distinction matters: if a WebSocket order-update
        message is ever dropped (broker-side blip, network hiccup — rare
        but real), local state can silently diverge from the broker's
        truth in ways that don't match any single "known bad" pattern —
        e.g. an SL that actually filled, but whose COMPLETE message never
        arrived, leaves position_qty/sl_order_id looking perfectly
        self-consistent locally (a nonzero position with a live SL id)
        while being completely wrong. The old guard clauses would never
        even look at the broker in that case. Syncing unconditionally
        means the broker is always the source of truth within one cycle
        (≤5s), not just at restart.
        """
        while not self._stop_event.is_set():
            if self._stop_event.wait(5):
                break
            if self.trades_blocked:
                continue
            with self.state_lock:
                prev_position = self.position_qty
                prev_sl       = self.sl_order_id
                prev_pending  = self.pending_order_id

                self.sync_state()

                drifted = (
                    prev_position != self.position_qty
                    or prev_sl != self.sl_order_id
                    or prev_pending != self.pending_order_id
                )
                if drifted:
                    self._log(
                        "WARNING",
                        f"🔧 State drift corrected from broker → "
                        f"position {prev_position}→{self.position_qty}, "
                        f"SL {prev_sl}→{self.sl_order_id}, "
                        f"pending {prev_pending}→{self.pending_order_id}"
                    )

                # ── Pending entry cleared at the broker while we had a deferred order queued ──
                if prev_pending and not self.pending_order_id and self.deferred_order:
                    self._log("INFO", "🔄 Periodic check: pending cleared → replaying deferred")
                    deferred = self.deferred_order
                    self.deferred_order   = None
                    self.deferred_for_oid = None
                    self.order_queue.put({
                        "type":    "PLACE",
                        "side":    deferred["side"],
                        "trigger": deferred["trigger"],
                        "limit":   deferred["limit"]
                    })

                # ── Position open at the broker but no SL and no pending order ──
                # Covers both the original case (entry-fill callback missed,
                # never got an SL in the first place) AND the drift case
                # above (old SL id turned out to be stale/filled, sync
                # already cleared it, position is confirmed still open).
                elif (self.position_qty != 0
                        and not self.sl_order_id
                        and not self.pending_order_id):
                    self._log("WARNING", "🚨 SAFETY NET: pos open but no SL/pending → recomputing SL from current level")
                    ref_price = self.renko.last_close
                    if ref_price is not None:
                        if self.position_qty > 0:
                            sl_trigger = self._round_price(ref_price - self.cfg.sl_brick_multiplier * self.cfg.brick_size)
                            sl_side = "S"
                        else:
                            sl_trigger = self._round_price(ref_price + self.cfg.sl_brick_multiplier * self.cfg.brick_size)
                            sl_side = "B"
                        self._place_sl_order(sl_side, sl_trigger, abs(self.position_qty))
                    else:
                        self._log("ERROR", "🚨 SAFETY NET: cannot compute SL — renko.last_close is None")

    # ================= ORDER WORKER =================
    def _order_worker(self):
        while not self._stop_event.is_set():
            try:
                task = self.order_queue.get(timeout=1)
            except Empty:
                continue
            try:
                if task["type"] == "PLACE":
                    if self.trades_blocked or self._is_squareoff_time():
                        self._log("INFO", "⛔ Trades blocked → skipping order placement")
                        continue
                    self._place_order(task)
                elif task["type"] == "CANCEL":
                    self._cancel_order_direct(task["order_id"])
                elif task["type"] == "MODIFY_SL":
                    self._modify_sl_order(task["new_trigger"])
            except Exception as e:
                self._log("ERROR", f"Order worker error → {e}")
            finally:
                self.order_queue.task_done()

    # ================= PLACE ORDER (fresh entries only) =================
    def _place_order(self, data):
        side    = data["side"]
        limit   = self._round_price(data["limit"])
        trigger = self._round_price(data["trigger"])

        with self.state_lock:
            self.sync_state()

            if self.trades_blocked:
                self._log("INFO", "⛔ Trades blocked → skipping order")
                return

            if self.position_qty != 0:
                self._log("INFO", f"🚫 {side} skipped → position_qty={self.position_qty} (exits handled by trailing SL)")
                return

            mode = self.cfg.trade_mode
            if side == "B" and mode not in ("LONG_ONLY", "LONG_SHORT"):
                self._log("INFO", f"🚫 BUY skipped → mode={mode}")
                return
            if side == "S" and mode not in ("SHORT_ONLY", "LONG_SHORT"):
                self._log("INFO", f"🚫 SELL skipped → mode={mode}")
                return

            order_qty = self.cfg.quantity
            self._log("INFO", f"{'🟢 BUY' if side == 'B' else '🔴 SELL'} FRESH ENTRY | qty={order_qty}")

            if self.pending_order_id:
                if self.pending_side == side:
                    self._log("INFO", "⛔ Same-side pending exists → skip")
                    return
                self._log("INFO", f"🔄 Opposite pending → cancelling {self.pending_order_id}, deferring {side} order")
                self.deferred_order = {"side": side, "trigger": trigger, "limit": limit}
                self.deferred_for_oid = self.pending_order_id
                self._cancel_order_direct(self.pending_order_id)
                return

            try:
                response = self.broker.place_order(
                    buy_or_sell=side,
                    product_type=self.cfg.product_type.value,
                    exchange=self.cfg.exchange,
                    tradingsymbol=self.cfg.trading_symbol,
                    quantity=order_qty,
                    discloseqty=0,
                    price_type='SL-LMT',
                    price=limit,
                    trigger_price=trigger,
                    retention='DAY',
                    remarks='api_order'
                )
                self._log("INFO", f"📤 Order Response → {response}")

                if response and response.get("stat") == "Ok":
                    self.pending_order_id = response.get("norenordno")
                    self.pending_side     = side

            except Exception as e:
                self._log("ERROR", f"Order error → {e}")
                self.deferred_order   = None
                self.deferred_for_oid = None

    # ================= PLACE SL ORDER =================
    def _place_sl_order(self, sl_side, trigger_price, qty):
        if self.sl_order_id:
            self._log("INFO", f"⛔ SL order already exists ({self.sl_order_id}) → not placing another")
            return

        trigger = self._round_price(trigger_price)
        if trigger <= 0:
            self._log("ERROR", f"❌ Invalid SL trigger price: {trigger_price}")
            return

        offset = self.cfg.sl_limit_offset or self.cfg.tick_size
        if sl_side == "S":
            limit = self._round_price(trigger - offset)
        else:
            limit = self._round_price(trigger + offset)

        self._log("INFO", f"📤 PLACING SL | side={sl_side} trigger={trigger:.2f} limit={limit:.2f} qty={qty}")

        try:
            response = self.broker.place_order(
                buy_or_sell=sl_side,
                product_type=self.cfg.product_type.value,
                exchange=self.cfg.exchange,
                tradingsymbol=self.cfg.trading_symbol,
                quantity=qty,
                discloseqty=0,
                price_type='SL-LMT',
                price=limit,
                trigger_price=trigger,
                retention='DAY',
                remarks='RENKO_SL'
            )
            self._log("INFO", f"📤 SL Order Response → {response}")

            if response and response.get("stat") == "Ok":
                self.sl_order_id      = response.get("norenordno")
                self.sl_trigger_price = trigger
                self.sl_limit_price   = limit
                self._log("INFO", f"✅ SL Placed | oid={self.sl_order_id} trigger={trigger:.2f}")
            else:
                self._log("ERROR", f"📤 SL Order FAILED ❌ | emsg={response.get('emsg') if response else None}")

        except Exception as e:
            self._log("ERROR", f"SL order exception → {e}")

    # ================= TRAIL SL (tighten-only) =================
    def _modify_sl_order(self, new_trigger):
        if not self.sl_order_id or self.position_qty == 0:
            return

        new_trigger = self._round_price(new_trigger)
        offset = self.cfg.sl_limit_offset or self.cfg.tick_size

        if self.position_qty > 0:
            if self.sl_trigger_price is not None and new_trigger <= self.sl_trigger_price:
                return
            new_limit = self._round_price(new_trigger - offset)
        else:
            if self.sl_trigger_price is not None and new_trigger >= self.sl_trigger_price:
                return
            new_limit = self._round_price(new_trigger + offset)

        try:
            self._log("INFO", f"🔧 Trailing SL | oid={self.sl_order_id} | {self.sl_trigger_price or 0:.2f} → {new_trigger:.2f}")

            response = self.broker.modify_order(
                exchange=self.cfg.exchange,
                tradingsymbol=self.cfg.trading_symbol,
                orderno=str(self.sl_order_id),
                newquantity=str(abs(self.position_qty)),
                newprice_type='SL-LMT',
                newprice=str(new_limit),
                newtrigger_price=str(new_trigger)
            )

            if response and response.get("stat") == "Ok":
                self.sl_trigger_price = new_trigger
                self.sl_limit_price   = new_limit
                self._log("INFO", f"🔧 SL Trailed ✅ | new trigger={new_trigger:.2f}")
            else:
                self._log("ERROR", f"🔧 Modify SL FAILED ❌ | {response}")
        except Exception as e:
            self._log("ERROR", f"Modify SL exception → {e}")

    # ================= CANCEL ORDER =================
    def _cancel_order_direct(self, order_id):
        try:
            response = self.broker.cancel_order(orderno=str(order_id))
            self._log("INFO", f"❌ Order Cancel Request → {response}")

            if response and response.get("stat") == "Ok":
                if order_id == self.sl_order_id:
                    self.sl_order_id      = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
            else:
                self._log("WARNING", f"⚠️ Cancel request may have failed → {response}")
                if self.deferred_for_oid == order_id:
                    self.deferred_order   = None
                    self.deferred_for_oid = None
                    self.pending_order_id = None
                    self.pending_side     = None

        except Exception as e:
            self._log("ERROR", f"Cancel error → {e}")
            if self.deferred_for_oid == order_id:
                self.deferred_order   = None
                self.deferred_for_oid = None
                self.pending_order_id = None
                self.pending_side     = None

    # ================= ORDER CALLBACK =================
    def order_handler(self, msg):
        status  = msg.get("status", "").upper()
        oid     = msg.get("norenordno")
        remarks = msg.get("remarks", "")

        self._log("INFO", f"📨 Order Update → oid={oid}, status={status}, remarks={remarks}")

        should_replay = None

        with self.state_lock:
            if status == "COMPLETE":
                tran       = msg.get("trantype")
                filled_qty = int(msg.get("fillshares", self.cfg.quantity))
                fill_price = float(msg.get("flprc", 0) or 0)

                if tran == "B":
                    self.position_qty += filled_qty
                else:
                    self.position_qty -= filled_qty

                if remarks == "RENKO_SL":
                    self.sl_order_id      = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
                    self.entry_price      = None
                    self._log("INFO", f"🛑 SL HIT → trantype={tran}, filled={filled_qty}, fill_price={fill_price}, new position_qty={self.position_qty}")

                else:
                    self.pending_order_id = None
                    self.pending_side     = None

                    if self.deferred_for_oid == oid and self.deferred_order:
                        self._log("WARNING", "⚠️ Order filled before cancel landed → re-evaluating deferred")
                        should_replay         = self.deferred_order
                        self.deferred_order   = None
                        self.deferred_for_oid = None

                    self._log("INFO", f"✅ Order COMPLETE → trantype={tran}, filled={filled_qty}, fill_price={fill_price}, new position_qty={self.position_qty}")

                    if remarks == "api_order" and self.position_qty != 0:
                        ref_price = fill_price if fill_price > 0 else self.renko.last_close
                        if ref_price:
                            self.entry_price = fill_price if fill_price > 0 else ref_price
                            if self.position_qty > 0:
                                sl_trigger = self._round_price(ref_price - self.cfg.sl_brick_multiplier * self.cfg.brick_size)
                                sl_side = "S"
                            else:
                                sl_trigger = self._round_price(ref_price + self.cfg.sl_brick_multiplier * self.cfg.brick_size)
                                sl_side = "B"
                            self._log("INFO", f"🛡️ Entry filled → placing SL | side={sl_side} trigger={sl_trigger:.2f}")
                            self._place_sl_order(sl_side, sl_trigger, abs(self.position_qty))
                        else:
                            self._log("ERROR", "❌ Cannot compute SL — no fill_price and renko.last_close is None")

            elif status == "REJECTED":
                reject_reason = msg.get("rejreason", "Unknown reason")
                self._log("ERROR", f"🚫 Order REJECTED → oid={oid}, reason={reject_reason}")

                if remarks == "RENKO_SL":
                    self.sl_order_id      = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
                else:
                    self.pending_order_id = None
                    self.pending_side     = None
                    if self.deferred_for_oid == oid and self.deferred_order:
                        should_replay         = self.deferred_order
                        self.deferred_order   = None
                        self.deferred_for_oid = None

            elif status == "CANCELLED":
                self._log("INFO", f"❌ Order CANCELLED → oid={oid}")
                if remarks == "RENKO_SL":
                    self.sl_order_id      = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
                else:
                    self.pending_order_id = None
                    self.pending_side     = None
                    if self.deferred_for_oid == oid and self.deferred_order:
                        should_replay         = self.deferred_order
                        self.deferred_order   = None
                        self.deferred_for_oid = None

            elif status == "TRIGGER_PENDING":
                self._log("INFO", f"⏳ TRIGGER PENDING → oid={oid}, remarks={remarks}")

            elif status == "OPEN":
                self._log("INFO", f"📬 Order OPEN → oid={oid}, remarks={remarks}")

            else:
                self._log("WARNING", f"⚠️ Unknown order status → oid={oid}, status={status}")

            self._skip_next_sync = True

        self._push_status()

        if should_replay and not self.trades_blocked:
            self._log("INFO", f"▶️ Replaying deferred {should_replay['side']} order")
            self.place_order(should_replay["side"], should_replay["trigger"], should_replay["limit"])

    # ================= FEED CALLBACK =================
    def feed_handler(self, msg):
        if "lp" not in msg or self._stop_event.is_set():
            return

        ltp = float(msg["lp"])
        self.last_ltp = ltp

        bricks = self.renko.process_price(ltp)
        if not bricks:
            return

        for brick in bricks:
            self.last_brick = brick
            self._log("INFO", f"{self.cfg.trading_symbol} | {brick} | LTP: {ltp:.2f}")

            if self.trades_blocked:
                continue

            color       = brick["color"]
            brick_no    = brick["brick_no"]
            brick_price = brick["brick_price"]

            # ===== CANCEL PENDING ENTRY ON HARD REVERSAL =====
            with self.state_lock:
                if self.pending_order_id and self.pending_order_id != self.deferred_for_oid:
                    if (self.pending_side == "B" and color == "Red"
                            and brick_no <= self.cfg.buy_order_cancel_brick_no):
                        self._log("INFO", f"🔄 Hard reversal → Cancel pending BUY ({self.pending_order_id})")
                        self.cancel_order(self.pending_order_id)
                    elif (self.pending_side == "S" and color == "Green"
                            and brick_no >= self.cfg.sell_order_cancel_brick_no):
                        self._log("INFO", f"🔄 Hard reversal → Cancel pending SELL ({self.pending_order_id})")
                        self.cancel_order(self.pending_order_id)

            # ===== TRAIL SL EVERY BRICK WHILE POSITION OPEN =====
            if self.position_qty != 0:
                if self.position_qty > 0:
                    candidate_trigger = brick_price - (self.cfg.sl_brick_multiplier * self.cfg.brick_size)
                else:
                    candidate_trigger = brick_price + (self.cfg.sl_brick_multiplier * self.cfg.brick_size)
                self.trail_sl(candidate_trigger)

            # ===== FRESH ENTRIES ONLY (exits via SL) =====
            if color == "Green" and brick_no == self.cfg.buy_brick_no:
                limit   = round(brick_price + (self.cfg.limit_price_buy_brick_no * self.cfg.brick_size), 2)
                trigger = round(limit - self.cfg.tick_size, 2)

                if self.cfg.trade_mode in ("LONG_ONLY", "LONG_SHORT"):
                    if self.position_qty == 0:
                        self._log("INFO", f"🟢 BUY FRESH Signal | Brick #{brick_no} | limit={limit:.2f}")
                        self.place_order("B", trigger, limit)
                    else:
                        self._log("INFO", f"⏭️ BUY skipped → position_qty={self.position_qty}")

            if color == "Red" and brick_no == self.cfg.sell_brick_no:
                limit   = round(brick_price - (self.cfg.limit_price_sell_brick_no * self.cfg.brick_size), 2)
                trigger = round(limit + self.cfg.tick_size, 2)

                if self.cfg.trade_mode in ("SHORT_ONLY", "LONG_SHORT"):
                    if self.position_qty == 0:
                        self._log("INFO", f"🔴 SELL FRESH Signal | Brick #{brick_no} | limit={limit:.2f}")
                        self.place_order("S", trigger, limit)
                    else:
                        self._log("INFO", f"⏭️ SELL skipped → position_qty={self.position_qty}")

        self._push_status()

    # ================= PUBLIC =================
    def place_order(self, side, trigger, limit):
        if self.trades_blocked:
            return
        self.order_queue.put({"type": "PLACE", "side": side, "trigger": trigger, "limit": limit})

    def cancel_order(self, order_id):
        if self.deferred_for_oid == order_id:
            return
        self.order_queue.put({"type": "CANCEL", "order_id": order_id})

    def trail_sl(self, new_trigger):
        if self.trades_blocked or not self.sl_order_id or self.position_qty == 0:
            return
        self.order_queue.put({"type": "MODIFY_SL", "new_trigger": new_trigger})