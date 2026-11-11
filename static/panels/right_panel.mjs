/**
 * RIGHT EDGE — the OpenAlgo trading-page panel (rail + PanelShell).
 *
 * One implementation for both desks: /charts mounts it with the page's own
 * market-data client as the adapter, the React /trading sub-app mounts it with
 * no adapter at all and the module opens its own /ws client (the vanilla
 * token-keyed protocol, desired-state replay + 45s/60s watchdog + the 5s
 * /api/multiquotes REST fallback while the socket is down).
 *
 * Tabs: Watchlist, Option chain, Pi chain, Algo symbols — every read/write
 * goes through the same /api endpoints the /charts page uses:
 *   GET  /api/symbols, POST /api/search-symbols, POST /api/symbols,
 *   PUT  /api/symbols/{id}, DELETE /api/symbols/{id}, POST /api/symbols/{id}/start|stop,
 *   GET  /api/optionchain/underlyings, GET /api/optionchain/chain,
 *   GET  /api/pichain/chain + POST /api/pichain/greeks (the PiConnect
 *   GetOptionChain / GetOptionGreek pair, composed server-side),
 *   POST /api/multiquotes, and the /ws market-data feed.
 *
 * Mount:   const panel = mountRightPanel({ host, adapter })
 *          panel.onTick(md)      — normalized {exchange, token, feed, data} frames
 *          panel.onStatus(p)     — engine status frames (algo tab)
 *          panel.open(id)        — "watchlist" | "optionchain" | "algo"
 *          panel.refreshAlgoSymbols()
 *          panel.destroy()
 *
 * `algoOnly: true` mounts the shell + dialogs WITHOUT the icon rail or the
 * floating OC window, opens the Algo symbols tab permanently (no Esc close,
 * no panel-remembering localStorage) and starts its 3s overview poll at
 * boot — the dashboard embeds the panel body as its strategy widget.
 *
 * adapter (all optional — each falls back to the module's own client/no-op):
 *   subscribe(exchange, token)            unsubscribe(exchange, token)
 *   connected() -> boolean                addChartToken(exchange, tsym, token)
 *   registerChartTokens(symbols[])        openSymbol(tsym, exchange)
 */

/** The panel DOM: the shell, its dialogs, and the icon rail. */
export const RIGHT_PANEL_MARKUP = `      <aside class="panel-shell" id="rightPanel" hidden aria-label="Symbols panel">
        <div class="panel-drag" id="rpDrag" role="separator" aria-orientation="vertical" aria-label="Resize panel"></div>

        <!-- TAB: WATCHLIST -->
        <div class="rp-tab" id="tabWatchlist">
          <div class="panel-header" id="wlHeader">
            <button class="ph-listname" id="wlListName" title="List lives here — manage in Dashboard">
              <span class="truncate" id="wlListNameText">Watchlist</span>
              <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <button class="oa-icon-btn" id="wlAddBtn" title="Add instrument" aria-label="Add instrument" aria-expanded="false">
              <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"/></svg>
            </button>
            <button class="oa-icon-btn" id="wlColsBtn" title="Customise columns" aria-label="Customise columns" aria-expanded="false">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </button>
            <div class="oa-menu align-end" id="wlColsMenu" hidden></div>
            <div class="oa-menu align-start" id="wlListMenu" hidden>
              <div class="oa-menu-label">Instrument list</div>
              <button class="oa-menu-item" id="wlSeedMenu">
                Seed from platform symbols <span class="mi-hint">once</span>
              </button>
              <button class="oa-menu-item" id="wlClear">
                Clear list
              </button>
            </div>
          </div>

          <div id="wlSearchbar" hidden>
            <input class="oa-input" id="wlSearch" placeholder="Search a broker symbol to add…" autocomplete="off" />
            <div class="oa-menu" id="wlResults" hidden></div>
          </div>

          <div class="wl-head" id="wlHead" hidden></div>
          <div class="wl-body" id="wlList"></div>
          <p class="wl-foot" id="wlFoot" hidden></p>
        </div>

        <!-- TAB: PI CHAIN (PiConnect GetOptionChain + GetOptionGreek) -->
        <div class="rp-tab" id="tabPichain" hidden>
          <div class="panel-header" style="position:relative;">
            <select class="oa-select" id="pcExchange" style="width:76px;" aria-label="Exchange segment">
              <option value="NFO">NFO</option>
              <option value="BFO">BFO</option>
              <option value="MCX">MCX</option>
              <option value="CDS">CDS</option>
            </select>
            <button class="oa-combo" id="pcUnderlyingBtn" aria-label="Underlying" aria-expanded="false">
              <span class="truncate" id="pcUnderlyingLabel">Select</span>
              <svg viewBox="0 0 24 24"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>
            </button>
            <button class="oa-icon-btn" id="pcRefreshBtn" title="Refresh" aria-label="Refresh Pi chain">
              <svg viewBox="0 0 24 24" id="pcRefreshIcon"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
            </button>
            <div class="oa-menu align-start" id="pcUnderlyingMenu" hidden>
              <input class="oa-input" id="pcUnderlyingSearch" placeholder="Search underlying…" autocomplete="off" />
              <div id="pcUnderlyingResults"></div>
            </div>
          </div>

          <div class="oc-band2">
            <select class="oa-select" id="pcExpiry" style="flex:1;min-width:0;" aria-label="Expiry" disabled>
              <option value="">Expiry</option>
            </select>
            <button class="oa-icon-btn" id="pcColsBtn" title="Customise columns" aria-label="Customise columns" aria-expanded="false">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </button>
            <div class="oa-menu align-end" id="pcColsMenu" hidden></div>
          </div>

          <div class="oc-spotline" id="pcSpot" hidden>
            <span><span class="oc-k">Spot</span> <b id="pcSpotValue">—</b></span>
            <span><span class="oc-k">ATM</span> <b id="pcAtmValue">—</b></span>
            <span id="pcPcrWrap" title="Across 0 strikes on screen"><span class="oc-k" id="pcPcrLabel">PCR(0)</span> <b id="pcPcrValue">—</b></span>
          </div>

          <div class="oc3" id="pcTable">
            <div class="oc3-head">
              <div class="oc3-side" id="pcCallHeadPane"><div class="oc-headgrid" id="pcCallHead"></div></div>
              <div class="oc-strike head">Strike</div>
              <div class="oc3-side" id="pcPutHeadPane"><div class="oc-headgrid" id="pcPutHead"></div></div>
            </div>
            <div class="oc3-body" id="pcBody"></div>
            <div class="oc3-pinbar" id="pcPinbar" hidden>
              <div class="oc3-pin" id="pcCallPin"><div id="pcCallPinInner" style="height:1px;"></div></div>
              <div class="oc3-pin-pin"></div>
              <div class="oc3-pin" id="pcPutPin"><div id="pcPutPinInner" style="height:1px;"></div></div>
            </div>
          </div>
          <p class="wl-foot" id="pcStatus" hidden></p>
        </div>

        <!-- TAB: ALGO SYMBOLS -->
        <div class="rp-tab" id="tabAlgo" hidden>
          <div class="algo-headblock">
            <div class="algo-title-row">
              <svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/></svg>
              <h2>Algo symbols</h2>
              <span class="oa-badge off" id="algoModeBadge" title="OpenAlgo's mode (Analyzer or Live) — unknown on this broker adapter">Mode unknown</span>
              <button class="oa-icon-btn" id="algoRefreshBtn" title="Refresh" aria-label="Refresh algo symbols">
                <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
              </button>
            </div>
            <div class="algo-actions-row">
              <button class="oa-btn" id="algoChartFocusBtn" title="Add the focused chart's symbol">
                <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"/></svg>
                <span>This chart</span>
              </button>
              <button class="oa-btn primary" id="algoAddBtn" title="Search the symbol master and configure a new algo symbol">
                <svg viewBox="0 0 24 24"><path d="M5 12h14M12 5v14"/></svg>
                <span>Add symbol</span>
              </button>
            </div>          </div>
          <p class="algo-byline" id="algoError" hidden></p>
          <div class="algo-body" id="algoList">
            <p class="algo-load">Loading…</p>
          </div>
        </div>
      </aside>

      <!-- SYMBOL SETTINGS DIALOG (algo-hub/SymbolSettingsDialog.tsx) -->
      <div class="oa-dlg-overlay" id="algoDlgOverlay" hidden>
        <div class="oa-dlg" role="dialog" aria-modal="true" aria-labelledby="algoDlgTitle">
          <div class="oa-dlg-head">
            <h3 id="algoDlgTitle">Add symbol for trade</h3>
            <p id="algoDlgDesc">Search the symbol master, then set this symbol's own configuration.</p>
            <button class="oa-icon-btn oa-dlg-close" id="algoDlgClose" aria-label="Close">
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
            </button>
          </div>

          <div id="algoDlgSymbolBlock">
            <label style="font-size:10px;font-weight:600;color:var(--oa-muted-fg);display:block;margin-bottom:3px;">Symbol</label>
            <div class="oa-dlg-symbol-row">
              <select id="algoDlgExchange" aria-label="Exchange"></select>
              <div class="oa-dlg-search">
                <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
                <input class="oa-input" id="algoDlgSearch" placeholder="Search e.g. SENSEX 72600 CE or CRUDEOILM FUT" autocomplete="off" />
              </div>
            </div>
            <div class="oa-dlg-selected" id="algoDlgSelected" hidden></div>
            <div class="oa-dlg-results" id="algoDlgResults" hidden></div>
          </div>

          <div id="algoDlgGroups"></div>

          <p class="oa-dlg-hint" id="algoDlgStopHint" hidden></p>
          <p class="oa-dlg-error" id="algoDlgError" hidden></p>

          <div class="oa-dlg-foot">
            <button class="oa-btn" id="algoDlgCancel">Cancel</button>
            <button class="oa-btn primary" id="algoDlgSave">Add symbol</button>
          </div>
        </div>
      </div>

      <!-- CONFIRM DIALOG (AlgoSymbolsPanel ConfirmState — styled, not window.confirm) -->
      <div class="oa-dlg-overlay" id="algoConfirmOverlay" hidden>
        <div class="oa-dlg oa-confirm" role="dialog" aria-modal="true">
          <div class="oa-dlg-head">
            <h3 id="algoConfirmTitle">Confirm</h3>
            <p id="algoConfirmDesc"></p>
          </div>
          <div class="oa-dlg-foot">
            <button class="oa-btn" id="algoConfirmCancel">Cancel</button>
            <button class="oa-btn primary" id="algoConfirmAction">OK</button>
          </div>
        </div>
      </div>`

/**
 * The icon rail is a separate export so page variants can mount the panel
 * WITHOUT it — the dashboard embeds the panel body (Algo symbols) alone,
 * where rails of watchlist/chain toggles have nothing to point at. The desk
 * mounts inject it after the shell, so the flex row keeps shell → rail order.
 */
export const RAIL_MARKUP = `<div id="rightRail">
        <div class="rail-item">
          <button class="rail-btn" data-panel="watchlist" id="railWatchlist" aria-label="Watchlist" aria-expanded="false">
            <svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>
          </button>
          <span class="rail-tip">Watchlist <em>Esc</em></span>
        </div>
        <div class="rail-item">
          <button class="rail-btn" data-panel="pichain" id="railPichain" aria-label="Pi chain" aria-expanded="false">
            <svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </button>
          <span class="rail-tip">Pi chain <em>Esc</em></span>
        </div>
        <div class="rail-item">
          <button class="rail-btn" data-panel="algo" id="railAlgo" aria-label="Algo symbols" aria-expanded="false">
            <svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/></svg>
          </button>
          <span class="rail-tip">Algo symbols <em>Esc</em></span>
        </div>
      </div>`

/**
 * The Option chain lives in its own FLOATING WINDOW, not the side panel —
 * both band buttons (next to One-Click on /charts and /trading) open it over
 * the chart. The markup carries the SAME ids the old rail tab had, so every
 * oc* behaviour — the sub-state, retry ladder, Greek upgrade, columns menu —
 * carries over unchanged. `.oa-panel-scope` re-states the `--oa-*` palette
 * for a node appended to <body>, outside the panel host's scope.
 */
export const OC_WINDOW_MARKUP = `
<div class="oa-panel-scope oa-window" id="ocWindow" hidden role="dialog" aria-label="Option chain">
  <div class="oa-window__bar" id="ocWinBar">
    <span class="oa-window__grip"><svg viewBox="0 0 24 24"><circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/></svg></span>
    <span class="oa-window__title">Option chain</span>
    <button class="oa-icon-btn" id="ocWinClose" title="Close (Esc)" aria-label="Close option chain">
      <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
  </div>
  <div class="oa-window__body">
        <div class="rp-tab" id="tabOptionchain">
          <div class="panel-header" style="position:relative;">
            <select class="oa-select" id="ocExchange" style="width:76px;" aria-label="Exchange segment">
              <option value="NFO">NFO</option>
              <option value="BFO">BFO</option>
              <option value="MCX">MCX</option>
              <option value="CDS">CDS</option>
            </select>
            <button class="oa-combo" id="ocUnderlyingBtn" aria-label="Underlying" aria-expanded="false">
              <span class="truncate" id="ocUnderlyingLabel">Select</span>
              <svg viewBox="0 0 24 24"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"/></svg>
            </button>
            <button class="oa-icon-btn" id="ocRefreshBtn" title="Refresh" aria-label="Refresh option chain">
              <svg viewBox="0 0 24 24" id="ocRefreshIcon"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
            </button>
            <div class="oa-menu align-start" id="ocUnderlyingMenu" hidden>
              <input class="oa-input" id="ocUnderlyingSearch" placeholder="Search underlying…" autocomplete="off" />
              <div id="ocUnderlyingResults"></div>
            </div>
          </div>

          <div class="oc-band2">
            <select class="oa-select" id="ocExpiry" style="flex:1;min-width:0;" aria-label="Expiry" disabled>
              <option value="">Expiry</option>
            </select>
            <button class="oa-icon-btn" id="ocColsBtn" title="Customise columns" aria-label="Customise columns" aria-expanded="false">
              <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
            </button>
            <div class="oa-menu align-end" id="ocColsMenu" hidden></div>
          </div>

          <div class="oc-spotline" id="ocSpot" hidden>
            <span><span class="oc-k">Spot</span> <b id="ocSpotValue">—</b></span>
            <span><span class="oc-k">ATM</span> <b id="ocAtmValue">—</b></span>
            <span id="ocPcrWrap" title="Across 0 strikes on screen"><span class="oc-k" id="ocPcrLabel">PCR(0)</span> <b id="ocPcrValue">—</b></span>
          </div>

          <div class="oc3" id="ocTable">
            <div class="oc3-head">
              <div class="oc3-side" id="ocCallHeadPane"><div class="oc-headgrid" id="ocCallHead"></div></div>
              <div class="oc-strike head">Strike</div>
              <div class="oc3-side" id="ocPutHeadPane"><div class="oc-headgrid" id="ocPutHead"></div></div>
            </div>
            <div class="oc3-body" id="ocBody"></div>
            <div class="oc3-pinbar" id="ocPinbar" hidden>
              <div class="oc3-pin" id="ocCallPin"><div id="ocCallPinInner" style="height:1px;"></div></div>
              <div class="oc3-pin-pin"></div>
              <div class="oc3-pin" id="ocPutPin"><div id="ocPutPinInner" style="height:1px;"></div></div>
            </div>
          </div>
          <p class="wl-foot" id="ocStatus" hidden></p>
        </div>
  </div>
  <div class="oa-window__resizer" id="ocWinResizer" aria-hidden="true"></div>
</div>`

/** Token-keyed /ws client used when the host supplies no adapter. */
function createQuoteClient(onFrame) {
  const wanted = new Map() // "EXCH|TOKEN" -> {exchange, token}
  let ws = null
  let lastMessage = 0
  let backoff = 3000
  let reconnectTimer = null
  let watchdog = null
  let fallbackTimer = null
  let disposed = false

  const keyOf = (exchange, token) => `${String(exchange).toUpperCase()}|${String(token)}`
  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)) } catch (e) { /* next frame */ }
    }
  }
  const isOpen = () => !!(ws && ws.readyState === WebSocket.OPEN)

  function replay() {
    for (const { exchange, token } of wanted.values()) {
      send({ action: 'subscribe', mode: 'quote', symbols: [{ exchange, token }] })
    }
  }

  function startFallback() {
    if (fallbackTimer) return
    fallbackTimer = setInterval(async () => {
      if (isOpen()) return  // socket healthy — ticks are the live path; a REST
                            // quote here would paint an OLDER price over the
                            // fresh cell (REST roundtrip > tick latency)
      const symbols = [...wanted.values()].map(({ exchange, token }) => ({ exchange, token }))
      if (!symbols.length) return
      try {
        const res = await fetch('/api/multiquotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbols }),
        })
        const payload = await res.json()
        for (const q of (payload && payload.quotes) || []) {
          if (q.status !== 'success') continue
          onFrame({ type: 'market_data', exchange: q.exchange, token: q.token, feed: 'rest', data: q })
        }
      } catch (e) { /* the next tick retries */ }
    }, 5000)
  }
  function stopFallback() {
    if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null }
  }

  function connect() {
    if (disposed) return
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    try { ws = new WebSocket(`${proto}//${location.host}/ws`) } catch (e) { schedule(); return }
    ws.onopen = () => {
      backoff = 3000
      lastMessage = Date.now()
      stopFallback()
      replay()
    }
    ws.onmessage = (event) => {
      lastMessage = Date.now()
      let msg
      try { msg = JSON.parse(event.data) } catch (e) { return }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'market_data' && msg.exchange != null && msg.token != null) {
        onFrame({ type: 'market_data', exchange: msg.exchange, token: String(msg.token), feed: msg.feed || msg.mode || 'quote', data: msg.data || {} })
        return
      }
      if (msg.type === 'market_data' && msg.data && msg.data.symbol && msg.data.exchange) {
        // OpenAlgo envelope (symbol-keyed): tokens ride along on the payload.
        if (msg.data.token != null) {
          onFrame({ type: 'market_data', exchange: msg.data.exchange, token: String(msg.data.token), feed: msg.data.mode || 'quote', data: msg.data })
        }
      }
    }
    ws.onclose = () => {
      ws = null
      startFallback()
      schedule()
    }
    ws.onerror = () => { try { ws && ws.close() } catch (e) { /* onclose retries */ } }
  }

  function schedule() {
    if (disposed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff)
    backoff = Math.min(backoff * 2, 60000)
  }

  function tick() {
    if (!isOpen()) return
    const quiet = Date.now() - lastMessage
    if (quiet >= 60000) { try { ws.close() } catch (e) { /* reconnect */ } return }
    if (quiet >= 45000) send({ action: 'ping' })
  }

  connect()
  watchdog = setInterval(tick, 5000)
  startFallback()

  return {
    connected: isOpen,
    subscribe(exchange, token) {
      const key = keyOf(exchange, token)
      if (wanted.has(key)) return key
      wanted.set(key, { exchange, token })
      send({ action: 'subscribe', mode: 'quote', symbols: [{ exchange, token }] })
      return key
    },
    unsubscribe(exchange, token) {
      const key = keyOf(exchange, token)
      if (!wanted.delete(key)) return key
      send({ action: 'unsubscribe', symbols: [{ exchange, token }] })
      return key
    },
    destroy() {
      disposed = true
      clearInterval(watchdog)
      stopFallback()
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws && ws.close() } catch (e) { /* gone */ }
      ws = null
    },
  }
}

/**
 * Mount the panel into `host` (the host must be the flex row that also holds
 * the chart: the shell and the rail are injected as its last children).
 */
export function mountRightPanel({ host, adapter = {}, algoOnly = false } = {}) {
  if (!host) throw new Error('mountRightPanel: a host element is required')
  host.insertAdjacentHTML('beforeend', RIGHT_PANEL_MARKUP)
  if (!algoOnly) host.insertAdjacentHTML('beforeend', RAIL_MARKUP)
  // The dashboard has no charts, so the Algo panel's "This chart" shortcut has
  // nothing to read there — the button is not rendered at all on that mount.
  const chartFocusBtn = document.getElementById("algoChartFocusBtn")
  if (algoOnly && chartFocusBtn) chartFocusBtn.remove()
  // The floating Option chain window is appended to <body>, OUTSIDE the page's
  // flex host: a fixed-position child of a scrolling ancestor would be clipped
  // by it, and every page already imports the stylesheet. ALWAYS mounted (the
  // whole OC tab lives inside it) — in algoOnly it stays hidden forever, an
  // inert 1-node the band toggle never sets.
  document.body.insertAdjacentHTML('beforeend', OC_WINDOW_MARKUP)

  // ---------- global listeners, collected for destroy() --------------------
  const listeners = []
  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts)
    listeners.push([target, type, fn, opts])
  }

  // ---------- host adapters ------------------------------------------------
  let tickSink = () => {}
  const client = adapter.subscribe ? null : createQuoteClient((md) => tickSink(md))

  const subKey = (exchange, token) =>
    adapter.subscribe ? adapter.subscribe(exchange, token) : client.subscribe(exchange, token)
  const unsubKey = (exchange, token) =>
    adapter.unsubscribe ? adapter.unsubscribe(exchange, token) : client.unsubscribe(exchange, token)
  const connected = () =>
    adapter.connected ? !!adapter.connected() : !!(client && client.connected())
  const addChartToken = (exchange, tsym, token) => {
    if (adapter.addChartToken) adapter.addChartToken(exchange, tsym, token)
  }
  const registerChartTokens = (symbols) => {
    if (adapter.registerChartTokens) adapter.registerChartTokens(symbols)
  }
  const openSymbol = (tsym, exchange) => {
    if (adapter.openSymbol) adapter.openSymbol(tsym, exchange)
  }
  // AlgoSymbolsPanel's getChartContext prop: reads the focused chart's symbol
  // for the "This chart" shortcut. {symbol, exchange} — or any object whose
  // .instrument / .symbol / "EXCH:SYM" answers (readChartSymbol parity).
  const getChartContext = () => (adapter.getChartContext ? adapter.getChartContext() : null)

  // ---------- panel body (ported verbatim from templates/charts.html) ------
    const RAIL_PANELS = [
      { id: "watchlist",   label: "Watchlist",    tab: "tabWatchlist",     btn: "railWatchlist",   widthKey: "cognix_wl_width",   fallback: 340, minW: 260, maxW: 520 },
      { id: "pichain",     label: "Pi chain",     tab: "tabPichain",       btn: "railPichain",     widthKey: "cognix_pichain_width", fallback: 340, minW: 260, maxW: 520 },
      { id: "algo",        label: "Algo symbols", tab: "tabAlgo",          btn: "railAlgo",        widthKey: "cognix_algo_width", fallback: 380, minW: 280, maxW: 760 },
    ];
    const rightPanel = document.getElementById("rightPanel");
    let activePanel = (function () {
      if (algoOnly) return "algo";  // the dashboard: the panel body itself is the widget
      // Storage outlives a release: a remembered id must still name a panel.
      const saved = localStorage.getItem("cognix_panel");
      return RAIL_PANELS.some(p => p.id === saved) ? saved : null;
    })();

    function clampPanelWidth(p, w) {
      return Math.max(p.minW, Math.min(p.maxW, w, Math.floor(window.innerWidth * 0.7)));
    }

    function readPanelWidth(p) {
      const saved = Number(localStorage.getItem(p.widthKey));
      return Number.isFinite(saved) && saved >= p.minW ? clampPanelWidth(p, saved) : p.fallback;
    }

    function applyPanelWidth() {
      const spec = RAIL_PANELS.find(p => p.id === activePanel);
      if (spec) {
        rightPanel.style.width = readPanelWidth(spec) + "px";
        rightPanel.style.maxWidth = Math.floor(window.innerWidth * 0.7) + "px";
      }
    }

    function setRailState() {
      RAIL_PANELS.forEach(p => {
        const btn = document.getElementById(p.btn);
        if (!btn) return;  // no rail mounted (the dashboard's algo-only host)
        btn.classList.toggle("active", activePanel === p.id);
        btn.setAttribute("aria-expanded", String(activePanel === p.id));
      });
    }

    // Clicking the open panel's own button closes it — the rail is the only
    // way back to a full-width chart, exactly like OpenAlgo.
    function openPanel(id) {
      if (activePanel === id) { closePanel(); return; }
      const spec = RAIL_PANELS.find(p => p.id === id);
      if (!spec) { closePanel(); return; }
      activePanel = id;
      rightPanel.hidden = false;
      RAIL_PANELS.forEach(p => { document.getElementById(p.tab).hidden = p.id !== id; });
      setRailState();
      applyPanelWidth();
      if (!algoOnly) localStorage.setItem("cognix_panel", id);
      if (id === "algo") { refreshAlgoSymbols(); startAlgoPolling(); }
      if (id === "watchlist") startWlRefresh();
      if (id === "pichain") {
        pcMeasurePanes();
        if (pcPrefs.underlying && pcPrefs.token) {
          document.getElementById("pcUnderlyingLabel").textContent = pcPrefs.underlying;
          startPiLive();
          fetchPiChain();
          pcHydrateExpiry();  // expiry select fills from the saved universe
        }
      }
    }

    function closePanel() {
      activePanel = null;
      rightPanel.hidden = true;
      setRailState();
      if (!algoOnly) localStorage.removeItem("cognix_panel");
      stopAlgoPolling();
      stopWlRefresh();  // the 30s quote fill has no reason to run hidden
      stopPiOiPoll();   // the Pi chain's 30s poll has no reason to run hidden
    }

    // ============================================================
    // OPTION CHAIN — FLOATING WINDOW (was the panel's OC rail tab)
    // ============================================================
    /* The band button on each desk opens the chain as a popup over the chart:
       draggable by its bar, corner-resizable, size/position persisted in
       localStorage. All oc* behaviour is untouched — only WHERE it renders
       and WHO shows it changed (openPanel's `optionchain` branch is gone).
    */
    const OC_WIN_STORE = "cognix_oc_win";
    let ocWinVisible = false;
    let ocWinDrag = null; // {kind:"move"|"size", startX, startY, rect}

    function ocWinDefaults() {
      return {
        w: Math.min(760, Math.max(360, Math.floor(window.innerWidth * 0.62))),
        h: Math.min(560, window.innerHeight - 96),
        x: Math.max(12, Math.floor((window.innerWidth - Math.min(760, window.innerWidth - 24)) / 2)),
        y: 72,
      };
    }
    function readOcWinRect() {
      let st = ocWinDefaults();
      try {
        const saved = JSON.parse(localStorage.getItem(OC_WIN_STORE) || "{}");
        st.w = Number.isFinite(saved.w) ? Math.min(Math.max(saved.w, 320), window.innerWidth - 16) : st.w;
        st.h = Number.isFinite(saved.h) ? Math.min(Math.max(saved.h, 240), window.innerHeight - 48) : st.h;
        st.x = Number.isFinite(saved.x) ? Math.min(Math.max(saved.x, 0), Math.max(0, window.innerWidth - 96)) : st.x;
        st.y = Number.isFinite(saved.y) ? Math.min(Math.max(saved.y, 0), Math.max(0, window.innerHeight - 60)) : st.y;
      } catch (e) { /* defaults */ }
      return st;
    }
    function saveOcWinRect() {
      const win = document.getElementById("ocWindow");
      try {
        localStorage.setItem(OC_WIN_STORE, JSON.stringify({
          w: win.offsetWidth, h: win.offsetHeight,
          x: parseFloat(win.style.left) || 0, y: parseFloat(win.style.top) || 0,
        }));
      } catch (e) { /* storage full / private mode */ }
    }
    function applyOcWinRect(st) {
      const win = document.getElementById("ocWindow");
      win.style.width = st.w + "px";
      win.style.height = st.h + "px";
      win.style.left = st.x + "px";
      win.style.top = st.y + "px";
    }

    function showOcWindow() {
      applyOcWinRect(readOcWinRect());
      document.getElementById("ocWindow").hidden = false;
      ocWinVisible = true;
      // The pane widths were measured while hidden (display:none → 0):
      // measure + repaint only after the window is actually laid out.
      ocMeasurePanes();
      // The label only updates at pick, even when a saved underlying drives
      // the load — restore it here so the window never shows "Select" while
      // a live chain is on screen.
      if (ocPrefs.underlying && ocPrefs.token) {
        const labelEl = document.getElementById("ocUnderlyingLabel");
        if (labelEl) labelEl.textContent = ocPrefs.underlying;
      }
      // Whatever prefs exist come alive at once — same flow the old
      // openPanel("optionchain") branch ran.
      if (ocPrefs.underlying && ocPrefs.token) {
        startOcLive();
        fetchOptionChain();
        ocHydrateExpiry();  // expiry select fills from the saved universe
      }
      (window.__oaChainChanged || function () {})(true);
    }
    function hideOcWindow() {
      if (!ocWinVisible) return;
      saveOcWinRect();
      document.getElementById("ocWindow").hidden = true;
      ocWinVisible = false;
      (window.__oaChainChanged || function () {})(false);
    }
    function toggleOcWindow() { ocWinVisible ? hideOcWindow() : showOcWindow(); }

    (function wireOcWindow() {
      const win = document.getElementById("ocWindow");
      const bar = document.getElementById("ocWinBar");
      const resizer = document.getElementById("ocWinResizer");
      const closer = document.getElementById("ocWinClose");
      if (!win || !bar || !resizer || !closer) return;  // no window mounted (algoOnly)
      const ocCurrentRect = () => ({
        w: win.offsetWidth || 760, h: win.offsetHeight || 560,
        x: parseFloat(win.style.left) || 0, y: parseFloat(win.style.top) || 0,
      });
      const clampRect = (st) => ({
        w: Math.min(Math.max(st.w, 320), window.innerWidth - 16),
        h: Math.min(Math.max(st.h, 240), window.innerHeight - 48),
        x: Math.min(Math.max(st.x, -st.w + 80), window.innerWidth - 80),
        y: Math.min(Math.max(st.y, 0), window.innerHeight - 60),
      });
      bar.addEventListener("pointerdown", (e) => {
        if (e.target.closest("#ocWinClose")) return;
        ocWinDrag = { kind: "move", startX: e.clientX, startY: e.clientY, rect: ocCurrentRect() };
        try { bar.setPointerCapture(e.pointerId); } catch (err) { /* detached */ }
      });
      resizer.addEventListener("pointerdown", (e) => {
        ocWinDrag = { kind: "size", startX: e.clientX, startY: e.clientY, rect: ocCurrentRect() };
        e.preventDefault();
      });
      on(window, "pointermove", (e) => {
        if (!ocWinDrag || !ocWinVisible) return;
        const dx = e.clientX - ocWinDrag.startX;
        const dy = e.clientY - ocWinDrag.startY;
        if (ocWinDrag.kind === "move") {
          applyOcWinRect(clampRect({ ...ocWinDrag.rect, x: ocWinDrag.rect.x + dx, y: ocWinDrag.rect.y + dy }));
        } else {
          applyOcWinRect(clampRect({ w: ocWinDrag.rect.w + dx, h: ocWinDrag.rect.h + dy, x: ocWinDrag.rect.x, y: ocWinDrag.rect.y }));
        }
        ocMeasurePanes();
      });
      on(window, "pointerup", () => {
        if (ocWinDrag) { ocWinDrag = null; saveOcWinRect(); }
      });
      closer.addEventListener("click", () => hideOcWindow());
      // A window resized/moved off a shrunken viewport must come back in.
      on(window, "resize", () => {
        if (ocWinVisible) applyOcWinRect(clampRect(ocCurrentRect()));
      });
    })();

    RAIL_PANELS.forEach(p => {
      const btn = document.getElementById(p.btn);
      if (btn) btn.addEventListener("click", () => openPanel(p.id));
    });
    on(document, "keydown", (e) => {
      if (e.key === "Escape" && ocWinVisible) { hideOcWindow(); return; }  // topmost first
      // The dashboard's panel is the page's strategy widget — Esc must not
      // collapse the whole column away.
      if (e.key === "Escape" && activePanel && !algoOnly) closePanel();
    });

    // ---------- drag-to-resize: the hairline that only announces itself ----
    const rpDrag = document.getElementById("rpDrag");
    let panelDrag = null; // { spec, startX, startW }

    function onPanelDragMove(e) {
      if (!panelDrag) return;
      const w = clampPanelWidth(panelDrag.spec, panelDrag.startW + (panelDrag.startX - e.clientX));
      rightPanel.style.width = w + "px";
    }

    function onPanelDragEnd() {
      if (!panelDrag) return;
      document.body.classList.remove("oa-resizing");
      window.removeEventListener("pointermove", onPanelDragMove);
      window.removeEventListener("pointerup", onPanelDragEnd);
      window.removeEventListener("pointercancel", onPanelDragEnd);
      localStorage.setItem(panelDrag.spec.widthKey, String(parseInt(rightPanel.style.width, 10)));
      panelDrag = null;
      rpDrag.classList.remove("active");
    }

    rpDrag.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !activePanel || algoOnly) return;
      e.preventDefault();
      const spec = RAIL_PANELS.find(p => p.id === activePanel);
      panelDrag = { spec, startX: e.clientX, startW: rightPanel.getBoundingClientRect().width };
      rpDrag.classList.add("active");
      document.body.classList.add("oa-resizing");
      on(window, "pointermove", onPanelDragMove);
      on(window, "pointerup", onPanelDragEnd);
      on(window, "pointercancel", onPanelDragEnd);
    });

    // ---------- popovers (DropdownMenu.tsx) --------------------------------
    const allMenus = ["wlColsMenu", "wlListMenu", "wlResults", "ocUnderlyingMenu", "ocColsMenu",
      "pcUnderlyingMenu", "pcColsMenu"];

    function closeAllMenus(except) {
      allMenus.forEach(id => {
        const el = document.getElementById(id);
        if (el && el !== except) el.hidden = true;
      });
    }

    on(document, "click", (e) => {
      if (e.target.closest(".oa-menu") || e.target.closest('[aria-controls]') ||
          e.target === document.getElementById("wlAddBtn") ||
          e.target === document.getElementById("wlColsBtn") ||
          e.target === document.getElementById("wlListName") ||
          e.target === document.getElementById("ocColsBtn") ||
          e.target === document.getElementById("ocUnderlyingBtn")) return;
      closeAllMenus();
    });

    function buildCheckItem(label, checked, onToggle) {
      const b = document.createElement("button");
      b.className = "oa-menu-item";
      const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      check.setAttribute("viewBox", "0 0 24 24");
      check.style.opacity = checked ? "1" : "0";
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M20 6 9 17l-5-5");
      check.appendChild(path);
      const span = document.createElement("span");
      span.textContent = label;
      b.appendChild(check);
      b.appendChild(span);
      b.addEventListener("click", (e) => { e.stopPropagation(); onToggle(); });
      return b;
    }

    const CHECK_SVG = '<svg viewBox="0 0 24 24" path="-d"><path d="M20 6 9 17l-5-5"/></svg>';

    // Icons (lucide, stroke 1.5)
    const ICONS = {
      search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
      trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
      grip: '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',
      plus: '<path d="M5 12h14M12 5v14"/>',
      kebab: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
      layers: '<path d="M12 2 2 7l10 5 10-5-10-5Z"/><path d="m2 12 10 5 10-5"/><path d="m2 17 10 5 10-5"/>',
      refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
      chevdn: '<path d="m6 9 6 6 6-6"/>',
      dots: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    };

    function svg(icon, cls) {
      return `<svg viewBox="0 0 24 24" ${cls ? `class="${cls}"` : ""}>${ICONS[icon]}</svg>`;
    }

    // ---------- broker funnel (WS subscribe actions, OpenAlgo parity) ------
    // pageSubs is the panel-side desired state; the actual WS subscribe /
    // unsubscribe actions happen through subKey / __wsUnsubKey
    // maintained by the module script's market-data client. The server
    // drops the socket's refcounts automatically on disconnect, so no
    // sendBeacon / beforeunload bookkeeping is needed anymore.
    const pageSubs = new Map(); // "EXCH|TOKEN" -> {exchange, token, tsym}
    let pageActiveKey = null;   // "EXCH:TSYM" of the instrument on the chart

    function subscribeChartItem(item) {
      const key = `${item.exchange}|${item.token}`;
      if (pageSubs.has(key)) return;
      pageSubs.set(key, item);
      if (subKey) subKey(item.exchange, item.token);
      if (item.tsym && addChartToken) addChartToken(item.exchange, item.tsym, item.token);
    }

    function unsubscribeChartItem(item) {
      const key = `${item.exchange}|${item.token}`;
      if (!pageSubs.has(key)) return;
      pageSubs.delete(key);
      if (unsubKey) unsubKey(item.exchange, item.token);
    }

    function markCharted(exchange, tsym) {
      pageActiveKey = `${String(exchange).toUpperCase()}:${String(tsym).toUpperCase()}`;
      renderWatchlistActive();
    }

    function renderWatchlistActive() {
      document.querySelectorAll(".wl-row").forEach(rowEl => {
        const it = wlItemsActive[rowEl.dataset.idx];
        rowEl.classList.toggle("active", !!it && `${it.exchange}:${it.tsym}` === pageActiveKey);
      });
    }

    // ---------- number formatting (WatchlistPanel.tsx fmt / compact) --------
    function fmt(v) {
      if (v == null || !Number.isFinite(v)) return "-";
      const dp = Math.abs(v) >= 1000 ? 1 : 2;
      return v.toLocaleString("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    }

    // Lakhs and crores: raw volume does not fit a 58px column.
    function fmtCompact(v) {
      if (typeof v !== "number" || !Number.isFinite(v) || v === 0) return "-";
      if (v >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
      if (v >= 1e5) return `${(v / 1e5).toFixed(2)}L`;
      if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
      return String(Math.round(v));
    }

    /**
     * A stable colour per instrument: a tinted initial, not a brand logo.
     * The hue is derived from the symbol itself, so it never changes between
     * sessions or devices (WatchlistPanel.symbolTint).
     */
    function symbolTint(symbol) {
      let hash = 0;
      for (let i = 0; i < symbol.length; i++) hash = (hash * 31 + symbol.charCodeAt(i)) | 0;
      return `hsl(${Math.abs(hash) % 360} 55% 45%)`;
    }

    // ============================================================
    // TAB 1 — WATCHLIST (WatchlistPanel.tsx)
    // ============================================================
    const WL_STORE = "cognix_chart_watchlist";
    let wlItems = [];
    try { wlItems = JSON.parse(localStorage.getItem(WL_STORE) || "[]"); } catch (e) { wlItems = []; }
    const wlStates = new Map(); // key -> {ltp, prevClose, volume, open, high, low}

    /* Every column the panel can show, in the order they appear. Which of them
       are on is the user's choice; the row and its header build their grid
       from the same selection (WatchlistPanel COLUMNS). */
    const WL_COLUMNS = [
      { id: "last",          label: "Last", width: 64, get: q => fmt(q.ltp) },
      { id: "change",        label: "Chg",  width: 60, tone: true, get: q => (q.change == null ? "-" : `${q.change >= 0 ? "+" : ""}${fmt(q.change)}`) },
      { id: "changePercent", label: "Chg%", width: 58, tone: true, get: q => (q.changePercent == null ? "-" : `${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%`) },
      { id: "volume",        label: "Vol",  width: 58, get: q => fmtCompact(q.volume) },
      { id: "high",          label: "High", width: 60, get: q => fmt(q.high) },
      { id: "low",           label: "Low",  width: 60, get: q => fmt(q.low) },
      { id: "open",          label: "Open", width: 60, get: q => fmt(q.open) },
    ];
    let wlDisplay = { columns: ["last", "change", "changePercent"], logo: true, exchange: true };
    try {
      const saved = JSON.parse(localStorage.getItem("cognix_wl_display") || "{}");
      const ids = WL_COLUMNS.map(c => c.id);
      wlDisplay = {
        columns: Array.isArray(saved.columns) ? saved.columns.filter(c => ids.includes(c)) : wlDisplay.columns,
        logo: typeof saved.logo === "boolean" ? saved.logo : true,
        exchange: typeof saved.exchange === "boolean" ? saved.exchange : true,
      };
    } catch (e) { /* defaults */ }

    function saveWlDisplay() { localStorage.setItem("cognix_wl_display", JSON.stringify(wlDisplay)); }
    function saveWL() { localStorage.setItem(WL_STORE, JSON.stringify(wlItems)); }

    function shownWlColumns() {
      return WL_COLUMNS.filter(c => wlDisplay.columns.includes(c.id));
    }

    // The row and its column header share this, so the two cannot drift apart.
    function wlGridTemplate() {
      return `1fr ${shownWlColumns().map(c => `${c.width}px`).join(" ")} 16px`;
    }

    function wlQuote(it) {
      const key = `${it.exchange}|${it.token}`;
      const st = wlStates.get(key);
      if (!st || st.ltp == null) return null;
      const known = typeof st.prevClose === "number" && st.prevClose > 0 && st.ltp > 0;
      return {
        ltp: st.ltp,
        change: known ? st.ltp - st.prevClose : null,
        changePercent: known ? ((st.ltp - st.prevClose) / st.prevClose) * 100 : null,
        volume: st.volume,
        // Live OHLC — served by the normalized market-data frames now
        // (real OpenAlgo watchlist High/Low/Open values; "-" until the
        // feed carries them).
        high: (typeof st.high === "number" && st.high > 0) ? st.high : null,
        low: (typeof st.low === "number" && st.low > 0) ? st.low : null,
        open: (typeof st.open === "number" && st.open > 0) ? st.open : null,
      };
    }

    function renderWatchlistHead() {
      const cols = shownWlColumns();
      const head = document.getElementById("wlHead");
      if (!wlItems.length) { head.hidden = true; return; }
      head.hidden = false;
      head.style.gridTemplateColumns = wlGridTemplate();
      head.innerHTML =
        `<span>Symbol</span>` +
        cols.map(c => `<span class="wr">${c.label}</span>`).join("") +
        `<span></span>`;
    }

    let wlItemsActive = []; // index-aligned copy of rendered rows

    function renderWatchlist() {
      renderWatchlistHead();
      const list = document.getElementById("wlList");
      const cols = shownWlColumns();
      wlItemsActive = wlItems;

      if (!wlItems.length) {
        list.innerHTML = `
          <div class="wl-empty">
            ${svg("search")}
            <p>This list is empty.</p>
            <button class="oa-btn" id="wlEmptyAdd" style="flex:none;height:28px;">
              ${svg("plus")} Add an instrument
            </button>
          </div>`;
        const add = document.getElementById("wlEmptyAdd");
        if (add) add.addEventListener("click", () => {
          document.getElementById("wlSearchbar").hidden = false;
          document.getElementById("wlSearch").focus();
        });
        return;
      }

      list.innerHTML = wlItems.map((it, idx) => {
        const key = `${it.exchange}|${it.token}`;
        const q = wlQuote(it);
        const direction = !q || q.changePercent == null ? "flat" : q.changePercent >= 0 ? "up" : "down";
        const active = `${it.exchange}:${it.tsym}` === pageActiveKey;
        return `
        <div class="wl-row${active ? " active" : ""}" data-key="${key}" data-idx="${idx}" style="grid-template-columns:${wlGridTemplate()}">
          <span class="wl-sym">
            ${wlDisplay.logo ? `<span class="wl-avatar" style="background-color:${symbolTint(it.tsym)}" aria-hidden="true">${(it.tsym || "?").charAt(0)}</span>` : ""}
            <span class="wl-name" title="${it.tsym}">${it.tsym}</span>
            ${wlDisplay.exchange ? `<span class="wl-exch">${it.exchange}</span>` : ""}
          </span>
          ${cols.map(c => {
            const cls = c.tone && direction === "up" ? "tone-up" : c.tone && direction === "down" ? "tone-down" : "muted";
            return `<span class="wl-cell ${!q ? "muted" : cls}">${q ? c.get(q) : "-"}</span>`;
          }).join("")}
          <button class="wl-remove" data-remove="${key}" title="Remove ${it.tsym}" aria-label="Remove ${it.tsym}">${svg("trash")}</button>
        </div>`;
      }).join("");

      list.querySelectorAll(".wl-row").forEach(rowEl => {
        const key = rowEl.dataset.key;
        rowEl.addEventListener("click", (e) => {
          if (e.target.closest(".wl-remove")) return;
          const it = wlItems.find(i => `${i.exchange}|${i.token}` === key);
          if (it) { markCharted(it.exchange, it.tsym); openSymbol(it.tsym, it.exchange); }
        });
        rowEl.querySelector(".wl-remove").addEventListener("click", (e) => {
          e.stopPropagation();
          const it = wlItems.find(i => `${i.exchange}|${i.token}` === key);
          if (!it) return;
          unsubscribeChartItem(it);
          wlItems = wlItems.filter(i => i !== it);
          saveWL();
          renderWatchlist();
        });
      });
    }

    function paintWlRow(key) {
      const rowEl = document.getElementById("wlList").querySelector(`.wl-row[data-key="${key}"]`) ||
                    document.getElementById("wlList").querySelector(`.wl-row[data-key="${key}"]`);
      if (!rowEl) return;
      const it = wlItems.find(i => `${i.exchange}|${i.token}` === key);
      if (!it) return;
      const q = wlQuote(it);
      const cols = shownWlColumns();
      const direction = !q || q.changePercent == null ? "flat" : q.changePercent >= 0 ? "up" : "down";
      const cells = rowEl.querySelectorAll(".wl-cell");
      cols.forEach((c, i) => {
        const cell = cells[i];
        if (!cell) return;
        cell.textContent = q ? c.get(q) : "-";
        cell.className = `wl-cell ${!q ? "muted" : c.tone && direction === "up" ? "tone-up" : c.tone && direction === "down" ? "tone-down" : "muted"}`;
      });
    }

    function updateWatchlistTick(msg) {
      // Accepts BOTH shapes: the legacy flat tick {ltp, day_volume,
      // prev_close} and the OpenAlgo-normalized market_data frame
      // {exchange, token, data:{ltp, prev_close, volume, open, high, low}}.
      const d = msg.data || {};
      const g = (name, legacy) => (d[name] != null ? Number(d[name]) : legacy);
      const patch = {
        prevClose: g("prev_close", msg.prevClose != null ? Number(msg.prevClose) : null),
        ltp: g("ltp", msg.ltp != null ? Number(msg.ltp) : null),
        volume: g("volume", msg.day_volume != null ? Number(msg.day_volume) : null),
        open: g("open", null),
        high: g("high", null),
        low: g("low", null),
      };
      const key = `${msg.exchange}|${msg.token}`;
      const known = wlItems.some(i => `${i.exchange}|${i.token}` === key);
      if (!known) return;
      let st = wlStates.get(key);
      if (!st) { st = { ltp: null, prevClose: null, volume: null, open: null, high: null, low: null }; wlStates.set(key, st); }
      for (const [field, v] of Object.entries(patch)) {
        if (v != null && Number.isFinite(v)) st[field] = v === 0 && field === "ltp" ? st.ltp : v;
      }
      paintWlRow(key);
    }

    /* REST fill — the last traded price without waiting for a trade.
       The WS pushes market data only while the broker is TRADING, so after
       market end (and on every page boot until the first print) the rows
       would sit as "-" forever. A broker watchlist always shows the last
       traded price, so the panel fills itself from the normalized broker
       snapshot (/api/multiquotes, <=40 symbols per call) — the same one
       the Pi chain uses as fillPiQuotes(). Refused/stale quotes are
       skipped, never wipe a row; a ltp of 0 keeps the previous value
       (updateWatchlistTick's own merge rule). */
    async function fillWlQuotes() {
      try {
        for (let i = 0; i < wlItems.length; i += 40) {
          const chunk = wlItems.slice(i, i + 40);
          const res = await fetch("/api/multiquotes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbols: chunk.map(it => ({ exchange: it.exchange, token: it.token })) }),
          });
          const payload = await res.json();
          for (const q of (payload && payload.quotes) || []) {
            if (q.status !== "success" || !q || (q.exchange == null && q.token == null)) continue;
            // multiquotes spreads the quote itself into the row, so q IS the
            // normalized data block updateWatchlistTick reads off msg.data.
            updateWatchlistTick({ exchange: q.exchange, token: q.token, data: q });
          }
        }
      } catch (e) { /* rows keep whatever they already show */ }
    }

    // Refresh cycle — the snapshot never goes stale while the tab is open:
    // one batch every 30s while the watchlist is the active panel (paused
    // while the page is hidden, resumed by the next open/tick), and a
    // single fill at boot + whenever an instrument is added. Live ticks
    // keep painting over it during market hours as they always did.
    let wlRefreshTimer = null;
    let wlFillBusy = false;
    async function wlRefreshTick() {
      if (wlFillBusy || document.hidden) return;
      wlFillBusy = true;
      try { await fillWlQuotes(); } finally { wlFillBusy = false; }
    }
    function startWlRefresh() {
      stopWlRefresh();
      wlRefreshTimer = setInterval(wlRefreshTick, 30000);
      wlRefreshTick();
    }
    function stopWlRefresh() {
      if (wlRefreshTimer) { clearInterval(wlRefreshTimer); wlRefreshTimer = null; }
    }

    async function seedWatchlistFromPlatform() {
      if (localStorage.getItem("cognix_wl_seeded")) return;
      localStorage.setItem("cognix_wl_seeded", "1");
      try {
        const res = await fetch("/api/symbols");
        const list = await res.json();
        if (registerChartTokens) registerChartTokens(Array.isArray(list) ? list : []);
        wlItems = (Array.isArray(list) ? list : []).slice(0, 20).map(s => {
          const cfg = s.config || s;
          return {
            exchange: cfg.exchange,
            token: String(cfg.token),
            tsym: cfg.trading_symbol,
            name: cfg.strategy_name || cfg.trading_symbol,
          };
        });
        saveWL();
        renderWatchlist();
        for (const it of wlItems) subscribeChartItem(it);
      } catch (e) { /* watchlist stays empty */ }
    }

    // ---------- add an instrument (the SymbolSearchDialog, inlined) ---------
    const wlSearch = document.getElementById("wlSearch");
    const wlResults = document.getElementById("wlResults");
    let wlSearchTimer = null;

    // Multi-exchange symbol search (OpenAlgo InTokenSearchBar behaviour):
    // every exchange Flattrade supports is queried IN PARALLEL and merged
    // by priority, so no exchange starves the others. Results arrive as
    // fast as the slowest broker search (~all in one wall-clock round trip
    // because they run concurrently).
    const WL_SEARCH_EXCHANGES = ["NSE", "NFO", "BFO", "BSE", "MCX", "CDS"];
    const WL_SEARCH_PRIO = { NSE: 0, NFO: 1, BFO: 2, BSE: 3, MCX: 4, CDS: 5 };
    let wlSearchSeq = 0; // stale-response guard

    async function runWlSearch(q) {
      if (!q || q.length < 2) { wlResults.hidden = true; return; }
      const seq = ++wlSearchSeq;
      wlResults.hidden = false;
      wlResults.innerHTML = `<button class="oa-menu-item" disabled>Searching…</button>`;
      const settled = await Promise.allSettled(
        WL_SEARCH_EXCHANGES.map(exch =>
          fetch("/api/search-symbols", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: q, exchange: exch }),
          }).then(r => r.json()).then(p => (p && p.values) || [])
        )
      );
      if (seq !== wlSearchSeq) return; // a newer query took over the box

      const perExch = 5, cap = 16;
      const seen = new Set();
      const merged = [];
      for (const outs of settled) {
        const values = outs.status === "fulfilled" ? (outs.value || []) : [];
        for (const v of values.slice(0, perExch)) {
          const exch = String(v.exch || "").toUpperCase();
          const tsym = String(v.tsym || v.ts || "");
          if (!tsym) continue;
          const k = `${exch}|${v.token}|${tsym}`;
          if (seen.has(k)) continue;
          seen.add(k);
          merged.push({ v, exch, tsym });
        }
      }
      merged.sort((a, b) =>
        ((WL_SEARCH_PRIO[a.exch] ?? 9) - (WL_SEARCH_PRIO[b.exch] ?? 9)) ||
        a.tsym.localeCompare(b.tsym));
      merged.length = Math.min(merged.length, cap);

      wlResults.innerHTML = merged.length
        ? merged.map(({ v, exch, tsym }) =>
            `<button class="oa-menu-item" data-exch="${exch}" data-token="${v.token}" data-tsym="${tsym}">
                      <span class="mi-hint" style="margin-left:0;order:2">${exch}</span>
                      <span style="order:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${tsym}</span>
                    </button>`).join("")
        : `<button class="oa-menu-item" disabled>Is the broker session active?</button>`;
      wlResults.hidden = false;
      wlResults.querySelectorAll(".oa-menu-item[data-tsym]").forEach(el => {
        el.addEventListener("click", () => {
          const item = {
            exchange: el.dataset.exch,
            token: String(el.dataset.token),
            tsym: el.dataset.tsym,
            name: el.dataset.tsym,
          };
          if (wlItems.some(i => i.exchange === item.exchange && i.token === item.token)) {
            wlSearch.value = "";
            wlResults.hidden = true;
            return;
          }
          wlItems.push(item);
          saveWL();
          subscribeChartItem(item);
          renderWatchlist();
          fillWlQuotes();  // the new row shows its last price at once
          wlSearch.value = "";
          wlResults.hidden = true;
          wlSearchbar.hidden = true;
        });
      });
    }

    const wlSearchbar = document.getElementById("wlSearchbar");
    document.getElementById("wlAddBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      closeAllMenus(wlResults);
      wlSearchbar.hidden = !wlSearchbar.hidden;
      if (!wlSearchbar.hidden) {
        wlSearch.focus();
        wlResults.hidden = true;
      }
    });
    wlSearch.addEventListener("input", () => {
      clearTimeout(wlSearchTimer);
      wlSearchTimer = setTimeout(() => runWlSearch(wlSearch.value.trim()), 250);
    });
    wlSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { clearTimeout(wlSearchTimer); runWlSearch(wlSearch.value.trim()); }
      if (e.key === "Escape") { wlResults.hidden = true; wlSearchbar.hidden = true; }
    });

    // ---------- list menu + columns menu ------------------------------------
    document.getElementById("wlListName").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("wlListMenu");
      const open = !menu.hidden;
      closeAllMenus(menu);
      menu.hidden = open;
    });
    document.getElementById("wlSeedMenu").addEventListener("click", () => {
      document.getElementById("wlListMenu").hidden = true;
      localStorage.removeItem("cognix_wl_seeded");
      seedWatchlistFromPlatform();
    });
    document.getElementById("wlClear").addEventListener("click", () => {
      document.getElementById("wlListMenu").hidden = true;
      for (const it of wlItems) unsubscribeChartItem(it);
      wlItems = [];
      wlStates.clear();
      saveWL();
      renderWatchlist();
    });
    document.getElementById("wlColsBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("wlColsMenu");
      const open = !menu.hidden;
      closeAllMenus(menu);
      if (open) { menu.hidden = true; return; }
      const bodyEl = document.createDocumentFragment();
      bodyEl.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-label", textContent: "Columns" }));
      for (const c of WL_COLUMNS) {
        const label = c.label === "Chg" ? "Change" : c.label === "Chg%" ? "Change %" : c.label === "Vol" ? "Volume" : c.label;
        const item = buildCheckItem(label, wlDisplay.columns.includes(c.id), () => {
          wlDisplay.columns = wlDisplay.columns.includes(c.id)
            ? wlDisplay.columns.filter(x => x !== c.id)
            : [...wlDisplay.columns, c.id];
          saveWlDisplay();
          renderWatchlist();
          renderWlColsMenu();
        });
        bodyEl.appendChild(item);
      }
      bodyEl.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-sep" }));
      bodyEl.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-label", textContent: "Symbol display" }));
      bodyEl.appendChild(buildCheckItem("Symbol letter", wlDisplay.logo, () => { wlDisplay.logo = !wlDisplay.logo; saveWlDisplay(); renderWatchlist(); }));
      bodyEl.appendChild(buildCheckItem("Exchange", wlDisplay.exchange, () => { wlDisplay.exchange = !wlDisplay.exchange; saveWlDisplay(); renderWatchlist(); }));
      menu.innerHTML = "";
      menu.appendChild(bodyEl);
      menu.hidden = false;
    });
    function renderWlColsMenu() { /* rebuilt on next open */ }

    // ============================================================
    // TAB 2 — OPTION CHAIN (OptionChainPanel.tsx)
    // ============================================================
    const OC_PREFS = "cognix_optionchain";
    let ocPrefs = { exchange: "NFO", underlying: "", token: "", tsymFut: "", expiry: "" };
    try { const _prev = JSON.parse(localStorage.getItem(OC_PREFS) || "{}"); delete _prev.count; ocPrefs = Object.assign(ocPrefs, _prev); } catch (e) { /* defaults */ }
    function saveOcPrefs() { localStorage.setItem(OC_PREFS, JSON.stringify(ocPrefs)); }

    /* OpenAlgo's fixed strike window: STRIKE_COUNT = 10. "Twenty rows is about
       one panel-height of scroll" — the panel has no strike-count control.
       The backend keeps its ?count= parameter for other callers. */
    const OC_STRIKE_COUNT = 10;

    /* All available columns, in the outward-from-strike order both sides share.
       LTP is first because it sits against the strike (OptionChainPanel
       ALL_COLUMNS). Width is the whole column: header, data cell and OI bar. */
    const OC_COLUMNS = [
      { id: "ltp",    label: "LTP",    symbol: "LTP", width: 68, group: "Price" },
      { id: "oi",     label: "OI",     symbol: "OI",  width: 60, group: "Price" },
      { id: "volume", label: "Volume", symbol: "Vol", width: 60, group: "Price", hideSymbol: true },
      { id: "iv",     label: "IV",     symbol: "σ",   width: 56, group: "Greeks" },
      { id: "delta",  label: "Delta",  symbol: "Δ",   width: 56, group: "Greeks" },
      { id: "gamma",  label: "Gamma",  symbol: "Γ",   width: 56, group: "Greeks" },
      { id: "theta",  label: "Theta",  symbol: "Θ",   width: 56, group: "Greeks" },
      { id: "vega",   label: "Vega",   symbol: "V",   width: 56, group: "Greeks" },
    ];
    let ocDisplay = { columns: ["ltp", "oi", "volume"], showBars: true };
    try {
      const saved = JSON.parse(localStorage.getItem("cognix_oc_display") || "{}");
      const ids = OC_COLUMNS.map(c => c.id);
      ocDisplay = {
        columns: Array.isArray(saved.columns) ? saved.columns.filter(c => ids.includes(c)) : ocDisplay.columns,
        showBars: typeof saved.showBars === "boolean" ? saved.showBars : true,
      };
    } catch (e) { /* defaults */ }
    function saveOcDisplay() { localStorage.setItem("cognix_oc_display", JSON.stringify(ocDisplay)); }

    function shownOcColumns() { return OC_COLUMNS.filter(c => ocDisplay.columns.includes(c.id)); }

    /* The metric columns whose values the broker's GetOptionGreek supplies.
       While none of them is displayed the panel never asks for Greeks. */
    const OC_GREEK_COLUMNS = ["iv", "delta", "gamma", "theta", "vega"];
    function ocWantsGreeks() { return OC_GREEK_COLUMNS.some(id => ocDisplay.columns.includes(id)); }

    /* Fixed pixel tracks, the OpenAlgo contract (tracksFor/widthFor): BOTH
       sides render every column at its full declared width and the overflow
       scrolls horizontally — the call side renders the SAME list REVERSED
       (callColumns) so its LTP sits against the strike, and the put side
       renders forward. No flexible slack column anywhere. */
    const OC_COL_GAP = 6;    // gap-x-1.5
    const OC_SIDE_PX = 16;   // px-2, padding inside the header strip AND the cells
    const OC_STRIKE_W = 64;  // strike column, borders included (STRIKE_WIDTH)

    function ocTracks(cols) { return cols.map(c => `${c.width}px`).join(" "); }

    /* Total pixel width of one side's content: tracks + gaps + the px-2
       padding the header strip carries on both sides. The header grid, the
       body's side stack and the pinned bar's spacer all get exactly this. */
    function ocWidthFor(cols) {
      return cols.reduce((s, c) => s + c.width, 0) +
             Math.max(0, cols.length - 1) * OC_COL_GAP + OC_SIDE_PX;
    }

    /**
     * One leg's value for the selected metric. Everything unavailable renders
     * as a dash rather than a zero (metricOf).
     */
    function ocMetric(leg, id) {
      if (!leg) return "-";
      if (id === "ltp") return leg.ltp > 0 ? leg.ltp.toFixed(2) : "-";
      if (id === "oi") return fmtCompact(leg.oi);
      if (id === "volume") return fmtCompact(leg.volume);
      const v = leg[id];
      if (!(typeof v === "number" && Number.isFinite(v))) return "-";
      // Per-column precision (OptionChainPanel.tsx): gamma 4dp, IV 1dp %,
      // everything else 2dp — gamma at 2dp always reads "0.00".
      const dp = id === "gamma" ? 4 : id === "iv" ? 1 : 2;
      return id === "iv" ? `${v.toFixed(dp)}%` : v.toFixed(dp);
    }

    /* One leg's day change in percent, only when the chain carried a usable
       previous close — otherwise the cell shows nothing rather than a
       fabricated zero. */
    function ocChangePct(leg) {
      if (!leg || !(leg.ltp > 0) || !(leg.prev_close > 0)) return null;
      return ((leg.ltp - leg.prev_close) / leg.prev_close) * 100;
    }

    let ocLoading = false;
    let ocData = null; // last chain payload
    let ocGreekRun = 0; // bumped per chain load; stale Greek upgrades abort
    let ocSpotPrevClose = null; // underlying prev_close from live frames (spot tri-state)
    let ocLastUpdate = null;    // Date of the last successful chain fetch
    let ocChainError = null;    // last chain error message (internal only)
    let ocFailStreak = 0;       // consecutive failed loads → stall footer
    let ocRetryTimer = null;    // silent auto-retry of a failed chain load
    let ocRetryAttempt = 0;     // consecutive retries → backoff step
    let ocStatusTimer = null;   // 5s status-footer refresher
    let ocPaneW = null;         // measured px width of one side pane

    /* ── side-pane width sharing (OpenAlgo sidePaneStyle) ─────────────────
       One measured pixel width per side pane — floor((bodyWidth − strike)/2)
       — applied to the header panes, the body panes AND the pinned-bar pans,
       so the strike column's vertical separators sit on the same pixel in
       all three strips. Before the first measurement everything falls back
       to the CSS flex-1 layout. */
    const ocBodyEl = document.getElementById("ocBody");

    function ocApplyPaneWidths() {
      for (const id of ["ocCallHeadPane", "ocPutHeadPane", "ocCallSide", "ocPutSide", "ocCallPin", "ocPutPin"]) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (ocPaneW != null) {
          el.style.width = ocPaneW + "px";
          el.style.flex = "0 0 auto";
        } else {
          el.style.width = "";
          el.style.flex = "";
        }
      }
    }

    function ocMeasurePanes() {
      if (rightPanel.hidden || !ocBodyEl.clientWidth) return;
      const w = Math.max(0, Math.floor((ocBodyEl.clientWidth - OC_STRIKE_W) / 2));
      if (w !== ocPaneW) {
        ocPaneW = w;
        ocApplyPaneWidths();
      }
      // Pane width follows the live body size (the vertical scrollbar comes
      // and goes with row count), and the call side's pinned anchor moves
      // with it — while the panel is dragged, scrollLeft does not re-pin
      // by itself (OpenAlgo re-runs the effect on pane width change).
      repinCallScroll();
    }
    // The OC/Pi bodies live in the floating window (absent in algoOnly
    // mounts) — a null observe() kills the whole mount.
    if (ocBodyEl) new ResizeObserver(ocMeasurePanes).observe(ocBodyEl);

    /* Open the call table fully scrolled right: its columns render
       reversed, so LTP is the LAST cell in DOM order and only scrollLeft
       == scrollWidth puts it against the strike. rAF because freshly
       injected rows have not laid out yet (scrollWidth still 0), and on
       the layout frame the assignment would be a no-op. */
    function repinCallScroll() {
      requestAnimationFrame(() => {
        const el = document.getElementById("ocCallSide");
        if (!el || !el.scrollWidth) return;
        el.scrollLeft = el.scrollWidth;
        const head = document.getElementById("ocCallHeadPane");
        const pin = document.getElementById("ocCallPin");
        if (head) head.scrollLeft = el.scrollLeft;
        if (pin) pin.scrollLeft = el.scrollLeft;
      });
    }

    const ocExchangeEl = document.getElementById("ocExchange");
    const ocExpiryEl = document.getElementById("ocExpiry");
    const ocRefreshIcon = document.getElementById("ocRefreshIcon");
    ocExchangeEl.value = ocPrefs.exchange;

    ocExpiryEl.addEventListener("change", () => {
      ocPrefs.expiry = ocExpiryEl.value;
      saveOcPrefs();
      fetchOptionChain();
    });

    // ---------- underlying universe (OpenAlgo scalping all_underlyings) ----
    /* The FULL per-exchange list, loaded once per exchange and filtered
       client-side, exactly like OpenAlgo's searchable combobox: indices at
       the top, then alphabetical; no broker search per keystroke. */

    function ocSetExpiryList(entry) {
      const exps = (entry && entry.expiries) || [];
      ocExpiryEl.innerHTML = "";
      if (!exps.length) {
        ocExpiryEl.disabled = true;
        ocExpiryEl.innerHTML = `<option value="">No expiries</option>`;
        ocPrefs.expiry = "";
      } else {
        ocExpiryEl.disabled = false;
        for (const e of exps) {
          const o = document.createElement("option");
          o.value = e;
          o.textContent = e;
          ocExpiryEl.appendChild(o);
        }
        if (!exps.includes(ocPrefs.expiry)) ocPrefs.expiry = exps[0];
        ocExpiryEl.value = ocPrefs.expiry;
      }
      saveOcPrefs();
    }

    function ocSelectUnderlying(entry) {
      ocPrefs.underlying = entry.base;
      ocPrefs.token = entry.token;
      ocPrefs.tsymFut = entry.tsym;
      saveOcPrefs();
      document.getElementById("ocUnderlyingLabel").textContent = entry.base;
      ocSetExpiryList(entry);
      ocUnderlyingMenu.hidden = true;
      ocData = null;          // the previous contract's chain must not linger
      startOcLive();
      fetchOptionChain();
    }

    ocExchangeEl.addEventListener("change", async () => {
      ocPrefs.exchange = ocExchangeEl.value;
      saveOcPrefs();
      clearOcLegs();
      ocData = null;
      document.getElementById("ocUnderlyingLabel").textContent = "Select";
      document.getElementById("ocBody").innerHTML = `<p class="oc-loadmsg">Select an underlying…</p>`;
      // OpenAlgo: switching segment keeps the old underlying only when the
      // new segment has it too; otherwise it falls back to the FIRST one the
      // segment actually carries, and the chain loads on its own.
      try {
        const list = await loadOcUniverse(ocPrefs.exchange);
        const keep = list.find(u => u.base === ocPrefs.underlying);
        const target = keep || list[0] || null;
        if (target) {
          ocSelectUnderlying(target);
          return;
        }
      } catch (e) {
        loadOcUnderlyingsIntoMenuIfOpen();  // surface the error in the picker
      }
    });

    // ---------- underlying picker (a searchable Popover+Command) ----------
    const ocUnderlyingBtn = document.getElementById("ocUnderlyingBtn");
    const ocUnderlyingMenu = document.getElementById("ocUnderlyingMenu");
    const ocSearchEl = document.getElementById("ocUnderlyingSearch");
    const ocUnderlyingResults = document.getElementById("ocUnderlyingResults");

    let ocUList = [];       // universe entries for the current exchange
    let ocUState = "idle";  // idle | loading | ready (failures stay "loading")
    let ocUError = null;    // last failure, internal only — never painted
    let ocULoading = false; // one universe fetch in flight at a time
    let ocURetryTimer = null;   // silent auto-retry of the universe load
    let ocURetryAttempt = 0;

    async function ocHydrateExpiry() {
      /* A saved underlying restored on panel open still needs its expiry
         select filled (the picker may never have opened this session). */
      try {
        const list = await loadOcUniverse(ocPrefs.exchange);
        const entry = list.find(u => u.base === ocPrefs.underlying);
        if (entry) ocSetExpiryList(entry);
      } catch (e) { /* silent — the picker retries on its own, see reloadOcUniverse */ }
    }

    async function loadOcUniverse(ex) {
      /* Cached in-memory per exchange — like OpenAlgo's effect keyed on
         `prefs.exchange`, the fetch itself is once per segment, not per
         keystroke. */
      if (ocUniverseCache.has(ex)) return ocUniverseCache.get(ex);
      const res = await fetch(`/api/optionchain/underlyings?exchange=${encodeURIComponent(ex)}`);
      const payload = await res.json();
      if (!payload || payload.stat !== "Ok") {
        throw new Error((payload && payload.emsg) || `Could not load ${ex} underlyings`);
      }
      const list = payload.underlyings || [];
      ocUniverseCache.set(ex, list);
      return list;
    }
    const ocUniverseCache = new Map();

    function ocListItem(entry) {
      const selected = entry.base === ocPrefs.underlying;
      const btn = document.createElement("button");
      btn.className = "oa-menu-item";
      const check = document.createElement("span");
      check.textContent = selected ? "✓" : "";
      check.style.cssText = "width:14px;flex:0 0 14px;text-align:center;font-weight:700;";
      const name = document.createElement("span");
      name.textContent = entry.base;
      name.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const hint = document.createElement("span");
      hint.className = "mi-hint";
      hint.textContent = entry.tsym || "";
      btn.append(check, name, hint);
      btn.addEventListener("click", () => ocSelectUnderlying(entry));
      return btn;
    }

    function ocListMessage(text, cls) {
      const div = document.createElement("div");
      div.style.cssText = "padding:12px;text-align:center;font-size:12px;color:" +
        (cls === "err" ? "var(--oa-rose)" : "var(--oa-muted-fg)");
      div.textContent = text;
      return div;
    }

    /* Client-side Command filter: substring, case-insensitive, over the whole
       already-loaded universe. No network on keystrokes. */
    function renderOcList() {
      ocUnderlyingResults.innerHTML = "";
      /* A failed load keeps the "Loading…" state and retries on its own —
         the picker never shows an error or a Retry button. */
      if (ocUState !== "ready") {
        ocUnderlyingResults.appendChild(ocListMessage("Loading…"));
        return;
      }
      const q = ocSearchEl.value.trim().toUpperCase();
      const hits = q ? ocUList.filter(u => u.base.includes(q)) : ocUList;
      if (!hits.length) {
        ocUnderlyingResults.appendChild(ocListMessage("No underlying found."));
        return;
      }
      for (const entry of hits.slice(0, 80)) {
        ocUnderlyingResults.appendChild(ocListItem(entry));
      }
    }

    async function reloadOcUniverse() {
      if (ocULoading) return;
      ocULoading = true;
      ocUState = "loading";
      ocUError = null;
      ocUList = [];
      renderOcList();
      try {
        ocUList = await loadOcUniverse(ocPrefs.exchange);
        ocUState = "ready";
        ocURetryAttempt = 0;
        if (ocURetryTimer) { clearTimeout(ocURetryTimer); ocURetryTimer = null; }
      } catch (e) {
        // Silent retry: the menu keeps saying "Loading…" and asks again with
        // backoff until the universe arrives (PiConnect throttles bursts).
        ocUError = e.message || `Could not load ${ocPrefs.exchange} underlyings`;
        ocUState = "loading";
        scheduleOcUniverseRetry();
      } finally {
        ocULoading = false;
      }
      if (!ocUnderlyingMenu.hidden) renderOcList();
    }

    function scheduleOcUniverseRetry() {
      if (ocURetryTimer) return;
      const delays = [800, 1500, 2500, 4000, 5000, 8000, 12000, 15000];
      const wait = delays[Math.min(ocURetryAttempt, delays.length - 1)];
      ocURetryAttempt++;
      ocURetryTimer = setTimeout(() => {
        ocURetryTimer = null;
        if (ocUnderlyingMenu.hidden) {
          // Menu closed — reopening starts a fresh load (the button handler
          // reloads on "idle"), so the loop stops here instead of polling.
          ocURetryAttempt = 0;
          ocUState = "idle";
          return;
        }
        reloadOcUniverse();
      }, wait);
    }

    // A segment switch in flight while the menu is closed still needs to
    // repaint the open menu when its load resolves — cheap identity check.
    let ocUSeg = ocPrefs.exchange;
    function loadOcUnderlyingsIntoMenuIfOpen() {
      if (ocUnderlyingMenu.hidden) return;
      if (ocUSeg !== ocPrefs.exchange) { ocUSeg = ocPrefs.exchange; reloadOcUniverse(); }
      else renderOcList();
    }

    ocUnderlyingBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !ocUnderlyingMenu.hidden;
      closeAllMenus(ocUnderlyingMenu);
      ocUnderlyingMenu.hidden = open;
      if (!ocUnderlyingMenu.hidden) {
        ocSearchEl.value = "";
        if (ocUSeg !== ocPrefs.exchange || ocUState === "idle") {
          reloadOcUniverse();
          ocUSeg = ocPrefs.exchange;
        } else {
          renderOcList();
        }
        setTimeout(() => ocSearchEl.focus(), 10);
      }
    });

    ocSearchEl.addEventListener("input", () => {
      // Client-side over the loaded list — instant, no debounce, no fetch.
      if (ocUState === "ready") renderOcList();
    });

    // ---------- live spot through the funnel --------------------------------
    let ocLiveKey = null;

    function startOcLive() {
      if (ocLiveKey) {
        const old = pageSubs.get(ocLiveKey);
        if (old) unsubscribeChartItem(old);
        ocLiveKey = null;
      }
      if (!ocPrefs.token) return;
      const item = { exchange: ocPrefs.exchange, token: ocPrefs.token, tsym: ocPrefs.tsymFut };
      subscribeChartItem(item);
      ocLiveKey = `${item.exchange}|${item.token}`;
    }

    // ---------- live option-chain legs (OpenAlgo chain parity) --------------
    // Legs are subscribed over the same page WS; each market-data frame
    // paints the leg's LTP + day-change chip in place, and merges
    // bid/ask/volume/prev_close into the leg model so re-renders (columns
    // menu, OI poll) keep carrying it. OI/IV/greeks are refreshed by a
    // 30-second chain poll, exactly like the OpenAlgo option-chain panel.
    let ocLegsByToken = new Map(); // "EXCH|TOKEN" -> {leg, cell, valueEl, chgEl, prevLtp}
    let ocOiTimer = null;

    function wireOcLegs(payload) {
      const wanted = new Set();
      const body = document.getElementById("ocBody");
      for (const row of (payload.chain || [])) {
        for (const side of ["ce", "pe"]) {
          const leg = row[side];
          if (!leg || !leg.token) continue;
          const key = `${payload.exchange}|${String(leg.token)}`;
          wanted.add(key);
          const cell = body.querySelector(
            `.oc-cell[data-side="${side}"][data-strike="${row.strike}"]`);
          if (!cell) continue;
          const valueEl = cell.querySelector(".oc-value > span");
          const chgEl = cell.querySelector(".oc-ltp-chg");
          ocLegsByToken.set(key, { leg, cell, valueEl, chgEl, prevLtp: null });
        }
      }
      // Release subscriptions for strikes that left the window.
      for (const key of [...ocLegsByToken.keys()]) {
        if (wanted.has(key)) continue;
        const [ex, tok] = key.split("|");
        if (unsubKey) unsubKey(ex, tok);
        ocLegsByToken.delete(key);
      }
      // Desired-state subscribe (idempotent — the module dedupes).
      if (subKey) {
        for (const key of wanted) {
          const [ex, tok] = key.split("|");
          subKey(ex, tok);
        }
      }
    }

    function clearOcLegs() {
      for (const key of [...ocLegsByToken.keys()]) {
        const [ex, tok] = key.split("|");
        if (unsubKey) unsubKey(ex, tok);
        ocLegsByToken.delete(key);
      }
      stopOcOiPoll();
    }

    function paintOcLegs(md) {
      const entries = ocLegsByToken.get(`${md.exchange}|${md.token}`);
      if (!entries) return;
      const d = md.data || {};
      const leg = entries.leg;

      // Merge everything the frame carries into the chain's leg model.
      if (d.ltp != null && Number(d.ltp) > 0) leg.ltp = Number(d.ltp);
      if (d.bid != null && Number(d.bid) >= 0) leg.bid = Number(d.bid);
      if (d.ask != null && Number(d.ask) >= 0) leg.ask = Number(d.ask);
      if (d.volume != null) leg.volume = Number(d.volume);
      if (d.prev_close != null && Number(d.prev_close) > 0) leg.prev_close = Number(d.prev_close);

      // In-place LTP + day-change chip.
      if (entries.valueEl && leg.ltp > 0) {
        entries.valueEl.textContent = fmt(leg.ltp);
        entries.prevLtp = leg.ltp;
      }
      if (entries.chgEl !== undefined) {
        const change = ocChangePct(leg);
        if (entries.chgEl) {
          if (change === null) { entries.chgEl.remove(); entries.chgEl = null; }
          else entries.chgEl.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
        }
      }
    }

    // 30s OI/IV poll (silent refetch — no spinner, no flash reset).
    function startOcOiPoll() {
      if (ocOiTimer) return;
      ocOiTimer = setInterval(() => {
        if (ocPrefs.underlying && ocPrefs.token && !ocLoading) fetchOptionChain({ silent: true });
      }, 30000);
    }
    function stopOcOiPoll() {
      if (ocOiTimer) { clearInterval(ocOiTimer); ocOiTimer = null; }
    }

    document.getElementById("ocRefreshBtn").addEventListener("click", () => fetchOptionChain());

    async function fetchOptionChain(opts = {}) {
      const silent = !!opts.silent;
      if (!ocPrefs.underlying || !ocPrefs.token) return;
      if (ocLoading) return;   // the retry loop must never stack requests
      ocLoading = true;
      ocGreekRun++;   // any Greek upgrade still running is now stale
      if (!silent) {
        ocRefreshIcon.classList.add("oc-spin");
        ocRefreshIcon.style.animation = "oaSpin 1s linear infinite";
        // Loading state only when nothing is on screen — a refresh never
        // blanks the rendered chain (OpenAlgo `loading && rows.length === 0`).
        if (!(ocData && (ocData.chain || []).length)) {
          document.getElementById("ocBody").innerHTML =
            `<p class="oc-loadmsg">Loading chain…</p>`;
        }
      }
      let abortTimer = null;
      try {
        const p = new URLSearchParams({
          exchange: ocPrefs.exchange,
          underlying: ocPrefs.tsymFut,
          token: ocPrefs.token,
          count: String(OC_STRIKE_COUNT),
        });
        if (ocPrefs.expiry) p.set("expiry", ocPrefs.expiry);
        /* A hung request must fail like any other — otherwise it holds
           ocLoading forever and the silent retry loop never runs. The
           budget is generous on purpose: the chain assembles its quotes
           leg-by-leg with a GetQuotes fallback per leg, and a throttled
           broker has been measured taking 36-44 s for the whole answer —
           a 25 s abort killed valid in-flight loads and the panel never
           painted (retry loop aborted again every time). */
        const ctl = new AbortController();
        abortTimer = setTimeout(() => ctl.abort(), 60000);
        const res = await fetch(`/api/optionchain/chain?${p.toString()}`, { signal: ctl.signal });
        const payload = await res.json();
        if (payload.stat !== "Ok") {
          ocChainFailed(payload.emsg || "Chain unavailable");
        } else {
          ocChainError = null;
          ocFailStreak = 0;
          clearOcRetry();
          ocLastUpdate = new Date();
          ocData = payload;
          renderChain(payload);
          startOcOiPoll();
          startOcStatusTimer();
          // Greek columns on screen → upgrade the local values to the
          // broker's own GetOptionGreek numbers (documented endpoint), a few
          // legs at a time so the chain stays interactive while they land.
          if (ocWantsGreeks()) upgradeOcGreeks();
        }
      } catch (e) {
        ocChainFailed(String(e.message || e));
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
        ocLoading = false;
        if (!silent) {
          ocRefreshIcon.style.animation = "";
          ocRefreshIcon.classList.remove("oc-spin");
        }
      }
    }

    /* A failed chain load is NEVER surfaced as an error: the broker's answer
       here is transient (PiConnect throttling, a stale ATM quote, a dead
       session), so the panel either keeps the rows it already has or keeps
       saying "Loading chain…" and quietly asks again — 0.8s, 1.2, 2, 3, 4, 5,
       then 8/12/15s, indefinitely — until a chain paints. The loop stops while
       the panel is closed (reopening triggers a fresh load) and while the tab
       is hidden. */
    function ocChainFailed(msg) {
      ocChainError = msg || "Chain unavailable";
      ocFailStreak++;
      if (!(ocData && (ocData.chain || []).length)) {
        const body = document.getElementById("ocBody");
        if (!body.querySelector(".oc-loadmsg")) {
          body.innerHTML = `<p class="oc-loadmsg">Loading chain…</p>`;
          document.getElementById("ocPinbar").hidden = true;
          clearOcLegs();
        }
      }
      updateOcStatus();
      scheduleOcRetry();
    }

    function scheduleOcRetry() {
      if (ocRetryTimer) return;
      const delays = [800, 1200, 2000, 3000, 4000, 5000, 8000, 12000, 15000];
      const wait = delays[Math.min(ocRetryAttempt, delays.length - 1)];
      ocRetryAttempt++;
      ocRetryTimer = setTimeout(() => {
        ocRetryTimer = null;
        if (!ocWinVisible) return;  // closed → the next open loads fresh
        if (document.hidden) { scheduleOcRetry(); return; }
        fetchOptionChain({ silent: true });
      }, wait);
    }

    function clearOcRetry() {
      if (ocRetryTimer) { clearTimeout(ocRetryTimer); ocRetryTimer = null; }
      ocRetryAttempt = 0;
    }

    // ---------- Greeks from the broker's own engine (GetOptionGreek) -------
    /* The chain route paints the legs with locally computed IV/Greeks in one
       fast pass. When a Greek column is on screen the panel then asks the
       documented POST /api/optionchain/greeks for the same legs — a few at a
       time, because each leg is one GetOptionGreek round-trip — and rewrites
       the cells as the broker's numbers land. A leg the broker refuses keeps
       its local values (source "local"); a new chain load supersedes any
       upgrade still in flight. */
    const OC_GREEK_BATCH = 8;

    async function upgradeOcGreeks() {
      if (!ocData || !ocData.expiry) return;
      const run = ocGreekRun;
      const legs = [];
      for (const row of ocData.chain || []) {
        for (const leg of [row.ce, row.pe]) {
          if (!leg || !leg.tsym || !(leg.ltp > 0)) continue;
          if (leg.greeks_source === "piconnect") continue;
          legs.push({
            tsym: leg.tsym, token: leg.token || "",
            strike: leg.strike, optt: leg.optt || "CE", ltp: leg.ltp,
          });
        }
      }
      for (let i = 0; i < legs.length; i += OC_GREEK_BATCH) {
        if (run !== ocGreekRun) return;  // a newer chain load took over
        try {
          const res = await fetch("/api/optionchain/greeks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              exchange: ocPrefs.exchange,
              expiry: ocData.expiry,
              legs: legs.slice(i, i + OC_GREEK_BATCH),
            }),
          });
          const payload = await res.json();
          if (run !== ocGreekRun) return;
          if (payload.stat !== "Ok" || !payload.greeks) continue;
          let touched = false;
          for (const row of ocData.chain || []) {
            for (const leg of [row.ce, row.pe]) {
              const g = leg && payload.greeks[leg.tsym];
              if (!g) continue;
              leg.iv = g.iv;
              leg.delta = g.delta;
              leg.gamma = g.gamma;
              leg.theta = g.theta;
              leg.vega = g.vega;
              leg.greeks_source = g.source;
              touched = true;
            }
          }
          if (touched) renderChain(ocData);
        } catch (e) {
          return;  // broker refused / offline — local values stay
        }
      }
    }

    // ---------- status footer (Not updating / Not streaming / closed) -------
    /* A silently-polled chain that stopped updating otherwise reads as live.
       Priority mirrors OptionChainPanel: stall > not-streaming > closed. */
    function ocMarketOpen() {
      const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      if (now.getDay() === 0 || now.getDay() === 6) return false;
      const mins = now.getHours() * 60 + now.getMinutes();
      return mins >= 555 && mins <= 930; // 09:15–15:30 IST
    }

    function updateOcStatus() {
      const foot = document.getElementById("ocStatus");
      if (!ocData || !(ocData.chain || []).length) { foot.hidden = true; return; }
      const hhmm = ocLastUpdate ? ocLastUpdate.toLocaleTimeString() : "";
      /* A refresh that keeps failing is retried silently (see ocChainFailed);
         only once several attempts in a row have missed does the footer note
         that the rows on screen are stale. */
      if (ocFailStreak >= 3 && ocLastUpdate) {
        foot.textContent = `Not updating. Last loaded ${hhmm}`;
        foot.className = "wl-foot amber";
      } else if (ocMarketOpen() && !(connected())) {
        foot.textContent = `Not streaming. Last update ${hhmm}`;
        foot.className = "wl-foot amber";
      } else if (!ocMarketOpen()) {
        foot.textContent = "Market closed. Showing last traded prices.";
        foot.className = "wl-foot";
      } else {
        foot.hidden = true;
        return;
      }
      foot.hidden = false;
    }

    function startOcStatusTimer() {
      if (ocStatusTimer) return;
      ocStatusTimer = setInterval(updateOcStatus, 5000);
    }

    // ---------- header cell (headerCell): label + greek chip ---------------
    function ocHeaderCell(column, align) {
      const showChip = column.symbol !== column.label && !column.hideSymbol;
      const chip = showChip ? `<span class="hchip">${column.symbol}</span>` : "";
      return `<span class="oc-hcell">${align === "right" ? chip : ""}<span style="overflow:hidden;text-overflow:ellipsis;">${column.label}</span>${align === "left" ? chip : ""}</span>`;
    }

    /**
     * The three-pane table:
     *   [ call table ][ strike ][ put table ]
     * Call cells read right-to-left toward the strike, puts left-to-right.
     * Each side owns ONE horizontal scroller; the strike column never
     * scrolls; the pinned strip under the body carries the visible bars.
     */
    function renderChain(payload) {
      const spotEl = document.getElementById("ocSpot");
      spotEl.hidden = false;
      document.getElementById("ocAtmValue").textContent = payload.atm_strike;
      document.getElementById("ocSpotValue").textContent = fmt(payload.underlying_ltp);
      updatePcrValue();
      paintSpotDirection();

      /* The put side's render order is the canonical outward-from-strike
         order; the call side is the SAME list reversed (callColumns), so
         its LTP also sits against the strike. */
      const cols = shownOcColumns();
      const callCols = [...cols].reverse();
      const callTracks = ocTracks(callCols);
      const putTracks = ocTracks(cols);
      const callW = ocWidthFor(callCols);
      const putW = ocWidthFor(cols);
      const peakOi = (payload.chain || []).reduce((m, r) => Math.max(m, (r.ce && r.ce.oi) || 0, (r.pe && r.pe.oi) || 0), 0);

      // Header strip (call header reads right-to-left, chip on the outer edge)
      const callHead = document.getElementById("ocCallHead");
      const putHead = document.getElementById("ocPutHead");
      callHead.style.gridTemplateColumns = callTracks;
      callHead.style.width = callW + "px";
      putHead.style.gridTemplateColumns = putTracks;
      putHead.style.width = putW + "px";
      callHead.innerHTML = callCols.map(c => ocHeaderCell(c, "right")).join("");
      putHead.innerHTML = cols.map(c => ocHeaderCell(c, "left")).join("");

      // Body rows
      const rows = payload.chain || [];
      if (!rows.length) {
        document.getElementById("ocBody").innerHTML =
          `<div class="oc-empty"><p>No chain for this contract. Check the expiry, or that master contracts are downloaded.</p></div>`;
        document.getElementById("ocPinbar").hidden = true;
        clearOcLegs();
        updateOcStatus();
        return;
      }

      const legCell = (side, row, column) => {
        const leg = row[side];
        const atm = row.strike === payload.atm_strike;
        const otm = side === "ce" ? row.strike > payload.atm_strike : row.strike < payload.atm_strike;
        const key = leg ? `${payload.exchange}:${String(leg.tsym).toUpperCase()}` : null;
        const active = key !== null && key === pageActiveKey;
        const cls = ["oc-cell", side,
          otm ? "otm" : "",
          active ? "legActive" : ""].filter(Boolean).join(" ");
        const value = ocMetric(leg, column.id);
        const change = column.id === "ltp" ? ocChangePct(leg) : null;
        const chgHtml = change != null
          ? `<span class="oc-ltp-chg ${change >= 0 ? "up" : "down"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</span>`
          : "";
        let barHtml = "";
        if (ocDisplay.showBars && column.id === "oi" && leg && leg.oi > 0 && peakOi > 0) {
          const w = Math.min(100, (leg.oi / peakOi) * 100);
          barHtml = `<span class="oc-oi-bar" style="width:${w}%;"></span>`;
        }
        return `<div class="${cls}" data-side="${side}" data-strike="${row.strike}">
                  ${barHtml}
                  <span class="oc-value ${leg ? "" : "oc-dim"}">
                    <span>${value}</span>${chgHtml}
                  </span>
                </div>`;
      };

      const callRows = rows.map(row =>
        `<div class="oc-leg" style="grid-template-columns:${callTracks};">
           ${callCols.map(c => legCell("ce", row, c)).join("")}
         </div>`).join("");
      const putRows = rows.map(row =>
        `<div class="oc-leg" style="grid-template-columns:${putTracks};">
           ${cols.map(c => legCell("pe", row, c)).join("")}
         </div>`).join("");
      const strikeRows = rows.map(row => {
        const atm = row.strike === payload.atm_strike;
        return `<div class="oc-strike rowcell${atm ? " atm" : ""}">${row.strike}</div>`;
      }).join("");

      /* This function repaints on every poll AND on each Greek batch, so the
         reader's position has to survive the DOM swap — otherwise the chain
         jumps back to the top mid-read. */
      const ocBodyEl = document.getElementById("ocBody");
      const prevTop = ocBodyEl.scrollTop;
      const prevCallLeft = (document.getElementById("ocCallSide") || {}).scrollLeft || 0;
      const prevPutLeft = (document.getElementById("ocPutSide") || {}).scrollLeft || 0;

      /* Each side owns ONE horizontal scroller wrapping a content-width
         stack of its rows — panning moves all rows on that side together,
         the two sides stay independent, the strike column never scrolls. */
      document.getElementById("ocBody").innerHTML = `
        <div class="oc3-rowwrap">
          <div class="oc3-side" id="ocCallSide"><div class="oc-sideInner" style="width:${callW}px;">${callRows}</div></div>
          <div id="ocStrikeCol">${strikeRows}</div>
          <div class="oc3-side" id="ocPutSide"><div class="oc-sideInner" style="width:${putW}px;">${putRows}</div></div>
        </div>`;

      // Fixed-width strike column keeps its separators on the body's lines.
      const strikeCol = document.getElementById("ocStrikeCol");
      strikeCol.style.width = "64px";
      strikeCol.style.flexShrink = "0";

      // The pinned bar's spacers get the same content widths as their
      // tables, so the visible thumb covers the same fraction as the body's.
      document.getElementById("ocCallPinInner").style.width = callW + "px";
      document.getElementById("ocPutPinInner").style.width = putW + "px";

      // Leg clicks chart the contract, the same pick the OA panel does.
      document.getElementById("ocBody").querySelectorAll(".oc-cell").forEach(cell => {
        cell.addEventListener("click", () => {
          const side = cell.dataset.side === "ce" ? "ce" : "pe";
          const strike = Number(cell.dataset.strike);
          const row = rows.find(r => r.strike === strike);
          const leg = row && row[side];
          if (!leg || !leg.tsym) return;
          if (leg.token && addChartToken) addChartToken(payload.exchange, leg.tsym, String(leg.token));
          markCharted(payload.exchange, leg.tsym);
          renderChain(ocData); // repaint active ring
          openSymbol(leg.tsym, payload.exchange);
        });
      });

      // Shared pane pixel width across header/body/pinned bar.
      ocApplyPaneWidths();

      // Scroll sync between the pinned strips, the headers and the side
      // scrollers — per-side guards, so a call drag can never fight a put
      // drag (OpenAlgo `syncing` refs).
      const callSide = document.getElementById("ocCallSide");
      const putSide = document.getElementById("ocPutSide");
      const callPin = document.getElementById("ocCallPin");
      const putPin = document.getElementById("ocPutPin");
      const callHeadPane = document.getElementById("ocCallHeadPane");
      const putHeadPane = document.getElementById("ocPutHeadPane");
      const syncing = { call: false, put: false };
      const wire = (from, targets, side) => from.addEventListener("scroll", () => {
        if (syncing[side]) return;
        syncing[side] = true;
        targets.forEach(t => { t.scrollLeft = from.scrollLeft; });
        syncing[side] = false;
      });
      wire(callSide, [callPin, callHeadPane], "call");
      wire(putSide, [putPin, putHeadPane], "put");
      wire(callPin, [callSide, callHeadPane], "call");
      wire(putPin, [putSide, putHeadPane], "put");
      document.getElementById("ocPinbar").hidden = false;
      callHeadPane.scrollLeft = 0;

      if (prevTop || prevCallLeft || prevPutLeft) {
        // Same reader position as before the repaint (the programmatic
        // scrollLeft assignments drive the header/pin sync via wire()).
        ocBodyEl.scrollTop = prevTop;
        callSide.scrollLeft = prevCallLeft;
        putSide.scrollLeft = prevPutLeft;
      } else {
        // Put LTP against the strike needs nothing (scrollLeft 0); the call
        // side must open fully scrolled right so ITS LTP meets the strike.
        repinCallScroll();
      }

      // Subscribe the legs so they paint live from market-data frames.
      wireOcLegs(payload);
      updateOcStatus();
    }

    function updatePcrValue() {
      if (!ocData || !ocData.chain) return;
      let ceOi = 0, peOi = 0;
      for (const row of ocData.chain) {
        ceOi += (row.ce && row.ce.oi) || 0;
        peOi += (row.pe && row.pe.oi) || 0;
      }
      document.getElementById("ocPcrLabel").textContent = `PCR(${ocData.chain.length})`;
      const wrap = document.getElementById("ocPcrWrap");
      if (wrap) wrap.title = `Across ${ocData.chain.length} strikes on screen`;
      document.getElementById("ocPcrValue").textContent =
        ceOi > 0 ? (peOi / ceOi).toFixed(2) : "-";
    }

    /* Tri-state spot, OpenAlgo spotDirection: green above the previous
       close, red below it, NEUTRAL when the close is unknown or equal.
       Persistent, never a tick-flash. */
    function paintSpotDirection() {
      const el = document.getElementById("ocSpotValue");
      el.classList.remove("spot-up", "spot-down");
      const ltp = Number(String(el.textContent).replace(/,/g, ""));
      if (!Number.isFinite(ltp) || !(ocSpotPrevClose > 0) || ltp === ocSpotPrevClose) return;
      el.classList.add(ltp > ocSpotPrevClose ? "spot-up" : "spot-down");
    }

    // ---------- chains columns menu -----------------------------------------
    document.getElementById("ocColsBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("ocColsMenu");
      const open = !menu.hidden;
      closeAllMenus(menu);
      if (open) { menu.hidden = true; return; }
      const frag = document.createDocumentFragment();
      frag.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-label", textContent: "Columns" }));
      for (const c of OC_COLUMNS) {
        frag.appendChild(buildCheckItem(c.label, ocDisplay.columns.includes(c.id), () => {
          ocDisplay.columns = ocDisplay.columns.includes(c.id)
            ? ocDisplay.columns.filter(x => x !== c.id)
            : [...ocDisplay.columns, c.id];
          saveOcDisplay();
          if (ocData) renderChain(ocData);
          // Turning a Greek column on: the chain already carries local
          // values, so just ask the broker's engine for the same legs.
          if (ocWantsGreeks()) upgradeOcGreeks();
        }));
      }
      frag.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-sep" }));
      frag.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-label", textContent: "Options" }));
      frag.appendChild(buildCheckItem("OI Bars", ocDisplay.showBars, () => {
        ocDisplay.showBars = !ocDisplay.showBars;
        saveOcDisplay();
        if (ocData) renderChain(ocData);
      }));
      menu.innerHTML = "";
      menu.appendChild(frag);
      menu.hidden = false;
    });

    // ============================================================
    // TAB — PI CHAIN (PiConnect GetOptionChain + GetOptionGreek)
    // The standalone sibling of the option chain that is built ONLY on the
    // two DOCUMENTED PiConnect endpoints, composed server-side:
    //   GET  /api/pichain/chain   — ONE spec-verbatim GetOptionChain call
    //     (metadata rows only, mid = the panel's live spot; probe-verified
    //     live that the wire carries no quotes, so prices arrive via /ws)
    //   POST /api/pichain/greeks  — GetOptionGreek per leg, batched: the
    //     leg's LIVE LTP (WS) is inverted with the spot Black-Scholes model
    //     GetOptionGreek itself evaluates, then the broker answers at that
    //     volatility (`sptprc` is a SPOT; exd wants DD-MON-YYYY; optt C/CE).
    // Everything else — board centre, strikes, expiry series, Greeks —
    // comes from these two calls and nothing else.
    // ============================================================
    const PC_PREFS = "cognix_pichain";
    let pcPrefs = { exchange: "NFO", underlying: "", token: "", tsymFut: "", expiry: "" };
    try { pcPrefs = Object.assign(pcPrefs, JSON.parse(localStorage.getItem(PC_PREFS) || "{}")); } catch (e) { /* defaults */ }
    function savePcPrefs() { localStorage.setItem(PC_PREFS, JSON.stringify(pcPrefs)); }
    /* The scrip the board is KEYED on: the futures for the front series,
       that series' representative option once another expiry is picked
       (GetOptionChain returns the tsym's own series — probe-verified). */
    let pcKeyTsym = "";   // tsym of the series rep (futures or option)

    const PC_STRIKE_COUNT = 10;          // cnt — strikes PER SIDE (doc)
    const PC_COLUMNS = OC_COLUMNS;       // same column catalog as the chain tab
    const PC_GREEK_COLUMNS = ["iv", "delta", "gamma", "theta", "vega"];
    function pcWantsGreeks() { return PC_GREEK_COLUMNS.some(id => pcDisplay.columns.includes(id)); }

    let pcDisplay = { columns: ["ltp", "oi", "volume"], showBars: true };
    try {
      const saved = JSON.parse(localStorage.getItem("cognix_pichain_display") || "{}");
      const ids = OC_COLUMNS.map(c => c.id);
      pcDisplay = {
        columns: Array.isArray(saved.columns) ? saved.columns.filter(c => ids.includes(c)) : pcDisplay.columns,
        showBars: typeof saved.showBars === "boolean" ? saved.showBars : true,
      };
    } catch (e) { /* defaults */ }
    function savePcDisplay() { localStorage.setItem("cognix_pichain_display", JSON.stringify(pcDisplay)); }

    let pcLoading = false;
    let pcData = null;        // last GetOptionChain payload (chain, mid)
    let pcSpot = null;        // live underlying value from the WS (the mid)
    let pcSpotPrevClose = null;
    let pcGreekRun = 0;
    let pcFailStreak = 0;     // consecutive failed loads → stall footer
    let pcLastUpdate = null;
    let pcRetryTimer = null;  // silent auto-retry of a failed load
    let pcRetryAttempt = 0;
    let pcStatusTimer = null;
    let pcOiTimer = null;     // 30s silent metadata refetch
    let pcPaneW = null;

    const pcBodyEl = document.getElementById("pcBody");
    const pcExchangeEl = document.getElementById("pcExchange");
    const pcExpiryEl = document.getElementById("pcExpiry");
    const pcRefreshIcon = document.getElementById("pcRefreshIcon");
    pcExchangeEl.value = pcPrefs.exchange;

    function pcApplyPaneWidths() {
      for (const id of ["pcCallHeadPane", "pcPutHeadPane", "pcCallSide", "pcPutSide", "pcCallPin", "pcPutPin"]) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (pcPaneW != null) {
          el.style.width = pcPaneW + "px";
          el.style.flex = "0 0 auto";
        } else {
          el.style.width = "";
          el.style.flex = "";
        }
      }
    }

    function pcMeasurePanes() {
      if (rightPanel.hidden || !pcBodyEl.clientWidth) return;
      const w = Math.max(0, Math.floor((pcBodyEl.clientWidth - OC_STRIKE_W) / 2));
      if (w !== pcPaneW) {
        pcPaneW = w;
        pcApplyPaneWidths();
      }
      repinPiCallScroll();
    }
    if (pcBodyEl) new ResizeObserver(pcMeasurePanes).observe(pcBodyEl);

    /* The call side renders reversed, so open it fully scrolled right —
       its LTP column sits against the strike. rAF for fresh layout. */
    function repinPiCallScroll() {
      requestAnimationFrame(() => {
        const el = document.getElementById("pcCallSide");
        if (!el || !el.scrollWidth) return;
        el.scrollLeft = el.scrollWidth;
        const head = document.getElementById("pcCallHeadPane");
        const pin = document.getElementById("pcCallPin");
        if (head) head.scrollLeft = el.scrollLeft;
        if (pin) pin.scrollLeft = el.scrollLeft;
      });
    }

    pcExpiryEl.addEventListener("change", () => {
      pcPrefs.expiry = pcExpiryEl.value;
      savePcPrefs();
      // GetOptionChain returns the tsym's own series, so a picked expiry
      // re-keys the board on that series' representative option.
      const reps = ((findPiUniverseEntry(pcPrefs.underlying) || {}).option_by_expiry) || {};
      const rep = (pcPrefs.expiry && reps[pcPrefs.expiry]) || null;
      pcKeyTsym = (rep && rep.tsym) || "";
      fetchPiChain();
    });

    // ---------- live underlying (WS) + one quote to seed the mid ------------
    let piLiveKey = null;
    function startPiLive() {
      if (piLiveKey) {
        const old = pageSubs.get(piLiveKey);
        if (old) unsubscribeChartItem(old);
        piLiveKey = null;
      }
      if (!pcPrefs.token) return;
      const item = { exchange: pcPrefs.exchange, token: pcPrefs.token, tsym: pcPrefs.tsymFut };
      subscribeChartItem(item);
      piLiveKey = `${item.exchange}|${item.token}`;
      // The very first board paint needs a mid even before any WS tick
      // arrives (pre-open, fresh session) — seed it with ONE quote call.
      // This is the quote fallback the rest of the module uses, not the
      // chain API: the board itself always comes from GetOptionChain.
      if (!pcSpot) seedPiSpot();
    }
    async function seedPiSpot() {
      try {
        const r = await fetch(`/api/quotes?exchange=${encodeURIComponent(pcPrefs.exchange)}&token=${encodeURIComponent(pcPrefs.token)}`, { method: "POST" });
        const p = await r.json();
        const d = (p && p.data) || {};
        if (d.ltp != null && Number(d.ltp) > 0) {
          pcSpot = Number(d.ltp);
          if (!pcSpotPrevClose && d.prev_close != null && Number(d.prev_close) > 0) {
            pcSpotPrevClose = Number(d.prev_close);
          }
          paintPiSpot();
        }
      } catch (e) { /* the WS will answer */ }
    }

    function paintPiSpot() {
      const line = document.getElementById("pcSpot");
      if (pcSpot == null && !(pcData && pcData.mid)) return;
      line.hidden = false;
      document.getElementById("pcSpotValue").textContent = fmt(pcSpot != null ? pcSpot : pcData.mid);
      document.getElementById("pcAtmValue").textContent =
        (pcData && pcData.atm_strike) != null ? pcData.atm_strike : "—";
      document.getElementById("pcPcrValue").textContent = pcPcr();
    }

    function pcPcr() {
      let ce = 0, pe = 0;
      for (const row of (pcData && pcData.chain) || []) {
        ce += (row.ce && row.ce.oi) || 0;
        pe += (row.pe && row.pe.oi) || 0;
      }
      return ce > 0 ? (pe / ce).toFixed(2) : "-";
    }

    function paintPiSpotDirection() {
      const el = document.getElementById("pcSpotValue");
      el.classList.remove("spot-up", "spot-down");
      const ltp = Number(String(el.textContent).replace(/,/g, ""));
      if (!Number.isFinite(ltp) || !(pcSpotPrevClose > 0) || ltp === pcSpotPrevClose) return;
      el.classList.add(ltp > pcSpotPrevClose ? "spot-up" : "spot-down");
    }

    // ---------- board fetch (documented GetOptionChain, through /pichain) ----
    document.getElementById("pcRefreshBtn").addEventListener("click", () => fetchPiChain());

    /* The series to KEY the board on: futures for the front series, that
       series' representative option once an expiry is picked. */
    function pcChainKey() {
      if (pcKeyTsym) return pcKeyTsym;
      return pcPrefs.tsymFut || pcPrefs.underlying;
    }

    async function fetchPiChain(opts = {}) {
      const silent = !!opts.silent;
      if (!pcPrefs.underlying || !pcPrefs.token) return;
      // The doc's strprc is the board's MID — the live underlying value.
      // Without it (pre-open, socket down) the loader waits and retries; it
      // is ONE seeded quote away, so this never surfaces as an error.
      if (pcSpot == null) {
        if (!silent) {
          document.getElementById("pcBody").innerHTML = `<p class="oc-loadmsg">Loading chain…</p>`;
          ocSpin(pcRefreshIcon, true);
          // The retry below re-seeds the quote; the spinner rests until then.
          setTimeout(() => ocSpin(pcRefreshIcon, false), 400);
        }
        schedulePiRetry();
        return;
      }
      if (pcLoading) return;
      pcLoading = true;
      pcGreekRun++;   // any Greek upgrade still running is now stale
      if (!silent) {
        ocSpin(pcRefreshIcon, true);
        // Loading state only when nothing is on screen — a refresh never
        // blanks the rendered chain.
        if (!(pcData && (pcData.chain || []).length)) {
          document.getElementById("pcBody").innerHTML = `<p class="oc-loadmsg">Loading chain…</p>`;
        }
      }
      try {
        const p = new URLSearchParams({
          exchange: pcPrefs.exchange,
          tsym: pcChainKey(),
          cnt: String(PC_STRIKE_COUNT),
          strprc: String(pcSpot),
        });
        const res = await fetch(`/api/pichain/chain?${p.toString()}`);
        const payload = await res.json();
        if (payload.stat !== "Ok") {
          pcChainFailed(payload.emsg || "GetOptionChain refused");
        } else {
          pcFailStreak = 0;
          clearPiRetry();
          pcLastUpdate = new Date();
          piPrepareChain(payload);
          pcData = payload;
          renderPiChain(payload);
          startPiOiPoll();
          startPiStatusTimer();
          // The WS only pushes on trade — outside market hours (or before
          // the first tick) every leg's price cell would sit at "—". One
          // REST fill of the board's quotes keeps the page usable, exactly
          // the fallback the rest of the module uses while the socket is
          // down; anything the WS delivers afterwards overwrites it. The
          // +4s second pass catches a cycle the busy-guard skipped (and
          // stragglers), since the fill and Greek batches are idempotent.
          fillPiQuotes();
          setTimeout(() => fillPiQuotes(), 4000);
        }
      } catch (e) {
        pcChainFailed(String(e.message || e));
      } finally {
        pcLoading = false;
        if (!silent) ocSpin(pcRefreshIcon, false);
      }
    }

    function piPrepareChain(payload) {
      /* GetOptionChain returns metadata only — the previous payload's
         client-merged live state (WS/fill prices, OI, broker Greeks) is
         carried across loads by token, so a 30s refresh does not blank the
         board or re-request the same Greeks for unchanged prices. */
      const prev = pcData;
      if (prev && prev.chain && prev.exchange === payload.exchange) {
        const prevLegs = new Map();
        for (const row of prev.chain) {
          for (const leg of [row.ce, row.pe]) {
            if (leg && leg.token) prevLegs.set(String(leg.token), leg);
          }
        }
        for (const leg of payload.contracts || []) {
          if (!leg) continue;
          const old = prevLegs.get(String(leg.token));
          if (!old) continue;
          if (old.ltp > 0) leg.ltp = old.ltp;
          if (old.prev_close > 0) leg.prev_close = old.prev_close;
          if (old.oi > 0) leg.oi = old.oi;
          if (old.volume > 0) leg.volume = old.volume;
          if (old.bid > 0) leg.bid = old.bid;
          if (old.ask > 0) leg.ask = old.ask;
          if (old.greeks_source === "piconnect") {
            leg.iv = old.iv; leg.delta = old.delta; leg.gamma = old.gamma;
            leg.theta = old.theta; leg.vega = old.vega; leg.rho = old.rho;
            leg.greeksLtp = old.greeksLtp;
            leg.greeks_source = old.greeks_source;
          }
        }
      }
      // Group the metadata rows by strike: ce/pe legs + the ATM the board
      // centred on (nearest strike to the mid GetOptionChain snapped).
      const grouped = new Map();
      for (const leg of payload.contracts || []) {
        const strike = Number(leg.strike);
        if (!Number.isFinite(strike)) continue;
        let row = grouped.get(strike);
        if (!row) {
          row = { strike, ce: null, pe: null };
          grouped.set(strike, row);
        }
        if (String(leg.optt || "").toUpperCase().startsWith("C")) {
          if (!row.ce) row.ce = leg;
        } else if (!row.pe) {
          row.pe = leg;
        }
      }
      const chain = [...grouped.values()].sort((a, b) => a.strike - b.strike);
      let atm = null;
      if (payload.mid != null && chain.length) {
        atm = chain.reduce((best, r) =>
          best == null || Math.abs(r.strike - payload.mid) < Math.abs(best - payload.mid)
            ? r.strike : best, null);
      }
      payload.chain = chain;
      payload.atm_strike = atm;
      payload.expiry = pcPrefs.expiry;
    }

    function pcChainFailed(msg) {
      pcFailStreak++;
      if (!(pcData && (pcData.chain || []).length)) {
        const body = document.getElementById("pcBody");
        if (!body.querySelector(".oc-loadmsg")) {
          body.innerHTML = `<p class="oc-loadmsg">Loading chain…</p>`;
          document.getElementById("pcPinbar").hidden = true;
          clearPiLegs();
        }
      }
      updatePiStatus();
      schedulePiRetry();
    }

    function schedulePiRetry() {
      if (pcRetryTimer) return;
      const delays = [800, 1200, 2000, 3000, 4000, 5000, 8000, 12000, 15000];
      const wait = delays[Math.min(pcRetryAttempt, delays.length - 1)];
      pcRetryAttempt++;
      pcRetryTimer = setTimeout(() => {
        pcRetryTimer = null;
        if (activePanel !== "pichain") return;  // reopened → fresh load
        if (document.hidden) { schedulePiRetry(); return; }
        // A load that keeps failing for lack of a mid re-seeds the quote.
        if (pcSpot == null) seedPiSpot();
        fetchPiChain({ silent: true });
      }, wait);
    }

    function clearPiRetry() {
      if (pcRetryTimer) { clearTimeout(pcRetryTimer); pcRetryTimer = null; }
      pcRetryAttempt = 0;
    }

    /* One batched REST fill of the board's quotes (≤40 / call, ≤3 calls for
       the max window). Legs the WS has already painted are left alone; the
       rest get ltp/prev_close/oi/volume/bid/ask merged into the leg model
       (ws frames keep overwriting from there) and a single repaint follows.
       This is the module's REST fallback — the board itself never comes
       from here, only the prices GetOptionChain does not carry. */
    let piFillBusy = false;
    async function fillPiQuotes() {
      if (!pcData) return;
      if (piFillBusy) return;
      const missing = [];   // leg objects whose price the WS has not painted
      for (const row of pcData.chain || []) {
        for (const leg of [row.ce, row.pe]) {
          if (leg && leg.token && !(leg.ltp > 0)) missing.push(leg);
        }
      }
      // Prices already delivered? Still ask the Greek batches to catch up —
      // legs that a previous load priced keep their answers, so this is
      // idempotent and cheap (un-priced legs are simply not sent).
      if (!missing.length) { upgradePiGreeks(); return; }
      piFillBusy = true;
      try {
        for (let i = 0; i < missing.length; i += 40) {
          const chunk = missing.slice(i, i + 40);
          const res = await fetch("/api/multiquotes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              symbols: chunk.map(leg => ({
                exchange: pcData.exchange, token: String(leg.token),
              })),
            }),
          });
          const payload = await res.json();
          if (payload.status !== "success") return;
          const byToken = new Map(chunk.map(leg => [String(leg.token), leg]));
          for (const q of payload.quotes || []) {
            if (!q || q.status !== "success") continue;
            const leg = byToken.get(String(q.token));
            if (!leg) continue;
            if (q.ltp != null && Number(q.ltp) > 0) leg.ltp = Number(q.ltp);
            if (q.prev_close != null && Number(q.prev_close) > 0) leg.prev_close = Number(q.prev_close);
            if (q.oi != null) leg.oi = Number(q.oi);
            if (q.volume != null) leg.volume = Number(q.volume);
            if (q.bid != null) leg.bid = Number(q.bid);
            if (q.ask != null) leg.ask = Number(q.ask);
          }
        }
        renderPiChain(pcData);
        // Prices just landed — the Greek upgrade can now invert them.
        upgradePiGreeks();
      } catch (e) {
        /* silent — the WS or the next 30s refresh repaints */
      } finally {
        piFillBusy = false;
      }
    }

    function ocSpin(icon, on) {
      if (on) {
        icon.classList.add("oc-spin");
        icon.style.animation = "oaSpin 1s linear infinite";
      } else {
        icon.style.animation = "";
        icon.classList.remove("oc-spin");
      }
    }

    // 30s silent metadata refetch (no spinner, no flash reset).
    function startPiOiPoll() {
      if (pcOiTimer) return;
      pcOiTimer = setInterval(() => {
        if (pcPrefs.underlying && pcPrefs.token && !pcLoading) fetchPiChain({ silent: true });
      }, 30000);
    }
    function stopPiOiPoll() {
      if (pcOiTimer) { clearInterval(pcOiTimer); pcOiTimer = null; }
    }

    // ---------- board repaint (the option-chain three-pane table) -----------
    function piHeaderCell(column, align) {
      const showChip = column.symbol !== column.label && !column.hideSymbol;
      const chip = showChip ? `<span class="hchip">${column.symbol}</span>` : "";
      return `<span class="oc-hcell">${align === "right" ? chip : ""}<span style="overflow:hidden;text-overflow:ellipsis;">${column.label}</span>${align === "left" ? chip : ""}</span>`;
    }

    function renderPiChain(payload) {
      const cols = PC_COLUMNS.filter(c => pcDisplay.columns.includes(c.id));
      const callCols = [...cols].reverse();
      const callTracks = ocTracks(callCols);
      const putTracks = ocTracks(cols);
      const callW = ocWidthFor(callCols);
      const putW = ocWidthFor(cols);
      const rows = payload.chain || [];
      const peakOi = rows.reduce((m, r) => Math.max(m, (r.ce && r.ce.oi) || 0, (r.pe && r.pe.oi) || 0), 0);

      paintPiSpot();
      paintPiSpotDirection();

      const callHead = document.getElementById("pcCallHead");
      const putHead = document.getElementById("pcPutHead");
      callHead.style.gridTemplateColumns = callTracks;
      callHead.style.width = callW + "px";
      putHead.style.gridTemplateColumns = putTracks;
      putHead.style.width = putW + "px";
      callHead.innerHTML = callCols.map(c => piHeaderCell(c, "right")).join("");
      putHead.innerHTML = cols.map(c => piHeaderCell(c, "left")).join("");

      if (!rows.length) {
        document.getElementById("pcBody").innerHTML =
          `<div class="oc-empty"><p>No chain for this contract. Check the expiry, or that master contracts are downloaded.</p></div>`;
        document.getElementById("pcPinbar").hidden = true;
        clearPiLegs();
        updatePiStatus();
        return;
      }

      const legCell = (side, row, column) => {
        const leg = row[side];
        const otm = side === "ce" ? row.strike > payload.atm_strike : row.strike < payload.atm_strike;
        const key = leg ? `${payload.exchange}:${String(leg.tsym).toUpperCase()}` : null;
        const active = key !== null && key === pageActiveKey;
        const cls = ["oc-cell", side, otm ? "otm" : "", active ? "legActive" : ""].filter(Boolean).join(" ");
        const value = ocMetric(leg, column.id);
        const change = column.id === "ltp" ? ocChangePct(leg) : null;
        const chgHtml = change != null
          ? `<span class="oc-ltp-chg ${change >= 0 ? "up" : "down"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</span>`
          : "";
        let barHtml = "";
        if (pcDisplay.showBars && column.id === "oi" && leg && leg.oi > 0 && peakOi > 0) {
          const w = Math.min(100, (leg.oi / peakOi) * 100);
          barHtml = `<span class="oc-oi-bar" style="width:${w}%;"></span>`;
        }
        return `<div class="${cls}" data-side="${side}" data-strike="${row.strike}">
                  ${barHtml}
                  <span class="oc-value ${leg ? "" : "oc-dim"}">
                    <span>${value}</span>${chgHtml}
                  </span>
                </div>`;
      };

      const callRows = rows.map(row =>
        `<div class="oc-leg" style="grid-template-columns:${callTracks};">
           ${callCols.map(c => legCell("ce", row, c)).join("")}
         </div>`).join("");
      const putRows = rows.map(row =>
        `<div class="oc-leg" style="grid-template-columns:${putTracks};">
           ${cols.map(c => legCell("pe", row, c)).join("")}
         </div>`).join("");
      const strikeRows = rows.map(row =>
        `<div class="oc-strike rowcell${row.strike === payload.atm_strike ? " atm" : ""}">${row.strike}</div>`).join("");

      // Preserve the reader's position across repaints (poll + Greek batches).
      const prevTop = pcBodyEl.scrollTop;
      const prevCallLeft = (document.getElementById("pcCallSide") || {}).scrollLeft || 0;
      const prevPutLeft = (document.getElementById("pcPutSide") || {}).scrollLeft || 0;

      pcBodyEl.innerHTML = `
        <div class="oc3-rowwrap">
          <div class="oc3-side" id="pcCallSide"><div class="oc-sideInner" style="width:${callW}px;">${callRows}</div></div>
          <div id="piStrikeCol">${strikeRows}</div>
          <div class="oc3-side" id="pcPutSide"><div class="oc-sideInner" style="width:${putW}px;">${putRows}</div></div>
        </div>`;
      const strikeCol = document.getElementById("piStrikeCol");
      strikeCol.style.width = "64px";
      strikeCol.style.flexShrink = "0";
      document.getElementById("pcCallPinInner").style.width = callW + "px";
      document.getElementById("pcPutPinInner").style.width = putW + "px";

      // Leg clicks chart the contract, the same pick the chain tab makes.
      pcBodyEl.querySelectorAll(".oc-cell").forEach(cell => {
        cell.addEventListener("click", () => {
          const side = cell.dataset.side === "ce" ? "ce" : "pe";
          const strike = Number(cell.dataset.strike);
          const row = rows.find(r => r.strike === strike);
          const leg = row && row[side];
          if (!leg || !leg.tsym) return;
          if (leg.token) addChartToken(payload.exchange, leg.tsym, String(leg.token));
          markCharted(payload.exchange, leg.tsym);
          renderPiChain(pcData);  // repaint the active ring
          openSymbol(leg.tsym, payload.exchange);
        });
      });

      pcApplyPaneWidths();

      // Scroll sync: per-side guards so a call drag can never fight a put drag.
      const callSide = document.getElementById("pcCallSide");
      const putSide = document.getElementById("pcPutSide");
      const callPin = document.getElementById("pcCallPin");
      const putPin = document.getElementById("pcPutPin");
      const callHeadPane = document.getElementById("pcCallHeadPane");
      const putHeadPane = document.getElementById("pcPutHeadPane");
      const syncing = { call: false, put: false };
      const wire = (from, targets, side) => from.addEventListener("scroll", () => {
        if (syncing[side]) return;
        syncing[side] = true;
        targets.forEach(t => { t.scrollLeft = from.scrollLeft; });
        syncing[side] = false;
      });
      wire(callSide, [callPin, callHeadPane], "call");
      wire(putSide, [putPin, putHeadPane], "put");
      wire(callPin, [callSide, callHeadPane], "call");
      wire(putPin, [putSide, putHeadPane], "put");
      document.getElementById("pcPinbar").hidden = false;
      callHeadPane.scrollLeft = 0;

      if (prevTop || prevCallLeft || prevPutLeft) {
        pcBodyEl.scrollTop = prevTop;
        callSide.scrollLeft = prevCallLeft;
        putSide.scrollLeft = prevPutLeft;
      } else {
        repinPiCallScroll();
      }

      wirePiLegs(payload);
      updatePiStatus();
    }

    // ---------- live legs over the same funnel ------------------------------
    let piLegsByToken = new Map();  // "EXCH|TOKEN" -> {leg, valueEl, chgEl}
    /* Coalesced live repaint: frames land leg-by-leg inside a few hundred ms
       (the broker queues each subscriber its snapshot), so one 150ms paint
       covers the burst and a settle pass mops up stragglers. */
    let piRepaintSoon = false;
    let piRepaintSettle = false;
    function schedulePiLiveRepaint() {
      if (piRepaintSoon) { piRepaintSettle = true; return; }
      piRepaintSoon = true;
      setTimeout(() => {
        piRepaintSoon = false;
        if (pcData) renderPiChain(pcData);
        if (piRepaintSettle) {
          piRepaintSettle = false;
          schedulePiLiveRepaint();
        }
      }, 150);
    }
    function wirePiLegs(payload) {
      const wanted = new Set();
      const body = document.getElementById("pcBody");
      for (const row of (payload.chain || [])) {
        for (const side of ["ce", "pe"]) {
          const leg = row[side];
          if (!leg || !leg.token) continue;
          const key = `${payload.exchange}|${String(leg.token)}`;
          wanted.add(key);
          const cell = body.querySelector(
            `.oc-cell[data-side="${side}"][data-strike="${row.strike}"]`);
          if (!cell) continue;
          piLegsByToken.set(key, {
            leg, cell,
            valueEl: cell.querySelector(".oc-value > span"),
            chgEl: cell.querySelector(".oc-ltp-chg"),
            prevLtp: null,
          });
        }
      }
      // Release subscriptions for strikes that left the window.
      for (const key of [...piLegsByToken.keys()]) {
        if (wanted.has(key)) continue;
        const [ex, tok] = key.split("|");
        if (unsubKey) unsubKey(ex, tok);
        piLegsByToken.delete(key);
      }
      if (subKey) {
        for (const key of wanted) {
          const [ex, tok] = key.split("|");
          subKey(ex, tok);
        }
      }
    }

    function clearPiLegs() {
      for (const key of [...piLegsByToken.keys()]) {
        const [ex, tok] = key.split("|");
        if (unsubKey) unsubKey(ex, tok);
        piLegsByToken.delete(key);
      }
      stopPiOiPoll();
    }

    function paintPiLegs(md) {
      const entries = piLegsByToken.get(`${md.exchange}|${md.token}`);
      if (!entries) return;
      const d = md.data || {};
      const leg = entries.leg;
      const wasEmpty = !(leg.ltp > 0);
      // Merge everything the frame carries into the leg model (live values
      // survive every re-render, since the legs are payload references).
      if (d.ltp != null && Number(d.ltp) > 0) leg.ltp = Number(d.ltp);
      if (d.bid != null && Number(d.bid) >= 0) leg.bid = Number(d.bid);
      if (d.ask != null && Number(d.ask) >= 0) leg.ask = Number(d.ask);
      if (d.volume != null) leg.volume = Number(d.volume);
      if (d.oi != null) leg.oi = Number(d.oi);
      if (d.prev_close != null && Number(d.prev_close) > 0) leg.prev_close = Number(d.prev_close);
      // In-place LTP + day-change chip (no full repaint on every tick).
      if (entries.valueEl && leg.ltp > 0) {
        entries.valueEl.textContent = fmt(leg.ltp);
        entries.prevLtp = leg.ltp;
      }
      if (entries.chgEl !== undefined) {
        const change = ocChangePct(leg);
        if (entries.chgEl) {
          if (change === null) { entries.chgEl.remove(); entries.chgEl = null; }
          else entries.chgEl.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
        }
      }
      /* Unlike the chain tab, this board renders from GetOptionChain's
         metadata-only contracts, so the OI/IV/Delta(all-but-LTP) columns
         leave as "-" and stay "-" without a repaint the moment the WS
         delivers prices. One coalesced repaint on the leg's empty→priced
         transition fills every column; afterwards the frames fall back to
         the in-place LTP updates, exactly like the chain tab. */
      if (wasEmpty && leg.ltp > 0) {
        schedulePiLiveRepaint();
        // Prices just landed — ask the documented endpoint for those legs
        // (chain-load triggers remain unlimited; live bursts rate-limit).
        if (pcWantsGreeks() && Date.now() - piGreeksLastAt > 10000) upgradePiGreeks();
      }
    }

    // ---------- Greeks through the documented GetOptionGreek (batched) ------
    const PC_GREEK_BATCH = 8;
    let piGreeksLastAt = 0;   // rate target for the live-transition trigger
    async function upgradePiGreeks() {
      if (!pcData || !pcData.expiry || pcSpot == null) return;
      const run = pcGreekRun;
      piGreeksLastAt = Date.now();
      const legs = [];
      for (const row of pcData.chain || []) {
        for (const leg of [row.ce, row.pe]) {
          if (!leg || !leg.tsym || !(leg.ltp > 0)) continue;
          // Upgraded at THIS price already — the same stock goes again
          // only when the leg's LTP moved since the broker answered.
          if (leg.greeks_source === "piconnect" && leg.greeksLtp === leg.ltp) continue;
          if (leg.greeks_source === "piconnect") leg.greeksLtp = leg.ltp;
          legs.push({
            tsym: leg.tsym, token: leg.token || "",
            strike: leg.strike, optt: leg.optt || "CE", ltp: leg.ltp,
          });
        }
      }
      for (let i = 0; i < legs.length; i += PC_GREEK_BATCH) {
        if (run !== pcGreekRun) return;   // a newer chain load superseded this
        const batch = legs.slice(i, i + PC_GREEK_BATCH);
        try {
          const res = await fetch("/api/pichain/greeks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              exchange: pcData.exchange, expiry: pcData.expiry,
              spot: pcSpot, legs: batch,
            }),
          });
          const payload = await res.json();
          if (payload.stat === "Ok" && run === pcGreekRun) {
            for (const row of pcData.chain || []) {
              for (const leg of [row.ce, row.pe]) {
                const g = (payload.greeks || {})[leg.tsym];
                if (!g) continue;
                leg.iv = g.iv;
                leg.delta = g.delta;
                leg.gamma = g.gamma;
                leg.theta = g.theta;
                leg.vega = g.vega;
                leg.rho = g.rho;
                leg.greeks_source = g.source;
                leg.greeksLtp = leg.ltp;
              }
            }
            renderPiChain(pcData);
          }
        } catch (e) {
          return;  // broker refused / offline — local values stay
        }
      }
    }

    // ---------- status footer ------------------------------------------------
    function updatePiStatus() {
      const foot = document.getElementById("pcStatus");
      if (!pcData || !(pcData.chain || []).length) { foot.hidden = true; return; }
      const hhmm = pcLastUpdate ? pcLastUpdate.toLocaleTimeString() : "";
      /* A refresh that keeps failing is retried silently; only once several
         attempts in a row have missed does the footer mark the rows stale. */
      if (pcFailStreak >= 3 && pcLastUpdate) {
        foot.textContent = `Not updating. Last loaded ${hhmm}`;
        foot.className = "wl-foot amber";
      } else if (ocMarketOpen() && !(connected())) {
        foot.textContent = `Not streaming. Last update ${hhmm}`;
        foot.className = "wl-foot amber";
      } else if (!ocMarketOpen()) {
        foot.textContent = "Market closed. Showing last traded prices.";
        foot.className = "wl-foot";
      } else {
        foot.hidden = true;
        return;
      }
      foot.hidden = false;
    }

    function startPiStatusTimer() {
      if (pcStatusTimer) return;
      pcStatusTimer = setInterval(updatePiStatus, 5000);
    }

    // ---------- exchange / underlying picker --------------------------------
    function pcSetExpiryList(entry) {
      const exps = (entry && entry.expiries) || [];
      pcExpiryEl.innerHTML = "";
      if (!exps.length) {
        pcExpiryEl.disabled = true;
        pcExpiryEl.innerHTML = `<option value="">No expiries</option>`;
        pcPrefs.expiry = "";
        pcKeyTsym = "";
      } else {
        pcExpiryEl.disabled = false;
        for (const e of exps) {
          const o = document.createElement("option");
          o.value = e;
          o.textContent = e;
          pcExpiryEl.appendChild(o);
        }
        if (!exps.includes(pcPrefs.expiry)) pcPrefs.expiry = exps[0];
        pcExpiryEl.value = pcPrefs.expiry;
        // The board is keyed on the PICKED series' rep when one is chosen.
        const reps = (entry && entry.option_by_expiry) || {};
        pcKeyTsym = (pcPrefs.expiry && reps[pcPrefs.expiry] && reps[pcPrefs.expiry].tsym) || "";
      }
      savePcPrefs();
    }

    function findPiUniverseEntry(base) {
      return (pcUList.length ? pcUList : ocUniverseCache.get(pcPrefs.exchange) || [])
        .find(u => u.base === base) || null;
    }

    function pcSelectUnderlying(entry) {
      pcPrefs.underlying = entry.base;
      pcPrefs.token = entry.token;
      pcPrefs.tsymFut = entry.tsym;
      savePcPrefs();
      document.getElementById("pcUnderlyingLabel").textContent = entry.base;
      pcData = null;          // the previous contract's chain must not linger
      pcSpot = null;          // the old scrip's mid means nothing here
      pcSpotPrevClose = null;
      clearPiLegs();
      // pcSetExpiryList leaves pcKeyTsym on the PICKED series' rep — do NOT
      // reset it here (the board must key the tsym of the selected series,
      // not silently fall back to the futures).
      pcSetExpiryList(entry);
      pcUnderlyingMenu.hidden = true;
      startPiLive();
      fetchPiChain();
    }

    pcExchangeEl.addEventListener("change", async () => {
      pcPrefs.exchange = pcExchangeEl.value;
      savePcPrefs();
      clearPiLegs();
      pcData = null;
      pcKeyTsym = "";
      document.getElementById("pcUnderlyingLabel").textContent = "Select";
      document.getElementById("pcBody").innerHTML = `<p class="oc-loadmsg">Select an underlying…</p>`;
      // Switching segment keeps the old underlying only when the new segment
      // has it too; otherwise it falls back to the segment's FIRST entry.
      try {
        const list = await loadOcUniverse(pcPrefs.exchange);
        const keep = list.find(u => u.base === pcPrefs.underlying);
        const target = keep || list[0] || null;
        if (target) {
          pcSelectUnderlying(target);
          return;
        }
      } catch (e) {
        loadPiUnderlyingsIntoMenuIfOpen();
      }
    });

    // Picker window (same universe + search behaviour as the chain tab).
    const pcUnderlyingBtn = document.getElementById("pcUnderlyingBtn");
    const pcUnderlyingMenu = document.getElementById("pcUnderlyingMenu");
    const pcSearchEl = document.getElementById("pcUnderlyingSearch");
    const pcUnderlyingResults = document.getElementById("pcUnderlyingResults");

    let pcUList = [];
    let pcUState = "idle";   // idle | loading | ready
    let pcULoading = false;
    let pcURetryTimer = null;
    let pcURetryAttempt = 0;

    function pcListMessage(text) {
      const div = document.createElement("div");
      div.style.cssText = "padding:12px;text-align:center;font-size:12px;color:var(--oa-muted-fg);";
      div.textContent = text;
      return div;
    }

    function renderPiList() {
      pcUnderlyingResults.innerHTML = "";
      // A failed load keeps "Loading…" and retries on its own — no error box.
      if (pcUState !== "ready") {
        pcUnderlyingResults.appendChild(pcListMessage("Loading…"));
        return;
      }
      const q = pcSearchEl.value.trim().toUpperCase();
      const hits = q ? pcUList.filter(u => u.base.includes(q)) : pcUList;
      if (!hits.length) {
        pcUnderlyingResults.appendChild(pcListMessage("No underlying found."));
        return;
      }
      for (const entry of hits.slice(0, 80)) {
        const btn = document.createElement("button");
        btn.className = "oa-menu-item";
        const check = document.createElement("span");
        check.textContent = entry.base === pcPrefs.underlying ? "✓" : "";
        check.style.cssText = "width:14px;flex:0 0 14px;text-align:center;font-weight:700;";
        const name = document.createElement("span");
        name.textContent = entry.base;
        name.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
        const hint = document.createElement("span");
        hint.className = "mi-hint";
        hint.textContent = entry.tsym || "";
        btn.append(check, name, hint);
        btn.addEventListener("click", () => pcSelectUnderlying(entry));
        pcUnderlyingResults.appendChild(btn);
      }
    }

    async function reloadPiUniverse() {
      if (pcULoading) return;
      pcULoading = true;
      pcUState = "loading";
      pcUList = [];
      renderPiList();
      try {
        pcUList = await loadOcUniverse(pcPrefs.exchange);
        pcUState = "ready";
        pcURetryAttempt = 0;
        if (pcURetryTimer) { clearTimeout(pcURetryTimer); pcURetryTimer = null; }
      } catch (e) {
        // Silent retry: the menu keeps saying "Loading…" and asks again with
        // backoff until the universe arrives.
        pcUState = "loading";
        schedulePiUniverseRetry();
      } finally {
        pcULoading = false;
      }
      if (!pcUnderlyingMenu.hidden) renderPiList();
    }

    function schedulePiUniverseRetry() {
      if (pcURetryTimer) return;
      const delays = [800, 1500, 2500, 4000, 5000, 8000, 12000, 15000];
      const wait = delays[Math.min(pcURetryAttempt, delays.length - 1)];
      pcURetryAttempt++;
      pcURetryTimer = setTimeout(() => {
        pcURetryTimer = null;
        if (pcUnderlyingMenu.hidden) {
          // Menu closed — reopening starts a fresh load.
          pcURetryAttempt = 0;
          pcUState = "idle";
          return;
        }
        reloadPiUniverse();
      }, wait);
    }

    // A segment switch in flight while the menu is closed still needs to
    // repaint the open menu when its load resolves.
    let pcUSeg = pcPrefs.exchange;
    function loadPiUnderlyingsIntoMenuIfOpen() {
      if (pcUnderlyingMenu.hidden) return;
      if (pcUSeg !== pcPrefs.exchange) { pcUSeg = pcPrefs.exchange; reloadPiUniverse(); }
      else renderPiList();
    }

    pcUnderlyingBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !pcUnderlyingMenu.hidden;
      closeAllMenus(pcUnderlyingMenu);
      pcUnderlyingMenu.hidden = open;
      if (!pcUnderlyingMenu.hidden) {
        pcSearchEl.value = "";
        if (pcUSeg !== pcPrefs.exchange || pcUState === "idle") {
          reloadPiUniverse();
          pcUSeg = pcPrefs.exchange;
        } else {
          renderPiList();
        }
        setTimeout(() => pcSearchEl.focus(), 10);
      }
    });

    pcSearchEl.addEventListener("input", () => {
      if (pcUState === "ready") renderPiList();
    });

    async function pcHydrateExpiry() {
      /* A saved underlying restored on panel open still needs its expiry
         select filled (the picker may never have opened this session).
         openPanel loads the board before this resolves, keyed on the
         futures — so once the picked series' rep is known, one silent
         refetch re-keys the board if the series actually needed it. */
      try {
        const list = await loadOcUniverse(pcPrefs.exchange);
        pcUList = list;
        const entry = list.find(u => u.base === pcPrefs.underlying);
        if (!entry) return;
        const before = pcKeyTsym;
        pcSetExpiryList(entry);
        if (pcKeyTsym && pcKeyTsym !== before) fetchPiChain({ silent: true });
      } catch (e) { /* silent — the picker retries on its own */ }
    }

    // ---------- columns menu -------------------------------------------------
    document.getElementById("pcColsBtn").addEventListener("click", (e) => {
      e.stopPropagation();
      const menu = document.getElementById("pcColsMenu");
      const open = !menu.hidden;
      closeAllMenus(menu);
      if (open) { menu.hidden = true; return; }
      const frag = document.createDocumentFragment();
      frag.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-label", textContent: "Columns" }));
      for (const c of PC_COLUMNS) {
        frag.appendChild(buildCheckItem(c.label, pcDisplay.columns.includes(c.id), () => {
          pcDisplay.columns = pcDisplay.columns.includes(c.id)
            ? pcDisplay.columns.filter(x => x !== c.id)
            : [...pcDisplay.columns, c.id];
          savePcDisplay();
          if (pcData) renderPiChain(pcData);
          // Turning a Greek column on: ask the documented endpoint for the
          // same legs a few at a time (they upgrade progressively).
          if (pcWantsGreeks()) upgradePiGreeks();
        }));
      }
      frag.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-sep" }));
      frag.appendChild(Object.assign(document.createElement("div"), { className: "oa-menu-label", textContent: "Options" }));
      frag.appendChild(buildCheckItem("OI Bars", pcDisplay.showBars, () => {
        pcDisplay.showBars = !pcDisplay.showBars;
        savePcDisplay();
        if (pcData) renderPiChain(pcData);
      }));
      menu.innerHTML = "";
      menu.appendChild(frag);
      menu.hidden = false;
    });

    // Telemetry for tests/diagnostics (closure state, one flat handle).
    window.__pcDebug = {
      fetch: fetchPiChain,
      fill: fillPiQuotes,
      greeks: upgradePiGreeks,
      data: () => pcData,
      spot: () => pcSpot,
      state: () => ({
        underlying: pcPrefs.underlying, token: pcPrefs.token, tsymFut: pcPrefs.tsymFut,
        expiry: pcPrefs.expiry, keyTsym: pcKeyTsym, loading: pcLoading,
        failStreak: pcFailStreak, rows: (pcData && pcData.chain || []).length,
        mid: pcData && pcData.mid, spot: pcSpot,
        legs: [...piLegsByToken.values()].slice(0, 3).map(e => ({ ltp: e.leg.ltp, oi: e.leg.oi, tsym: e.leg.tsym })),
      }),
    };


    // ============================================================
    // TAB 3 — ALGO SYMBOLS (algo-hub/AlgoSymbolsPanel.tsx)
    // One card per symbol, three lines:
    //   1. symbol, enable switch, status, actions menu
    //   2. Mode / Qty / Brick / LTP          (heading over value)
    //   3. Last brick / Long-Short / Pending B-S / SL  (heading over value)
    // ============================================================
    const algoRows = new Map(); // id (String) -> merged record (hub row + mapped status)
    const algoFeedKeys = new Set(); // "EXCH|TOKEN" the embed subscribes for live LTP ticks
    let algoTimer = null;
    let algoBusy = new Set();
    let algoProcesses = [];     // per-exchange managed-process lines from the overview
    let algoFlashTimer = null;  // transient info line timeout (flashAlgoInfo)

    // AlgoSymbolsPanel's readChartSymbol: accept {symbol, exchange}, an
    // {instrument:{symbol, exchange}} wrapper, or an "EXCH:SYM" string.
    function readChartInstr(ctx) {
      if (typeof ctx === "string") {
        const cut = ctx.indexOf(":");
        if (cut <= 0) return null;
        return { symbol: ctx.slice(cut + 1), exchange: ctx.slice(0, cut).toUpperCase() };
      }
      if (!ctx || typeof ctx !== "object") return null;
      const inst = (ctx.instrument && typeof ctx.instrument === "object" ? ctx.instrument : ctx) || {};
      let symbol = typeof inst.symbol === "string" ? inst.symbol : "";
      let exchange = typeof inst.exchange === "string" ? inst.exchange : "";
      if (symbol.includes(":")) {
        const [ex, sym] = symbol.split(":");
        exchange = exchange || ex;
        symbol = sym;
      }
      return symbol && exchange ? { symbol, exchange: exchange.toUpperCase() } : null;
    }

    let algoAnalyzeMode = null; // true=Analyzer false=LIVE null=unknown (overview.analyze_mode)

    // GET /strategy-hub/api/overview — {status, analyze_mode, processes[], symbols[]}
    // (strategy_hub/routes.py; blueprint.py parity). Symbols are hub rows:
    // config columns + enabled/version + one `status` row the exchange process
    // rewrote <=2s ago (+ `stale` when the process has not published recently).
    // The record keeps the hub status row RAW (long_qty/short_qty/buy_pending/
    // sell_pending/sl_long/sl_short — AlgoSymbolsPanel reads exactly these);
    // rendering gates it to `enabled && !stale`.
    async function refreshAlgoSymbols() {
      try {
        const res = await fetch("/strategy-hub/api/overview");
        const d = await res.json();
        const arr = (d && d.status === "success" && Array.isArray(d.symbols)) ? d.symbols : [];
        algoProcesses = (d && Array.isArray(d.processes)) ? d.processes : [];
        algoAnalyzeMode = d && d.analyze_mode === true ? true : d && d.analyze_mode === false ? false : null;
        for (const rec of arr) {
          const merged = {
            id: String(rec.id),
            exchange: rec.exchange,
            token: String(rec.token ?? ""),
            tsym: rec.symbol,
            name: rec.strategy_name || rec.symbol,
            product: rec.product || "",
            quantity: rec.quantity,
            trade_mode: rec.trade_mode,
            // Brick method + its parameters (the card's Brick field is method-aware)
            brick_method: rec.brick_method || "fixed",
            atr_period: rec.atr_period,
            atr_multiplier: rec.atr_multiplier,
            ltp_percent: rec.ltp_percent,
            brick_size: rec.brick_size,
            config: Object.assign({}, rec, { id: String(rec.id) }),  // full hub row for the dialog
            enabled: !!rec.enabled,
            stale: !!rec.stale,
            status: rec.status || {},   // raw status row: {state, message, ltp, brick_color, brick_no, long_qty, short_qty, buy_pending, sell_pending, sl_long, sl_short, trades_blocked}
            trades_blocked: !!rec.status?.trades_blocked,
          };
          algoRows.set(merged.id, merged);
          if (addChartToken) addChartToken(merged.exchange, merged.tsym, merged.token);
        }
        for (const id of [...algoRows.keys()]) {
          if (!arr.some(r => String(r.id) === id)) algoRows.delete(id);
        }
        document.getElementById("algoError").hidden = true;
        renderAlgo();
        // Live LTP for algo rows — the SAME path the option-chain legs use:
        // every enabled row is subscribed to the platform feed (the OC
        // subscribes its legs the same way via the page adapter), so
        // paintAlgoLtp paints each tick in place. Refcount-safe on both the
        // desks' shared client and the embed's own quote client.
        {
          const want = new Set();
          for (const rec of algoRows.values()) {
            if (rec.enabled && !rec.stale && rec.exchange && rec.token) {
              want.add(`${String(rec.exchange).toUpperCase()}|${String(rec.token)}`);
            }
          }
          for (const key of want) {
            if (algoFeedKeys.has(key)) continue;
            const [exch, tok] = key.split("|");
            subKey(exch, tok);
            algoFeedKeys.add(key);
          }
          for (const key of [...algoFeedKeys]) {
            if (want.has(key)) continue;
            const [exch, tok] = key.split("|");
            unsubKey(exch, tok);
            algoFeedKeys.delete(key);
          }
        }
      } catch (e) {
        const err = document.getElementById("algoError");
        err.textContent = "Could not reach the server";
        err.hidden = false;
      }
    }

    /** Transient info line (the server's message after an enable/disable/etc). */
    function flashAlgoInfo(text) {
      const err = document.getElementById("algoError");
      err.textContent = text || "";
      err.hidden = !text;
      clearTimeout(algoFlashTimer);
      algoFlashTimer = setTimeout(() => { err.hidden = true; }, 5000);
    }

    function startAlgoPolling() { stopAlgoPolling(); algoTimer = setInterval(refreshAlgoSymbols, 3000); }
    function stopAlgoPolling() { if (algoTimer) { clearInterval(algoTimer); algoTimer = null; } }

    function algoStatusBadge(r) {
      if (!r.enabled) return `<span class="oa-badge off">Disabled</span>`;
      if (r.stale) return `<span class="oa-badge warn" title="Enabled, waiting for the strategy process to start">Waiting</span>`;
      const s = (r.status && r.status.state) || null;
      if (s === "RUNNING") {
        return r.trades_blocked
          ? `<span class="oa-badge warn" title="Squareoff ran — disable and re-enable to resume">Halted</span>`
          : `<span class="oa-badge run">Running</span>`;
      }
      if (s === "HALTED") return `<span class="oa-badge warn" title="${escAlgo((r.status && r.status.message) || "")}">Halted</span>`;
      if (s === "ERROR") return `<span class="oa-badge err" title="${escAlgo((r.status && r.status.message) || "")}">Error</span>`;
      return `<span class="oa-badge off">${escAlgo(s || "Starting")}</span>`;
    }

    // Styled confirm (AlgoSymbolsPanel's ConfirmState Dialog) — replaces the
    // old window.confirm calls: title + description + Cancel/(destructive) action.
    let algoConfirmState = null;
    function algoConfirm(c) {
      algoConfirmState = c;
      document.getElementById("algoConfirmTitle").textContent = c.title || "Confirm";
      const desc = document.getElementById("algoConfirmDesc");
      desc.textContent = c.description || "";
      desc.style.whiteSpace = "pre-line";
      const act = document.getElementById("algoConfirmAction");
      act.textContent = c.action || "OK";
      act.classList.toggle("destructive", !!c.destructive);
      document.getElementById("algoConfirmOverlay").hidden = false;
    }
    function algoConfirmClose() {
      document.getElementById("algoConfirmOverlay").hidden = true;
      algoConfirmState = null;
    }
    document.getElementById("algoConfirmCancel").addEventListener("click", algoConfirmClose);
    document.getElementById("algoConfirmAction").addEventListener("click", async () => {
      const c = algoConfirmState;
      algoConfirmClose();
      if (c) await c.run();
    });
    document.getElementById("algoConfirmOverlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) algoConfirmClose();
    });

    /** A heading with its value directly underneath (Field). */
    function algoField(label, valueHtml, cls) {
      return `<div class="algo-field">
                <div class="k">${label}</div>
                <div class="v ${cls || ""}">${valueHtml}</div>
              </div>`;
    }

    /** Live LTP for algo rows — the SAME method paintOcLegs uses for the
     *  option-chain legs: match by exchange|token, merge the frame's ltp into
     *  the row's status and set the value element in place (no re-render).
     *  Works for BOTH renderers — cards on the desks and the dashboard's
     *  table — because both stamp [data-algo-row][data-id] and carry .c-ltp
     *  on the LTP value element. A full renderAlgo per tick would kill open
     *  kebab menus and be pointless: only the number changes. */
    function paintAlgoLtp(md) {
      const exch = String(md.exchange || "").toUpperCase();
      const tok = String(md.token ?? "");
      if (!tok) return;
      const ltp = md.data && md.data.ltp != null ? Number(md.data.ltp) : null;
      if (ltp == null || isNaN(ltp) || ltp <= 0) return;
      for (const rec of algoRows.values()) {
        if (!rec.enabled) continue;
        if (String(rec.exchange || "").toUpperCase() !== exch || String(rec.token) !== tok) continue;
        if (Number(rec.status?.ltp) === ltp) continue;
        if (!rec.status) rec.status = {};
        rec.status.ltp = ltp;
        // Freshness marker: the 3s overview poll and the manager's status row
        // can both be a poll-cycle behind; the renderer prefers this value so
        // a re-render never rolls the cell back to an older price.
        rec.tick_ltp = ltp;
        rec.tick_at = Date.now();
        const cell = document.querySelector(`[data-algo-row][data-id="${rec.id}"] .c-ltp`);
        if (cell) cell.textContent = fmt(ltp);
      }
    }

    function renderAlgo() {
      const list = document.getElementById("algoList");
      const entries = [...algoRows.values()];

      // OpenAlgo modeBadge: the strategy runs as Analyzer or Live; this broker
      // adapter carries no analyzer mode, so it stays "Mode unknown".
      const badge = document.getElementById("algoModeBadge");
      if (algoAnalyzeMode === true) {
        badge.className = "oa-badge off";
        badge.textContent = "Analyzer";
      } else if (algoAnalyzeMode === false) {
        badge.className = "oa-badge err";
        badge.textContent = "LIVE";
      } else {
        badge.className = "oa-badge off";
        badge.textContent = "Mode unknown";
      }

      // The dashboard embed drops the per-exchange process strip — the rows
      // are the table, and the processes still auto-run per schedules.
      const procHtml = algoOnly ? "" : (algoProcesses.length ? algoProcesses.map(algoProcessLine).join("") : "");

      if (!entries.length && !procHtml) {
        list.innerHTML = algoOnly
          ? `<div class="algo-empty">No symbols yet. Use <span style="font-weight:600;">Add</span> to search a symbol and configure it.</div>`
          : `<div class="algo-empty">No symbols yet. Use <span style="font-weight:600;">Add</span> to search a symbol, or <span style="font-weight:600;">This chart</span> to add the one you are looking at.</div>`;
        return;
      }

      if (algoOnly) {
        // The dashboard embed renders the rows as the wide reference TABLE
        // (symbol-first, one row per strategy) instead of the desks' cards.
        list.innerHTML = procHtml + `
          <div class="algo-table-wrap">
            <table class="algo-table">
              <thead><tr>
                <th>Symbol</th><th>Status</th><th>Mode</th><th class="ta-r">Qty</th>
                <th class="ta-r">Brick</th><th class="ta-r">LTP</th><th>Last brick</th><th>Trend</th>
                <th>Long / Short</th><th>Pending B/S</th><th class="ta-r">Entry</th><th class="ta-r">SL</th>
                <th>Updated</th><th class="ta-r"></th>
              </tr></thead>
              <tbody>${entries.map(algoTableRow).join("")}</tbody>
            </table>
          </div>`;
      } else {
        list.innerHTML = procHtml + entries.map(r => {
        // OpenAlgo gates the live fields to enabled && !stale — a disabled or
        // waiting row shows dashes everywhere `st` is read.
        const st = (r.enabled && !r.stale) ? (r.status || null) : null;
        const isBusy = algoBusy.has(r.id);
        const cfgRow = r.config || r;
        const brickText = r.brick_method === "atr"
          ? `ATR ${r.atr_period ?? "?"}×${r.atr_multiplier ?? "?"}`
          : r.brick_method === "ltp_pct"
            ? `LTP ${r.ltp_percent ?? "?"}%`
            : r.brick_size ?? "-";
        const pend = (v) => v == null ? "-" : String(v);
        const hasPos = ((Number(st?.long_qty) || 0) !== 0) || ((Number(st?.short_qty) || 0) !== 0);
        return `
        <div class="algo-card" data-algo-row data-id="${r.id}">
          <div class="algo-l1">
            <span class="algo-sym" title="${escAlgo(r.exchange)}:${escAlgo(r.tsym)} · ${escAlgo(r.product)}">${escAlgo(r.tsym)}</span>
            <button class="oa-switch ${r.enabled ? "on" : ""}" data-toggle="1" aria-label="${r.enabled ? "Disable" : "Enable"} ${escAlgo(r.tsym)}" ${isBusy ? "disabled" : ""}></button>
            <span title="${escAlgo(st?.message ?? "")}">${algoStatusBadge(r, hasPos)}</span>
            <span class="kekku">
              <button class="oa-icon-btn" data-menu="1" aria-label="${escAlgo(r.tsym)} actions" style="width:28px;height:28px;">${svg("kebab")}</button>
              <div class="oa-menu" hidden>
                <button class="oa-menu-item" data-act="edit" ${r.enabled ? "disabled" : ""}>Edit settings</button>
                <button class="oa-menu-item" data-act="clone">Clone to new symbol</button>
                <button class="oa-menu-item destructive" data-act="squareoff" ${!r.enabled || r.stale ? "disabled" : ""}>Square off</button>
                <div class="oa-menu-sep"></div>
                <button class="oa-menu-item destructive" data-act="remove" ${r.enabled ? "disabled" : ""}>Remove</button>
              </div>
            </span>
          </div>
          <div class="algo-grid" style="grid-template-columns: 1.35fr 0.7fr 0.8fr 1fr; border-top:1px solid var(--oa-border); padding-top:6px;">
            ${algoField("Mode", escAlgo(r.trade_mode || "-"))}
            ${algoField("Qty", r.quantity ?? "-")}
            ${algoField("Brick", escAlgo(brickText))}
            ${algoField("LTP", st?.ltp != null ? fmt(st.ltp) : "-", "c-ltp")}
          </div>
          <div class="algo-grid" style="grid-template-columns: 1.1fr 0.85fr 1.2fr 1.2fr;">
            ${algoField("Last brick", st?.brick_color
              ? `<span class="${st.brick_color === 'Green' ? 'up' : 'down'}">${st.brick_color} #${st.brick_no ?? 0}</span>`
              : "-")}
            ${algoField("Long / Short", `${pend(st?.long_qty)} / ${pend(st?.short_qty)}`)}
            ${algoField("Pending B / S", `${pend(st?.buy_pending)} / ${pend(st?.sell_pending)}`)}
            ${algoField("SL long / short", `${pend(st?.sl_long)} / ${pend(st?.sl_short)}`)}
          </div>
          ${st?.message ? `<div class="algo-errmsg">${escAlgo(st.message)}</div>` : ""}
        </div>`;
        }).join("");
      }

      list.querySelectorAll("[data-algo-row]").forEach(cardEl => {
        const id = cardEl.dataset.id;
        const r = algoRows.get(id);

        // Hub enable/disable flow (the switch, not start/stop): enabling starts
        // the exchange's managed strategy and the symbol's instance; disabling
        // drops the instance but leaves broker orders/positions untouched.
        cardEl.querySelector("[data-toggle]").addEventListener("click", (e) => {
          if (algoBusy.has(id)) return;
          const btn = e.currentTarget;
          const rr = algoRows.get(id);
          const enabling = !rr.enabled;
          const rawSt = rr.status || {};
          const hasPosition = (Number(rawSt.long_qty) || 0) > 0 || (Number(rawSt.short_qty) || 0) > 0;
          const go = () => {
            algoBusy.add(id);
            btn.disabled = true;
            fetch(`/strategy-hub/api/symbols/${id}/${enabling ? "enable" : "disable"}`, { method: "POST" })
              .then(res => res.json().catch(() => {}))
              .then(d => { if (d && d.message) flashAlgoInfo(d.message); })
              .catch(() => {})
              .finally(() => { algoBusy.delete(id); refreshAlgoSymbols(); });
          };
          // AlgoSymbolsPanel's toggle(): enabling confirms through the styled
          // dialog (mode unknown wording — this adapter has no analyzer mode);
          // disabling with an open position warns about what stays live.
          if (enabling) {
            algoConfirm({
              title: `Enable ${rr.tsym}?`,
              description: algoAnalyzeMode === false
                ? "OpenAlgo is in LIVE mode. Enabling starts the strategy for this symbol and it will place real orders as soon as a signal appears."
                : "OpenAlgo's mode (Analyzer or Live) could not be determined. If it is Live, enabling starts real order placement for this symbol.",
              action: "Enable and trade",
              destructive: true,
              run: go,
            });
          } else if (hasPosition) {
            algoConfirm({
              title: `Disable ${rr.tsym}?`,
              description: "This symbol has an open position. Disabling stops the bot but leaves the position and its stop-loss orders live at the broker. Use Squareoff first if you want to flatten.",
              action: "Disable anyway",
              run: go,
            });
          } else {
            go();
          }
        });

        const menuBtn = cardEl.querySelector("[data-menu]");
        const menu = cardEl.querySelector(".oa-menu");
        menuBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const open = !menu.hidden;
          closeAllMenus(menu);
          menu.hidden = open;
        });
        menu.querySelectorAll(".oa-menu-item[data-act]").forEach(item => {
          item.addEventListener("click", async (e) => {
            e.stopPropagation();
            menu.hidden = true;
            const act = item.dataset.act;
            if (act === "edit") { openAlgoSettings("edit", id); return; }
            if (act === "clone") { openAlgoSettings("clone", id); return; }
            if (act === "remove") {
              algoConfirm({
                title: `Remove ${r.tsym}?`,
                description: "Deletes this symbol and its settings.",
                action: "Remove",
                destructive: true,
                run: async () => {
                  algoBusy.add(id);
                  await fetch(`/strategy-hub/api/symbols/${id}`, { method: "DELETE" }).catch(() => {});
                  algoBusy.delete(id);
                  refreshAlgoSymbols();
                },
              });
              return;
            }
            if (act === "squareoff") {
              // Hub's SQUAREOFF: halts trading until disable + re-enable.
              algoConfirm({
                title: `Square off ${r.tsym}?`,
                description: "Cancels all pending entries and stop-loss orders for this symbol and closes the position. Trading for this symbol stays halted until you disable and re-enable it.",
                action: "Square off",
                destructive: true,
                run: async () => {
                  algoBusy.add(id);
                  await fetch(`/strategy-hub/api/symbols/${id}/command`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ command: "SQUAREOFF" }),
                  }).catch(() => {});
                  algoBusy.delete(id);
                  flashAlgoInfo(`Square off queued for ${r.tsym}`);
                  refreshAlgoSymbols();
                },
              });
            }
          });
        });
      });

      // Per-exchange managed-process lines (start/stop/restart)
      list.querySelectorAll(".algo-process").forEach(lineEl => {
        const ex = lineEl.dataset.ex;
        const proc = algoProcesses.find(p => p.exchange === ex) || {};
        lineEl.querySelectorAll("[data-pact]").forEach(btn => {
          btn.addEventListener("click", async () => {
            const pkey = `p:${ex}`;
            if (algoBusy.has(pkey)) return;
            algoBusy.add(pkey);
            btn.disabled = true;
            try {
              const res = await fetch(`/strategy-hub/api/process/${ex}/${btn.dataset.pact}`, { method: "POST" });
              const d = await res.json().catch(() => ({}));
              flashAlgoInfo(d.message || (d.status === "error" ? "Process action failed" : ""));
            } catch { /* refresh will tell */ }
            finally { algoBusy.delete(pkey); refreshAlgoSymbols(); }
          });
        });
      });
    }

    // One managed process per exchange (registry.process_info) — the
    // AlgoSymbolsPanel layout: EXCH · state dot · "Running · 09:00-15:35"
    // (or the scheduler's status message) and Restart/Stop while running,
    // Start otherwise. (OpenAlgo also links a Logs page; this platform has
    // no per-strategy logs route, so the link is omitted.)
    function algoProcessLabel(p) {
      if (p.is_running) return "Running";
      if (p.status === "not_registered") return "Idle";
      if (p.manually_stopped) return "Stopped";
      return p.status_message || "Scheduled";
    }
    function algoProcessLine(p) {
      const busy = algoBusy.has(`p:${p.exchange}`);
      const running = !!p.is_running;
      const label = algoProcessLabel(p);
      const dot = running ? ""
        : p.status === "error"
          ? `<span class="algo-pdot err"></span>`
          : `<span class="algo-pdot muted"></span>`;
      return `
      <div class="algo-process" data-ex="${escAlgo(p.exchange)}">
        <span class="algo-pexch">${escAlgo(p.exchange)}</span>
        ${running ? `<span class="algo-pdot run"></span>` : dot}
        <span class="algo-pmsg" title="${escAlgo(p.status_message || "")}">${escAlgo(label)} · ${escAlgo(p.schedule_start)}-${escAlgo(p.schedule_stop)}</span>
        <span class="algo-pbtns">
          ${running ? `
            <button class="oa-btn tiny" data-pact="restart" ${busy ? "disabled" : ""}>Restart</button>
            <button class="oa-btn tiny" data-pact="stop" ${busy ? "disabled" : ""}>Stop</button>
          ` : `
            <button class="oa-btn tiny" data-pact="start" ${busy ? "disabled" : ""}>Start</button>
          `}
        </span>
      </div>`;
    }

    function runningNow(r) { return !!r && r.enabled; }

    // ---- reference TABLE (the dashboard's embed view) ------------------------
    /** IST clock for the Updated column: the engine frame carries its own
     *  string; the overview's symbol_status row carries an epoch (updated_at). */
    function algoFmtUpdated(st) {
      if (st && st.last_updated) return String(st.last_updated);
      if (st && st.updated_at) {
        try {
          return new Date(Number(st.updated_at) * 1000).toLocaleTimeString(
            "en-IN", { timeZone: "Asia/Kolkata", hour12: false });
        } catch (e) { /* fall through */ }
      }
      return "-";
    }
    /** The reference wording — a disabled row is "Stopped", not "Disabled". */
    function algoTableBadge(r) {
      if (!r.enabled) return `<span class="oa-badge off">Stopped</span>`;
      if (r.stale) return `<span class="oa-badge warn" title="Enabled, waiting for the strategy process to start">Waiting</span>`;
      const s = (r.status && r.status.state) || null;
      if (s === "RUNNING") {
        return r.trades_blocked
          ? `<span class="oa-badge warn" title="Squareoff ran — disable and re-enable to resume">Halted</span>`
          : `<span class="oa-badge run">Running</span>`;
      }
      if (s === "HALTED") return `<span class="oa-badge warn" title="${escAlgo((r.status && r.status.message) || "")}">Halted</span>`;
      if (s === "ERROR") return `<span class="oa-badge err" title="${escAlgo((r.status && r.status.message) || "")}">Error</span>`;
      return `<span class="oa-badge off">${escAlgo(s || "Starting")}</span>`;
    }
    function algoTableRow(r) {
      const st = r.status || {};
      const isBusy = algoBusy.has(r.id);
      const brickText = r.brick_method === "atr"
        ? `ATR ${r.atr_period ?? "?"}×${r.atr_multiplier ?? "?"}`
        : r.brick_method === "ltp_pct"
          ? `LTP ${r.ltp_percent ?? "?"}%`
          : r.brick_size ?? "-";
      const pend = (v) => v == null ? "-" : String(v);
      const color = st.brick_color;
      const lastBrick = color
        ? `<span class="${color === "Green" ? "up" : "down"}">${color} #${st.brick_no ?? 0}</span>`
        : "-";
      const trendShown = color || (st.trend === "Green" || st.trend === "Red" ? st.trend : null);
      const sl = st.sl_long ?? st.sl_short;
      const entry = (st.entry_price != null && st.entry_price !== "") ? fmt(st.entry_price) : "-";
      // LTP display prefers the freshest live tick (paintAlgoLtp stamps
      // tick_ltp/tick_at): the overview poll and the manager's status row lag
      // the tape, so a re-render must never roll the cell back to an older
      // price. Falls back to the status value 10s after ticks stop (disabled /
      // market closed — the engine's own last price is then the truth).
      const tickFresh = r.tick_ltp != null && r.tick_at && (Date.now() - r.tick_at) < 10000;
      const ltpShown = tickFresh ? r.tick_ltp : st.ltp;
      return `
      <tr data-algo-row data-id="${r.id}">
        <td class="c-sym" title="${escAlgo(r.exchange)}:${escAlgo(r.tsym)} · ${escAlgo(r.product)}">${escAlgo(r.tsym)}</td>
        <td>${algoTableBadge(r)}</td>
        <td class="c-mut">${escAlgo(r.trade_mode || "-")}</td>
        <td class="ta-r">${r.quantity ?? "-"}</td>
        <td class="ta-r">${escAlgo(brickText)}</td>
        <td class="ta-r c-ltp">${ltpShown != null ? fmt(ltpShown) : "-"}</td>
        <td>${lastBrick}</td>
        <td>${trendShown ? `<span class="${trendShown === "Green" ? "up" : "down"}">${trendShown}</span>` : "-"}</td>
        <td class="c-vals">${pend(st.long_qty ?? 0)} / ${pend(st.short_qty ?? 0)}</td>
        <td class="c-vals">${pend(st.buy_pending)} / ${pend(st.sell_pending)}</td>
        <td class="ta-r">${entry}</td>
        <td class="ta-r">${sl != null ? fmt(sl) : "-"}</td>
        <td class="c-mut">${algoFmtUpdated(st)}</td>
        <td class="c-act">
          <span class="row-ctl">
            <button class="oa-switch ${r.enabled ? "on" : ""}" data-toggle="1" aria-label="${r.enabled ? "Disable" : "Enable"} ${escAlgo(r.tsym)}" ${isBusy ? "disabled" : ""}></button>
            <span class="kekku">
              <button class="oa-icon-btn" data-menu="1" aria-label="${escAlgo(r.tsym)} actions">${svg("kebab")}</button>
              <div class="oa-menu" hidden>
                <button class="oa-menu-item" data-act="edit" ${r.enabled ? "disabled" : ""}>Edit settings</button>
                <button class="oa-menu-item" data-act="clone">Clone to new symbol</button>
                <button class="oa-menu-item destructive" data-act="squareoff" ${!r.enabled || r.stale ? "disabled" : ""}>Square off</button>
                <div class="oa-menu-sep"></div>
                <button class="oa-menu-item destructive" data-act="remove" ${r.enabled ? "disabled" : ""}>Remove</button>
              </div>
            </span>
          </span>
        </td>
      </tr>`;
    }

    // ============================================================
    // SYMBOL SETTINGS DIALOG (algo-hub/SymbolSettingsDialog.tsx — hub fields)
    // Add mode: debounced broker symbol search → pick fills quantity from the
    //           lot size, tick/limit offset from the contract tick, then the
    //           hub's per-exchange defaults (GET /strategy-hub/api/defaults)
    //           prefill the rest; saved as POST /strategy-hub/api/symbols
    //           {symbol, exchange, ...settings}.
    // Clone: prefilled from an existing row, new symbol searched.
    // Edit: prefilled from the saved hub row, PUT .../symbols/{id}
    //           (settings only; edits require the symbol to be disabled —
    //           the API refuses enabled rows).
    // Fields mirror strategy_hub.service.CONFIG_FIELDS; our engine keeps the
    // fixed brick_size method only (no atr/ltp_pct variants).
    // ============================================================
    const escAlgo = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const ALGO_EXCHANGES = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "BCD", "NCO"];

    // METHOD_LABELS + FIELD_GROUPS verbatim from SymbolSettingsDialog.tsx —
    // fields with a `method` are hidden unless the chosen brick_method matches.
    const ALGO_METHOD_LABELS = {
      fixed: "Fixed size",
      atr: "ATR",
      ltp_pct: "LTP %",
    };

    const ALGO_SECTIONS = [
      { title: "Order", fields: [
        { key: "product", label: "Product", kind: "select", options: ["MIS", "NRML", "CNC"] },
        { key: "quantity", label: "Quantity", kind: "number", hint: "Multiple of the lot size" },
        { key: "trade_mode", label: "Trade mode", kind: "select", options: ["LONG_ONLY", "SHORT_ONLY", "LONG_SHORT"] },
        { key: "max_position_per_side", label: "Max position / side", kind: "number", hint: "0 = quantity (no scale-in)" },
      ]},
      { title: "Renko", fields: [
        { key: "brick_method", label: "Brick method", kind: "select", options: ["fixed", "atr", "ltp_pct"], labels: ALGO_METHOD_LABELS },
        { key: "brick_size", label: "Brick size", kind: "number", step: "any", method: ["fixed", "atr"] },
        { key: "atr_period", label: "ATR period", kind: "number", method: "atr" },
        { key: "atr_multiplier", label: "ATR multiplier", kind: "number", step: "0.1", method: "atr" },
        { key: "ltp_percent", label: "LTP %", kind: "number", step: "any", hint: "Brick = % of the price band", method: "ltp_pct" },
        { key: "g2r", label: "Green → Red reversal", kind: "number" },
        { key: "r2g", label: "Red → Green reversal", kind: "number" },
      ]},
      { title: "Entries and trailing", fields: [
        { key: "buy_brick_no", label: "BUY brick no", kind: "number", hint: "Green brick, >= 0" },
        { key: "limit_buy_brick_no", label: "BUY limit = brick + N bricks", kind: "number" },
        { key: "sell_brick_no", label: "SELL brick no", kind: "number", hint: "Red brick, <= 0" },
        { key: "limit_sell_brick_no", label: "SELL limit = brick − N bricks", kind: "number" },
        { key: "entry_trail_bricks", label: "Entry trail (bricks)", kind: "number" },
        { key: "sl_trail_bricks", label: "SL trail (bricks)", kind: "number" },
      ]},
      { title: "Prices and squareoff", fields: [
        { key: "tick_size", label: "Tick size", kind: "number", step: "any" },
        { key: "limit_offset", label: "SL trigger/limit offset", kind: "number", step: "any" },
        { key: "sl_lmt_buffer", label: "Squareoff limit buffer", kind: "number", step: "any" },
        { key: "squareoff", label: "Squareoff time (IST)", kind: "time" },
      ]},
    ];
    /** fields visible for the currently chosen brick method (visibleFields) */
    function algoDlgVisibleFields(fields) {
      const m = algoDlgForm.brick_method || "fixed";
      return fields.filter(f =>
        f.method === undefined ? true : Array.isArray(f.method) ? f.method.includes(m) : f.method === m);
    }

    const ALGO_FORM_DEFAULTS = {
      strategy_name: "",
      product: "MIS",
      quantity: "1",
      trade_mode: "LONG_ONLY",
      max_position_per_side: "0",
      brick_method: "fixed",
      brick_size: "1",
      atr_period: "14",
      atr_multiplier: "1",
      ltp_percent: "0.25",
      g2r: "2",
      r2g: "2",
      buy_brick_no: "1",
      sell_brick_no: "-1",
      limit_buy_brick_no: "1",
      limit_sell_brick_no: "1",
      entry_trail_bricks: "2",
      sl_trail_bricks: "2",
      tick_size: "0.05",
      limit_offset: "0.05",
      sl_lmt_buffer: "0.05",
      squareoff: "15:15",
    };

    let algoDlgEditing = null;   // row being edited, null in add/clone mode
    let algoDlgCloneSource = null; // clone mode: the source row (pick keeps its settings)
    let algoDlgForm = null;
    let algoDlgTimer = null;
    let algoDlgSeq = 0;
    let algoDlgScheduleStop = null;  // from /defaults — feeds the stop hint
    let algoDlgPrefill = null;       // {symbol, exchange} from "This chart"
    let algoDlgAutoPicked = false;   // exact-match auto-pick already done

    function algoDlgCfgToForm(c) {
      return {
        strategy_name: c.strategy_name ?? "",
        product: c.product ?? "MIS",
        quantity: String(c.quantity ?? 1),
        trade_mode: c.trade_mode ?? "LONG_ONLY",
        max_position_per_side: String(c.max_position_per_side ?? 0),
        brick_method: c.brick_method ?? "fixed",
        brick_size: String(c.brick_size ?? 1),
        atr_period: String(c.atr_period ?? 14),
        atr_multiplier: String(c.atr_multiplier ?? 1),
        ltp_percent: String(c.ltp_percent ?? 0.25),
        g2r: String(c.g2r ?? 2),
        r2g: String(c.r2g ?? 2),
        buy_brick_no: String(c.buy_brick_no ?? 1),
        sell_brick_no: String(c.sell_brick_no ?? -1),
        limit_buy_brick_no: String(c.limit_buy_brick_no ?? 1),
        limit_sell_brick_no: String(c.limit_sell_brick_no ?? 1),
        entry_trail_bricks: String(c.entry_trail_bricks ?? 2),
        sl_trail_bricks: String(c.sl_trail_bricks ?? 2),
        tick_size: String(c.tick_size ?? 0.05),
        limit_offset: String(c.limit_offset ?? 0.05),
        sl_lmt_buffer: String(c.sl_lmt_buffer ?? 0.05),
        squareoff: c.squareoff_time ?? "15:15",
        token: String(c.token ?? ""),
      };
    }

    /** The squareoff-before-schedule-stop rule, stated next to the form. */
    function algoDlgPaintStopHint() {
      const el = document.getElementById("algoDlgStopHint");
      if (!el) return;
      if (algoDlgEditing || !algoDlgScheduleStop) { el.hidden = true; return; }
      el.textContent = `Squareoff must be earlier than this exchange's strategy schedule stop (${algoDlgScheduleStop} IST).`;
      el.hidden = false;
    }

    // GET /strategy-hub/api/defaults?exchange= — the hub's per-exchange defaults
    // + schedule_stop. pickSymbol parity: they OVERWRITE the whole form on a
    // fresh add (then the contract's lot/tick land on top); clone keeps the
    // copied row settings and only re-keys the tick fields from the contract.
    async function algoDlgFetchDefaults(exchange) {
      try {
        const res = await fetch(`/strategy-hub/api/defaults?exchange=${encodeURIComponent(exchange || "NFO")}`);
        const d = await res.json();
        if (d && d.status === "success") return d;
      } catch { /* the plain form defaults stay */ }
      return null;
    }
    function algoDlgFillFromDefaults(defaults) {
      Object.assign(algoDlgForm, {
        product: defaults.product,
        quantity: String(defaults.quantity),
        trade_mode: defaults.trade_mode,
        max_position_per_side: String(defaults.max_position_per_side),
        brick_method: defaults.brick_method || "fixed",
        brick_size: String(defaults.brick_size),
        atr_period: String(defaults.atr_period),
        atr_multiplier: String(defaults.atr_multiplier),
        ltp_percent: String(defaults.ltp_percent),
        g2r: String(defaults.g2r),
        r2g: String(defaults.r2g),
        buy_brick_no: String(defaults.buy_brick_no),
        sell_brick_no: String(defaults.sell_brick_no),
        limit_buy_brick_no: String(defaults.limit_buy_brick_no),
        limit_sell_brick_no: String(defaults.limit_sell_brick_no),
        entry_trail_bricks: String(defaults.entry_trail_bricks),
        sl_trail_bricks: String(defaults.sl_trail_bricks),
        tick_size: String(defaults.tick_size),
        limit_offset: String(defaults.limit_offset),
        sl_lmt_buffer: String(defaults.sl_lmt_buffer),
        squareoff: String(defaults.squareoff_time),
      });
    }

    function openAlgoSettings(mode, id, prefill) {
      const rec = mode !== "add" && id ? algoRows.get(id) : null;
      algoDlgEditing = mode === "edit" ? (rec || null) : null;   // clone = add-with-prefill
      algoDlgCloneSource = (mode === "clone") ? (rec || null) : null;
      algoDlgPrefill = (!algoDlgEditing && !algoDlgCloneSource && prefill) ? prefill : null;
      algoDlgAutoPicked = false;
      algoDlgForm = rec
        ? algoDlgCfgToForm(rec.config || rec)
        : Object.assign({}, ALGO_FORM_DEFAULTS);   // add: SymbolSettingsDialog's emptyForm
      algoDlgScheduleStop = null;

      const editing = mode === "edit" && !!rec;
      const cfg = rec ? (rec.config || rec) : null;
      // scheduleStops come from the overview's process lines; the hint shows
      // wherever a schedule stop is known (OpenAlgo passes the map in).
      const stopFor = (ex) => {
        const p = algoProcesses.find(p2 => p2.exchange === ex);
        return (p && p.schedule_stop) || null;
      };
      // Title / description / save (SymbolSettingsDialog's strings).
      document.getElementById("algoDlgTitle").textContent = editing ? `Edit ${rec.tsym || cfg.symbol}` : "Add symbol for trade";
      document.getElementById("algoDlgDesc").textContent = editing
        ? "Settings apply the next time this symbol is enabled."
        : (mode === "clone" ? "Search a new symbol — the settings below are copied from the source row."
                            : "Search the symbol master, then set this symbol's own configuration.");
      document.getElementById("algoDlgSave").textContent = editing ? "Save settings" : "Add symbol";

      // Exchange selector value: edit/clone → the row's exchange, prefill →
      // the chart's, bare add → NFO (OpenAlgo's emptyForm default).
      const exSel = document.getElementById("algoDlgExchange");
      const exVal = String(rec?.exchange ?? algoDlgPrefill?.exchange ?? "NFO");
      exSel.innerHTML = ALGO_EXCHANGES.map(x =>
        `<option value="${x}" ${x === exVal ? "selected" : ""}>${x}</option>`).join("");
      exSel.disabled = editing;

      // Search row (add/clone) vs fixed symbol row (edit — symbol/exchange are fixed)
      document.getElementById("algoDlgSearch").value = "";
      const resultsBox = document.getElementById("algoDlgResults");
      resultsBox.hidden = true; resultsBox.innerHTML = "";
      const selEl = document.getElementById("algoDlgSelected");
      if (editing) {
        selEl.innerHTML = `Edit settings for <span class="mono">${escAlgo(rec.exchange)}:${escAlgo(rec.tsym || cfg.symbol)}</span>`;
        selEl.hidden = false;
        algoDlgScheduleStop = stopFor(rec.exchange);
      } else {
        selEl.hidden = true; selEl.innerHTML = "";
        if (mode === "clone") algoDlgScheduleStop = stopFor(exVal);
      }

      document.getElementById("algoDlgError").hidden = true;
      algoDlgRenderGroups();
      algoDlgPaintStopHint();
      document.getElementById("algoDlgOverlay").hidden = false;
      // OpenAlgo gates its defaults fill to PICK only — nothing here applies
      // them on open, so a bare add shows the plain emptyForm defaults.
      if (algoDlgPrefill) {
        // "This chart": preselect the chart's symbol — the debounced search
        // runs on the input event and auto-picks when it matches exactly.
        dlgSearchInput.value = algoDlgPrefill.symbol;
        dlgSearchInput.dispatchEvent(new Event("input"));
      }
    }

    function algoDlgClose() {
      document.getElementById("algoDlgOverlay").hidden = true;
      algoDlgEditing = null;
      algoDlgCloneSource = null;
      algoDlgPrefill = null;
      algoDlgAutoPicked = false;
      algoDlgForm = null;
      clearTimeout(algoDlgTimer);
    }

    function algoDlgRenderGroups() {
      const wrap = document.getElementById("algoDlgGroups");
      wrap.innerHTML = ALGO_SECTIONS.map(sec => `
        <div class="oa-dlg-section-title">${escAlgo(sec.title)}</div>
        <div class="oa-dlg-fields">
          ${algoDlgVisibleFields(sec.fields).map(f => {
            const hint = f.hint ? `<div class="hint">${f.hint}</div>` : "";
            if (f.kind === "checkbox") {
              return `<label class="oa-dlg-check"><input type="checkbox" data-f="${f.key}" ${algoDlgForm[f.key] ? "checked" : ""} /><span>${f.label}</span></label>`;
            }
            if (f.kind === "select") {
              return `<label class="oa-dlg-field">${f.label}
                <select data-f="${f.key}">${f.options.map(o =>
                  `<option value="${o}" ${algoDlgForm[f.key] === o ? "selected" : ""}>${(f.labels && f.labels[o]) || o}</option>`).join("")}</select>${hint}</label>`;
            }
            const type = f.kind === "time" ? "time" : f.kind === "text" ? "text" : "number";
            return `<label class="oa-dlg-field">${f.label}
              <input type="${type}" data-f="${f.key}" value="${algoDlgForm[f.key] ?? ""}" ${f.step ? `step="${f.step}"` : ""} />${hint}</label>`;
          }).join("")}
        </div>`).join("");

      wrap.querySelectorAll("[data-f]").forEach(el => {
        const key = el.dataset.f;
        const evt = el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input";
        el.addEventListener(evt, () => {
          algoDlgForm[key] = el.type === "checkbox" ? el.checked : el.value;
          // The brick method GATES which fields exist — switching it re-renders
          // the sections (fixed/atr share brick_size, atr gets period×multiplier,
          // ltp_pct gets the LTP % field).
          if (key === "brick_method") algoDlgRenderGroups();
        });
      });
    }

    // ---- debounced broker symbol search (add mode only) ---------------------
    const dlgSearchInput = document.getElementById("algoDlgSearch");
    dlgSearchInput.addEventListener("input", () => {
      clearTimeout(algoDlgTimer);
      algoDlgForm.trading_symbol = "";
      algoDlgForm.token = "";
      const q = dlgSearchInput.value.trim();
      const resBox = document.getElementById("algoDlgResults");
      if (q.length < 2) { resBox.hidden = true; resBox.innerHTML = ""; return; }
      algoDlgTimer = setTimeout(async () => {
        const seq = ++algoDlgSeq;
        const exchange = document.getElementById("algoDlgExchange").value;
        resBox.hidden = false;
        resBox.innerHTML = `<div style="padding:7px 9px;font-size:12px;color:var(--oa-muted-fg);">Searching…</div>`;
        try {
          const r = await fetch("/api/search-symbols", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: q, exchange }),
          });
          if (seq !== algoDlgSeq) return;
          const d = await r.json();
          const values = (d && d.values) || [];
          if (!values.length) {
            resBox.innerHTML = `<div style="padding:7px 9px;font-size:12px;color:var(--oa-muted-fg);">No matches</div>`;
            return;
          }
          resBox.innerHTML = values.map((v, i) => `
            <button type="button" class="oa-dlg-result" data-i="${i}">
              <span class="mono">${escAlgo(v.tsym)}</span>
              <small>${escAlgo(v.exch || exchange)} · lot ${escAlgo(v.ls ?? "-")} · tick ${escAlgo(v.ti ?? "-")}${v.exd || v.expiry ? ` · exp ${escAlgo(v.exd || v.expiry)}` : ""}</small>
            </button>`).join("");
          // This chart's own symbol: pick it straight away when the search
          // answers with an exact (symbol, exchange) match.
          if (algoDlgPrefill && !algoDlgAutoPicked && !algoDlgForm.trading_symbol) {
            const exact = values.find(x =>
              x.tsym === algoDlgPrefill.symbol && (x.exch || exchange) === algoDlgPrefill.exchange);
            if (exact) {
              algoDlgAutoPicked = true;
              void algoDlgPick(exact, exchange);
            }
          }
          resBox.querySelectorAll(".oa-dlg-result").forEach(btn => {
            btn.addEventListener("click", () => algoDlgPick(values[Number(btn.dataset.i)], exchange));
          });
        } catch {
          if (seq === algoDlgSeq) { resBox.hidden = true; }
        }
      }, 300);
    });

    // The exchange select only re-keys the stop hint — OpenAlgo's dialog fills
    // its defaults at PICK time (the exchange changes with the picked row).
    document.getElementById("algoDlgExchange").addEventListener("change", (e) => {
      const ex = e.target.value;
      const p = algoProcesses.find(p2 => p2.exchange === ex);
      algoDlgScheduleStop = (p && p.schedule_stop) || null;
      algoDlgPaintStopHint();
    });

    async function algoDlgPick(v, exchange) {
      const ex = v.exch || exchange;
      algoDlgForm.trading_symbol = v.tsym;
      algoDlgForm.token = String(v.token ?? "");
      algoDlgForm.exchange = ex;
      // pickSymbol parity: a fresh add applies the exchange defaults FULL
      // (every setting overwritten, quantity from the contract lot); a clone
      // keeps its copied settings. The contract's tick wins for all three
      // tick-derived fields in both cases.
      if (!algoDlgEditing && !algoDlgCloneSource) {
        const d = await algoDlgFetchDefaults(ex);
        if (d && d.data) {
          algoDlgScheduleStop = d.schedule_stop || algoDlgScheduleStop;
          algoDlgFillFromDefaults(d.data);
        }
        algoDlgForm.strategy_name = v.dname || v.cname || v.tsym;
      }
      if (v.ls) algoDlgForm.quantity = String(v.ls);
      if (v.ti) {
        algoDlgForm.tick_size = String(v.ti);
        algoDlgForm.limit_offset = String(v.ti);
        algoDlgForm.sl_lmt_buffer = String(v.ti);
      }
      // The exchange selector should follow the picked row too.
      const exSel = document.getElementById("algoDlgExchange");
      if (exSel.value !== ex && [...exSel.options].some(o => o.value === ex)) exSel.value = ex;
      algoDlgScheduleStop = algoDlgScheduleStop || (function () {
        const p = algoProcesses.find(p2 => p2.exchange === ex);
        return (p && p.schedule_stop) || null;
      })();
      algoDlgPaintStopHint();
      const selEl = document.getElementById("algoDlgSelected");
      selEl.innerHTML = `Selected: <span class="mono">${escAlgo(ex)}:${escAlgo(v.tsym)}</span>`;
      selEl.hidden = false;
      const resBox = document.getElementById("algoDlgResults");
      resBox.hidden = true; resBox.innerHTML = "";
      dlgSearchInput.value = "";
      algoDlgRenderGroups();
    }

    // ---- save ----------------------------------------------------------------
    async function algoDlgSubmit() {
      const err = document.getElementById("algoDlgError");
      err.hidden = true;
      const editing = !!algoDlgEditing;
      if (!editing && !algoDlgForm.trading_symbol) {
        err.textContent = "Search and pick a symbol first";
        err.hidden = false;
        return;
      }
      const num = (k, dflt) => { const n = Number(algoDlgForm[k]); return Number.isFinite(n) && String(algoDlgForm[k]).trim() !== "" ? n : dflt; };
      const iint = (k, dflt) => Math.round(num(k, dflt));
      const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
      const pad = (n) => String(n).padStart(2, "0");
      const sq = String(algoDlgForm.squareoff || "15:15").split(":");
      // strategy_hub.service.CONFIG_FIELDS — the exact settings shape the hub
      // API validates (squareoff as an HH:MM string).
      const settings = {
        strategy_name: String(algoDlgForm.strategy_name || "").trim() || null,
        product: algoDlgForm.product || "MIS",
        quantity: Math.max(1, iint("quantity", 1)),
        trade_mode: algoDlgForm.trade_mode || "LONG_ONLY",
        max_position_per_side: Math.max(0, iint("max_position_per_side", 0)),
        brick_method: ["fixed", "atr", "ltp_pct"].includes(algoDlgForm.brick_method)
          ? algoDlgForm.brick_method : "fixed",
        brick_size: Math.max(0.01, num("brick_size", 1)),
        atr_period: clamp(Math.round(Number(algoDlgForm.atr_period) || 14), 2, 200),
        atr_multiplier: Math.max(0.01, num("atr_multiplier", 1)),
        ltp_percent: Math.max(0.01, num("ltp_percent", 0.25)),
        g2r: Math.max(1, iint("g2r", 2)),
        r2g: Math.max(1, iint("r2g", 2)),
        buy_brick_no: iint("buy_brick_no", 1),
        sell_brick_no: iint("sell_brick_no", -1),
        limit_buy_brick_no: Math.max(1, iint("limit_buy_brick_no", 1)),
        limit_sell_brick_no: Math.max(1, iint("limit_sell_brick_no", 1)),
        entry_trail_bricks: Math.max(1, num("entry_trail_bricks", 2)),
        sl_trail_bricks: Math.max(1, num("sl_trail_bricks", 2)),
        tick_size: num("tick_size", 0.05),
        limit_offset: num("limit_offset", 0.05),
        sl_lmt_buffer: num("sl_lmt_buffer", 0.05),
        squareoff_time: `${pad(clamp(Math.round(Number(sq[0]) || 15), 0, 23))}:${pad(clamp(Math.round(Number(sq[1]) || 0), 0, 59))}`,
      };
      const btn = document.getElementById("algoDlgSave");
      btn.disabled = true;
      btn.textContent = editing ? "Saving…" : "Adding…";
      try {
        const url = editing ? `/strategy-hub/api/symbols/${algoDlgEditing.id}` : "/strategy-hub/api/symbols";
        const body = editing ? settings
          : Object.assign({}, settings, {
              symbol: algoDlgForm.trading_symbol,
              exchange: algoDlgForm.exchange || document.getElementById("algoDlgExchange").value,
            });
        const res = await fetch(url, {
          method: editing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const d = await res.json().catch(() => ({}));
        if (d.status === "error") {
          err.textContent = d.message || "Save failed";
          if (Array.isArray(d.errors) && d.errors.length) {
            err.textContent += "\n" + d.errors.join("\n");
            err.style.whiteSpace = "pre-line";
          }
          err.hidden = false;
          return;
        }
        algoDlgClose();
        flashAlgoInfo(d.message || (editing ? "Settings saved" : "Symbol added (disabled)"));
        refreshAlgoSymbols();
      } catch (e2) {
        err.textContent = e2.message || "Save failed";
        err.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = editing ? "Save settings" : "Add symbol";
      }
    }

    document.getElementById("algoAddBtn").addEventListener("click", () => openAlgoSettings("add"));
    // "This chart": read the focused chart's symbol (adapter.getChartContext —
    // widget.symbol()/exchange() on /charts, the focused pane's key on /trading)
    // and open the Add dialog with it preselected (readChartSymbol parity).
    chartFocusBtn?.addEventListener("click", () => {
      let found = null;
      try { found = readChartInstr(getChartContext()); } catch { found = null; }
      if (!found) {
        flashAlgoInfo("Could not read the symbol on the focused chart");
        return;
      }
      openAlgoSettings("add", null, found);
    });
    document.getElementById("algoDlgCancel").addEventListener("click", algoDlgClose);
    document.getElementById("algoDlgClose").addEventListener("click", algoDlgClose);
    document.getElementById("algoDlgSave").addEventListener("click", algoDlgSubmit);
    document.getElementById("algoDlgOverlay").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) algoDlgClose();
    });
    on(document, "keydown", (e) => {
      if (e.key === "Escape") {
        if (!document.getElementById("algoDlgOverlay").hidden) algoDlgClose();
        if (!document.getElementById("algoConfirmOverlay").hidden) algoConfirmClose();
      }
    });

    document.getElementById("algoRefreshBtn").addEventListener("click", () => refreshAlgoSymbols());

    // Live status patches from ws: {"type":"status","instance_id":..,"status":{...}}.
    // Hub engines broadcast as instance_id "hub_<row_id>" — map the prefix onto
    // the panel's row-id keys before patching. An engine status frame carries
    // the ENGINE shape (brick dict, trend string, one position_qty / one
    // sl_trigger_price, pending_*_trigger_price) — translate it into the same
    // hub-shaped status row the overview serves (_status_row parity), so the
    // card renderer reads one shape.
    function updateAlgoFromStatus(msg) {
      let rid = String(msg.instance_id ?? "");
      if (rid.startsWith("hub_")) rid = rid.slice(4);
      if (!algoRows.has(rid)) return;
      const st = msg.status || {};
      const brick = st.brick && typeof st.brick === "object" ? st.brick : {};
      const trend = brick.color || st.trend;             // "Green" | "Red" | other
      const pos = Number(st.position_qty ?? 0) || 0;
      const sl = st.sl_trigger_price ?? null;
      const patch = {
        stale: false,   // a live frame means the process is publishing again
        status: {
          state: st.status,
          message: st.trades_blocked ? (st.message || "Halted: squareoff")
            : (st.status === "RUNNING" ? null : st.message || null),
          ltp: st.ltp,
          brick_color: trend === "Green" || trend === "Red" ? trend : null,
          brick_no: typeof brick.brick_no === "number" ? brick.brick_no : null,
          long_qty: Math.max(pos, 0),
          short_qty: Math.max(-pos, 0),
          buy_pending: st.pending_buy_trigger_price ?? null,
          sell_pending: st.pending_sell_trigger_price ?? null,
          sl_long: sl != null && pos > 0 ? sl : null,
          sl_short: sl != null && pos < 0 ? sl : null,
          trades_blocked: st.trades_blocked ? 1 : 0,
          // enrichments the table view shows and the overview row omits
          entry_price: st.entry_price ?? null,
          trend: st.trend ?? null,
          last_updated: st.last_updated ?? null,
        },
        trades_blocked: !!st.trades_blocked,
      };
      const merged = Object.assign({}, algoRows.get(rid), patch);
      algoRows.set(rid, merged);
      renderAlgo();
    }

    // ---------- page tick router (market_data frames from the module) -------
    // md looks like {exchange, token, feed, data:{ltp, prev_close, volume,
    // open, high, low, bid, ask, oi, ...}} — the OpenAlgo-normalized
    // market-data payload. Legacy flat ticks are converted by the module
    // before they reach here.
    const onTick = (md) => {
      updateWatchlistTick(md);
      paintAlgoLtp(md);   // the embed's table LTP at tick speed
      const d = md.data || {};
      const ltp = d.ltp != null ? Number(d.ltp) : null;
      if (ocLiveKey && `${md.exchange}|${md.token}` === ocLiveKey) {
        // The underlying's feed carries its previous close — the tri-state
        // anchor. The spot text itself moves with every frame.
        if (d.prev_close != null && Number(d.prev_close) > 0) {
          ocSpotPrevClose = Number(d.prev_close);
        }
        if (ltp) {
          const el = document.getElementById("ocSpotValue");
          el.textContent = fmt(ltp);
          paintSpotDirection();
        }
      }
      paintOcLegs(md); // live option-chain legs (no-op when token not a leg)
      if (piLiveKey && `${md.exchange}|${md.token}` === piLiveKey) {
        // The Pi chain's spot is the board's mid (doc `strprc`) and the
        // Greeks call's `sptprc` — it moves with the underlying's frames.
        if (d.prev_close != null && Number(d.prev_close) > 0) {
          pcSpotPrevClose = Number(d.prev_close);
        }
        if (ltp) {
          pcSpot = Number(ltp);
          paintPiSpot();
          paintPiSpotDirection();
        }
      }
      paintPiLegs(md); // live Pi-chain legs (no-op when token not a leg)
    };
    const onStatus = updateAlgoFromStatus;
    // ============================================================
    // INIT
    // ============================================================
    if (algoOnly) {
      // The dashboard host: the panel BODY is the widget — show the algo tab
      // directly (no rail, no open/close cycle, no remembered-panel store) and
      // keep the 3s overview poll running from boot.
      rightPanel.hidden = false;
      RAIL_PANELS.forEach(p => { const t = document.getElementById(p.tab); if (t) t.hidden = p.id !== "algo"; });
      // Width is the host column's own (CSS), not the remembered rail width.
      rightPanel.style.width = "";
      rightPanel.style.maxWidth = "";
      refreshAlgoSymbols();
      startAlgoPolling();
    } else {
      // openPanel is a toggle (OpenAlgo behaviour), so clear the remembered
      // id before restoring — otherwise the boot would immediately "close" it.
      const restorePanel = activePanel;
      activePanel = null;
      if (restorePanel) openPanel(restorePanel);
      seedWatchlistFromPlatform().then(() => { if (!wlItems.length) renderWatchlist(); })
        .then(() => fillWlQuotes());  // boot fill: the remembered rows show last prices immediately
      renderWatchlist();
    }

  tickSink = onTick

  // Band buttons on both desks toggle the chain window without holding a
  // module reference (on /trading the button lives inside the React chart
  // component, which cannot import this vanilla module). RightPanel.tsx
  // clears it on unmount; on /charts nothing unmounts. Only when the window
  // actually exists — the dashboard's algo-only host mounts none.
  if (!algoOnly) window.__oaChainToggle = toggleOcWindow

  return {
    onTick,
    onStatus,
    open: openPanel,
    /** The floating Option chain window — the band buttons on both desks call this. */
    toggleOptionChain: toggleOcWindow,
    refreshAlgoSymbols,
    destroy() {
      for (const [target, type, fn, opts] of listeners) target.removeEventListener(type, fn, opts)
      listeners.length = 0
      stopWlRefresh()
      if (client) client.destroy()
      for (const id of ['rightPanel', 'algoDlgOverlay', 'rightRail', 'ocWindow']) {
        const node = document.getElementById(id)
        if (node && node.parentNode) node.parentNode.removeChild(node)
      }
    },
  }
}
