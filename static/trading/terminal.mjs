/**
 * TradingTerminal — the OpenAlgoNew `terminal.ts` port for NexAlgo, driving the
 * vendored openalgo-charts core `createChart` (NOT the widget tier).
 *
 * Charts-only scope round (chart types + transformed charts + brick renderers
 * + ghost/projections + volume + legend + viewport). Deferred on this class,
 * wired in their rounds: indicators, replay, alerts, comparisons, drawings,
 * profile layers, LtpTag axis pill, screenshots, expression symbols,
 * session-hours calendar (their market-timings server has no NexAlgo
 * equivalent), price-axis command shortcuts, order wire.
 */

import {
  createChart,
  withBarCache,
  DataLoadingController,
  BuySellButtons,
  exportChartDataCsv,
  compactVolume,
  getIndicator,
  registeredIndicators,
  indicatorDefaults,
  indicatorStyleInputs,
} from "/static/vendor/openalgo-charts/openalgo-charts.mjs";
import { provisionalElementsOf } from "/static/vendor/openalgo-charts/openalgo-renko-adjacent.mjs";

import {
  INTERVAL_SECONDS,
  TerminalFeed,
  resolveToken,
} from "./terminal_feed.mjs";
import { CHART_TYPES, isBoxChartType, volumeUnderElements } from "./chart_types.mjs";
import {
  buildChartTheme,
  volumeColor,
  quietVolumeStyle,
  volumeValues,
  volumePoint,
  volumeAverage,
  volumeAveragePoint,
  chartMotionOptions,
} from "./chart_theme.mjs";
import { registerBrickRenderers } from "./brick_renderer.mjs";
import {
  tickSize,
  priceDp,
  fmtPrice,
  snapTick,
} from "./format.mjs";
import {
  buildChartLegend,
  legendToneStyle,
  resolveCssColor,
} from "./legend.mjs";
import { csvOptions } from "./chart_data_export.mjs";
import {
  CHART_READY,
  chartLoadFailed,
  chartNoData,
  traderReason as traderReasonText,
} from "./chart_state.mjs";

/* Legend geometry copied from their terminal.ts paintLegend. */
const LEGEND_X = 12;
const LEGEND_Y = 8;
const LEGEND_GAP = 6;

const VISIBLE_BARS = 120;
const RIGHT_PAD_BARS = 4;
const TRANSFORM_CHOICES_KEPT = 64;

const QUOTE_ONLY = new Set(); // Noren feeds always carry volume for listed segs

/* ── the terminal ──────────────────────────────────────────────────────────── */

export class TradingTerminal {
  constructor({ host, socket, notify, tradeUi }) {
    this.container = host;
    this.socket = socket;
    this.notify = notify || (() => {});
    this.tradeUi = tradeUi || {}; // { qtyEl, onBuy, onSell } — pills stay visual

    this.destroyed = false;
    this.chart = null;
    this.price = null;
    this.volume = null;
    this.volumeMA = null;
    this.feed = null;
    this.data = null;
    this.offData = null;
    this.tradeBtns = null;

    this.sym = null; // {symbol, exchange, token, tsym, tick}
    this.interval = "5m";
    this.ctype = "candlestick";
    this.themeName = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    this.chartTheme = null;

    this.tickCache = 0;
    this.refPriceCache = 0;
    this.rawBars = [];
    this.shownCount = 0;
    this.lastLtp = null;
    this.legendTime = null;
    this.legendBar = null;
    this.legendPrevClose = null;

    this.displayedVolume = [];
    this.volumeOn = true;
    this.volumeSettings = {}; // the volume-settings dialog round replaces this

    this.projectionBars = [];
    this.projectionAnchorTime = NaN;
    this.ghostBrick = null;

    this.loadTicket = 0;
    this.chartDataKey = null;
    this.noMoreHistory = false;

    this.transformBase = null;
    this.transformChoices = this.lsGet("transforms") || {};

    // The state each load reports to the page's gate + overlay (their
    // onChartState), and the primitives that never enter an exported image.
    this.onChartState = null;
    this.screenshotExcluded = [];

    this.tickColors = { up: "#00958a", down: "#F23645" };

    // ── indicators (Round B) ──────────────────────────────────────────
    this.onIndicatorsChange = null;
    this.onIndicatorSettings = null;
    this.activeIndicators = []; // {instanceId, indicatorId, name, settings, paneIndex, visible}
    this.announcedIndicators = [];
    this.indicatorsLoaded = false;
    this.applyingIndicators = false;

    // The data path lives ONCE per terminal (their initialize parity): cache
    // (origin feed) → controller. Chart rebuilds (type/theme) never re-make
    // it — the controller keeps paging while the canvas is rebuilt around it.
    this.feed = new TerminalFeed(this.socket);
    const cached = withBarCache(this.feed, { ttlMs: 10 * 60_000 });
    this.data = new DataLoadingController(cached, {
      pollIntervalMs: 30_000,
      refreshOnBarClose: true,
      refreshOnGap: true,
      refreshWindowBars: 5,
      pageSize: 500,
      maxEmptyPages: 4,
      maxBars: 100_000,
    });
    this.offData = this.data.subscribe((snap) => this.applyDataSnapshot(snap));
  }

  /* ── storage (their lsSet/lsGet: namespaced keys) ─────────────────────────── */

  lsGet(key) {
    try {
      const v = localStorage.getItem(`cognix_terminal_${key}`);
      if (v == null) return null;
      if (key === "transforms") return JSON.parse(v);
      return v;
    } catch {
      return null;
    }
  }

  lsSet(key, value) {
    try {
      localStorage.setItem(`cognix_terminal_${key}`, String(value));
    } catch {
      /* storage off */
    }
  }

  /* ── tick / price helpers (format.mjs-backed) ─────────────────────────────── */

  refPrice() {
    return this.refPriceCache || (this.rawBars.length ? this.rawBars[this.rawBars.length - 1].close : 0);
  }
  tick() {
    return tickSize(this.sym?.tick, this.refPrice());
  }
  dp() {
    return priceDp(this.sym?.tick, this.refPrice());
  }
  fmt(n) {
    return fmtPrice(n, this.sym?.tick, this.refPrice());
  }

  /** History lookback (days) per interval — intervals.ts lookbackDays parity. */
  lookbackDays(interval) {
    const i = interval === "1d" ? "D" : interval;
    const m = /^(\d+)([smh])$/.exec(i);
    if (m) {
      const n = Number(m[1]);
      if (m[2] === "s") return 2;
      if (m[2] === "m") return n <= 1 ? 7 : n <= 5 ? 30 : n <= 15 ? 60 : 120;
      return 180; // hours
    }
    if (i === "D") return 3 * 365;
    return 30;
  }

  /* ── load a symbol ────────────────────────────────────────────────────────── */

  /** Resolve happened upstream; `pick` carries `{symbol, exchange, token}`. */
  async boot(pick) {
    if (this.destroyed) return;
    this.rawBars = [];
    this.shownCount = 0;
    this.lastLtp = null;
    this.legendTime = null;
    this.sym = { ...pick, tick: 0 };
    // Instrument tick before the chart builds — boxOf, snappers and the price
    // format all read it. A refused quote (closed market) keeps the 0.05 fallback.
    const q = await fetchTick(pick.exchange, pick.token);
    if (!this.destroyed && q) {
      this.sym.tick = q.tick_size;
      this.refPriceCache = q.ltp || 0;
    }
    // Their load path builds the chart only once a snapshot delivers bars —
    // a movement-driven type's box must come from the HISTORY's last close,
    // so building on empty rawBars would freeze a fallback-sized transform
    // onto the instrument. The controller's first snapshot builds it.
    await this.kickLoad();
  }  stopFeed() {
    if (this.offData) {
      try { this.offData(); } catch { /* off */ }
      this.offData = null;
    }
    if (this.data) {
      try { this.data.destroy(); } catch { /* */ }
      this.data = null;
    }
  }

  /* ── chart-type / interval switching (terminal.ts parity) ─────────────────── */

  setChartType(v) {
    if (!CHART_TYPES[v]) return this.ctype;
    // Profile kinds arrive with the profile-layer round.
    if (CHART_TYPES[v].pending) {
      this.notify(`${CHART_TYPES[v].label} — profile layers round`, "err");
      return this.ctype;
    }
    this.ctype = v;
    this.lsSet("ctype", v);
    if (this.rawBars.length) this.buildChart();
    return v;
  }

  setInterval(iv) {
    if (iv === this.interval) return this.interval;
    this.interval = iv;
    this.lsSet("interval", iv);
    if (this.sym) this.reloadCurrent();
    return iv;
  }

  /** Range stub — history round wires real lookback here. */
  setRange(range) {
    this.notify(`Range ${range} — history round`, "");
    return range;
  }

  reloadCurrent() {
    if (!this.sym) return;
    // No eager buildChart: the new interval's history snapshot changes the
    // data key, and applyDataSnapshot's mismatch branch rebuilds the chart
    // with the NEW bars — a transformed type's box re-sizes from the new
    // interval's last close. Pre-setting the key (or building on stale bar
    // arrays) would freeze the old box, same trap as boot().
    void this.kickLoad();
  }

  applyTheme() {
    this.themeName = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    if (this.chart && this.rawBars.length) this.buildChart();
  }

  /* ── transform choices: the Box settings ──────────────────────────────────── */

  transformChoiceKey() {
    return this.sym ? `${this.sym.exchange}:${this.sym.symbol}` : null;
  }

  /** The spec to build with: the base, with the choice kept for this instrument and type. */
  chosenTransform(base) {
    const key = this.transformChoiceKey();
    const chosen = key ? this.transformChoices[key]?.[this.ctype] : undefined;
    if (!chosen || typeof chosen !== "object") return base;
    return { type: base.type, options: { ...base.options, ...chosen } };
  }

  /* ── chart types (transforms bucket volume onto their own element times) ──── */

  boxOf() {
    const c = this.rawBars.length ? this.rawBars[this.rawBars.length - 1].close : 100;
    const t = this.tick();
    return Math.max(t, Number((Math.round((c * 0.0015) / t) * t).toFixed(this.dp())));
  }

  /**
   * Whether the chart applies a transform to the price series (Heikin Ashi,
   * Renko, range bars, line break, Point & Figure, Kagi). Read from the chart
   * rather than from `ctype`, which moves before the chart is rebuilt for it.
   */
  transformed() {
    return this.chart !== null && this.price !== null && this.chart.seriesTransform(this.price) !== null;
  }

  /**
   * What the price series is actually showing: `rawBars`, or the elements the
   * chart formed from them for the chart type's transform.
   */
  get shownBars() {
    return this.chart && this.transformed() ? this.chart.primaryBars() : this.rawBars;
  }

  /**
   * A drawn element with the volume the volume bars show under it.
   */
  withDrawnVolume(bar) {
    if (!bar || !this.transformed()) return bar;
    const points = this.displayedVolume;
    let lo = 0;
    let hi = points.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (points[mid].time === bar.time) return { ...bar, volume: points[mid].close };
      if (points[mid].time < bar.time) lo = mid + 1;
      else hi = mid - 1;
    }
    return { ...bar, volume: undefined };
  }

  /** The brick box the transform is running with (a chosen 0 means history-sized). */
  brickBoxOf() {
    const transform = this.price ? this.chart?.seriesTransform(this.price) : null;
    const given = Number(transform?.options?.boxSize);
    return given > 0 ? given : this.boxOf();
  }

  /* ── build the chart (terminal.ts buildChart parity, charts-only scope) ───── */

  buildChart() {
    if (this.destroyed) return;
    // Terminal.ts teardown parity for the CANVAS: the old chart is destroyed
    // before the host DOM clears. (The feed + controller live once per
    // terminal — constructor — and must never be torn down from here.)
    if (this.chart) {
      try { this.chart.destroy(); } catch { /* */ }
      this.chart = null;
    }
    this.container.innerHTML = "";
    this.chartTheme = buildChartTheme(this.themeName);
    // Brick-based charts (Renko, Line Break) should have bricks touching
    const isBrickChart = this.ctype === "renko" || this.ctype === "line-break";
    if (isBrickChart) this.registerBrickChartRenderer();

    this.chart = createChart(this.container, {
      priceAxisWidth: 78,
      theme: this.chartTheme,
      timeScale: isBrickChart ? { minBarSpacing: 1 } : undefined,
      axisChrome: { sessionClock: { showOffset: true }, barCountdown: true },
      doubleClick: "maximize",
      zoomAnchor: "right",
      shortcuts: {
        disabledCommands: ["screenshot", "toggleGridVert", "toggleGridHorz"],
        // priceAxisShortcuts land with the price-axis round
      },
      legendOffset: { top: 80 },
      ...chartMotionOptions(),
    });
    this.chart.setDataContext(
      this.sym
        ? {
            symbol: this.sym.symbol,
            exchange: this.sym.exchange,
            interval: this.interval,
            hasOpenInterest: false,
          }
        : { interval: this.interval }
    );

    const cfg = CHART_TYPES[this.ctype] || CHART_TYPES.candlestick;
    const dp = this.dp();
    let styleAdd = {};
    if (cfg.baseline && this.rawBars.length) {
      styleAdd = {
        baseValue: this.rawBars.reduce((s, b) => s + b.close, 0) / (this.rawBars.length || 1),
      };
    }
    // A movement-driven type has the chart apply its transform to the raw bars
    // this series is fed, forming the elements again on every tick.
    const base = cfg.transform ? cfg.transform(this.boxOf()) : null;
    this.transformBase = base;
    const priceSeries = (transform) =>
      this.chart.addSeries(cfg.series, {
        ...styleAdd,
        priceFormat: { type: "custom", formatter: (p) => p.toFixed(dp) },
        ...(transform ? { transform } : {}),
      });
    try {
      this.price = priceSeries(base ? this.chosenTransform(base) : null);
    } catch {
      // A kept choice this build refuses throws before the series exists. The
      // chart opens on the base instead; the choice goes when one is next saved.
      this.price = priceSeries(base);
    }
    // Brick-based charts (Renko, Line Break) should have bricks touching without borders
    if (isBrickChart) this.price.applyOptions({ borderVisible: false });
    // Tell the engine the instrument's tick.
    const tick = this.tick();
    if (tick > 0) this.chart.setPriceScaleOptions({ minMove: tick });

    // Volume rides an OVERLAY price scale inside the price pane (their parity).
    this.volume = this.chart.addSeries(isBrickChart ? "brick-volume" : "histogram", {
      paneIndex: 0,
      priceScaleId: "",
      style: { color: volumeColor(this.themeName) },
      priceFormat: { type: "volume" },
    });
    this.volume.priceScale().setOptions({ marginTop: 0.82, marginBottom: 0 });
    this.volumeMA = null;
    this.displayedVolume = [];
    if (!this.volumeOn || !this.volumeAvailable()) this.volume.applyOptions({ visible: false });

    // inline SELL · qty · BUY panel, docked top-left below the OHLC legend.
    // VISUAL ONLY — the order wire attaches in the trade round.
    const lp =
      this.lastLtp != null
        ? this.lastLtp
        : this.rawBars.length
          ? this.rawBars[this.rawBars.length - 1].close
          : null;
    this.tradeBtns = new BuySellButtons({
      id: "trade",
      position: "top-left",
      margin: { x: 14, y: 44 },
      qty: this.tradeUi.qty(),
      scale: 0.72,
    });
    if (lp != null) this.tradeBtns.setMark(lp);
    // Trade buttons are interaction chrome: they come down for a screenshot
    // and go back up after (their addExcludedPrimitive semantics).
    this.screenshotExcluded.length = 0;
    this.addExcludedPrimitive(this.tradeBtns, 0);

    this.chart.subscribeCrosshairMove((e) => {
      this.legendTime = e.bar?.time ?? null;
      this.refreshLegend();
    });

    this.setPriceData();
    this.applyDefaultViewport();
    // The explicit `data.load(request)` is the kick — the controller stays
    // idle without it. Called once per boot / interval change (see reloadCurrent).
  }

  volumeAvailable() {
    return this.sym ? !QUOTE_ONLY.has(this.sym.exchange) : true;
  }

  async kickLoad() {
    if (this.destroyed || !this.data || !this.sym) return;
    const to = Math.floor(Date.now() / 1000);
    const request = {
      symbol: this.sym.symbol,
      exchange: this.sym.exchange,
      interval: this.interval,
      from: to - this.lookbackDays(this.interval) * 86400,
      to,
    };
    this.emitChartState({ kind: "loading", symbol: this.sym.symbol, interval: this.interval });
    try {
      await this.data.load(request);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      this.emitChartState(chartLoadFailed(this.sym.symbol, this.interval, msg));
      this.notify(`History load failed — ${msg}`, "err");
      if (this.onStatus) this.onStatus(`load failed: ${msg}`);
    }
  }

  /** The terminal's latest load state, read by the page's gate + overlay. */
  emitChartState(view) {
    if (this.onChartState) this.onChartState(view);
  }

  /** Reset returns to the view the chart opened at, not to the whole of history. */
  resetScale() {
    if (!this.chart) return;
    this.chart.resetScale();
    this.applyDefaultViewport();
  }

  applyDefaultViewport() {
    if (!this.chart) return;
    const isBrickChart = this.ctype === "renko" || this.ctype === "line-break";
    const targetBarSpacing = isBrickChart ? 1 : 14;
    if (this.shownCount > VISIBLE_BARS) {
      const to = this.shownCount - 1 + RIGHT_PAD_BARS;
      this.chart.timeScale.setVisibleLogicalRange({ from: to - VISIBLE_BARS, to });
    } else if (this.chart.timeScale.barSpacing > targetBarSpacing) {
      this.chart.timeScale.setBarSpacing(targetBarSpacing);
    }
  }

  registerBrickChartRenderer() {
    const me = this;
    registerBrickRenderers(this.chartTheme, {
      get ctype() { return me.ctype; },
      get modeName() { return me.themeName; },
      projections() { return me.projectionBars; },
      projectionAnchor() { return me.projectionAnchorTime; },
      ghost() { return me.ghostBrick; },
      replayOwnsDisplay() { return false; },
    });
  }

  /* ── data: series feeding ─────────────────────────────────────────────────── */

  dataKey(request) {
    return `${request.exchange}:${request.symbol}:${request.interval}`;
  }

  setPriceData() {
    if (!this.price || !this.volume || !this.rawBars.length) return;
    // Always the raw bars. On a transformed chart type the chart forms the
    // elements from them, so a tick, history paging and replay all speak bars.
    this.price.setData(this.rawBars);
    // The ghost reads the elements first, volume folds the running volume onto
    // the ghost's own column after it.
    this.updateGhostBrick();
    if (this.transformed()) this.setTransformedVolume(this.rawBars);
    else this.setVolumeData(this.rawBars);
    this.shownCount = this.shownBars.length;
    this.refreshLegend();
  }

  /** Volume on the elements drawn: each element sums the raw bars it was formed from. */
  setTransformedVolume(raw) {
    if (!this.chart) return;
    const drawn = this.chart.primaryBars();
    const under = volumeUnderElements(drawn, raw);
    let prices = drawn;
    // The FORMING candle's running volume rides the tail column: the ghost's
    // own slot while nothing has crossed yet, else the last projection
    // brick's column — even before the first brick has PRINTED.
    const lastTime = drawn.length ? drawn[drawn.length - 1].time : -Infinity;
    let rest = 0;
    for (const bar of raw) if (bar.time > lastTime) rest += bar.volume ?? 0;
    const ghost = this.ctype === "renko" ? this.ghostBrick : null;
    if (rest > 0 && (ghost || this.projectionBars.length)) {
      const lastUnder = under[under.length - 1];
      if (lastUnder) {
        lastUnder.high = Math.max(0, lastUnder.high - rest);
        lastUnder.close = Math.max(0, lastUnder.close - rest);
      }
      if (ghost) {
        prices = [
          ...drawn,
          {
            time: ghost.time,
            open: ghost.open,
            high: Math.max(ghost.open, ghost.close),
            low: Math.min(ghost.open, ghost.close),
            close: ghost.close,
          },
        ];
        under.push({ time: ghost.time, open: 0, high: rest, low: 0, close: rest });
      } else {
        const tail = this.projectionBars[this.projectionBars.length - 1];
        prices = [...drawn, tail];
        under.push({ time: tail.time, open: 0, high: rest, low: 0, close: rest });
      }
    }
    this.setVolumeData(prices, under);
  }

  volumeCandleStyle() {
    const theme = this.chart?.theme?.() ?? this.chartTheme;
    const style = {
      upColor: theme?.upColor,
      downColor: theme?.downColor,
      ...(this.chart?.primarySeriesInfo ? this.chart.primarySeriesInfo().style : {}),
    };
    return quietVolumeStyle(style, theme?.background || "#0b0e17");
  }

  setVolumeData(prices, amounts) {
    if (!this.volume || !this.chart) return;
    const settings = volumeValues(this.volumeSettings);
    const style = this.volumeCandleStyle();
    const byTime = amounts ? new Map(amounts.map((bar) => [bar.time, bar.close])) : null;
    this.displayedVolume = prices.map((bar, index) =>
      volumePoint(
        bar,
        prices[index - 1]?.close,
        byTime?.get(bar.time) ?? bar.volume ?? 0,
        style,
        settings["volume.colorByDirection"] === true
      )
    );
    this.volume.setData(this.displayedVolume);
    if (!this.volumeMA) {
      this.volumeMA = this.chart.addSeries("line", {
        paneIndex: 0,
        priceScaleId: "",
        priceFormat: { type: "volume" },
        style: { priceLineVisible: false, lastValueVisible: false },
      });
    }
    this.volumeMA.applyOptions({
      visible:
        this.volumeOn &&
        this.volumeAvailable() &&
        settings["volume.showMA"] === true,
      color: String(settings["volume.maColor"]),
      lineWidth: Number(settings["volume.maWidth"]),
      lineStyle: settings["volume.maStyle"],
    });
    if (settings["volume.showMA"] === true)
      this.volumeMA.setData(volumeAverage(this.displayedVolume, Number(settings["volume.maPeriod"])));
  }

  /**
   * Push one bar into the live series without rebuilding either of them.
   * Returns false when the caller must rebuild instead.
   */
  updateLiveBar(bar) {
    if (!this.price || !this.volume) return false;
    this.price.update(bar);
    if (this.transformed()) {
      this.updateGhostBrick();
      this.setTransformedVolume(this.rawBars);
      this.shownCount = this.shownBars.length;
      return true;
    }
    const settings = volumeValues(this.volumeSettings);
    const point = volumePoint(
      bar,
      this.rawBars[this.rawBars.length - 2]?.close,
      bar.volume ?? 0,
      this.volumeCandleStyle(),
      settings["volume.colorByDirection"] === true
    );
    const last = this.displayedVolume.length - 1;
    if (last >= 0 && this.displayedVolume[last].time === point.time)
      this.displayedVolume[last] = point;
    else this.displayedVolume.push(point);
    this.volume.update(point);
    if (settings["volume.showMA"] && this.volumeMA) {
      this.volumeMA.update(
        volumeAveragePoint(this.displayedVolume, this.displayedVolume.length - 1, Number(settings["volume.maPeriod"]))
      );
    }
    this.shownCount = this.rawBars.length;
    return true;
  }

  /**
   * The slot the live LTP occupies next to the last element, drawn shaded
   * rather than settled, plus the forming bar's projection columns (Renko /
   * Line Break, via the adjacent transforms' provisional elements).
   */
  updateGhostBrick() {
    this.projectionBars =
      this.transformed() && (this.ctype === "renko" || this.ctype === "line-break")
        ? provisionalElementsOf()
        : [];
    this.projectionAnchorTime = NaN;
    this.ghostBrick = null;
    if (this.lastLtp == null || !this.chart || !this.transformed()) return;
    const elements = this.chart.primaryBars();
    if (!elements.length) return;
    const last = elements[elements.length - 1];
    this.projectionAnchorTime = this.projectionBars.length ? last.time : NaN;
    // While the forming bar has already printed bricks, the projection
    // columns themselves show what is forming.
    if (this.projectionBars.length) return;
    const price = this.lastLtp;
    if (this.ctype === "renko") {
      const box = this.brickBoxOf();
      const upTrend = last.close >= last.open;
      let open;
      let close;
      if (upTrend) {
        if (price > last.close) {
          open = last.close;
          close = price;
        } else if (price < last.close - box) {
          open = last.close - box;
          close = price;
        } else return;
      } else {
        if (price < last.close) {
          open = last.close;
          close = price;
        } else if (price > last.close + box) {
          open = last.close + box;
          close = price;
        } else return;
      }
      // A legitimate forming brick is never taller than one box.
      if (Math.abs(close - open) > box) return;
      this.ghostBrick = { open, close, time: last.time + 1, anchor: last.time };
    } else if (this.ctype === "line-break") {
      if (elements.length < 2) return;
      const lines = Number(this.chart.seriesTransform(this.price)?.options?.lines ?? 3);
      const n = Math.max(1, Number.isFinite(lines) ? Math.floor(lines) : 3);
      const window = elements.slice(-n);
      let lowN = Infinity;
      let highN = -Infinity;
      for (const line of window) {
        lowN = Math.min(lowN, line.low);
        highN = Math.max(highN, line.high);
      }
      if (last.close >= last.open) {
        // Uptrend: the red line will hang off the last green's low edge.
        if (price < last.low && price > lowN) {
          this.ghostBrick = { open: last.low, close: price, time: last.time + 1, anchor: last.time };
        }
      } else {
        // Downtrend: the green line will hang off the last red's high edge.
        if (price > last.high && price < highN) {
          this.ghostBrick = { open: last.high, close: price, time: last.time + 1, anchor: last.time };
        }
      }
    }
  }

  /* ── controller snapshots: apply to this symbol session only ──────────────── */

  applyDataSnapshot(snapshot) {
    const request = snapshot.request;
    const sym = this.sym;
    if (
      this.destroyed ||
      !request ||
      !sym ||
      request.symbol !== sym.symbol ||
      request.exchange !== sym.exchange ||
      request.interval !== this.interval
    )
      return;
    const key = this.dataKey(request);
    if (!this.chart || !this.price || !this.volume || this.chartDataKey !== key) {
      // A build BEFORE this snapshot carries bars would size a transformed
      // type off the empty-history fallback close (0.15% of 100) and consume
      // the key, freezing a bogus box onto the instrument. Wait for the
      // history-shaped snapshot instead — the old chart just stays up a beat.
      if (!snapshot.bars?.length) {
        this.emitChartState(chartNoData(sym.symbol, this.interval));
        return;
      }
      // The chart on canvas is not this snapshot's session (a load race or a
      // switch mid-flight): seed the forming-bucket grid where the snapshot
      // has history bars and rebuild — buildChart restarts the load chain.
      this.chartDataKey = key;
      if (snapshot.reason !== "live" && snapshot.reason !== "state" && snapshot.bars?.length) {
        this.rawBars = [...snapshot.bars];
        this.feed.adoptSeed(request, snapshot.bars[snapshot.bars.length - 1]);
      }
      this.buildChart();
      this.emitChartState(CHART_READY);
      return;
    }
    this.noMoreHistory = snapshot.hasMore === false;

    // One-bar LIVE pushes reach the O(1) tail path; the controller keeps the
    // full store, we splice the tail into rawBars and update both series.
    if (snapshot.reason === "live" && snapshot.bars?.length) {
      const tail = snapshot.bars[snapshot.bars.length - 1];
      const last = this.rawBars[this.rawBars.length - 1];
      if (last && tail.time === last.time) this.rawBars[this.rawBars.length - 1] = tail;
      else this.rawBars.push(tail);
      this.updateLiveBar(tail);
      this.refreshLegend();
      return;
    }
    if (snapshot.reason === "state") return;

    const owned = snapshot.paused ? this.data?.bars?.() : snapshot.bars;
    if (!owned?.length) {
      if (!this.rawBars.length) this.emitChartState(chartNoData(sym.symbol, this.interval));
      return;
    }
    const next = [...owned];
    const chart = this.chart;
    const before = snapshot.reason === "prepend" ? chart?.getVisibleLogicalRange() : null;
    const countBefore = this.shownCount;

    this.rawBars = next;

    // History's view of the bar still forming: re-anchor the live bucket
    // builder on the loaded tail (only on history-shaping reasons).
    if (snapshot.reason !== "refresh" || this.chartDataKey !== key) {
      this.feed.adoptSeed(request, next[next.length - 1]);
    }

    this.setPriceData();
    this.emitChartState(CHART_READY);
    this.syncIndicators();

    // Prepending shifts logical indexes. Preserve the same candles in view,
    // including for transformed charts whose output count differs from OHLC.
    const inserted = this.shownCount - countBefore;
    if (snapshot.reason === "prepend" && before && inserted > 0 && chart && this.chart === chart) {
      chart.setVisibleLogicalRange({ from: before.from + inserted, to: before.to + inserted });
    }
    if (this.onStatus) this.onStatus(`bars: ${this.rawBars.length}`);
    if (snapshot.error) this.notify(snapshot.error.message || String(snapshot.error), "err");
  }

  /* ── live ticks from the shared socket ────────────────────────────────────── */

  onTick(frame) {
    const sym = this.sym;
    if (!sym || frame.key !== `${sym.exchange}|${sym.token}`) return;
    const d = frame.data || {};
    const ltp = Number(d.ltp != null ? d.ltp : d.lp);
    if (!(Number.isFinite(ltp) && ltp > 0)) return;
    this.lastLtp = ltp;
    this.refPriceCache = ltp;
    if (this.tradeBtns) this.tradeBtns.setMark(ltp);
    // Renew the forming slot on a quantised chart with the fresh LTP.
    if (this.transformed()) {
      this.updateGhostBrick();
      this.setTransformedVolume(this.rawBars);
    }
    if (this.onQuote) this.onQuote(ltp);
  }

  /* ── legend (their refreshLegend runs: name, interval, type, OHLC, change) ── */

  drawnBars() {
    return this.chart && this.transformed() ? this.chart.primaryBars() : this.rawBars;
  }

  refreshLegend() {
    if (!this.onLegend) return;
    const bars = this.drawnBars();
    const t = this.legendTime;
    const bar = (t != null ? bars.find((b) => b.time === t) : null) ?? bars[bars.length - 1] ?? null;
    const shown = this.withDrawnVolume(bar);
    // The legend's change reads the bar before the hovered one (legend.ts).
    const idx = bar ? bars.indexOf(bar) : -1;
    const prevClose = idx > 0 ? bars[idx - 1].close : null;
    // The same model the PNG export paints (legend.mjs: one builder, two
    // renderers — the saved image and the screen must agree).
    this.legendBar = shown;
    this.legendPrevClose = prevClose;
    this.onLegend({
      symbol: this.sym?.symbol || "—",
      exchange: this.sym?.exchange || "—",
      interval: this.interval,
      typeLabel: CHART_TYPES[this.ctype]?.label || "",
      bar: shown,
      prevClose,
      barsCount: bars.length,
      dp: this.dp(),
      ltp: this.lastLtp,
    });
  }

  /* ── the Box settings dialog (isBoxChartType types) ───────────────────────── */

  openBoxSettings() {
    if (!isBoxChartType(this.ctype)) return;
    const dlg = document.createElement("dialog");
    dlg.className = "tt-dialog";
    const key = this.transformChoiceKey();
    const saved = (key && this.transformChoices[key]?.[this.ctype]) || null;
    const base = this.transformBase?.options || {};
    const boxInput = saved?.boxSize ?? base.boxSize ?? "";
    dlg.innerHTML = `
      <div class="tt-box-head"><b>${CHART_TYPES[this.ctype].label} settings</b></div>
      <label class="tt-field">Box size — blank = auto (0.15% of last close, tick-snapped)
        <input class="tt-box-input" type="number" min="0" value="${boxInput ?? ""}" />
      </label>
      <div class="tt-box-row">
        <span class="tt-mutedlite">Current box: ${this.fmt(this.brickBoxOf())}</span>
        <span class="tt-growth"></span>
        <button class="tt-btn" data-act="reset">Reset</button>
        <button class="tt-btn" data-act="save">Apply</button>
      </div>`;
    document.body.appendChild(dlg);
    const input = dlg.querySelector("input");
    dlg.showModal();
    input.focus();
    const close = () => dlg.close();
    dlg.addEventListener("close", () => dlg.remove());
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) close();
    });
    dlg.querySelector('[data-act="reset"]').onclick = () => {
      this.forgetTransformChoice();
      close();
      if (this.rawBars.length)
        this.buildChart();
    };
    dlg.querySelector('[data-act="save"]').onclick = () => {
      const v = Number(input.value);
      this.rememberTransformChoice(Number.isFinite(v) && v > 0 ? v : null);
      close();
      if (this.rawBars.length)
        this.buildChart();
    };
  }

  /** Keep the chosen box for this instrument and type; null drops the entry. */
  rememberTransformChoice(boxSize) {
    const key = this.transformChoiceKey();
    if (!key) return;
    const forInstrument = { ...this.transformChoices[key] };
    if (boxSize != null) forInstrument[this.ctype] = { boxSize };
    else delete forInstrument[this.ctype];
    const next = { ...this.transformChoices };
    delete next[key];
    if (Object.keys(forInstrument).length) next[key] = forInstrument;
    const keys = Object.keys(next);
    for (const old of keys.slice(0, Math.max(0, keys.length - TRANSFORM_CHOICES_KEPT))) delete next[old];
    this.transformChoices = next;
    this.lsSet("transforms", JSON.stringify(next));
  }

  forgetTransformChoice() {
    this.rememberTransformChoice(null);
  }

  /** The elements were formed again from the same bars: their count and their volume moved. */
  afterTransformChange() {
    this.shownCount = this.shownBars.length;
    this.refreshLegend();
  }

  /* ── indicators (Round B) ─────────────────────────────────────────── */

  /** The registered indicator catalogue (loads the indicator tier on first use). */
  async indicatorCatalog() {
    if (!this.indicatorsLoaded) {
      try {
        await import("/static/vendor/openalgo-charts/openalgo-charts.indicators.mjs");
        await import("/static/vendor/openalgo-charts/openalgo-charts.mjs");
      } catch { /* */ }
      this.indicatorsLoaded = true;
    }
    const reg = registeredIndicators();
    return reg.map((d) => ({ id: d.id, name: d.name || d.id, category: d.category || "Studies" }));
  }

  /** The live indicators, for the picker and persistence. */
  listIndicators() {
    if (!this.chart) return [];
    return this.chart.indicators().map((i) => ({
      id: i.id,
      indicatorId: i.indicatorId,
      name: i.name || i.indicatorId,
    }));
  }

  /** Sync the active-indicator list with the chart and announce changes to the page. */
  syncIndicators() {
    if (!this.chart || this.applyingIndicators) return;
    const next = (this.chart.indicators() || []).map((i) => {
      const rec = this.activeIndicators.find((r) => r.instanceId === i.id) || {};
      return {
        instanceId: i.id,
        indicatorId: i.indicatorId,
        name: i.name || i.indicatorId,
        settings: i.settings?.() ?? rec.settings ?? {},
        visible: rec.visible !== undefined ? rec.visible : true,
        paneIndex: rec.paneIndex ?? 0,
      };
    });
    const changed = JSON.stringify(next) !== JSON.stringify(this.activeIndicators);
    this.activeIndicators = next;
    const announced = this.listIndicators().map(({ id, name }) => ({ id, name }));
    const annChanged =
      announced.length !== this.announcedIndicators.length ||
      announced.some((a, i) => a.id !== this.announcedIndicators[i]?.id || a.name !== this.announcedIndicators[i]?.name);
    if (annChanged) {
      this.announcedIndicators = announced;
      if (this.onIndicatorsChange) this.onIndicatorsChange(announced);
    }
    return changed;
  }

  /** Add an indicator by id, with defaults. */
  async addIndicatorById(id) {
    if (!this.chart) throw new Error("The chart is not ready");
    try {
      await import("/static/vendor/openalgo-charts/openalgo-charts.indicators.mjs");
      await import("/static/vendor/openalgo-charts/openalgo-charts.mjs");
    } catch { /* */ }
    this.indicatorsLoaded = true;
    const inst = this.chart.addIndicator(id, {});
    if (inst) {
      this.syncIndicators();
      return inst;
    }
    return null;
  }

  /** Remove a live indicator by instance id. */
  removeIndicatorById(instanceId) {
    if (!this.chart) return;
    this.chart.removeIndicator(instanceId);
    this.syncIndicators();
  }

  /** Open the settings form for a live indicator (hands the page a field spec). */
  async openIndicatorSettings(instanceId) {
    if (!this.chart || !this.onIndicatorSettings) return;
    const inst = (this.chart.indicators() || []).find((i) => i.id === instanceId);
    if (!inst) return;
    const descriptor = getIndicator(inst.indicatorId);
    if (!descriptor) return;
    const fields = (indicatorStyleInputs(descriptor) || []).map((f) => ({
      key: f.key,
      type: f.type,
      label: f.label || f.key,
      group: f.group,
      default: f.defaultValue,
    }));
    const settings = inst.settings ? inst.settings() : {};
    this.onIndicatorSettings({ instanceId, indicatorId: inst.indicatorId, fields, settings });
  }

  /** Apply a settings patch to a live indicator. */
  updateIndicatorSettings(instanceId, patch) {
    if (!this.chart) return;
    const inst = (this.chart.indicators() || []).find((i) => i.id === instanceId);
    if (!inst || !inst.settings) return;
    const cur = inst.settings() || {};
    inst.settings({ ...cur, ...patch });
    this.syncIndicators();
  }

  /* ── snapshot + data export (their export rounds) ─────────────────────────── */

  /**
   * Attach a primitive that must never appear in an exported image.
   *
   * Anything an image cannot be used for — a button, a drag handle — belongs
   * here rather than on `addPrimitive` directly.
   */
  addExcludedPrimitive(primitive, paneIndex = 0) {
    this.chart.addPrimitive(primitive, paneIndex);
    this.screenshotExcluded.push({ primitive, paneIndex });
  }

  /** The frame the chart repaints on, double-rAF like their `nextPaint`. */
  nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  screenshotName() {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    return `${this.sym?.symbol ?? "chart"}-${this.interval}-${stamp}.png`;
  }

  /** Save the chart as a PNG. */
  async screenshot() {
    const chart = this.chart;
    if (!chart || !this.sym) return;
    try {
      const canvas = await this.captureCanvas();
      if (!canvas) return;
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = this.screenshotName();
      a.click();
      this.notify("Chart saved", "ok");
    } catch (e) {
      this.notify(traderReasonText((e && e.message) || String(e)), "err");
    }
  }

  /**
   * The chart as a named PNG file, or null when there is nothing to capture.
   *
   * A `File` rather than a `Blob` because every caller needs the name as well
   * as the bytes. Copying to the clipboard comes through here too, so a change
   * to what is composited reaches both.
   */
  async snapshotPng() {
    const canvas = await this.captureCanvas();
    if (!canvas) return null;
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    if (!blob) return null;
    return new File([blob], this.screenshotName(), { type: "image/png" });
  }

  /**
   * Put the chart on the clipboard as an image, ready to paste.
   *
   * The image clipboard needs a secure context and a user gesture: a click on
   * the menu item is the gesture, and localhost counts as secure alongside
   * https. Anything else is reported rather than failing silently.
   */
  async copyScreenshot() {
    if (!this.chart || !this.sym) return;
    try {
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
        throw new Error("Copying images needs https or localhost");
      }
      const file = await this.snapshotPng();
      if (!file) throw new Error("The chart produced no image");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": file })]);
      this.notify("Chart copied, paste it anywhere", "ok");
    } catch (e) {
      this.notify(traderReasonText((e && e.message) || String(e)), "err");
    }
  }

  /**
   * Composite the chart into an offscreen canvas with the export excluded
   * overlays taken down, then paint the OHLC readout into the corner the DOM
   * overlay occupies on screen.
   *
   * The detach/re-attach is why this is async: `removePrimitive` only marks the
   * pane dirty, so the buttons are still in the canvas bitmap until the chart
   * repaints on the next frame.
   */
  async captureCanvas() {
    const chart = this.chart;
    if (!chart || this.destroyed) return null;
    const hidden = [...this.screenshotExcluded];
    for (const o of hidden) {
      try {
        chart.removePrimitive(o.primitive);
      } catch {
        /* already gone */
      }
    }
    try {
      await this.nextPaint();
      // A theme toggle or an interval change during that frame rebuilds the
      // chart, and the one captured here would no longer be on screen.
      if (this.destroyed || this.chart !== chart) return null;
      const shot = chart.takeScreenshot();
      this.paintLegend(shot);
      return shot;
    } finally {
      if (!this.destroyed && this.chart === chart) {
        for (const o of hidden) {
          try {
            chart.addPrimitive(o.primitive, o.paneIndex);
          } catch {
            /* */
          }
        }
      }
    }
  }

  /**
   * Paint the OHLC readout onto a captured canvas, where the DOM overlay sits
   * on screen and in the colours it is showing.
   *
   * The capture is device-pixel sized, and the ratio is derived from the canvas
   * against the container rather than read from `devicePixelRatio` — that is
   * the ratio the chart actually rendered at. The foreground goes through
   * `resolveCssColor` because theme tokens may carry colour functions a canvas
   * is not guaranteed to parse.
   */
  paintLegend(canvas) {
    const ctx = canvas.getContext("2d");
    if (!ctx || !this.sym) return;
    const hostEl = this.legendEl || this.container;
    const cssWidth = this.container.clientWidth || canvas.width;
    const ratio = canvas.width / cssWidth;
    const css = getComputedStyle(hostEl);
    const family = css.fontFamily || "system-ui, sans-serif";
    const foreground = resolveCssColor(css.color || "#e4e8f4");
    ctx.save();
    ctx.scale(ratio, ratio);
    ctx.textBaseline = "top";
    ctx.font = `500 12px ${family}`;
    let x = LEGEND_X;
    const runs = buildChartLegend({
      symbol: this.sym.symbol,
      interval: this.interval,
      exchange: this.sym.exchange,
      lotsize: null,
      bar: this.legendBar ?? null,
      prevClose: this.legendPrevClose ?? null,
      fmt: (n) => this.fmt(n),
      fmtVolume: compactVolume,
      volumeHidden: !this.volumeOn || !this.volumeAvailable(),
    });
    for (const run of runs) {
      const tone = legendToneStyle(run.tone, foreground);
      ctx.fillStyle = tone.color;
      ctx.globalAlpha = tone.alpha;
      ctx.fillText(run.text, x, LEGEND_Y);
      x += ctx.measureText(run.text).width + LEGEND_GAP;
    }
    ctx.restore();
  }

  /**
   * The chart's data as CSV. With no options it is every loaded bar, which
   * is what this always wrote; the download dialog narrows it
   * (chart_data_export.mjs csvOptions parity). Ranges/throws mirror theirs.
   */
  exportDataCsv(options = {}) {
    if (this.destroyed || !this.chart) throw new Error("Chart history is unavailable for export");
    return exportChartDataCsv(this.chart, csvOptions(this.chart, options));
  }

  /* ── teardown ─────────────────────────────────────────────────────────────── */

  destroy() {
    this.destroyed = true;
    this.stopFeed();
    if (this.chart) {
      try { this.chart.destroy(); } catch { /* */ }
      this.chart = null;
    }
    this.container.innerHTML = "";
  }
}

/* ── module helpers ─────────────────────────────────────────────────────────── */

async function fetchTick(exchange, token) {
  try {
    // The route takes exchange/token as QUERY params (FastAPI scalars) and
    // answers {status, data:{tick_size, ltp, ...}}; a refused/stale quote is
    // a 502 we ride out on the 0.05 fallback.
    const res = await fetch(
      `/api/quotes?exchange=${encodeURIComponent(exchange)}&token=${encodeURIComponent(token)}`,
      { method: "POST" }
    );
    const j = await res.json();
    const d = j && j.data ? j.data : j;
    return d && d.tick_size > 0
      ? { tick_size: Number(d.tick_size), ltp: d.ltp != null ? Number(d.ltp) : null }
      : null;
  } catch {
    return null;
  }
}
