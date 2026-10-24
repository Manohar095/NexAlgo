// ---------------------------------------------------------------------
// CogniX Algo — dashboard client (works on both dashboard & logs page)
// ---------------------------------------------------------------------

const boardBody   = document.getElementById("boardBody");
const logStream   = document.getElementById("logStream");
const logFilter   = document.getElementById("logFilter");
const connDot     = document.getElementById("connDot");
const connLabel   = document.getElementById("connLabel");

// These may be null on the logs page – guard all usage
const modalOverlay = document.getElementById("modalOverlay");
const modalTitle   = document.getElementById("modalTitle");
const symbolForm   = document.getElementById("symbolForm");

let symbols = {};
let knownSymbolNames = {};

const FIELD_IDS = [
  "strategy_name", "exchange", "trading_symbol", "token", "quantity", "product_type",
  "brick_size", "green_to_red_rev", "red_to_green_rev",
  "buy_brick_no", "sell_brick_no", "tick_size",
  "limit_price_buy_brick_no", "limit_price_sell_brick_no",
  "sl_trail_brick_number", "entry_trail_brick_number", "limit_offset",
  "trade_mode", "squareoff_hour", "squareoff_minute", "sl_lmt_buffer", "autostart"
];

// ---------------- REST helpers ----------------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.detail || `Request failed (${res.status})`);
  }
  return res.status === 204 ? null : res.json();
}

// ---------------- Symbols & Board ----------------
async function loadSymbols() {
  const records = await api("/api/symbols");
  symbols = {};
  records.forEach(r => { symbols[r.id] = r; knownSymbolNames[r.id] = r.config.strategy_name; });
  renderBoard();
  renderLogFilterOptions();
}

function renderBoard() {
  if (!boardBody) return;
  const ids = Object.keys(symbols);
  if (ids.length === 0) {
    boardBody.innerHTML = `<tr class="empty-row"><td colspan="12">No symbols yet. Click “+ Add Symbol” to configure your first Renko strategy.</td></tr>`;
    return;
  }

  boardBody.innerHTML = ids.map(id => rowHTML(symbols[id])).join("");

  ids.forEach(id => {
    document.querySelector(`[data-start="${id}"]`)?.addEventListener("click", () => startSymbol(id));
    document.querySelector(`[data-stop="${id}"]`)?.addEventListener("click", () => stopSymbol(id));
    document.querySelector(`[data-restart="${id}"]`)?.addEventListener("click", () => restartSymbol(id));
    document.querySelector(`[data-edit="${id}"]`)?.addEventListener("click", () => openEditModal(id));
    document.querySelector(`[data-delete="${id}"]`)?.addEventListener("click", () => deleteSymbol(id));
  });
}

function rowHTML(rec) {
  const cfg = rec.config;
  const live = rec.live_status || {};
  const status = live.status || "STOPPED";
  const brick = live.brick;
  const pos = live.position_qty ?? 0;

  const posTag = pos > 0
    ? `<span class="tag tag-green">LONG ${pos}</span>`
    : pos < 0
      ? `<span class="tag tag-red">SHORT ${Math.abs(pos)}</span>`
      : `<span class="tag tag-flat">FLAT</span>`;

  const statusTag = live.trades_blocked
    ? `<span class="tag tag-blocked">BLOCKED</span>`
    : status === "RUNNING"
      ? `<span class="tag tag-running">RUNNING</span>`
      : status === "ERROR"
        ? `<span class="tag tag-error">ERROR</span>`
        : `<span class="tag tag-stopped">STOPPED</span>`;

  const brickHTML = brick
    ? `<span class="brick-swatch"><span class="brick-dot ${brick.color === 'Green' ? 'green' : 'red'}"></span>#${brick.brick_no} @ ${brick.brick_price}</span>`
    : "—";

  return `
    <tr data-row="${rec.id}">
      <td>
        <span class="sym-name">${escapeHTML(cfg.strategy_name)}</span>
      </td>
      <td>${fmtNum(live.ltp)}</td>
      <td>${brickHTML}</td>
      <td>${live.trend || "—"}</td>
      <td>${posTag}</td>
      <td>${fmtNum(live.entry_price)}</td>
      <td>${fmtNum(live.sl_trigger_price)}</td>
      <td>${cfg.quantity}</td>
      <td>${cfg.trade_mode.replace("_", " ")}</td>
      <td>${statusTag}</td>
      <td>${live.last_updated || "—"}</td>
      <td>
        <div class="row-actions">
          ${status === "RUNNING"
            ? `<button class="btn btn-sm" data-stop="${rec.id}">Stop</button>
               <button class="btn btn-sm" data-restart="${rec.id}">Restart</button>`
            : `<button class="btn btn-sm btn-primary" data-start="${rec.id}">Start</button>`
          }
          <button class="btn btn-sm" data-edit="${rec.id}">Edit</button>
          <button class="btn btn-sm" data-delete="${rec.id}">Delete</button>
        </div>
      </td>
    </tr>
  `;
}

function fmtNum(v) {
  if (v === null || v === undefined) return "—";
  return typeof v === "number" ? v.toFixed(2) : v;
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ---------------- Actions ----------------
async function startSymbol(id) {
  try { await api(`/api/symbols/${id}/start`, { method: "POST" }); await loadSymbols(); }
  catch (e) { alert(e.message); }
}
async function stopSymbol(id) {
  try { await api(`/api/symbols/${id}/stop`, { method: "POST" }); await loadSymbols(); }
  catch (e) { alert(e.message); }
}
async function restartSymbol(id) {
  try { await api(`/api/symbols/${id}/restart`, { method: "POST" }); await loadSymbols(); }
  catch (e) { alert(e.message); }
}
async function deleteSymbol(id) {
  const rec = symbols[id];
  if (!confirm(`Delete "${rec.config.strategy_name}"? This stops it and removes its saved config.`)) return;
  try { await api(`/api/symbols/${id}`, { method: "DELETE" }); await loadSymbols(); }
  catch (e) { alert(e.message); }
}

// ---------------- Modal / form ----------------
if (document.getElementById("btnAddSymbol")) {
  document.getElementById("btnAddSymbol").addEventListener("click", () => openCreateModal());
}
if (document.getElementById("btnCancel")) {
  document.getElementById("btnCancel").addEventListener("click", closeModal);
}
if (document.getElementById("modalClose")) {
  document.getElementById("modalClose").addEventListener("click", closeModal);
}
if (modalOverlay) {
  modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });
}

function openCreateModal() {
  if (!modalOverlay || !modalTitle || !symbolForm) return;
  modalTitle.textContent = "New Symbol";
  symbolForm.reset();
  document.getElementById("symbolId").value = "";
  modalOverlay.classList.remove("hidden");
}

function openEditModal(id) {
  if (!modalOverlay || !modalTitle || !symbolForm) return;
  const rec = symbols[id];
  modalTitle.textContent = `Edit — ${rec.config.strategy_name}`;
  document.getElementById("symbolId").value = id;
  FIELD_IDS.forEach(f => {
    const el = document.getElementById(f);
    if (!el) return;
    const val = rec.config[f];
    if (el.type === "checkbox") el.checked = !!val;
    else el.value = val ?? "";
  });
  modalOverlay.classList.remove("hidden");
}

function closeModal() {
  if (modalOverlay) modalOverlay.classList.add("hidden");
}

if (symbolForm) {
  symbolForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("symbolId").value;

    const config = {};
    FIELD_IDS.forEach(f => {
      const el = document.getElementById(f);
      if (!el) return;
      if (el.type === "checkbox") { config[f] = el.checked; return; }
      if (el.type === "number") {
        config[f] = el.value === "" ? null : parseFloat(el.value);
        return;
      }
      config[f] = el.value;
    });

    if (config.limit_offset === null) delete config.limit_offset;
    if (config.entry_trail_brick_number === null) delete config.entry_trail_brick_number;

    try {
      if (id) {
        await api(`/api/symbols/${id}`, { method: "PUT", body: JSON.stringify({ config }) });
      } else {
        await api(`/api/symbols`, { method: "POST", body: JSON.stringify({ config }) });
      }
      closeModal();
      await loadSymbols();
    } catch (err) {
      alert(err.message);
    }
  });
}

// ---------------- Broker access token ----------------
const brokerModalOverlay = document.getElementById("brokerModalOverlay");
const brokerTokenForm    = document.getElementById("brokerTokenForm");
const brokerTokenStatus  = document.getElementById("brokerTokenStatus");
const newAccessTokenEl   = document.getElementById("newAccessToken");

if (document.getElementById("btnBrokerToken")) {
  document.getElementById("btnBrokerToken").addEventListener("click", openBrokerModal);
}
if (document.getElementById("brokerModalCancel")) {
  document.getElementById("brokerModalCancel").addEventListener("click", closeBrokerModal);
}
if (document.getElementById("brokerModalClose")) {
  document.getElementById("brokerModalClose").addEventListener("click", closeBrokerModal);
}
if (brokerModalOverlay) {
  brokerModalOverlay.addEventListener("click", (e) => { if (e.target === brokerModalOverlay) closeBrokerModal(); });
}

const btnGenerateToken = document.getElementById("btnGenerateToken");
const btnCloseAfterGenerate = document.getElementById("btnCloseAfterGenerate");

if (btnGenerateToken) {
  btnGenerateToken.addEventListener("click", async () => {
    const originalLabel = btnGenerateToken.textContent;
    btnGenerateToken.disabled = true;
    btnGenerateToken.textContent = "⏳ Generating…";
    brokerTokenStatus.textContent = "Logging in and generating a fresh access token — this takes a few seconds…";
    brokerTokenStatus.className = "token-status";
    btnCloseAfterGenerate?.classList.add("hidden");

    try {
      const s = await api("/api/broker/generate-token", { method: "POST" });
      renderBrokerStatus(s);
      brokerTokenStatus.innerHTML = `✅ ${escapeHTML(s.message || "Token generated and applied.")}<br/>` + brokerTokenStatus.innerHTML;
      brokerTokenStatus.className = "token-status ok";
      if (s.access_token) {
        newAccessTokenEl.value = s.access_token;
      }
      btnCloseAfterGenerate?.classList.remove("hidden");
    } catch (err) {
      brokerTokenStatus.textContent = `❌ ${err.message}`;
      brokerTokenStatus.className = "token-status warn";
    } finally {
      btnGenerateToken.disabled = false;
      btnGenerateToken.textContent = originalLabel;
    }
  });
}

if (btnCloseAfterGenerate) {
  btnCloseAfterGenerate.addEventListener("click", closeBrokerModal);
}

async function openBrokerModal() {
  if (!brokerModalOverlay) return;
  newAccessTokenEl.value = "";
  brokerTokenStatus.textContent = "Loading…";
  brokerTokenStatus.className = "token-status";
  brokerModalOverlay.classList.remove("hidden");
  try {
    const s = await api("/api/broker/settings");
    renderBrokerStatus(s);
  } catch (e) {
    brokerTokenStatus.textContent = `Could not load status: ${e.message}`;
    brokerTokenStatus.className = "token-status warn";
  }
}

function renderBrokerStatus(s) {
  if (!s.is_set) {
    brokerTokenStatus.textContent = "No access token configured yet — generate one or paste it below.";
    brokerTokenStatus.className = "token-status warn";
    return;
  }
  const when = s.updated_at ? new Date(s.updated_at).toLocaleString() : "at platform startup (.env)";
  const connLine = s.connected ? "Broker session: connected" : "Broker session: not yet connected";
  brokerTokenStatus.innerHTML =
    `Current token: ${s.masked} <span class="sym-sub">(updated ${when})</span><br/>${connLine}`;
  brokerTokenStatus.className = s.connected ? "token-status ok" : "token-status warn";
}

function closeBrokerModal() {
  if (brokerModalOverlay) brokerModalOverlay.classList.add("hidden");
}

if (brokerTokenForm) {
  brokerTokenForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = newAccessTokenEl.value.trim();
    if (!token) { alert("Paste today's access token first."); return; }
    try {
      const s = await api("/api/broker/settings", {
        method: "POST",
        body: JSON.stringify({ access_token: token }),
      });
      renderBrokerStatus(s);
      closeBrokerModal();
    } catch (err) {
      alert(err.message);
    }
  });
}

// ---------------- Search Symbol with LTP ----------------
const btnSearchSymbol = document.getElementById("btnSearchSymbol");
const searchInputLarge = document.getElementById("searchInputLarge");
const searchExchangeSelect = document.getElementById("searchExchangeSelect");
const searchResultsList = document.getElementById("searchResultsList");

let searchResultsData = [];
let searchTimeout = null;

async function performSearch() {
  const query = searchInputLarge?.value?.trim() || '';
  const exchange = searchExchangeSelect?.value || "NSE";

  if (searchTimeout) {
    clearTimeout(searchTimeout);
    searchTimeout = null;
  }

  if (query.length < 2) {
    if (searchResultsList) {
      searchResultsList.innerHTML = '<div class="no-results">Type at least 2 characters…</div>';
    }
    searchResultsData = [];
    return;
  }

  if (searchResultsList) {
    searchResultsList.innerHTML = '<div class="no-results">Searching...</div>';
  }

  searchTimeout = setTimeout(async () => {
    try {
      const result = await api("/api/search-symbols", {
        method: "POST",
        body: JSON.stringify({ query: query, exchange: exchange })
      });

      if (result.stat !== "Ok") {
        if (searchResultsList) {
          searchResultsList.innerHTML = `<div class="no-results">${escapeHTML(result.emsg || "Search failed")}</div>`;
        }
        searchResultsData = [];
        return;
      }

      const values = result.values || [];
      searchResultsData = values;

      if (!searchResultsList) return;

      if (values.length === 0) {
        searchResultsList.innerHTML = '<div class="no-results">No symbols found</div>';
        return;
      }

      searchResultsList.innerHTML = '<div class="no-results">Fetching live prices...</div>';

      const maxResults = Math.min(values.length, 20);
      const enhancedResults = [];
      
      for (let i = 0; i < maxResults; i++) {
        const item = values[i];
        const token = item.token;
        const exch = item.exch || exchange;
        
        let ltp = '--';
        let high = '';
        let low = '';
        let volume = '';
        let open = '';
        let bid = '';
        let ask = '';
        
        if (token) {
          try {
            const quoteResponse = await fetch(`/api/get-quotes?exchange=${encodeURIComponent(exch)}&token=${encodeURIComponent(token)}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' }
            });
            const quoteData = await quoteResponse.json();
            if (quoteData.success && quoteData.data) {
              ltp = quoteData.data.lp || '--';
              high = quoteData.data.h || '';
              low = quoteData.data.l || '';
              volume = quoteData.data.v || '';
              open = quoteData.data.pp || '';
              bid = quoteData.data.bp1 || '';
              ask = quoteData.data.sp1 || '';
            }
          } catch (e) {
            console.error(`Failed to fetch LTP for ${item.tsym}:`, e);
          }
        }
        
        enhancedResults.push({
          ...item,
          ltp: ltp,
          high: high,
          low: low,
          volume: volume,
          open: open,
          bid: bid,
          ask: ask
        });
      }
      
      if (values.length > maxResults) {
        for (let i = maxResults; i < values.length; i++) {
          enhancedResults.push({
            ...values[i],
            ltp: '--',
            high: '',
            low: '',
            volume: '',
            open: '',
            bid: '',
            ask: ''
          });
        }
      }
      
      searchResultsData = enhancedResults;

      searchResultsList.innerHTML = `
        <div style="display: flex; flex-direction: column; width: 100%; font-size: 12px;">
          <div style="display: flex; background: rgba(255, 255, 255, 0.05); padding: 8px 12px; font-weight: 600; font-size: 11px; color: var(--text-muted, #a0b4d0); border-bottom: 2px solid var(--border-color, rgba(255,255,255,0.12)); position: sticky; top: 0; z-index: 5; text-transform: uppercase; letter-spacing: 0.5px;">
            <div style="flex: 0.25; min-width: 28px; text-align: center;">#</div>
            <div style="flex: 1.8; min-width: 100px;">Symbol</div>
            <div style="flex: 0.5; min-width: 45px; text-align: center;">Exch</div>
            <div style="flex: 0.8; min-width: 65px; text-align: center;">Token</div>
            <div style="flex: 0.9; min-width: 65px; text-align: center;">LTP</div>
            <div style="flex: 0.8; min-width: 60px; text-align: center;">High</div>
            <div style="flex: 0.8; min-width: 60px; text-align: center;">Low</div>
            <div style="flex: 1; min-width: 65px; text-align: center;">Volume</div>
            <div style="flex: 1.8; min-width: 130px; text-align: right;">Actions</div>
          </div>
          
          ${enhancedResults.map((item, index) => {
            const ltpDisplay = item.ltp !== '--' ? parseFloat(item.ltp).toFixed(2) : '--';
            
            return `
              <div class="result-item" data-index="${index}" style="display: flex; align-items: center; padding: 6px 12px; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.06)); cursor: pointer; transition: background 0.15s; font-size: 12px; min-height: 32px; color: var(--text-main, #f0f4ff);">
                <div style="flex: 0.25; min-width: 28px; font-size: 11px; color: var(--text-muted, #a0b4d0); text-align: center;">${index + 1}</div>
                <div style="flex: 1.8; min-width: 100px; font-weight: 600; font-size: 12px; color: var(--text-main, #f0f4ff); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" onclick="selectSearchResult(${index})">${escapeHTML(item.tsym || "")}</div>
                <div style="flex: 0.5; min-width: 45px; font-size: 10px; text-align: center;" onclick="selectSearchResult(${index})"><span style="background: rgba(190, 227, 248, 0.15); color: #bee3f8; padding: 2px 8px; border-radius: 10px; font-size: 9px; font-weight: 600;">${escapeHTML(item.exch || "")}</span></div>
                <div style="flex: 0.8; min-width: 65px; font-size: 10px; color: var(--text-muted, #a0b4d0); text-align: center; font-family: monospace;" onclick="selectSearchResult(${index})">${escapeHTML(item.token || "")}</div>
                <div style="flex: 0.9; min-width: 65px; font-weight: 400; font-size: 11px; color: var(--text-muted, #a0b4d0); text-align: center;" onclick="selectSearchResult(${index})">${ltpDisplay}</div>
                <div style="flex: 0.8; min-width: 60px; font-size: 11px; color: var(--text-muted, #a0b4d0); text-align: center;" onclick="selectSearchResult(${index})">${item.high || '--'}</div>
                <div style="flex: 0.8; min-width: 60px; font-size: 11px; color: var(--text-muted, #a0b4d0); text-align: center;" onclick="selectSearchResult(${index})">${item.low || '--'}</div>
                <div style="flex: 1; min-width: 65px; font-size: 11px; color: var(--text-muted, #a0b4d0); text-align: center;" onclick="selectSearchResult(${index})">${item.volume || '--'}</div>
                <div style="flex: 1.8; min-width: 130px; display: flex; gap: 6px; justify-content: flex-end;">
                  <button class="btn btn-sm" onclick="event.stopPropagation(); getQuotes('${escapeHTML(item.exch || 'NSE')}', '${escapeHTML(item.token || '')}', '${escapeHTML(item.tsym || '')}')" style="padding: 4px 12px; font-size: 11px; border-radius: 6px; background: transparent; color: #dadde6; border: 1px solid rgba(82, 81, 82, 0.4); cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                    Quotes
                  </button>
                  <button class="btn btn-sm" onclick="event.stopPropagation(); addToWatchlistFromSearch(${index})" style="padding: 4px 12px; font-size: 11px; border-radius: 6px; background: transparent; color: #fbbf24; border: 1px solid rgba(251, 191, 36, 0.3); cursor: pointer; white-space: nowrap; transition: all 0.2s;" 
                    onmouseover="this.style.background='rgba(251, 191, 36, 0.1)'" 
                    onmouseout="this.style.background='transparent'">
                    ⭐
                  </button>
                  <button class="btn btn-sm" onclick="event.stopPropagation(); selectSearchResult(${index})" style="padding: 4px 12px; font-size: 11px; border-radius: 6px; background: var(--btn-add-grad, linear-gradient(135deg, #00d4ff 0%, #7b2ffc 50%, #ff2d95 100%)); color: #ffffff; border: none; cursor: pointer; white-space: nowrap; transition: all 0.2s;">
                    Add Symbol
                  </button>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      `;

      searchResultsList.querySelectorAll('.result-item').forEach(el => {
        el.addEventListener('click', function(e) {
          if (!e.target.closest('button')) {
            const index = parseInt(this.dataset.index);
            selectSearchResult(index);
          }
        });
      });

    } catch (error) {
      console.error("SEARCH API ERROR:", error);
      if (searchResultsList) {
        searchResultsList.innerHTML = `<div class="no-results">${escapeHTML(error.message)}</div>`;
      }
      searchResultsData = [];
    }
  }, 300);
}

if (searchInputLarge) {
  searchInputLarge.addEventListener("input", performSearch);
  searchInputLarge.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (searchTimeout) {
        clearTimeout(searchTimeout);
        searchTimeout = null;
      }
      performSearch();
    }
  });
}

if (searchExchangeSelect) {
  searchExchangeSelect.addEventListener("change", performSearch);
}

if (btnSearchSymbol) {
  btnSearchSymbol.addEventListener("click", () => {
    const overlay = document.getElementById("searchModalOverlay");
    if (overlay) {
      overlay.classList.remove("hidden");
    }
    if (searchInputLarge) {
      searchInputLarge.focus();
      searchInputLarge.select();
      if (searchInputLarge.value.trim().length >= 2) {
        performSearch();
      }
    }
  });
}

function selectSearchResult(index) {
  const item = searchResultsData[index];
  if (!item) return;

  console.log("SELECTED SYMBOL:", item);

  const searchOverlay = document.getElementById("searchModalOverlay");
  if (searchOverlay) searchOverlay.classList.add("hidden");

  openCreateModal();

  const strategyNameField = document.getElementById("strategy_name");
  const exchangeField = document.getElementById("exchange");
  const tradingSymbolField = document.getElementById("trading_symbol");
  const tokenField = document.getElementById("token");
  const tickSizeField = document.getElementById("tick_size");
  const quantityField = document.getElementById("quantity");

  const displayName = item.dname || item.cname || item.tsym || "";

  if (strategyNameField) strategyNameField.value = displayName;
  if (exchangeField) exchangeField.value = item.exch || "";
  if (tradingSymbolField) tradingSymbolField.value = item.tsym || "";
  if (tokenField) tokenField.value = item.token || "";
  if (tickSizeField) tickSizeField.value = item.ti || "";
  if (quantityField && item.ls) quantityField.value = item.ls;

  console.log("SCRIP POPULATED:", displayName, "TOKEN:", item.token, "EXCHANGE:", item.exch);
}

const searchModalClose = document.getElementById("searchModalClose");
if (searchModalClose) {
  searchModalClose.addEventListener("click", () => {
    const overlay = document.getElementById("searchModalOverlay");
    if (overlay) overlay.classList.add("hidden");
  });
}

const searchModalOverlay = document.getElementById("searchModalOverlay");
if (searchModalOverlay) {
  searchModalOverlay.addEventListener("click", (e) => {
    if (e.target === searchModalOverlay) {
      searchModalOverlay.classList.add("hidden");
    }
  });
}

// ---------------- Select from Quotes Function ----------------
function selectFromQuotes() {
  console.log("selectFromQuotes called!");
  
  const quoteData = window._selectedQuoteData;
  if (!quoteData) {
    console.error("No quote data found!");
    return;
  }
  
  console.log("Quote data:", quoteData);
  
  const quotesModalOverlay = document.getElementById('quotesModalOverlay');
  if (quotesModalOverlay) {
    quotesModalOverlay.classList.add('hidden');
  }
  
  openCreateModal();
  
  const strategyNameField = document.getElementById("strategy_name");
  const exchangeField = document.getElementById("exchange");
  const tradingSymbolField = document.getElementById("trading_symbol");
  const tokenField = document.getElementById("token");
  const tickSizeField = document.getElementById("tick_size");
  const quantityField = document.getElementById("quantity");
  
  const displayName = quoteData.cname || quoteData.dname || quoteData.tsym || '';
  const exchange = quoteData.exch || '';
  const token = quoteData.token || '';
  const tickSize = quoteData.ti || '';
  const tsym = quoteData.tsym || '';
  const lotSize = quoteData.ls || '';

  console.log("Populating with:", { displayName, exchange, token, tickSize, tsym });
  
  if (strategyNameField) strategyNameField.value = displayName;
  if (exchangeField) exchangeField.value = exchange;
  if (tradingSymbolField) tradingSymbolField.value = tsym;
  if (tokenField) tokenField.value = token;
  if (tickSizeField) tickSizeField.value = tickSize;
  if (quantityField && lotSize) quantityField.value = lotSize;

  console.log("Form populated successfully from quotes!");
}

// ---------------- Get Quotes Functionality ----------------
async function getQuotes(exchange, token, symbol) {
  const modal = document.getElementById('quotesModalOverlay');
  const modalContent = document.getElementById('quotesModalContent');
  const modalTitle = document.getElementById('quotesModalTitle');
  const loadingIndicator = document.getElementById('quotesLoading');
  
  if (!modal) {
    console.error('Quotes modal not found');
    return;
  }
  
  modalTitle.textContent = `Quote Details - ${symbol}`;
  modalContent.innerHTML = '';
  loadingIndicator.classList.remove('hidden');
  modal.classList.remove('hidden');
  
  try {
    const url = `/api/get-quotes?exchange=${encodeURIComponent(exchange)}&token=${encodeURIComponent(token)}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    const data = await response.json();
    console.log("RAW QUOTE DATA:", JSON.stringify(data.data));
    loadingIndicator.classList.add('hidden');
    
    if (data.success) {
      displayQuotesInModal(data.data);
    } else {
      modalContent.innerHTML = `
        <div class="alert-error" style="padding: 12px 16px; border-radius: 8px; background: #fed7d7; color: #742a2a; border: 1px solid #fc8181;">
          Failed to get quotes: ${escapeHTML(data.error || 'Unknown error')}
        </div>
      `;
    }
  } catch (error) {
    console.error('Get quotes error:', error);
    loadingIndicator.classList.add('hidden');
    modalContent.innerHTML = `
      <div class="alert-error" style="padding: 12px 16px; border-radius: 8px; background: #fed7d7; color: #742a2a; border: 1px solid #fc8181;">
        Error fetching quotes: ${escapeHTML(error.message)}
      </div>
    `;
  }
}

function displayQuotesInModal(data) {
  const modalContent = document.getElementById('quotesModalContent');
  
  window._selectedQuoteData = data;
  
  let html = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0;">
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Company Name</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.cname || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Symbol Name</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.symname || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Exchange</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">
          <span style="background: #bee3f8; color: #2a4365; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;">${escapeHTML(data.exch || 'N/A')}</span>
        </span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Trading Symbol</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);"><strong>${escapeHTML(data.tsym || 'N/A')}</strong></span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Token</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">
          <code style="background: rgba(255,255,255,0.08); padding: 2px 8px; border-radius: 4px; font-size: 13px;">${escapeHTML(data.token || 'N/A')}</code>
        </span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">ISIN</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.isin || 'N/A')}</span>
      </div>
      
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Instrument</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">
          <span style="background: #e9d8fd; color: #553c9a; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;">${escapeHTML(data.instname || 'N/A')}</span>
        </span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Segment</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.seg || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Lot Size</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.ls || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Tick Size</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.ti || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Multiplier</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.mult || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Price Precision</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.pp || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color); grid-column: span 2;">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Price Factor</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.prcftr_d || 'N/A')}</span>
      </div>
      
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Last Price</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.lp || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Day High</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.h || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Day Low</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.l || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Volume</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.v || '0')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Upper Circuit</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.uc || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Lower Circuit</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.lc || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Last Trade Qty</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.ltq || '0')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Last Trade Time</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.ltt || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color); grid-column: span 2;">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Last Trade Date</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.ltd || data.exd || 'N/A')}</span>
      </div>
      
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Best Bid Price</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bp1 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Best Ask Price</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sp1 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Best Bid Qty</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bq1 || '0')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Best Ask Qty</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sq1 || '0')}</span>
      </div>
      
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Price 2</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bp2 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Price 2</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sp2 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Qty 2</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bq2 || '0')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Qty 2</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sq2 || '0')}</span>
      </div>
    </div>
  `;

  html += `
    <div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-color);">
      <button 
        class="btn btn-secondary" 
        style="padding: 12px 24px; font-size: 14px; cursor: pointer;"
        onclick="closeQuotesModal()"
      >
        Close
      </button>
    </div>
  `;

  modalContent.innerHTML = html;
}

function closeQuotesModal() {
  console.log("closeQuotesModal called!");
  const quotesModalOverlay = document.getElementById('quotesModalOverlay');
  if (quotesModalOverlay) {
    quotesModalOverlay.classList.add('hidden');
  }
  const modalContent = document.getElementById('quotesModalContent');
  if (modalContent) {
    setTimeout(() => {
      if (quotesModalOverlay && quotesModalOverlay.classList.contains('hidden')) {
        modalContent.innerHTML = '';
        const loadingDiv = document.createElement('div');
        loadingDiv.id = 'quotesLoading';
        loadingDiv.className = 'loading';
        loadingDiv.innerHTML = `
          <div class="spinner"></div>
          <p style="margin-top: 8px; color: var(--text-muted);">Fetching quotes...</p>
        `;
        modalContent.appendChild(loadingDiv);
        delete window._selectedQuoteData;
      }
    }, 300);
  }
}

const quotesModalOverlay = document.getElementById('quotesModalOverlay');
const quotesModalClose = document.getElementById('quotesModalClose');

if (quotesModalClose) {
  quotesModalClose.addEventListener('click', closeQuotesModal);
}

if (quotesModalOverlay) {
  quotesModalOverlay.addEventListener('click', function(e) {
    if (e.target === quotesModalOverlay) {
      closeQuotesModal();
    }
  });
}

document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape' && quotesModalOverlay && !quotesModalOverlay.classList.contains('hidden')) {
    closeQuotesModal();
  }
});

window.closeQuotesModal = closeQuotesModal;
window.getQuotes = getQuotes;
window.selectSearchResult = selectSearchResult;
window.selectFromQuotes = selectFromQuotes;

// ---------------- Logs ----------------
function renderLogFilterOptions() {
  if (!logFilter) return;
  const current = logFilter.value;
  const opts = [`<option value="__all__">All symbols</option>`];
  Object.entries(knownSymbolNames).forEach(([id, name]) => {
    opts.push(`<option value="${id}">${escapeHTML(name)}</option>`);
  });
  logFilter.innerHTML = opts.join("");
  logFilter.value = [...logFilter.options].some(o => o.value === current) ? current : "__all__";
}

async function loadInitialLogs() {
  if (!logStream) return;
  try {
    const logs = await api("/api/logs?limit=200");
    logs.forEach(appendLogLine);
    logStream.scrollTop = logStream.scrollHeight;
  } catch (e) { /* ignore */ }
}

function appendLogLine(entry) {
  if (!logStream) return;
  const filterVal = logFilter?.value || "__all__";
  if (filterVal !== "__all__" && entry.id && entry.id !== filterVal) return;

  const line = document.createElement("div");
  line.className = `log-line log-${entry.level || "INFO"}`;
  line.dataset.symId = entry.id || "";
  const symLabel = entry.symbol ? `<span class="log-sym">[${escapeHTML(entry.symbol)}]</span>` : "";
  line.innerHTML = `<span class="log-time">${entry.time}</span>${symLabel}${escapeHTML(entry.message)}`;
  logStream.appendChild(line);

  while (logStream.childElementCount > 500) logStream.removeChild(logStream.firstChild);
  const nearBottom = logStream.scrollHeight - logStream.scrollTop - logStream.clientHeight < 80;
  if (nearBottom) logStream.scrollTop = logStream.scrollHeight;
}

if (logFilter) {
  logFilter.addEventListener("change", () => {
    if (logStream) {
      logStream.innerHTML = "";
      loadInitialLogs();
    }
  });
}

// =====================================================================
// WATCHLIST - LTP now updates exactly like the Strategy table: a
// websocket tick mutates the in-memory item and calls renderWatchlist()
// directly, with zero API calls in that hot path.
//
// Previous Close is fetched ONCE per token (on load / on add) and
// cached in `previousCloseCache`. Every later LTP update — whether
// from the initial fetch or from a websocket tick — reuses that
// cached value to compute Change / Change% locally. It is never
// re-fetched for the lifetime of that token in the watchlist.
// =====================================================================

// Watchlist data
let watchlistData = {};

// token (string) -> previous close price. Populated once, reused forever.
const previousCloseCache = {};

function cachePrevClose(token, prevClose) {
  if (token === undefined || token === null || token === '') return;
  const key = String(token);
  const val = parseFloat(prevClose);
  // Only set it if we don't already have one — this is the "fetch once" guarantee.
  if (!(key in previousCloseCache) && !isNaN(val) && val > 0) {
    previousCloseCache[key] = val;
  }
}

function getPrevClose(token) {
  return previousCloseCache[String(token)];
}

function clearPrevClose(token) {
  delete previousCloseCache[String(token)];
}

// Single, shared update path for BOTH the initial REST fetch and every
// websocket tick — mirrors how renderBoard() is the single update path
// for the Strategy table.
function applyLTPUpdate(item, ltp) {
  if (!item || ltp === null || ltp === undefined || isNaN(ltp)) return;

  const prevClose = getPrevClose(item.token);

  let change = 0;
  let changePercent = 0;
  if (prevClose && prevClose > 0) {
    change = ltp - prevClose;
    changePercent = (change / prevClose) * 100;
  }

  item.ltp = ltp;
  item.change = change;
  item.changePercent = changePercent;
  item.lastUpdated = new Date().toLocaleTimeString();

  renderWatchlist();
}

// Load watchlist from localStorage
function loadWatchlist() {
  try {
    const saved = localStorage.getItem('cognix_watchlist');
    if (saved) {
      const items = JSON.parse(saved);
      watchlistData = {};
      items.forEach(item => {
        const id = `wl_${Date.now()}_${Math.random()}`;
        watchlistData[id] = {
          id: id,
          symbol: item.symbol,
          exchange: item.exchange,
          token: item.token,
          ltp: null,
          change: 0,
          changePercent: 0,
          lastUpdated: null
        };
      });
    } else {
      watchlistData = {};
    }
  } catch (e) {
    console.error('Error loading watchlist:', e);
    watchlistData = {};
  }
  
  updateWatchlistCount();
  renderWatchlist();

  // Seed previous-close cache + initial LTP exactly once per symbol,
  // right when the watchlist loads — same idea as loadSymbols() pulling
  // initial live_status for the Strategy table on page load.
  Object.keys(watchlistData).forEach(id => fetchWatchlistLTP(id));
}

// Save watchlist to localStorage
function saveWatchlist() {
  try {
    const items = Object.values(watchlistData).map(item => ({
      symbol: item.symbol,
      exchange: item.exchange,
      token: item.token
    }));
    localStorage.setItem('cognix_watchlist', JSON.stringify(items));
  } catch (e) {
    console.error('Error saving watchlist:', e);
  }
  updateWatchlistCount();
}

function updateWatchlistCount() {
  const countEl = document.getElementById('watchlistCount');
  if (countEl) {
    countEl.textContent = Object.keys(watchlistData).length;
  }
}

// Add symbol to watchlist
function addToWatchlist(symbol, exchange, token) {
  // Check if already exists
  const exists = Object.values(watchlistData).some(item => 
    String(item.token) === String(token) && item.exchange === exchange
  );
  
  if (exists) {
    showAlert('Symbol already in watchlist', 'info');
    return;
  }
  
  const id = `wl_${Date.now()}_${Math.random()}`;
  watchlistData[id] = {
    id: id,
    symbol: symbol,
    exchange: exchange,
    token: token,
    ltp: null,
    change: 0,
    changePercent: 0,
    lastUpdated: null
  };
  
  saveWatchlist();
  renderWatchlist();
  showAlert(`Added ${symbol} to watchlist`, 'success');
  
  // Fetch initial LTP + cache Previous Close ONCE for this token.
  fetchWatchlistLTP(id);
  // Live updates ride the page WebSocket now.
  wsSubscribeSymbols([{ exchange, token, symbol }]);
}

// Remove symbol from watchlist
function removeFromWatchlist(id) {
  if (!id) return;
  
  const item = watchlistData[id];
  if (!item) return;
  
  if (confirm(`Remove "${item.symbol}" from watchlist?`)) {
    const token = item.token;
    delete watchlistData[id];

    // Drop the cached previous close only if no other watchlist row
    // still references this token.
    const stillUsed = Object.values(watchlistData).some(w => String(w.token) === String(token));
    if (!stillUsed) {
      clearPrevClose(token);
      // Nobody needs this token on this page anymore — release the feed.
      wsUnsubscribeSymbol(item.exchange, token);
    }

    saveWatchlist();
    renderWatchlist();
    showAlert(`Removed ${item.symbol} from watchlist`, 'info');
  }
}

// Fetch LTP for watchlist item — this is the ONLY place Previous Close
// is ever pulled from the API, and cachePrevClose() makes even repeated
// calls here a no-op once a value is cached for that token.
async function fetchWatchlistLTP(id) {
  const item = watchlistData[id];
  if (!item) return;
  
  try {
    const response = await fetch(`/api/get-quotes?exchange=${encodeURIComponent(item.exchange)}&token=${encodeURIComponent(item.token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    
    if (data.success && data.data) {
      const quote = data.data;
      const ltp = parseFloat(quote.lp) || 0;

      // Cache previous close ONCE. If it's already cached, this no-ops.
      const prevCloseFromQuote = parseFloat(quote.c) || parseFloat(quote.o) || 0;
      cachePrevClose(item.token, prevCloseFromQuote);

      applyLTPUpdate(item, ltp);
    }
  } catch (e) {
    console.error(`Failed to fetch LTP for ${item.symbol}:`, e);
  }
}

// Render watchlist
function renderWatchlist() {
  const tbody = document.getElementById('watchlistBody');
  if (!tbody) return;
  
  const items = Object.values(watchlistData);
  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align: center; padding: 20px 14px; color: var(--text-muted); font-size: 13px;">
          No symbols in watchlist
        </td>
      </tr>
    `;
    return;
  }
  
  let html = '';
  items.forEach(item => {
    const ltpDisplay = item.ltp !== null && item.ltp !== undefined 
      ? (typeof item.ltp === "number" ? item.ltp.toFixed(2) : item.ltp)
      : "⌛";
    
    const changeColor = item.change > 0 ? '#48bb78' : (item.change < 0 ? '#fc8181' : 'var(--text-muted)');
    const changeArrow = item.change > 0 ? '▲' : (item.change < 0 ? '▼' : '');
    
    const changeDisplay = item.change !== 0 ? 
      `<span style="display: inline-flex; align-items: center; gap: 2px;">
        <span style="font-size: 11px;">${changeArrow}</span>
        <span>${item.change > 0 ? '+' : ''}${item.change.toFixed(2)}</span>
      </span>` : 
      '<span>--</span>';
    
    const percentDisplay = (item.changePercent !== 0) ?
      `${item.changePercent > 0 ? '+' : ''}${item.changePercent.toFixed(2)}%` :
      '';
    
    html += `
      <tr>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid var(--border-color); vertical-align: middle; text-align: left;">
          <span style="font-weight: 600; color: var(--text-main);">${escapeHTML(item.symbol)}</span>
          <span style="font-size: 11px; color: var(--text-muted); margin-left: 6px;">${escapeHTML(item.exchange)}</span>
          ${item.lastUpdated ? `<span style="font-size: 9px; color: var(--text-muted); margin-left: 8px; opacity: 0.5;">${item.lastUpdated}</span>` : ''}
        </td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid var(--border-color); color: var(--text-main); text-align: right; font-weight: 600; vertical-align: middle;">
          ${ltpDisplay}
        </td>
        <td style="padding: 8px 12px; font-size: 13px; border-bottom: 1px solid var(--border-color); color: ${changeColor}; text-align: right; font-weight: 600; position: relative; vertical-align: middle; padding-right: 32px;">
          <div style="display: flex; flex-direction: column; align-items: flex-end; line-height: 1.3;">
            ${changeDisplay}
            ${percentDisplay ? `<span style="font-size: 11px; opacity: 0.8; font-weight: 500;">${percentDisplay}</span>` : ''}
          </div>
          <button 
            onclick="removeFromWatchlist('${item.id}')"
            title="Remove from watchlist"
            style="position: absolute; top: 4px; right: 4px; background: transparent; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 4px; transition: all 0.2s; line-height: 1; opacity: 0.3;"
            onmouseover="this.style.color='#fc8181'; this.style.background='rgba(252, 129, 129, 0.15)'; this.style.opacity='1';"
            onmouseout="this.style.color='var(--text-muted)'; this.style.background='transparent'; this.style.opacity='0.3';"
          >
            ✕
          </button>
        </td>
      </tr>
    `;
  });
  
  tbody.innerHTML = html;
}

// Update watchlist from WebSocket — SIMPLE AND DIRECT, exactly like the
// Strategy table's `status` handler: find the row, mutate it, render.
// NO API calls happen here. Previous Close comes from the cache only.
function updateWatchlistFromWebSocket(data) {
  if (!data || !data.token) return;
  
  const token = String(data.token);
  
  // Find matching watchlist item
  let targetItem = null;
  for (const id in watchlistData) {
    if (String(watchlistData[id].token) === token) {
      targetItem = watchlistData[id];
      break;
    }
  }
  
  if (!targetItem) return;

  const ltp = parseFloat(data.lp ?? data.ltp ?? data.last_price ?? 0);
  if (!ltp || isNaN(ltp)) return;

  // Edge case only: a tick arrives before the initial REST fetch has
  // completed, so the cache is still empty. Seed it from whatever the
  // feed itself provides — this fires at most once per token, since
  // cachePrevClose() never overwrites an existing cached value.
  if (getPrevClose(token) === undefined) {
    const seed = parseFloat(data.c ?? data.prev_close ?? data.o ?? data.open ?? 0);
    if (seed > 0) cachePrevClose(token, seed);
  }

  // Single shared path — no extra fetch, no recomputation from message
  // fields beyond the seed-once fallback above.
  applyLTPUpdate(targetItem, ltp);
}

// Watchlist Modal functions
function openWatchlistModal() {
  const overlay = document.getElementById("watchlistModalOverlay");
  if (overlay) {
    overlay.classList.remove("hidden");
    // Refresh all watchlist items — cachePrevClose() no-ops if already
    // cached, so this only ever re-pulls LTP, never re-fetches Previous Close.
    Object.keys(watchlistData).forEach(id => fetchWatchlistLTP(id));
  }
}

function closeWatchlistModal() {
  const overlay = document.getElementById("watchlistModalOverlay");
  if (overlay) {
    overlay.classList.add("hidden");
  }
}

// Add to Watchlist from Search Results
function addToWatchlistFromSearch(index) {
  const item = searchResultsData[index];
  if (!item) return;
  
  const symbol = item.tsym || item.symbol || '';
  const exchange = item.exch || item.exchange || '';
  const token = item.token || '';
  
  if (symbol && exchange && token) {
    addToWatchlist(symbol, exchange, token);
  } else {
    showAlert('Invalid symbol data', 'error');
  }
}

// Alert function
function showAlert(message, type = 'info') {
  const alertDiv = document.createElement('div');
  alertDiv.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 12px 24px;
    border-radius: 10px;
    background: var(--bg-card);
    color: var(--text-main);
    border: 1px solid var(--border-color);
    box-shadow: 0 8px 30px rgba(0,0,0,0.4);
    z-index: 1000;
    font-size: 14px;
    font-weight: 500;
    backdrop-filter: blur(10px);
    animation: modalPop 0.3s ease forwards;
  `;
  
  if (type === 'success') {
    alertDiv.style.borderColor = '#48bb78';
    alertDiv.style.borderLeft = '4px solid #48bb78';
  } else if (type === 'error') {
    alertDiv.style.borderColor = '#fc8181';
    alertDiv.style.borderLeft = '4px solid #fc8181';
  } else if (type === 'info') {
    alertDiv.style.borderColor = '#60a5fa';
    alertDiv.style.borderLeft = '4px solid #60a5fa';
  }
  
  alertDiv.textContent = message;
  document.body.appendChild(alertDiv);
  
  setTimeout(() => {
    alertDiv.style.opacity = '0';
    alertDiv.style.transform = 'translateY(20px)';
    alertDiv.style.transition = 'all 0.3s ease';
    setTimeout(() => {
      if (alertDiv.parentNode) {
        alertDiv.remove();
      }
    }, 300);
  }, 4000);
}

// Make functions globally accessible
window.removeFromWatchlist = removeFromWatchlist;
window.addToWatchlist = addToWatchlist;
window.addToWatchlistFromSearch = addToWatchlistFromSearch;
window.openWatchlistModal = openWatchlistModal;
window.closeWatchlistModal = closeWatchlistModal;

// Refresh Watchlist Button
const refreshBtn = document.getElementById('refreshWatchlistBtn');
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    Object.keys(watchlistData).forEach(id => fetchWatchlistLTP(id));
  });
}

// Watchlist Modal button
const watchlistBtn = document.getElementById('btnWatchlist');
if (watchlistBtn) {
  watchlistBtn.addEventListener('click', openWatchlistModal);
}



// ---------------- WebSocket ----------------
let boardWS = null;

// OpenAlgo-parity WS market data: the dashboard declares WHICH instruments
// it wants via {action:"subscribe"}; the server fans market_data frames
// only to sockets that asked for them, and frees the broker feed refcount
// automatically when this socket drops.
function wsSubscribeSymbols(list, mode = "quote") {
  const symbols = (list || []).map(i => ({ exchange: i.exchange, token: String(i.token), symbol: i.symbol }));
  if (!symbols.length) return;
  try {
    if (boardWS && boardWS.readyState === 1) {
      boardWS.send(JSON.stringify({ action: "subscribe", mode, symbols }));
    }
  } catch (e) { /* socket just dropped — reconnect resubscribes */ }
}

function wsUnsubscribeSymbol(exchange, token) {
  try {
    if (boardWS && boardWS.readyState === 1) {
      boardWS.send(JSON.stringify({ action: "unsubscribe", symbols: [{ exchange, token: String(token) }] }));
    }
  } catch (e) { /* best effort */ }
}

function wsSubscribeWatchlist() {
  wsSubscribeSymbols(Object.values(watchlistData));
}

function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  boardWS = new WebSocket(`${proto}//${location.host}/ws`);

  boardWS.onopen = () => {
    connDot.className = "conn-dot live";
    connLabel.textContent = "live";
    wsSubscribeWatchlist();            // desired-state replay (idempotent)
    try {
      boardWS.send(JSON.stringify({ action: "subscribe_orders" }));
    } catch (e) { /* ignore */ }
  };

  boardWS.onclose = () => {
    connDot.className = "conn-dot down";
    connLabel.textContent = "reconnecting…";
    setTimeout(connectWS, 2000);
  };

  boardWS.onerror = () => boardWS.close();

  boardWS.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);

      // --- STATUS MESSAGES (Strategy Updates) ---
      if (msg.type === "status") {
        if (symbols[msg.instance_id]) {
          symbols[msg.instance_id].live_status = msg.status;
          renderBoard();
        }
      }

      // --- LOG MESSAGES ---
      else if (msg.type === "log") {
        const name = knownSymbolNames[msg.instance_id];
        appendLogLine({ ...msg.entry, id: msg.instance_id, symbol: name });
      }

      // --- ORDER STREAM (subscribe_orders) — refresh the strategy board ---
      else if (msg.type === "order_update") {
        loadSymbols();
      }

      // --- REAL-TIME MARKET DATA for WATCHLIST ---
      else if (msg.type === "quote" || msg.type === "ltp" || msg.type === "tick" ||
              msg.type === "depth" || msg.type === "df" || msg.type === "dk" ||
              msg.type === "market_data") {

        // market_data frames keep token/exchange at the frame level and the
        // normalized quote under data — flatten them for the handler.
        const data = msg.type === "market_data"
          ? { token: msg.token, exchange: msg.exchange, ...(msg.data || {}) }
          : (msg.data || msg);
        if (data && data.token) {
          // Update watchlist with the data
          updateWatchlistFromWebSocket(data);
        }
      }

    } catch (error) {
      console.error('WebSocket message parse error:', error);
    }
  };
}


// ---------------- Init ----------------
const logoutBtn = document.getElementById("btnLogout");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.href = "/login";
    }
  });
}

(async function init() {
  try {
    const authStatus = await fetch("/api/auth/status").then(r => r.json());
    if (!authStatus.auth_enabled && logoutBtn) {
      logoutBtn.classList.add("hidden");
    }
  } catch (e) { /* ignore */ }

  await loadSymbols();
  await loadInitialLogs();
  loadWatchlist();
  connectWS();
  setInterval(loadSymbols, 15000);
})();