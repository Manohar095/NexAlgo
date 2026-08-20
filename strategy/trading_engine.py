# -*- coding: utf-8 -*-
"""
strategy/trading_engine.py
============================
This is the original FlattradeBot (v3, SL-based exit) strategy logic,
refactored so every symbol gets its own fully independent instance:
own Renko engine, own position/SL/pending-order state, own worker
thread, own squareoff scheduler, own periodic safety-net thread, own
log stream.

LONG_SHORT mode now tracks BUY and SELL pending entries as two fully
INDEPENDENT order slots (pending_buy_*/pending_sell_*) instead of a
single shared pending-order slot. They can coexist (a BUY pending and
a SELL pending resting at the same time), neither cancels the other
just because the opposite signal fires or price retraces through its
own origin brick, and either can fill while the other keeps trailing
— including while a position from the other side's earlier fill is
already open (e.g. SHORT position + BUY pending + SHORT SL is a valid
state). See __init__, sync_state, _place_order,
_modify_pending_entry_order, _cancel_order_direct, order_handler, and
feed_handler for the per-function detail. LONG_ONLY / SHORT_ONLY
behaviour is unchanged.

FIXES APPLIED:
1. Track LONG and SHORT positions separately (long_qty, short_qty) — SL is
   only cancelled when BOTH are zero (truly flat), not just when net is zero.
2. SL quantity is tracked (sl_qty) and updated when position quantity changes.
3. SL remains active when position_qty == 0 due to opposing LONG + SHORT
   positions coexisting (net zero but gross positions exist).
4. last_known_sl_trigger is removed entirely — SL is always calculated fresh
   from entry price or renko.last_close whenever placed or re-armed.
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
        self.cfg    = cfg       # models.symbol_config.SymbolConfig
        self.broker = broker    # strategy.broker.BrokerSession (shared)
        self.on_log = on_log    # callback(instance_id, level, message)
        self.on_status = on_status # callback(instance_id, status_dict)

        self.renko = LiveRenko(cfg.brick_size, cfg.green_to_red_rev, cfg.red_to_green_rev)

        # ---- Trading state ----
        # ── Gross positions (tracked separately for LONG/SHORT) ──
        self.long_qty = 0
        self.short_qty = 0
        self.position_qty = 0  # Derived: long_qty - short_qty

        # ── Independent per-side pending ENTRY order state ──
        self.pending_buy_order_id      = None
        self.pending_buy_trigger_price = None
        self.pending_buy_limit_price   = None
        self.pending_buy_origin_price  = None

        self.pending_sell_order_id      = None
        self.pending_sell_trigger_price = None
        self.pending_sell_limit_price   = None
        self.pending_sell_origin_price  = None

        # Tracks the LMT order squareoff places to flatten an open position
        self.squareoff_order_id = None
        self.squareoff_side     = None

        # ── SL state ──
        self.sl_order_id      = None
        self.sl_side           = None  # "B" (protects SHORT) or "S" (protects LONG)
        self.sl_trigger_price = None
        self.sl_limit_price   = None
        self.sl_qty           = 0      # Current SL quantity

        self.entry_price      = None

        # ── Trend-origin price tracking ──
        self.green0_price = None
        self.red0_price   = None

        self._skip_next_sync = False

        self.trades_blocked       = False
        self.squareoff_completed  = False
        self.squareoff_done_today = False
        self.squareoff_check_date = None

        self.last_ltp = None
        self.last_brick = None
        self.last_updated = None

        self.status = "STOPPED"  # STOPPED | RUNNING | ERROR

        self.state_lock  = threading.Lock()
        self.order_queue = Queue()
        self.last_sync_time = 0

        self.log_buffer = deque(maxlen=500)

        self._stop_event = threading.Event()
        self._threads = []

        self._log("INFO", f"Instance created for {cfg.exchange}:{cfg.trading_symbol}")

    # ================= LOGGING =================
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
            "long_qty": self.long_qty,
            "short_qty": self.short_qty,
            "entry_price": self.entry_price,
            "sl_trigger_price": self.sl_trigger_price,
            "sl_qty": self.sl_qty,
            "quantity": self.cfg.quantity,
            "trade_mode": self.cfg.trade_mode,
            "trades_blocked": self.trades_blocked,
            "last_updated": self.last_updated,
            "pending_buy_order_id": self.pending_buy_order_id,
            "pending_buy_trigger_price": self.pending_buy_trigger_price,
            "pending_sell_order_id": self.pending_sell_order_id,
            "pending_sell_trigger_price": self.pending_sell_trigger_price,
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
        self.broker.start_websocket()

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
            self.pending_buy_order_id      = None
            self.pending_buy_trigger_price = None
            self.pending_buy_limit_price   = None
            self.pending_sell_order_id      = None
            self.pending_sell_trigger_price = None
            self.pending_sell_limit_price   = None
            self.squareoff_order_id = None
            self.squareoff_side     = None
            self.sl_order_id      = None
            self.sl_side           = None
            self.sl_trigger_price = None
            self.sl_limit_price   = None
            self.sl_qty           = 0

            if orders:
                for o in orders:
                    if not (o.get("tsym") == self.cfg.trading_symbol and o.get("exch") == self.cfg.exchange):
                        continue
                    if o.get("status", "").upper() not in ["OPEN", "TRIGGER_PENDING"]:
                        continue

                    if o.get("remarks") == "RENKO_SL":
                        self.sl_order_id      = o.get("norenordno")
                        self.sl_side           = o.get("trantype")
                        self.sl_trigger_price = float(o.get("trgprc", 0) or 0)
                        self.sl_limit_price   = float(o.get("prc", 0) or 0)
                        self.sl_qty           = int(o.get("qty", 0) or 0)
                        continue

                    trantype = o.get("trantype")
                    trg = float(o.get("trgprc", 0) or 0)
                    prc = float(o.get("prc", 0) or 0)

                    if trg == 0:
                        self.squareoff_order_id = o.get("norenordno")
                        self.squareoff_side     = trantype
                        continue

                    if trantype == "B":
                        self.pending_buy_order_id      = o.get("norenordno")
                        self.pending_buy_trigger_price = trg
                        self.pending_buy_limit_price   = prc
                    elif trantype == "S":
                        self.pending_sell_order_id      = o.get("norenordno")
                        self.pending_sell_trigger_price = trg
                        self.pending_sell_limit_price   = prc

            positions = self.broker.get_positions()
            self.long_qty = 0
            self.short_qty = 0
            if positions:
                for p in positions:
                    if p.get("tsym") == self.cfg.trading_symbol and p.get("exch") == self.cfg.exchange:
                        qty = int(p.get("netqty", 0))
                        if qty > 0:
                            self.long_qty = qty
                        elif qty < 0:
                            self.short_qty = -qty
                        break

            self.position_qty = self.long_qty - self.short_qty

            # ── Origin-price snapshot recovery ──
            if not self.pending_buy_order_id:
                self.pending_buy_origin_price = None
            elif self.pending_buy_origin_price is None and self.pending_buy_trigger_price:
                self.pending_buy_origin_price = self._round_price(
                    self.pending_buy_trigger_price + self.cfg.brick_size
                )
                self._log(
                    "WARNING",
                    f"🔧 Recovered missing BUY origin snapshot after restart → "
                    f"approximated at {self.pending_buy_origin_price} from resting trigger {self.pending_buy_trigger_price}"
                )

            if not self.pending_sell_order_id:
                self.pending_sell_origin_price = None
            elif self.pending_sell_origin_price is None and self.pending_sell_trigger_price:
                self.pending_sell_origin_price = self._round_price(
                    self.pending_sell_trigger_price - self.cfg.brick_size
                )
                self._log(
                    "WARNING",
                    f"🔧 Recovered missing SELL origin snapshot after restart → "
                    f"approximated at {self.pending_sell_origin_price} from resting trigger {self.pending_sell_trigger_price}"
                )

            self._log(
                "INFO",
                f"🔄 Sync → Position Qty: {self.position_qty} (LONG:{self.long_qty}, SHORT:{self.short_qty}), "
                f"BUY pending: {self.pending_buy_order_id} (trigger={self.pending_buy_trigger_price}), "
                f"SELL pending: {self.pending_sell_order_id} (trigger={self.pending_sell_trigger_price}), "
                f"SL: {self.sl_order_id} (trigger={self.sl_trigger_price}, qty={self.sl_qty})"
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

            if self.pending_buy_order_id:
                self._log("INFO", f"🗑️ Cancelling pending BUY before squareoff: {self.pending_buy_order_id}")
                self._cancel_order_direct(self.pending_buy_order_id)
                self.pending_buy_order_id      = None
                self.pending_buy_trigger_price = None
                self.pending_buy_limit_price   = None
                self.pending_buy_origin_price  = None
                time.sleep(1)

            if self.pending_sell_order_id:
                self._log("INFO", f"🗑️ Cancelling pending SELL before squareoff: {self.pending_sell_order_id}")
                self._cancel_order_direct(self.pending_sell_order_id)
                self.pending_sell_order_id      = None
                self.pending_sell_trigger_price = None
                self.pending_sell_limit_price   = None
                self.pending_sell_origin_price  = None
                time.sleep(1)

            if self.long_qty == 0 and self.short_qty == 0:
                self._log("INFO", "📭 No open positions to square off")
                return

            if self.position_qty > 0:
                side = "S"
                qty = self.position_qty
            elif self.position_qty < 0:
                side = "B"
                qty = -self.position_qty
            else:
                if self.long_qty > 0:
                    side = "S"
                    qty = self.long_qty
                elif self.short_qty > 0:
                    side = "B"
                    qty = self.short_qty
                else:
                    return

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
                self.squareoff_order_id = response.get("norenordno")
                self.squareoff_side = side
                self._log("INFO", f"✅ Squareoff LMT order placed. Order ID: {self.squareoff_order_id}")
                time.sleep(3)
                self.sync_state()
                if self.long_qty == 0 and self.short_qty == 0:
                    self._log("INFO", "✅ Squareoff validated: Position closed successfully")
                else:
                    self._log("WARNING", f"⚠️ Position still open after squareoff: LONG={self.long_qty}, SHORT={self.short_qty}")
            else:
                self._log("ERROR", "❌ Squareoff order failed — position may still be open")

        except Exception as e:
            self._log("ERROR", f"Squareoff execution error → {e}")

    # ================= PERIODIC STATE CHECK (safety net) =================
    def _periodic_state_check(self):
        while not self._stop_event.is_set():
            if self._stop_event.wait(5):
                break
            if self.trades_blocked:
                continue
            with self.state_lock:
                prev_position     = self.position_qty
                prev_sl           = self.sl_order_id
                prev_sl_qty       = self.sl_qty
                prev_pending_buy  = self.pending_buy_order_id
                prev_pending_sell = self.pending_sell_order_id

                self.sync_state()

                drifted = (
                    prev_position != self.position_qty
                    or prev_sl != self.sl_order_id
                    or prev_sl_qty != self.sl_qty
                    or prev_pending_buy != self.pending_buy_order_id
                    or prev_pending_sell != self.pending_sell_order_id
                )
                if drifted:
                    self._log(
                        "WARNING",
                        f"🔧 State drift corrected from broker → "
                        f"position {prev_position}→{self.position_qty}, "
                        f"SL {prev_sl}→{self.sl_order_id} (qty {prev_sl_qty}→{self.sl_qty}), "
                        f"BUY pending {prev_pending_buy}→{self.pending_buy_order_id}, "
                        f"SELL pending {prev_pending_sell}→{self.pending_sell_order_id}"
                    )

                self._reconcile_sl_for_position()

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
                    self._modify_sl_order(task["new_trigger"], task.get("new_qty"))
                elif task["type"] == "MODIFY_PENDING_ENTRY":
                    self._modify_pending_entry_order(task["side"], task["new_trigger"], task["new_limit"])
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

            mode = self.cfg.trade_mode

            if mode != "LONG_SHORT" and self.position_qty != 0:
                self._log("INFO", f"🚫 {side} skipped → position_qty={self.position_qty} (exits handled by trailing SL)")
                return

            if side == "B" and mode not in ("LONG_ONLY", "LONG_SHORT"):
                self._log("INFO", f"🚫 BUY skipped → mode={mode}")
                return
            if side == "S" and mode not in ("SHORT_ONLY", "LONG_SHORT"):
                self._log("INFO", f"🚫 SELL skipped → mode={mode}")
                return

            if side == "B" and self.pending_buy_order_id:
                self._log("INFO", "⛔ BUY pending already exists → skip")
                return
            if side == "S" and self.pending_sell_order_id:
                self._log("INFO", "⛔ SELL pending already exists → skip")
                return

            order_qty = self.cfg.quantity
            self._log("INFO", f"{'🟢 BUY' if side == 'B' else '🔴 SELL'} FRESH ENTRY | qty={order_qty}")

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
                    if side == "B":
                        self.pending_buy_order_id      = response.get("norenordno")
                        self.pending_buy_trigger_price = trigger
                        self.pending_buy_limit_price   = limit
                        self.pending_buy_origin_price  = self.green0_price
                        self._log("INFO", f"📍 BUY entry-trail origin snapshot: Green Brick #0 = {self.green0_price}")
                    else:
                        self.pending_sell_order_id      = response.get("norenordno")
                        self.pending_sell_trigger_price = trigger
                        self.pending_sell_limit_price   = limit
                        self.pending_sell_origin_price  = self.red0_price
                        self._log("INFO", f"📍 SELL entry-trail origin snapshot: Red Brick #0 = {self.red0_price}")

            except Exception as e:
                self._log("ERROR", f"Order error → {e}")

    # ================= PLACE SL ORDER =================
    def _place_sl_order(self, sl_side, trigger_price, qty):
        if self.sl_order_id:
            self._log("INFO", f"⛔ SL order already exists ({self.sl_order_id}) → not placing another")
            return

        trigger = self._round_price(trigger_price)
        if trigger <= 0:
            self._log("ERROR", f"❌ Invalid SL trigger price: {trigger_price}")
            return

        offset = self.cfg.limit_offset or self.cfg.tick_size
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
                self.sl_side          = sl_side
                self.sl_trigger_price = trigger
                self.sl_limit_price   = limit
                self.sl_qty           = qty
                self._log("INFO", f"✅ SL Placed | oid={self.sl_order_id} trigger={trigger:.2f} qty={qty}")
            else:
                self._log("ERROR", f"📤 SL Order FAILED ❌ | emsg={response.get('emsg') if response else None}")

        except Exception as e:
            self._log("ERROR", f"SL order exception → {e}")

    # ================= TRAIL SL (tighten-only) =================
    def _modify_sl_order(self, new_trigger, new_qty=None):
        if not self.sl_order_id or self.position_qty == 0:
            return

        new_trigger = self._round_price(new_trigger)
        offset = self.cfg.limit_offset or self.cfg.tick_size

        if self.position_qty > 0:
            if self.sl_trigger_price is not None and new_trigger <= self.sl_trigger_price:
                return
            new_limit = self._round_price(new_trigger - offset)
        else:
            if self.sl_trigger_price is not None and new_trigger >= self.sl_trigger_price:
                return
            new_limit = self._round_price(new_trigger + offset)

        qty_to_use = new_qty if new_qty is not None else abs(self.position_qty)

        try:
            self._log("INFO", f"🔧 Trailing SL | oid={self.sl_order_id} | {self.sl_trigger_price or 0:.2f} → {new_trigger:.2f} | qty {self.sl_qty}→{qty_to_use}")

            response = self.broker.modify_order(
                exchange=self.cfg.exchange,
                tradingsymbol=self.cfg.trading_symbol,
                orderno=str(self.sl_order_id),
                newquantity=str(qty_to_use),
                newprice_type='SL-LMT',
                newprice=str(new_limit),
                newtrigger_price=str(new_trigger)
            )

            if response and response.get("stat") == "Ok":
                self.sl_trigger_price = new_trigger
                self.sl_limit_price   = new_limit
                self.sl_qty           = qty_to_use
                self._log("INFO", f"🔧 SL Trailed ✅ | new trigger={new_trigger:.2f} qty={qty_to_use}")
            else:
                self._log("ERROR", f"🔧 Modify SL FAILED ❌ | {response}")
        except Exception as e:
            self._log("ERROR", f"Modify SL exception → {e}")

    # ================= TRAIL PENDING ENTRY ORDER =================
    def _modify_pending_entry_order(self, side, new_trigger, new_limit):
        if side == "B":
            order_id = self.pending_buy_order_id
            current_trigger = self.pending_buy_trigger_price
            current_limit   = self.pending_buy_limit_price
        elif side == "S":
            order_id = self.pending_sell_order_id
            current_trigger = self.pending_sell_trigger_price
            current_limit   = self.pending_sell_limit_price
        else:
            return

        if not order_id:
            return

        new_trigger = self._round_price(new_trigger)
        new_limit   = self._round_price(new_limit)

        if side == "B":
            # BUY entry only ever trails DOWN as price falls.
            if current_trigger is not None and new_trigger >= current_trigger:
                return
            if current_limit is not None and new_limit >= current_limit:
                return
        else:
            # SELL entry only ever trails UP as price rises.
            if current_trigger is not None and new_trigger <= current_trigger:
                return
            if current_limit is not None and new_limit <= current_limit:
                return

        try:
            self._log(
                "INFO",
                f"🔧 Trailing PENDING {side} entry | oid={order_id} | "
                f"{current_trigger or 0:.2f} → {new_trigger:.2f}"
            )

            response = self.broker.modify_order(
                exchange=self.cfg.exchange,
                tradingsymbol=self.cfg.trading_symbol,
                orderno=str(order_id),
                newquantity=str(self.cfg.quantity),
                newprice_type='SL-LMT',
                newprice=str(new_limit),
                newtrigger_price=str(new_trigger)
            )

            if response and response.get("stat") == "Ok":
                old_trigger = current_trigger

                if side == "B":
                    self.pending_buy_trigger_price = new_trigger
                    self.pending_buy_limit_price   = new_limit
                    if old_trigger is not None and self.pending_buy_origin_price is not None:
                        trail_amount = old_trigger - new_trigger  # positive: trigger moved down
                        self.pending_buy_origin_price = self._round_price(self.pending_buy_origin_price - trail_amount)
                else:
                    self.pending_sell_trigger_price = new_trigger
                    self.pending_sell_limit_price   = new_limit
                    if old_trigger is not None and self.pending_sell_origin_price is not None:
                        trail_amount = new_trigger - old_trigger  # positive: trigger moved up
                        self.pending_sell_origin_price = self._round_price(self.pending_sell_origin_price + trail_amount)

                self._log("INFO", f"🔧 Pending entry trailed ✅ | new trigger={new_trigger:.2f}")
            else:
                self._log("ERROR", f"🔧 Modify pending entry FAILED ❌ | {response}")
        except Exception as e:
            self._log("ERROR", f"Modify pending entry exception → {e}")

    # ================= CANCEL ORDER =================
    def _cancel_order_direct(self, order_id):
        try:
            response = self.broker.cancel_order(orderno=str(order_id))
            self._log("INFO", f"❌ Order Cancel Request → {response}")

            if response and response.get("stat") == "Ok":
                if order_id == self.sl_order_id:
                    self.sl_order_id      = None
                    self.sl_side           = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
                    self.sl_qty           = 0
                elif order_id == self.pending_buy_order_id:
                    self.pending_buy_order_id      = None
                    self.pending_buy_trigger_price = None
                    self.pending_buy_limit_price   = None
                    self.pending_buy_origin_price  = None
                elif order_id == self.pending_sell_order_id:
                    self.pending_sell_order_id      = None
                    self.pending_sell_trigger_price = None
                    self.pending_sell_limit_price   = None
                    self.pending_sell_origin_price  = None
            else:
                self._log("WARNING", f"⚠️ Cancel request may have failed → {response}")

        except Exception as e:
            self._log("ERROR", f"Cancel error → {e}")

    # ================= ORDER CALLBACK =================
    def order_handler(self, msg):
        status  = msg.get("status", "").upper()
        oid     = msg.get("norenordno")
        remarks = msg.get("remarks", "")

        self._log("INFO", f"📨 Order Update → oid={oid}, status={status}, remarks={remarks}")

        with self.state_lock:
            if status == "COMPLETE":
                tran       = msg.get("trantype")
                filled_qty = int(msg.get("fillshares", self.cfg.quantity))
                fill_price = float(msg.get("flprc", 0) or 0)

                if tran == "B":
                    self.long_qty += filled_qty
                else:
                    self.short_qty += filled_qty

                self.position_qty = self.long_qty - self.short_qty

                if remarks == "RENKO_SL":
                    self.sl_order_id      = None
                    self.sl_side           = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
                    self.sl_qty           = 0
                    self.entry_price      = None
                    self._log("INFO", f"🛑 SL HIT → trantype={tran}, filled={filled_qty}, fill_price={fill_price}, new position_qty={self.position_qty} (LONG:{self.long_qty}, SHORT:{self.short_qty})")

                elif oid == self.squareoff_order_id:
                    self.squareoff_order_id = None
                    self.squareoff_side     = None
                    self._log("INFO", f"✅ Squareoff order COMPLETE → trantype={tran}, filled={filled_qty}, new position_qty={self.position_qty}")

                elif oid == self.pending_buy_order_id:
                    self.pending_buy_order_id      = None
                    self.pending_buy_trigger_price = None
                    self.pending_buy_limit_price   = None
                    self.pending_buy_origin_price  = None
                    self._log("INFO", f"✅ BUY entry COMPLETE → filled={filled_qty}, fill_price={fill_price}, new position_qty={self.position_qty} (LONG:{self.long_qty}, SHORT:{self.short_qty})")
                    if fill_price > 0:
                        self.entry_price = fill_price
                    self._reconcile_sl_for_position()

                elif oid == self.pending_sell_order_id:
                    self.pending_sell_order_id      = None
                    self.pending_sell_trigger_price = None
                    self.pending_sell_limit_price   = None
                    self.pending_sell_origin_price  = None
                    self._log("INFO", f"✅ SELL entry COMPLETE → filled={filled_qty}, fill_price={fill_price}, new position_qty={self.position_qty} (LONG:{self.long_qty}, SHORT:{self.short_qty})")
                    if fill_price > 0:
                        self.entry_price = fill_price
                    self._reconcile_sl_for_position()

                else:
                    self._log("WARNING", f"⚠️ COMPLETE for untracked oid={oid} → reconciling SL from resulting position")
                    self._reconcile_sl_for_position()

            elif status == "REJECTED":
                reject_reason = msg.get("rejreason", "Unknown reason")
                self._log("ERROR", f"🚫 Order REJECTED → oid={oid}, reason={reject_reason}")

                if remarks == "RENKO_SL":
                    self.sl_order_id      = None
                    self.sl_side           = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
                    self.sl_qty           = 0
                elif oid == self.squareoff_order_id:
                    self.squareoff_order_id = None
                    self.squareoff_side     = None
                elif oid == self.pending_buy_order_id:
                    self.pending_buy_order_id      = None
                    self.pending_buy_trigger_price = None
                    self.pending_buy_limit_price   = None
                    self.pending_buy_origin_price  = None
                elif oid == self.pending_sell_order_id:
                    self.pending_sell_order_id      = None
                    self.pending_sell_trigger_price = None
                    self.pending_sell_limit_price   = None
                    self.pending_sell_origin_price  = None

            elif status == "CANCELLED":
                self._log("INFO", f"❌ Order CANCELLED → oid={oid}")
                if remarks == "RENKO_SL":
                    self.sl_order_id      = None
                    self.sl_side           = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
                    self.sl_qty           = 0
                elif oid == self.squareoff_order_id:
                    self.squareoff_order_id = None
                    self.squareoff_side     = None
                elif oid == self.pending_buy_order_id:
                    self.pending_buy_order_id      = None
                    self.pending_buy_trigger_price = None
                    self.pending_buy_limit_price   = None
                    self.pending_buy_origin_price  = None
                elif oid == self.pending_sell_order_id:
                    self.pending_sell_order_id      = None
                    self.pending_sell_trigger_price = None
                    self.pending_sell_limit_price   = None
                    self.pending_sell_origin_price  = None

            elif status == "TRIGGER_PENDING":
                self._log("INFO", f"⏳ TRIGGER PENDING → oid={oid}, remarks={remarks}")

            elif status == "OPEN":
                self._log("INFO", f"📬 Order OPEN → oid={oid}, remarks={remarks}")

            else:
                self._log("WARNING", f"⚠️ Unknown order status → oid={oid}, status={status}")

            self._skip_next_sync = True

        self._push_status()

    def _reconcile_sl_for_position(self):
        """
        Brings the SL in line with the CURRENT position (LONG and SHORT separately).

        SL is always calculated fresh from entry_price or renko.last_close.
        No stale trail levels are used.
        """
        # ── ONLY CANCEL SL WHEN TRULY FLAT ──
        if self.long_qty == 0 and self.short_qty == 0:
            if self.sl_order_id:
                self._log(
                    "WARNING",
                    f"🔁 Truly flat (LONG:0, SHORT:0) but SL {self.sl_order_id} still resting → cancelling stale SL"
                )
                self._cancel_order_direct(self.sl_order_id)
                self.entry_price = None
            return

        # ── If net position is zero but gross positions exist, handle opposing positions ──
        if self.position_qty == 0:
            if self.sl_order_id:
                # Check quantity against dominant side
                dominant_qty = max(self.long_qty, self.short_qty)
                if self.sl_qty != dominant_qty:
                    self._log(
                        "INFO",
                        f"🔧 SL quantity mismatch in opposing positions: {self.sl_qty} → {dominant_qty}"
                    )
                    self._modify_sl_order(self.sl_trigger_price, dominant_qty)
                    self.sl_qty = dominant_qty
                return
            else:
                # No SL, place for dominant side
                if self.long_qty > self.short_qty:
                    ref_price = self.entry_price if self.entry_price else self.renko.last_close
                    if not ref_price:
                        self._log("ERROR", "❌ Cannot compute SL — no entry_price and renko.last_close is None")
                        return
                    sl_trigger = self._round_price(ref_price - self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                    sl_side = "S"
                    qty = self.long_qty
                    self._log("INFO", f"🛡️ Reconciling SL for opposing positions (LONG:{self.long_qty}, SHORT:{self.short_qty}) | side={sl_side} trigger={sl_trigger:.2f} qty={qty}")
                    self._place_sl_order(sl_side, sl_trigger, qty)
                elif self.short_qty > self.long_qty:
                    ref_price = self.entry_price if self.entry_price else self.renko.last_close
                    if not ref_price:
                        self._log("ERROR", "❌ Cannot compute SL — no entry_price and renko.last_close is None")
                        return
                    sl_trigger = self._round_price(ref_price + self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                    sl_side = "B"
                    qty = self.short_qty
                    self._log("INFO", f"🛡️ Reconciling SL for opposing positions (LONG:{self.long_qty}, SHORT:{self.short_qty}) | side={sl_side} trigger={sl_trigger:.2f} qty={qty}")
                    self._place_sl_order(sl_side, sl_trigger, qty)
                else:
                    # Equal opposing positions - default to LONG
                    ref_price = self.entry_price if self.entry_price else self.renko.last_close
                    if not ref_price:
                        self._log("ERROR", "❌ Cannot compute SL — no entry_price and renko.last_close is None")
                        return
                    sl_trigger = self._round_price(ref_price - self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                    sl_side = "S"
                    qty = self.long_qty
                    self._log("INFO", f"🛡️ Reconciling SL for equal opposing positions (LONG:{self.long_qty}, SHORT:{self.short_qty}) | side={sl_side} trigger={sl_trigger:.2f} qty={qty}")
                    self._place_sl_order(sl_side, sl_trigger, qty)
                return

        required_sl_side = "S" if self.position_qty > 0 else "B"
        required_qty = abs(self.position_qty)

        # ── If SL exists but wrong side, cancel it ──
        if self.sl_order_id and self.sl_side is not None and self.sl_side != required_sl_side:
            self._log(
                "WARNING",
                f"🔁 Position direction changed (now {self.position_qty}) → cancelling stale SL {self.sl_order_id} before re-arming"
            )
            self._cancel_order_direct(self.sl_order_id)

        # ── If no SL, place one ──
        if not self.sl_order_id:
            ref_price = self.entry_price if self.entry_price else self.renko.last_close
            if not ref_price:
                self._log("ERROR", "❌ Cannot compute SL — no entry_price and renko.last_close is None")
                return

            if self.position_qty > 0:
                sl_trigger = self._round_price(ref_price - self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                sl_side = "S"
            else:
                sl_trigger = self._round_price(ref_price + self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                sl_side = "B"

            self._log("INFO", f"🛡️ Reconciling SL for position={self.position_qty} | side={sl_side} trigger={sl_trigger:.2f} qty={required_qty}")
            self._place_sl_order(sl_side, sl_trigger, required_qty)
            return

        # ── SL exists and is on correct side, check quantity ──
        if self.sl_order_id and self.sl_side == required_sl_side:
            if self.sl_qty != required_qty:
                self._log(
                    "INFO",
                    f"🔧 SL quantity changed: {self.sl_qty} → {required_qty}. Modifying SL {self.sl_order_id}"
                )
                self._modify_sl_order(self.sl_trigger_price, required_qty)
                self.sl_qty = required_qty

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

            color       = brick["color"]
            brick_no    = brick["brick_no"]
            brick_price = brick["brick_price"]

            if brick_no == 0:
                if color == "Green":
                    self.green0_price = brick_price
                elif color == "Red":
                    self.red0_price = brick_price

            if self.trades_blocked:
                continue

            with self.state_lock:
                if self.pending_buy_order_id and color == "Red":
                    gap = self.cfg.entry_trail_brick_number * self.cfg.brick_size
                    candidate_trigger = brick_price + gap
                    candidate_limit   = candidate_trigger + self.cfg.tick_size
                    self.trail_pending_entry("B", candidate_trigger, candidate_limit)

                if self.pending_sell_order_id and color == "Green":
                    gap = self.cfg.entry_trail_brick_number * self.cfg.brick_size
                    candidate_trigger = brick_price - gap
                    candidate_limit   = candidate_trigger - self.cfg.tick_size
                    self.trail_pending_entry("S", candidate_trigger, candidate_limit)

            if self.position_qty != 0:
                if self.position_qty > 0:
                    candidate_trigger = brick_price - (self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                else:
                    candidate_trigger = brick_price + (self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                self.trail_sl(candidate_trigger)

            if color == "Green" and brick_no == self.cfg.buy_brick_no:
                limit   = round(brick_price + (self.cfg.limit_price_buy_brick_no * self.cfg.brick_size), 2)
                trigger = round(limit - self.cfg.tick_size, 2)

                if self.cfg.trade_mode in ("LONG_ONLY", "LONG_SHORT"):
                    if self.cfg.trade_mode == "LONG_ONLY" and self.position_qty != 0:
                        self._log("INFO", f"⏭️ BUY skipped → position_qty={self.position_qty}")
                    else:
                        self._log("INFO", f"🟢 BUY Signal | Brick #{brick_no} | limit={limit:.2f}")
                        self.place_order("B", trigger, limit)

            if color == "Red" and brick_no == self.cfg.sell_brick_no:
                limit   = round(brick_price - (self.cfg.limit_price_sell_brick_no * self.cfg.brick_size), 2)
                trigger = round(limit + self.cfg.tick_size, 2)

                if self.cfg.trade_mode in ("SHORT_ONLY", "LONG_SHORT"):
                    if self.cfg.trade_mode == "SHORT_ONLY" and self.position_qty != 0:
                        self._log("INFO", f"⏭️ SELL skipped → position_qty={self.position_qty}")
                    else:
                        self._log("INFO", f"🔴 SELL Signal | Brick #{brick_no} | limit={limit:.2f}")
                        self.place_order("S", trigger, limit)

        self._push_status()

    # ================= PUBLIC =================
    def place_order(self, side, trigger, limit):
        if self.trades_blocked:
            return
        self.order_queue.put({"type": "PLACE", "side": side, "trigger": trigger, "limit": limit})

    def cancel_order(self, order_id):
        self.order_queue.put({"type": "CANCEL", "order_id": order_id})

    def trail_sl(self, new_trigger):
        if self.trades_blocked or not self.sl_order_id or self.position_qty == 0:
            return
        self.order_queue.put({"type": "MODIFY_SL", "new_trigger": new_trigger})

    def trail_pending_entry(self, side, new_trigger, new_limit):
        if self.trades_blocked:
            return
        if side == "B" and not self.pending_buy_order_id:
            return
        if side == "S" and not self.pending_sell_order_id:
            return
        self.order_queue.put({"type": "MODIFY_PENDING_ENTRY", "side": side, "new_trigger": new_trigger, "new_limit": new_limit})