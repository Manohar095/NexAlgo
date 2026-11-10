/**
 * static/trading/trade_layer.mjs
 * ==============================
 * The trading half of the OpenAlgoNew trading page, ported onto the widget-tier
 * chart that `/trading` already runs.
 *
 * OpenAlgoNew's `terminal.ts` spends its trading block on three things:
 *
 *   1. an armed, price-marked SELL / qty / BUY panel drawn ON the canvas
 *      (`BuySellButtons` from the package), which places market orders;
 *   2. one price line per WORKING order — badge, quantity, order type as the
 *      left label, a ✕ that cancels, and a drag that modifies (with a drag
 *      ghost at the previous price and tick-snapped commits);
 *   3. one price line for the open position, carrying its P&L.
 *
 * Every one of those primitives already ships in the vendored package:
 *
 *   - `BuySellButtons` (core) hit-tests to `trade:buy` / `trade:sell` /
 *     `trade:qty` through `chart.subscribeClick`;
 *   - `chart.trading` — the package's `TradingController` — owns the order and
 *     position lines and emits the intent events this module acts on:
 *       `trading:order_cancel`   { orderId }
 *       `trading:order_modify`   { orderId, newPrice, previousPrice }
 *       `trading:position_close` { positionId }
 *       `trading:order_click`    { order }
 *       `trading:position_click` { position }
 *
 * So this file is the *adapter*, not a re-implementation: the books from
 * `/api/terminal/orders` and `/api/terminal/positions` are mapped into the controller's
 * entity shapes, and the controller's events are turned back into
 * `/api/terminal/order/{modify,cancel}` and `/api/terminal/position/close` writes.
 *
 * Wire formats (see `api/routes.py` Terminal*Payload): JSON bodies — the older
 * form-encoded POST answered 422 and never placed anything.
 */

import {
  BuySellButtons,
  TickSchedule,
} from "/static/vendor/openalgo-charts/openalgo-charts.mjs";

/** OpenAlgo's candle pair, the same tones the chart theme uses. */
const UP = "#14b887";
const DOWN = "#f0525f";

/** Minimum gap between two armed fires (terminal.ts ORDER_COOLDOWN_MS). */
export const ORDER_COOLDOWN_MS = 120;

/** Statuses whose lines belong on the chart. */
const WORKING = new Set(["pending", "working", "partial", "open"]);

const num = (v, d = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const money = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "";
  const abs = Math.abs(n);
  const text = abs.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${n >= 0 ? "+" : "-"}₹${text}`;
};

/**
 * One `Order` row (`/api/terminal/orders`) -> the controller's order entity.
 * Returns null for a row that draws nothing (filled, rejected, cancelled, or a
 * market order with no line price).
 */
export function orderLineEntity(row) {
  if (!row) return null;
  const status = String(row.status || "").toLowerCase();
  if (!WORKING.has(status)) return null;
  const price = num(row.triggerPrice, null) ?? num(row.price, 0);
  if (!price) return null;
  const side = String(row.side || "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const type = String(row.type || "LIMIT").toUpperCase();
  return {
    id: String(row.order_id || ""),
    side,
    type,
    price,
    size: Math.max(0, Math.round(num(row.qty, 0))),
    // A stop sits on its trigger; a plain limit drags both ways.
    draggable: true,
    lineWidth: 1,
    lineStyle: type === "MARKET" ? "dashed" : "solid",
    color: side === "BUY" ? UP : DOWN,
    readOnly: false,
  };
}

/**
 * One `Position` row (`/api/terminal/positions`) -> the controller's position
 * entity. Only a non-flat position draws a line.
 */
export function positionEntity(row) {
  if (!row) return null;
  const net = num(row.netQty, 0);
  if (!net) return null;
  const avg = num(row.avgPrice, 0);
  if (!avg) return null;
  const side = net > 0 ? "long" : "short";
  const pnl = num(row.unrealizedPnl ?? row.pnl, null);
  const entity = {
    id: `${String(row.exchange || "").toUpperCase()}:${row.symbol || ""}`,
    side,
    entryPrice: avg,
    size: Math.abs(net),
    readOnly: false,
  };
  if (pnl != null) {
    entity.pnlText = money(pnl);
    const invested = avg * Math.abs(net);
    if (invested > 0) entity.pnlPercent = `${((pnl / invested) * 100).toFixed(2)}%`;
  }
  return entity;
}

/** Tick-snap schedule for drag commits — one band is enough for a single tick. */
function scheduleFor(tick) {
  const t = num(tick, null);
  if (!t || t <= 0) return null;
  try {
    return new TickSchedule([{ tick: t }]);
  } catch {
    return null;
  }
}

/**
 * Snap a price to the instrument's tick. Chart-driven prices come out of a
 * pixel→value inversion with float debris (`1190.37265625` on a 0.10 tick), and
 * the broker rejects those, so round to the tick and print at the tick's own
 * precision (no `0.30000000000000004`).
 */
export function snapToTick(price, tick) {
  const p = num(price, null);
  if (p == null) return null;
  const t = num(tick, null);
  if (!t || t <= 0) return p;
  const dp = Math.min(6, Math.max(0, String(t).split(".")[1]?.length ?? 2));
  return Number((Math.round(p / t) * t).toFixed(dp));
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok) {
    throw new Error(
      (payload && (payload.error || payload.emsg)) || `HTTP ${res.status}`
    );
  }
  return payload || {};
}

/**
 * The layer. One instance per chart cell; `attach()` when the chart exists and
 * `destroy()` when it is rebuilt.
 */
export function createTradeLayer({
  chart,
  socket = null,
  /** () => { symbol, exchange, token, tick, lotSize, qty, product, tradable } */
  getContext,
  /** (message, kind) => void */
  onToast = () => {},
  /** () => void — the qty chip was clicked (host focuses its own qty field) */
  onQty = () => {},
  /** ({ orders, positions, tradable }) => void */
  onBooks = () => {},
  /**
   * (intent) => boolean | Promise<boolean> — gate before a write leaves the
   * page. Hosts use it for one-click parity: return false to abort (the host
   * has already asked the user). Absent = always fire.
   */
  onBeforeOrder = null,
}) {
  const btns = new BuySellButtons({
    id: "trade",
    position: "top-left",
    margin: { x: 14, y: 44 },
    scale: 0.72,
    qty: "",
  });

  const trading = chart.trading;
  let ltp = null;
  let ltpToken = null;
  let orders = [];
  let positions = [];
  let destroyed = false;
  let lastFire = 0;
  let pollTimer = null;
  let polling = false;
  const offs = [];

  const ctx = () => getContext() || {};

  function toast(msg, kind = "") {
    try {
      onToast(msg, kind);
    } catch {
      /* host */
    }
  }

  /** The canvas palette: the candle pair for both the buttons and the lines. */
  function applyColors() {
    const c = ctx();
    trading.setSettings({
      buyColor: c.buyColor || UP,
      sellColor: c.sellColor || DOWN,
      orderColor: c.orderColor || "#7f8db3",
      longColor: UP,
      shortColor: DOWN,
    });
  }

  function refreshButtons() {
    const c = ctx();
    const count = orders.filter((o) => WORKING.has(String(o.status || "").toLowerCase())).length;
    btns.setQty(String(c.qty ?? ""));
    if (ltp != null) btns.setMark(ltp);
    onBooks({ orders, positions, tradable: c.tradable !== false, working: count });
  }

  /** Place an order. `type` is MARKET unless the caller supplies a price. */
  async function place(side, type = "MARKET", price = null) {
    const c = ctx();
    if (c.tradable === false) {
      toast("This instrument is quote-only — nothing to trade", "err");
      return null;
    }
    const now = Date.now();
    if (now - lastFire < ORDER_COOLDOWN_MS) return null;
    lastFire = now;
    if (!c.symbol || !c.exchange) {
      toast("No instrument on the chart yet", "err");
      return null;
    }
    const lots = Math.max(1, Math.floor(num(c.qty, 1)));
    const units = Math.round(lots * Math.max(1, num(c.lotSize, 1)));
    const isStop = type === "SL" || type === "SL-M";
    // A chart price is a pixel→value inversion (`1190.37265625`), and the broker
    // only accepts multiples of the contract's tick — snap every wire price.
    const snapped = snapToTick(price, c.tick);
    const body = {
      symbol: c.symbol,
      exchange: c.exchange,
      side,
      type,
      qty: units,
      product: c.product || "MIS",
      price: type === "MARKET" || type === "SL-M" ? null : snapped,
      triggerPrice: isStop ? snapped : null,
    };
    if (typeof onBeforeOrder === "function") {
      let proceed = true;
      try {
        proceed = await onBeforeOrder({
          symbol: c.symbol,
          exchange: c.exchange,
          side,
          type,
          qty: units,
          product: body.product,
          price: body.price,
          triggerPrice: body.triggerPrice,
        });
      } catch {
        proceed = false;
      }
      if (proceed === false) return null;
    }
    try {
      const answer = await postJson("/api/terminal/order", body);
      if (answer.stat === "Ok") {
        toast(`${side} ${type} ${units} × ${c.symbol} placed${answer.order_id ? ` · ${answer.order_id}` : ""}`, "ok");
        void poll();
        return answer;
      }
      toast(`${side} rejected: ${answer.error || answer.emsg || "unknown"}`, "err");
      return null;
    } catch (e) {
      toast(`${side} failed: ${String(e.message || e).slice(0, 120)}`, "err");
      return null;
    }
  }

  async function cancel(orderId) {
    const row = orders.find((o) => String(o.order_id) === String(orderId));
    try {
      const answer = await postJson("/api/terminal/order/cancel", { orderId: String(orderId) });
      if (answer.stat === "Ok") toast(`Order ${orderId} cancelled`, "ok");
      else toast(`Cancel refused: ${answer.error || answer.emsg || "unknown"}`, "err");
    } catch (e) {
      toast(`Cancel failed: ${String(e.message || e).slice(0, 120)}`, "err");
    }
    void poll();
    return row || null;
  }

  async function modify(orderId, newPrice) {
    const row = orders.find((o) => String(o.order_id) === String(orderId));
    if (!row) return null;
    const stop = ["SL", "SL-M"].includes(String(row.type || "").toUpperCase());
    const snapped = snapToTick(newPrice, ctx().tick);
    const body = {
      orderId: String(orderId),
      exchange: row.exchange,
      symbol: row.symbol,
      type: row.type,
      qty: num(row.qty, null),
      price: stop ? num(row.price, null) : snapped,
      triggerPrice: stop ? snapped : null,
    };
    try {
      const answer = await postJson("/api/terminal/order/modify", body);
      if (answer.stat !== "Ok") {
        toast(`Modify refused: ${answer.error || answer.emsg || "unknown"}`, "err");
        void poll();
        return null;
      }
      return answer;
    } catch (e) {
      toast(`Modify failed: ${String(e.message || e).slice(0, 120)}`, "err");
      void poll();
      return null;
    }
  }

  async function closePosition(positionId) {
    const pos = positions.find(
      (p) => `${String(p.exchange || "").toUpperCase()}:${p.symbol || ""}` === positionId
    );
    if (!pos) return null;
    const net = num(pos.netQty, 0);
    if (!net) return null;
    try {
      const answer = await postJson("/api/terminal/position/close", {
        symbol: pos.symbol,
        exchange: pos.exchange,
        netQty: net,
        product: pos.product || ctx().product || "MIS",
        priceType: "MARKET",
      });
      if (answer.stat === "Ok") toast(`Position ${pos.symbol} squared off`, "ok");
      else toast(`Square off refused: ${answer.error || answer.emsg || "unknown"}`, "err");
      void poll();
      return answer;
    } catch (e) {
      toast(`Square off failed: ${String(e.message || e).slice(0, 120)}`, "err");
      return null;
    }
  }

  /** Refill both lines from the books. Never throws into the chart's frame. */
  async function poll() {
    if (destroyed || polling) return;
    polling = true;
    try {
      const [orderBook, positionBook] = await Promise.allSettled([
        fetch("/api/terminal/orders").then((r) => r.json()),
        fetch("/api/terminal/positions").then((r) => r.json()),
      ]);
      if (destroyed) return;
      if (orderBook.status === "fulfilled" && orderBook.value && orderBook.value.stat === "Ok") {
        orders = Array.isArray(orderBook.value.orders) ? orderBook.value.orders : [];
      }
      if (
        positionBook.status === "fulfilled" &&
        positionBook.value &&
        positionBook.value.stat === "Ok"
      ) {
        positions = Array.isArray(positionBook.value.positions)
          ? positionBook.value.positions
          : [];
      }
      const c = ctx();
      const isMine = (row) =>
        !c.symbol || String(row.symbol || "").toUpperCase() === String(c.symbol).toUpperCase();
      const entities = orders.map(orderLineEntity).filter(Boolean);
      trading.setOrders(entities);
      const posEntities = positions.filter(isMine).map(positionEntity).filter(Boolean);
      trading.setPositions(posEntities);
      refreshButtons();
    } catch {
      /* transient — the next poll repairs */
    } finally {
      polling = false;
    }
  }

  // Tick-snap both the chart's own price lines and the order lines. `chart`
  // forwards the schedule to `chart.trading`, so one call is enough.
  try {
    chart.setTickSchedule(scheduleFor(ctx().tick));
  } catch {
    /* no schedule yet — a coarse drag is better than a dead gesture */
  }
  applyColors();

  // --- canvas interaction -------------------------------------------------
  offs.push(
    chart.subscribeClick((id) => {
      if (id === "trade:buy") return void place("BUY", "MARKET");
      if (id === "trade:sell") return void place("SELL", "MARKET");
      // The package only reports the hit; the qty editor is host chrome.
      if (id === "trade:qty") return void onQty();
      return undefined;
    })
  );

  offs.push(
    trading.on("trading:order_cancel", ({ orderId }) => void cancel(orderId)),
  );
  offs.push(
    trading.on("trading:order_modify", ({ orderId, newPrice }) => void modify(orderId, newPrice)),
  );
  offs.push(
    trading.on("trading:position_close", ({ positionId }) => void closePosition(positionId)),
  );
  offs.push(
    trading.on("trading:order_click", ({ order }) => {
      if (!order) return;
      const px = num(order.price, 0);
      toast(`${order.side} ${order.type} ${order.size} @ ${px}`, "");
    })
  );
  offs.push(
    trading.on("trading:position_click", ({ position }) => {
      if (!position) return;
      const cls = position.side === "long" ? "ok" : "err";
      toast(
        `${position.side.toUpperCase()} ${position.size} @ ${position.entryPrice}${
          position.pnlText ? ` · ${position.pnlText}` : ""
        }`,
        cls
      );
    })
  );

  // The order lines are chart content; the trade buttons are an affordance.
  // The camera path removes the latter for the duration of a capture.
  chart.addPrimitive(btns, 0);

  function onOrderFrame(row) {
    // A live order update only means the books moved: refill them.
    if (!row) return;
    void poll();
  }
  if (socket && typeof socket.onOrderUpdate === "function") {
    socket.onOrderUpdate(onOrderFrame);
  }

  return {
    btns,
    attach() {
      return this;
    },
    /** The books as they were last polled (host readouts + E2E). */
    books() {
      return { orders: orders.slice(), positions: positions.slice(), ltp };
    },
    /** Feed one normalized market_data frame; the LTP marks the buttons. */
    onTick(frame) {
      if (!frame) return false;
      const c = ctx();
      if (!c.token || String(frame.token) !== String(c.token)) return false;
      const px = num(frame.data?.ltp ?? frame.data?.lp, null);
      if (px == null || px <= 0) return false;
      ltp = px;
      ltpToken = String(c.token);
      btns.setMark(px);
      return true;
    },
    /** The instrument changed: re-read tick/qty/product and refill. */
    setContext() {
      const c = ctx();
      // A mark from a DIFFERENT contract would price the panel off the previous
      // symbol until the next tick — drop it (NaN renders as "no price", the
      // primitive's own empty state) instead.
      if (ltpToken && c.token && ltpToken !== String(c.token)) {
        ltp = null;
        ltpToken = null;
        btns.setPrices(NaN, NaN);
      }
      try {
        chart.setTickSchedule(scheduleFor(ctx().tick));
      } catch {
        /* keep the previous schedule */
      }
      refreshButtons();
      void poll();
      return this;
    },
    place,
    cancel,
    modify,
    closePosition,
    poll,
    pngExcludedPrimitive: btns,
    destroy() {
      destroyed = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      for (const off of offs.splice(0)) {
        try {
          off && off();
        } catch {
          /* already gone */
        }
      }
      try {
        chart.removePrimitive(btns);
      } catch {
        /* chart gone */
      }
      try {
        trading.clear();
      } catch {
        /* chart gone */
      }
    },
    startPolling(ms = 5000) {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(() => void poll(), ms);
      void poll();
      return this;
    },
  };
}
