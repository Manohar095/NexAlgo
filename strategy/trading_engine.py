# -*- coding: utf-8 -*-
"""
strategy/trading_engine.py
============================
This is the original FlattradeBot (v3, SL-based exit) strategy logic,
refactored so every symbol gets its own fully independent instance:
own Renko engine, own position/SL/pending-order state, own worker
thread, own squareoff scheduler, own periodic safety-net thread, own
log stream.

STRATEGY LOGIC IS UNCHANGED except for one deliberate improvement in
LONG_SHORT mode's reversal handling (see _place_reversal_order below).
Everything else is a mechanical refactor to support multiple
simultaneous symbols:
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
        self.cfg    = cfg       # models.symbol_config.SymbolConfig
        self.broker = broker    # strategy.broker.BrokerSession (shared)
        self.on_log = on_log    # callback(instance_id, level, message)
        self.on_status = on_status # callback(instance_id, status_dict)

        self.renko = LiveRenko(cfg.brick_size, cfg.green_to_red_rev, cfg.red_to_green_rev)

        # ---- Trading state (identical fields to the original bot) ----
        self.position_qty     = 0
        self.pending_order_id = None
        self.pending_side     = None
        self.pending_trigger_price = None  # current trigger of the resting pending ENTRY order (trails on retracement)
        self.pending_limit_price   = None  # current limit of the resting pending ENTRY order

        self.deferred_order   = None
        self.deferred_for_oid = None

        self.sl_order_id      = None
        self.sl_trigger_price = None
        self.sl_limit_price   = None

        # Persists across squareoff/position-flat events for logging
        # clarity only now — see _place_reversal_order for why this no
        # longer needs to survive an SL cancellation: reversals don't
        # cancel the SL anymore, so there's no "re-arm after a failed
        # reversal" scenario to track. Still useful for the unrelated
        # case of a missed-fill safety-net re-arm never coming back
        # looser than a level already earned by trailing.
        self.last_known_sl_trigger = None

        self.entry_price      = None

        # ── Dynamic price-based cancellation state ──
        # green0_price / red0_price track the price of the brick that
        # STARTED the current up/down run (brick_no == 0 for that color —
        # either the very first brick of the session, or the reversal
        # brick right after a trend flip). These update continuously as
        # new brick_no==0 bricks form. pending_buy_origin_price /
        # pending_sell_origin_price are a SNAPSHOT of that value taken at
        # the moment an order is actually placed — the frozen reference
        # point a pending order's cancellation level is measured from,
        # per the spec: "once a pending Buy order is placed, record the
        # price of Green Brick #0".
        self.green0_price = None
        self.red0_price   = None
        self.pending_buy_origin_price  = None
        self.pending_sell_origin_price = None

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
            self.pending_trigger_price = None
            self.pending_limit_price   = None
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
                        self.pending_trigger_price = float(o.get("trgprc", 0) or 0)
                        self.pending_limit_price   = float(o.get("prc", 0) or 0)

            positions = self.broker.get_positions()
            self.position_qty = 0
            if positions:
                for p in positions:
                    if p.get("tsym") == self.cfg.trading_symbol and p.get("exch") == self.cfg.exchange:
                        self.position_qty = int(p.get("netqty", 0))
                        break

            if not self.pending_order_id:
                # No pending order at the broker (anymore) — any cancellation
                # origin snapshot from a prior pending order is now stale.
                self.pending_buy_origin_price  = None
                self.pending_sell_origin_price = None
            else:
                # A pending order exists at the broker, but the origin-price
                # snapshot (pending_buy_origin_price / pending_sell_origin_price)
                # is a LOCAL-ONLY value — it's never sent to or read back from
                # the broker's order book, unlike pending_trigger_price/
                # pending_limit_price above. If the process restarts (or this
                # instance is freshly created) while an order is resting —
                # possibly already trailed several times — that snapshot is
                # lost and would otherwise stay None forever, silently
                # disabling the LONG_SHORT cancel-and-reverse check for that
                # order until a brand-new entry is placed.
                #
                # Reconstruct a reasonable origin from the CURRENT
                # trigger/limit instead of leaving it None: this is exactly
                # the inverse of the fresh-entry relationship used elsewhere
                # (limit = brick_price ± offset*brick_size, trigger = limit
                # ∓ tick_size), so treating the recovered trigger as if it
                # were freshly derived from "brick #0 = trigger" one gap back
                # reproduces a same-order-of-magnitude reference level. It
                # won't be bit-for-bit identical to the true original Brick
                # #0 price if the order had already trailed before the
                # restart, but it keeps the safety check live and roughly
                # calibrated rather than permanently off.
                if self.pending_side == "B" and self.pending_buy_origin_price is None and self.pending_trigger_price:
                    self.pending_buy_origin_price = self._round_price(
                        self.pending_trigger_price + self.cfg.brick_size
                    )
                    self._log(
                        "WARNING",
                        f"🔧 Recovered missing BUY origin snapshot after restart → "
                        f"approximated at {self.pending_buy_origin_price} from resting trigger {self.pending_trigger_price}"
                    )
                elif self.pending_side == "S" and self.pending_sell_origin_price is None and self.pending_trigger_price:
                    self.pending_sell_origin_price = self._round_price(
                        self.pending_trigger_price - self.cfg.brick_size
                    )
                    self._log(
                        "WARNING",
                        f"🔧 Recovered missing SELL origin snapshot after restart → "
                        f"approximated at {self.pending_sell_origin_price} from resting trigger {self.pending_trigger_price}"
                    )

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

            if self.pending_order_id:
                self._log("INFO", f"🗑️ Cancelling pending order before squareoff: {self.pending_order_id}")
                self._cancel_order_direct(self.pending_order_id)
                self.pending_order_id = None
                self.pending_side     = None
                self.pending_trigger_price     = None
                self.pending_limit_price       = None
                self.pending_buy_origin_price  = None
                self.pending_sell_origin_price = None
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
        Runs every 5s while the symbol is active. Always reconciles from
        the broker first (sync_state() has its own internal 1s throttle,
        so this is cheap) rather than only syncing when local state
        already looked stale by some specific pattern — if a WebSocket
        order-update message is ever dropped (broker-side blip, rare but
        real), local state can silently diverge from the broker's truth
        in ways that don't match any single "known bad" pattern. Syncing
        unconditionally means the broker is always the source of truth
        within one cycle (≤5s), not just at restart.
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
                # Covers the entry-fill-callback-missed case (never got an
                # SL in the first place) and the drift case above (old SL
                # id turned out to be stale/filled, sync already cleared
                # it, position confirmed still open). Reversals no longer
                # cancel the SL, so this branch doesn't need to handle a
                # "reversal failed" case anymore — the SL simply never
                # leaves the broker's order book during a reversal attempt.
                elif (self.position_qty != 0
                        and not self.sl_order_id
                        and not self.pending_order_id):
                    ref_price = self.renko.last_close
                    if ref_price is not None:
                        if self.position_qty > 0:
                            fresh_trigger = self._round_price(ref_price - self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                            sl_side = "S"
                            # LONG: tighter = higher trigger. Never re-arm
                            # looser than a level already earned by trailing.
                            if self.last_known_sl_trigger is not None:
                                sl_trigger = max(fresh_trigger, self.last_known_sl_trigger)
                            else:
                                sl_trigger = fresh_trigger
                        else:
                            fresh_trigger = self._round_price(ref_price + self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                            sl_side = "B"
                            # SHORT: tighter = lower trigger.
                            if self.last_known_sl_trigger is not None:
                                sl_trigger = min(fresh_trigger, self.last_known_sl_trigger)
                            else:
                                sl_trigger = fresh_trigger

                        if self.last_known_sl_trigger is not None and sl_trigger != fresh_trigger:
                            self._log(
                                "WARNING",
                                f"🚨 SAFETY NET: pos open but no SL/pending → re-arming at {sl_trigger} "
                                f"(kept prior trailed level {self.last_known_sl_trigger}, tighter than fresh calc {fresh_trigger})"
                            )
                        else:
                            self._log(
                                "WARNING",
                                f"🚨 SAFETY NET: pos open but no SL/pending → re-arming at {sl_trigger} (fresh calc from current level)"
                            )
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
                elif task["type"] == "REVERSE":
                    if self.trades_blocked or self._is_squareoff_time():
                        self._log("INFO", "⛔ Trades blocked → skipping opposite entry")
                        continue
                    self._place_reversal_order(task)
                elif task["type"] == "CANCEL":
                    self._cancel_order_direct(task["order_id"])
                elif task["type"] == "MODIFY_SL":
                    self._modify_sl_order(task["new_trigger"])
                elif task["type"] == "MODIFY_PENDING_ENTRY":
                    self._modify_pending_entry_order(task["new_trigger"], task["new_limit"])
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
                    self.pending_trigger_price = trigger
                    self.pending_limit_price   = limit
                    if side == "B":
                        self.pending_buy_origin_price = self.green0_price
                        self._log("INFO", f"📍 BUY cancellation origin snapshot: Green Brick #0 = {self.green0_price}")
                    else:
                        self.pending_sell_origin_price = self.red0_price
                        self._log("INFO", f"📍 SELL cancellation origin snapshot: Red Brick #0 = {self.red0_price}")

            except Exception as e:
                self._log("ERROR", f"Order error → {e}")
                self.deferred_order   = None
                self.deferred_for_oid = None

    # ================= OPPOSITE-DIRECTION ENTRY (LONG_SHORT only) =================
    def _place_reversal_order(self, data):
        """
        LONG_SHORT mode only. Fires on an opposite-direction signal while
        a position is already open.

        REDESIGNED — previously this cancelled the resting SL and placed
        a single doubled-quantity order at the NEW signal's price. That
        was wrong: the new signal's price is (by construction — it's
        further out than the SL's own distance) reliably WORSE than the
        SL's already-earned level, so the old leg ended up exiting at a
        worse price than its own stop-loss would have given it, with a
        real unprotected gap in between while the reversal order was
        still pending.

        NEW BEHAVIOUR: does NOT touch the existing SL at all, and does
        NOT double the quantity:
          - The existing SL stays exactly as it was, live, still
            trailing — it's already the correct mechanism to close the
            current leg at its own protected price whenever price gets
            there. Nothing new needs to be built for that; it already
            works.
          - A brand new, NORMAL single-qty entry order is placed for the
            opposite direction, at the new signal's own price — placed
            concurrently, not gated behind the position going flat
            first, so a fast move still gets captured immediately.
          - This new entry order is tracked exactly like any other
            pending entry (pending_order_id/pending_side, origin-price
            snapshot for the existing dynamic cancellation logic) — no
            special-casing needed there, it already applies generically.
            If price un-reverses before this new entry fills, the
            existing feed_handler cancellation logic cancels it exactly
            like it would any fresh entry, leaving the original,
            still-live SL to keep protecting the unchanged original
            position — nothing else needed.

        Sequencing in the normal case: since the SL is always the closer
        trigger level (by construction — the signal offset pushes further
        from current price than the SL distance), the SL fires first,
        closing the old leg at its correct price; the new entry order
        remains resting and later fires on its own when/if price
        continues, opening the new leg from a clean flat position exactly
        like any fresh entry — reusing that already-tested code path with
        zero special-casing.
        """
        side    = data["side"]
        limit   = self._round_price(data["limit"])
        trigger = self._round_price(data["trigger"])

        with self.state_lock:
            self.sync_state()

            if self.trades_blocked:
                self._log("INFO", "⛔ Trades blocked → skipping opposite entry")
                return

            if self.cfg.trade_mode != "LONG_SHORT":
                return  # defensive — this path should only ever be queued in LONG_SHORT mode

            if self.position_qty == 0:
                # Already flat by the time this got processed — just a fresh entry.
                self._place_order(data)
                return

            already_same_direction = (side == "B" and self.position_qty > 0) or (side == "S" and self.position_qty < 0)
            if already_same_direction:
                self._log("INFO", f"🚫 Opposite entry {side} skipped → position already in that direction (qty={self.position_qty})")
                return

            if self.pending_order_id:
                if self.pending_side == side:
                    self._log("INFO", "⛔ Same-side pending opposite entry already exists → skip")
                    return
                self._log("INFO", f"🔄 Opposite pending exists → cancelling {self.pending_order_id}, deferring new {side} entry")
                self.deferred_order = {"side": side, "trigger": trigger, "limit": limit}
                self.deferred_for_oid = self.pending_order_id
                self._cancel_order_direct(self.pending_order_id)
                return

            order_qty = self.cfg.quantity  # NOT doubled — the existing SL (untouched) closes the current leg at its own price
            current_direction = "LONG" if self.position_qty > 0 else "SHORT"
            self._log(
                "INFO",
                f"🔀 OPPOSITE ENTRY {side} | qty={order_qty} — existing SL for the current {current_direction} "
                f"leg stays live and untouched (will close it at its own protected level, {self.sl_trigger_price})"
            )

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
                self._log("INFO", f"📤 Opposite Entry Order Response → {response}")

                if response and response.get("stat") == "Ok":
                    self.pending_order_id = response.get("norenordno")
                    self.pending_side     = side
                    self.pending_trigger_price = trigger
                    self.pending_limit_price   = limit
                    if side == "B":
                        self.pending_buy_origin_price = self.green0_price
                    else:
                        self.pending_sell_origin_price = self.red0_price

            except Exception as e:
                self._log("ERROR", f"Opposite entry order error → {e}")

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
                self.sl_trigger_price = trigger
                self.sl_limit_price   = limit
                self.last_known_sl_trigger = trigger
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
        offset = self.cfg.limit_offset or self.cfg.tick_size

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
                self.last_known_sl_trigger = new_trigger
                self._log("INFO", f"🔧 SL Trailed ✅ | new trigger={new_trigger:.2f}")
            else:
                self._log("ERROR", f"🔧 Modify SL FAILED ❌ | {response}")
        except Exception as e:
            self._log("ERROR", f"Modify SL exception → {e}")

    # ================= TRAIL PENDING ENTRY ORDER (loosen-only, follows retracement) =================
    def _modify_pending_entry_order(self, new_trigger, new_limit):
        """
        Trails a resting PENDING ENTRY order (BUY or SELL, remarks=api_order,
        NOT an SL — self.sl_order_id/self.position_qty are untouched here)
        in the direction of an adverse retracement, instead of cancelling
        it outright.

        This mirrors _modify_sl_order's tighten-only-in-one-direction shape,
        but for the opposite purpose: an SL trails to LOCK IN a better exit
        as price moves favourably for an OPEN position; this trails a
        not-yet-filled ENTRY order to follow price as it moves AWAY from
        triggering, so the order keeps working instead of being thrown away.

        - BUY pending entry: price falling → trigger/limit move DOWN with it.
          Only ever moves down (never snaps back up on a small uptick),
          exactly like the SL's tighten-only guard.
        - SELL pending entry: price rising → trigger/limit move UP with it.
          Only ever moves up.

        Uses entry_trail_brick_number for gap calculation and limit_offset
        for limit price offset.
        """
        if not self.pending_order_id or self.position_qty != 0:
            return

        new_trigger = self._round_price(new_trigger)
        new_limit   = self._round_price(new_limit)

        if self.pending_side == "B":
            # BUY entry only ever trails DOWN as price falls.
            if self.pending_trigger_price is not None and new_trigger >= self.pending_trigger_price:
                return
            if self.pending_limit_price is not None and new_limit >= self.pending_limit_price:
                return
        elif self.pending_side == "S":
            # SELL entry only ever trails UP as price rises.
            if self.pending_trigger_price is not None and new_trigger <= self.pending_trigger_price:
                return
            if self.pending_limit_price is not None and new_limit <= self.pending_limit_price:
                return
        else:
            return

        try:
            self._log(
                "INFO",
                f"🔧 Trailing PENDING {self.pending_side} entry | oid={self.pending_order_id} | "
                f"{self.pending_trigger_price or 0:.2f} → {new_trigger:.2f}"
            )

            response = self.broker.modify_order(
                exchange=self.cfg.exchange,
                tradingsymbol=self.cfg.trading_symbol,
                orderno=str(self.pending_order_id),
                newquantity=str(self.cfg.quantity),
                newprice_type='SL-LMT',
                newprice=str(new_limit),
                newtrigger_price=str(new_trigger)
            )

            if response and response.get("stat") == "Ok":
                old_trigger = self.pending_trigger_price

                self.pending_trigger_price = new_trigger
                self.pending_limit_price   = new_limit

                # The origin-price snapshot used by the LONG_SHORT
                # cancel-and-reverse check must move together with the
                # order — shifted by the SAME delta the trigger just
                # moved, not re-derived from new_trigger with a fixed
                # offset (that would reset/invert the reference level
                # instead of tracking it).
                if old_trigger is not None:
                    if self.pending_side == "B" and self.pending_buy_origin_price is not None:
                        trail_amount = old_trigger - new_trigger  # positive: trigger moved down
                        self.pending_buy_origin_price = self._round_price(self.pending_buy_origin_price - trail_amount)
                    elif self.pending_side == "S" and self.pending_sell_origin_price is not None:
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
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
            else:
                self._log("WARNING", f"⚠️ Cancel request may have failed → {response}")
                if self.deferred_for_oid == order_id:
                    self.deferred_order   = None
                    self.deferred_for_oid = None
                    self.pending_order_id = None
                    self.pending_side     = None
                    self.pending_trigger_price     = None
                    self.pending_limit_price       = None
                    self.pending_buy_origin_price  = None
                    self.pending_sell_origin_price = None

        except Exception as e:
            self._log("ERROR", f"Cancel error → {e}")
            if self.deferred_for_oid == order_id:
                self.deferred_order   = None
                self.deferred_for_oid = None
                self.pending_order_id = None
                self.pending_side     = None
                self.pending_trigger_price     = None
                self.pending_limit_price       = None
                self.pending_buy_origin_price  = None
                self.pending_sell_origin_price = None

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

                if self.position_qty == 0:
                    # Covers squareoff too (it also fills under the
                    # 'api_order' tag) — flat is flat, nothing to remember.
                    self.last_known_sl_trigger = None

                if remarks == "RENKO_SL":
                    self.sl_order_id      = None
                    self.sl_trigger_price = None
                    self.sl_limit_price   = None
                    self.entry_price      = None
                    self.last_known_sl_trigger = None  # position genuinely closed — nothing to remember
                    self._log("INFO", f"🛑 SL HIT → trantype={tran}, filled={filled_qty}, fill_price={fill_price}, new position_qty={self.position_qty}")

                else:
                    self.pending_order_id = None
                    self.pending_side     = None
                    self.pending_trigger_price     = None
                    self.pending_limit_price       = None
                    self.pending_buy_origin_price  = None
                    self.pending_sell_origin_price = None

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
                            # New leg starting (fresh entry, or an opposite
                            # entry that fired while the old leg's SL was
                            # still resting/unfilled) — always clear the
                            # remembered level unconditionally so nothing
                            # from a prior leg can ever contaminate this one.
                            self.last_known_sl_trigger = None

                            if self.position_qty > 0:
                                sl_trigger = self._round_price(ref_price - self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                                sl_side = "S"
                            else:
                                sl_trigger = self._round_price(ref_price + self.cfg.sl_trail_brick_number * self.cfg.brick_size)
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
                    self.pending_trigger_price     = None
                    self.pending_limit_price       = None
                    self.pending_buy_origin_price  = None
                    self.pending_sell_origin_price = None
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
                    self.pending_trigger_price     = None
                    self.pending_limit_price       = None
                    self.pending_buy_origin_price  = None
                    self.pending_sell_origin_price = None
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

            color       = brick["color"]
            brick_no    = brick["brick_no"]
            brick_price = brick["brick_price"]

            # ===== TRACK TREND-ORIGIN PRICE (Brick #0 of the current run) =====
            # Updated unconditionally — even if trades are blocked — since
            # this is just recording price history, not placing trades.
            # brick_no == 0 always marks either the very first brick of the
            # session or the reversal brick right after a trend flip.
            if brick_no == 0:
                if color == "Green":
                    self.green0_price = brick_price
                elif color == "Red":
                    self.red0_price = brick_price

            if self.trades_blocked:
                continue

            # ===== PENDING ENTRY ORDER: TRAIL ON RETRACEMENT (all modes) =====
            # PLUS LONG_SHORT-ONLY: CANCEL + REVERSE ONCE PRICE FULLY UN-REVERSES
            #
            # Previously the retracement level (pending_*_origin_price ±
            # brick_size) simply cancelled the pending entry outright, in
            # every trade mode. New behaviour: the pending entry order
            # itself now TRAILS with price as it retraces — using the gap
            # (entry_trail_brick_number * brick_size) — instead of being
            # thrown away, so it keeps working closer to the market.
            # This trailing applies in ALL modes (LONG_ONLY, SHORT_ONLY,
            # LONG_SHORT).
            #
            # The old cancel-and-place-opposite-entry behaviour is kept,
            # but now gated to LONG_SHORT mode only, and is driven by the
            # SAME retracement trigger as before (price reaching the
            # original Brick #0 origin ± one brick) — i.e. "price reverses
            # and reaches the BUY Entry Order level from the opposite
            # direction". In LONG_ONLY/SHORT_ONLY this branch is skipped
            # entirely and the order just keeps trailing indefinitely.
            # ===== PENDING ENTRY ORDER: TRAIL 1-BRICK-AT-A-TIME ON RETRACEMENT (all modes) =====
            # PLUS LONG_SHORT-ONLY: CANCEL + REVERSE ONCE PRICE FULLY UN-REVERSES
            #
            # Option A (confirmed): trailing moves the pending order by
            # exactly ONE brick_size for every new brick that forms against
            # it — one real brick of price movement = one brick_size of
            # trigger movement, in lockstep. NOT entry_trail_brick_number *
            # brick_size as a single gap (that jumps the full distance the
            # instant one adverse brick forms, which is wrong — see prior
            # log trace: 23.01 -> 22.61 off a single brick, confirmed
            # unwanted). entry_trail_brick_number is unused here.
            #
            # The trail only ever moves toward the market (BUY trigger
            # down, SELL trigger up) — if price reverses back the other
            # way, the order simply stops trailing and holds its last
            # level; it never moves back with a favourable move. This runs
            # on every red brick (BUY side) / green brick (SELL side)
            # while a pending entry is resting, independent of the
            # LONG_SHORT-only cancel_level check below — that one triggers
            # once, after a full brick_size retracement past the origin
            # brick; this one triggers per-brick starting immediately
            # after entry.
            with self.state_lock:
                if self.pending_order_id and self.pending_order_id != self.deferred_for_oid:
                    if self.pending_side == "B" and self.pending_trigger_price is not None:
                        # A brick moving against a resting BUY is a Red brick
                        # whose price sits below the current trigger — trail
                        # down by exactly one brick_size to follow it.
                        if color == "Red" and brick_price < self.pending_trigger_price:
                            new_trigger = self._round_price(self.pending_trigger_price - self.cfg.brick_size)
                            new_limit   = new_trigger + self.cfg.tick_size
                            self.trail_pending_entry(new_trigger, new_limit)

                    elif self.pending_side == "S" and self.pending_trigger_price is not None:
                        # A brick moving against a resting SELL is a Green
                        # brick whose price sits above the current trigger —
                        # trail up by exactly one brick_size to follow it.
                        if color == "Green" and brick_price > self.pending_trigger_price:
                            new_trigger = self._round_price(self.pending_trigger_price + self.cfg.brick_size)
                            new_limit   = new_trigger - self.cfg.tick_size
                            self.trail_pending_entry(new_trigger, new_limit)

            # ===== LONG_SHORT ONLY: CANCEL + REVERSE ON FULL ORIGIN RETRACEMENT =====
            # Separate, one-shot threshold (unrelated to the per-brick trail
            # above): once price retraces a full brick past the breakout's
            # own origin brick, cancel the (still-trailing) pending entry
            # and place the opposite-direction entry instead. LONG_ONLY /
            # SHORT_ONLY never take this branch — their pending entry just
            # keeps trailing indefinitely per the block above.
            with self.state_lock:
                if self.pending_order_id and self.pending_order_id != self.deferred_for_oid:
                    if self.pending_side == "B" and self.pending_buy_origin_price is not None:
                        cancel_level = self._round_price(self.pending_buy_origin_price - self.cfg.brick_size)
                        if brick_price <= cancel_level and self.cfg.trade_mode == "LONG_SHORT":
                            self._log(
                                "INFO",
                                f"🔄 Price retraced to {brick_price} (≤ {cancel_level}, "
                                f"Green#0 was {self.pending_buy_origin_price}) → LONG_SHORT: Cancel pending BUY "
                                f"({self.pending_order_id}) and reverse"
                            )
                            self.cancel_order(self.pending_order_id)

                    elif self.pending_side == "S" and self.pending_sell_origin_price is not None:
                        cancel_level = self._round_price(self.pending_sell_origin_price + self.cfg.brick_size)
                        if brick_price >= cancel_level and self.cfg.trade_mode == "LONG_SHORT":
                            self._log(
                                "INFO",
                                f"🔄 Price retraced to {brick_price} (≥ {cancel_level}, "
                                f"Red#0 was {self.pending_sell_origin_price}) → LONG_SHORT: Cancel pending SELL "
                                f"({self.pending_order_id}) and reverse"
                            )
                            self.cancel_order(self.pending_order_id)

            # ===== TRAIL SL EVERY BRICK WHILE POSITION OPEN =====
            if self.position_qty != 0:
                if self.position_qty > 0:
                    candidate_trigger = brick_price - (self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                else:
                    candidate_trigger = brick_price + (self.cfg.sl_trail_brick_number * self.cfg.brick_size)
                self.trail_sl(candidate_trigger)

            # ===== FRESH ENTRIES + LONG_SHORT OPPOSITE ENTRIES (LONG_ONLY/SHORT_ONLY still exit via SL only) =====
            if color == "Green" and brick_no == self.cfg.buy_brick_no:
                limit   = round(brick_price + (self.cfg.limit_price_buy_brick_no * self.cfg.brick_size), 2)
                trigger = round(limit - self.cfg.tick_size, 2)

                if self.cfg.trade_mode in ("LONG_ONLY", "LONG_SHORT"):
                    if self.position_qty == 0:
                        self._log("INFO", f"🟢 BUY FRESH Signal | Brick #{brick_no} | limit={limit:.2f}")
                        self.place_order("B", trigger, limit)
                    elif self.cfg.trade_mode == "LONG_SHORT" and self.position_qty < 0:
                        self._log("INFO", f"🔀 OPPOSITE BUY Signal | Brick #{brick_no} | limit={limit:.2f}")
                        self.reverse_order("B", trigger, limit)
                    else:
                        self._log("INFO", f"⏭️ BUY skipped → position_qty={self.position_qty}")

            if color == "Red" and brick_no == self.cfg.sell_brick_no:
                limit   = round(brick_price - (self.cfg.limit_price_sell_brick_no * self.cfg.brick_size), 2)
                trigger = round(limit + self.cfg.tick_size, 2)

                if self.cfg.trade_mode in ("SHORT_ONLY", "LONG_SHORT"):
                    if self.position_qty == 0:
                        self._log("INFO", f"🔴 SELL FRESH Signal | Brick #{brick_no} | limit={limit:.2f}")
                        self.place_order("S", trigger, limit)
                    elif self.cfg.trade_mode == "LONG_SHORT" and self.position_qty > 0:
                        self._log("INFO", f"🔀 OPPOSITE SELL Signal | Brick #{brick_no} | limit={limit:.2f}")
                        self.reverse_order("S", trigger, limit)
                    else:
                        self._log("INFO", f"⏭️ SELL skipped → position_qty={self.position_qty}")

        self._push_status()

    # ================= PUBLIC =================
    def place_order(self, side, trigger, limit):
        if self.trades_blocked:
            return
        self.order_queue.put({"type": "PLACE", "side": side, "trigger": trigger, "limit": limit})

    def reverse_order(self, side, trigger, limit):
        """LONG_SHORT mode only — places a concurrent opposite-direction
        entry while a position is open, WITHOUT touching the existing SL
        (see _place_reversal_order for the full reasoning)."""
        if self.trades_blocked:
            return
        self.order_queue.put({"type": "REVERSE", "side": side, "trigger": trigger, "limit": limit})

    def cancel_order(self, order_id):
        if self.deferred_for_oid == order_id:
            return
        self.order_queue.put({"type": "CANCEL", "order_id": order_id})

    def trail_sl(self, new_trigger):
        if self.trades_blocked or not self.sl_order_id or self.position_qty == 0:
            return
        self.order_queue.put({"type": "MODIFY_SL", "new_trigger": new_trigger})

    def trail_pending_entry(self, new_trigger, new_limit):
        """Trails a resting pending ENTRY order (BUY or SELL) toward the
        market as price retraces away from it, instead of cancelling it.
        No-op if trades are blocked, there's no pending entry, or a
        position is already open (trailing SL owns that case instead)."""
        if self.trades_blocked or not self.pending_order_id or self.position_qty != 0:
            return
        self.order_queue.put({"type": "MODIFY_PENDING_ENTRY", "new_trigger": new_trigger, "new_limit": new_limit})