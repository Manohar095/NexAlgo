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

// ---------------- Search Symbol ----------------
const btnSearchSymbol = document.getElementById("btnSearchSymbol");
const searchInputLarge = document.getElementById("searchInputLarge");
const searchExchangeSelect = document.getElementById("searchExchangeSelect");
const searchResultsList = document.getElementById("searchResultsList");

let searchResultsData = [];
let searchTimeout = null;

// Function to perform search
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

      searchResultsList.innerHTML = values.map((item, index) => {
        return `
          <div class="result-item" data-index="${index}" style="display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; cursor: pointer;">
            <div style="flex: 1;" onclick="selectSearchResult(${index})">
              <strong>${escapeHTML(item.tsym || "")}</strong>
              <span style="margin-left: 8px; font-size: 12px; color: #718096;">${escapeHTML(item.exch || "")}</span>
              <span style="margin-left: 8px; font-size: 12px; color: #718096;">Token: ${escapeHTML(item.token || "")}</span>
            </div>
            <div>
              <button class="btn btn-sm btn-success" onclick="event.stopPropagation(); getQuotes('${escapeHTML(item.exch || 'NSE')}', '${escapeHTML(item.token || '')}', '${escapeHTML(item.tsym || '')}')" style="margin-right: 4px;">
                Quotes
              </button>
              <button class="btn btn-sm btn-primary" onclick="event.stopPropagation(); selectSearchResult(${index})">
                Select
              </button>
            </div>
          </div>
        `;
      }).join("");

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

// Search input handler
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

// Exchange dropdown change handler
if (searchExchangeSelect) {
  searchExchangeSelect.addEventListener("change", performSearch);
}

// Open search modal
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

// Select search result and populate form
function selectSearchResult(index) {
  const item = searchResultsData[index];
  if (!item) return;

  console.log("SELECTED SYMBOL:", item);

  // Close search popup
  const searchOverlay = document.getElementById("searchModalOverlay");
  if (searchOverlay) searchOverlay.classList.add("hidden");

  // Open Add Symbol form
  openCreateModal();

  // Populate the form with the selected data
  const strategyNameField = document.getElementById("strategy_name");
  const exchangeField = document.getElementById("exchange");
  const tradingSymbolField = document.getElementById("trading_symbol");
  const tokenField = document.getElementById("token");
  const tickSizeField = document.getElementById("tick_size");

  if (strategyNameField) strategyNameField.value = item.tsym || "";
  if (exchangeField) exchangeField.value = item.exch || "";
  if (tradingSymbolField) tradingSymbolField.value = item.tsym || "";
  if (tokenField) tokenField.value = item.token || "";
  if (tickSizeField) tickSizeField.value = item.ti || "";

  console.log("SCRIP POPULATED:", item.tsym, "TOKEN:", item.token, "EXCHANGE:", item.exch);
}

// Close search popup
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


// ---------------- Select from Quotes Function (like selectSearchResult) ----------------
function selectFromQuotes() {
  console.log("selectFromQuotes called!");
  
  const quoteData = window._selectedQuoteData;
  if (!quoteData) {
    console.error("No quote data found!");
    return;
  }
  
  console.log("Quote data:", quoteData);
  
  // Close quotes modal
  const quotesModalOverlay = document.getElementById('quotesModalOverlay');
  if (quotesModalOverlay) {
    quotesModalOverlay.classList.add('hidden');
  }
  
  // Open Add Symbol form - using the same function as search results
  openCreateModal();
  
  // Populate form fields
  const strategyNameField = document.getElementById("strategy_name");
  const exchangeField = document.getElementById("exchange");
  const tradingSymbolField = document.getElementById("trading_symbol");
  const tokenField = document.getElementById("token");
  const tickSizeField = document.getElementById("tick_size");
  
  const symbolName = quoteData.tsym || quoteData.cname || '';
  const exchange = quoteData.exch || '';
  const token = quoteData.token || '';
  const tickSize = quoteData.ti || '';
  
  console.log("Populating with:", { symbolName, exchange, token, tickSize });
  
  if (strategyNameField) strategyNameField.value = symbolName;
  if (exchangeField) exchangeField.value = exchange;
  if (tradingSymbolField) tradingSymbolField.value = symbolName;
  if (tokenField) tokenField.value = token;
  if (tickSizeField) tickSizeField.value = tickSize;
  
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

// ---------------- Display Quotes in Modal ----------------
function displayQuotesInModal(data) {
  const modalContent = document.getElementById('quotesModalContent');
  
  window._selectedQuoteData = data;
  
  let html = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 16px 0;">
      <!-- Basic Information -->
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
      
      <!-- Instrument Details -->
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
      
      <!-- Price & Market Data -->
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
      
      <!-- Best Bid/Ask (Level 1) -->
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
      
      <!-- Best Bid/Ask (Level 2) -->
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
      
      <!-- Best Bid/Ask (Level 3) -->
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Price 3</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bp3 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Price 3</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sp3 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Qty 3</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bq3 || '0')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Qty 3</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sq3 || '0')}</span>
      </div>
      
      <!-- Best Bid/Ask (Level 4) -->
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Price 4</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bp4 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Price 4</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sp4 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Qty 4</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bq4 || '0')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Qty 4</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sq4 || '0')}</span>
      </div>
      
      <!-- Best Bid/Ask (Level 5) -->
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Price 5</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bp5 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Price 5</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sp5 || '0.00')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Qty 5</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bq5 || '0')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Qty 5</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.sq5 || '0')}</span>
      </div>
      
      <!-- Best Bid/Ask Orders -->
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Bid Orders 1</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.bo1 || '0')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Ask Orders 1</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.so1 || '0')}</span>
      </div>
      
      <!-- Additional Fields -->
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Option Type</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">
          <span style="background: #feebc8; color: #744210; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600;">${escapeHTML(data.optt || data.opt || 'N/A')}</span>
        </span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color);">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Expiry Date</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.exd || 'N/A')}</span>
      </div>
      <div style="background: var(--input-bg); padding: 12px 16px; border-radius: 8px; display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border-color); grid-column: span 2;">
        <span style="font-size: 12px; color: var(--text-muted); font-weight: 500;">Request Time</span>
        <span style="font-size: 14px; font-weight: 600; color: var(--text-main);">${escapeHTML(data.request_time || 'N/A')}</span>
      </div>
    </div>
  `;
  
  
  // Add Close button only
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


// ---------------- Close Quotes Modal Function ----------------
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

// ---------------- Quotes Modal Event Listeners ----------------
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

// ---------------- Make functions globally accessible ----------------
window.closeQuotesModal = closeQuotesModal;
window.getQuotes = getQuotes;
window.selectSearchResult = selectSearchResult;

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

// ---------------- WebSocket ----------------
function connectWS() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => { connDot.className = "conn-dot live"; connLabel.textContent = "live"; };
  ws.onclose = () => {
    connDot.className = "conn-dot down"; connLabel.textContent = "reconnecting…";
    setTimeout(connectWS, 2000);
  };
  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === "status") {
      if (symbols[msg.instance_id]) {
        symbols[msg.instance_id].live_status = msg.status;
        renderBoard();
      }
    } else if (msg.type === "log") {
      const name = knownSymbolNames[msg.instance_id];
      appendLogLine({ ...msg.entry, id: msg.instance_id, symbol: name });
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
  connectWS();
  setInterval(loadSymbols, 15000);
})();