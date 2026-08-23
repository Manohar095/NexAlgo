// ---------------------------------------------------------------------
// CogniX Algo — dashboard client
// ---------------------------------------------------------------------

const boardBody   = document.getElementById("boardBody");
const logStream   = document.getElementById("logStream");
const logFilter   = document.getElementById("logFilter");
const connDot     = document.getElementById("connDot");
const connLabel   = document.getElementById("connLabel");

const modalOverlay = document.getElementById("modalOverlay");
const modalTitle   = document.getElementById("modalTitle");
const symbolForm   = document.getElementById("symbolForm");

let symbols = {};      // id -> record (config + live_status)
let knownSymbolNames = {}; // id -> strategy_name (for log filter dropdown)

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

async function loadSymbols() {
  const records = await api("/api/symbols");
  symbols = {};
  records.forEach(r => { symbols[r.id] = r; knownSymbolNames[r.id] = r.config.strategy_name; });
  renderBoard();
  renderLogFilterOptions();
}

// ---------------- Board rendering ----------------
function renderBoard() {
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
        <span class="sym-sub">${escapeHTML(cfg.exchange)}:${escapeHTML(cfg.trading_symbol)}</span>
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
document.getElementById("btnAddSymbol").addEventListener("click", () => openCreateModal());
document.getElementById("btnCancel").addEventListener("click", closeModal);
document.getElementById("modalClose").addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => { if (e.target === modalOverlay) closeModal(); });

function openCreateModal() {
  modalTitle.textContent = "New Symbol";
  symbolForm.reset();
  document.getElementById("symbolId").value = "";
  modalOverlay.classList.remove("hidden");
}

function openEditModal(id) {
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

function closeModal() { modalOverlay.classList.add("hidden"); }

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

// ---------------- Broker access token (daily, shared) ----------------
const brokerModalOverlay = document.getElementById("brokerModalOverlay");
const brokerTokenForm    = document.getElementById("brokerTokenForm");
const brokerTokenStatus  = document.getElementById("brokerTokenStatus");
const newAccessTokenEl   = document.getElementById("newAccessToken");

document.getElementById("btnBrokerToken").addEventListener("click", openBrokerModal);
document.getElementById("brokerModalCancel").addEventListener("click", closeBrokerModal);
document.getElementById("brokerModalClose").addEventListener("click", closeBrokerModal);
brokerModalOverlay.addEventListener("click", (e) => { if (e.target === brokerModalOverlay) closeBrokerModal(); });

const btnGenerateToken = document.getElementById("btnGenerateToken");
const btnCloseAfterGenerate = document.getElementById("btnCloseAfterGenerate");

btnGenerateToken.addEventListener("click", async () => {
  const originalLabel = btnGenerateToken.textContent;
  btnGenerateToken.disabled = true;
  btnGenerateToken.textContent = "⏳ Generating…";
  brokerTokenStatus.textContent = "Logging in and generating a fresh access token — this takes a few seconds…";
  brokerTokenStatus.className = "token-status";
  btnCloseAfterGenerate.classList.add("hidden");

  try {
    const s = await api("/api/broker/generate-token", { method: "POST" });
    renderBrokerStatus(s);
    brokerTokenStatus.innerHTML = `✅ ${escapeHTML(s.message || "Token generated and applied.")}<br/>` + brokerTokenStatus.innerHTML;
    brokerTokenStatus.className = "token-status ok";
    if (s.access_token) {
      newAccessTokenEl.value = s.access_token;
    }
    btnCloseAfterGenerate.classList.remove("hidden");
  } catch (err) {
    brokerTokenStatus.textContent = `❌ ${err.message}`;
    brokerTokenStatus.className = "token-status warn";
  } finally {
    btnGenerateToken.disabled = false;
    btnGenerateToken.textContent = originalLabel;
  }
});

btnCloseAfterGenerate.addEventListener("click", closeBrokerModal);

async function openBrokerModal() {
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

function closeBrokerModal() { brokerModalOverlay.classList.add("hidden"); }

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

// ---------------- Logs ----------------
function renderLogFilterOptions() {
  const current = logFilter.value;
  const opts = [`<option value="__all__">All symbols</option>`];
  Object.entries(knownSymbolNames).forEach(([id, name]) => {
    opts.push(`<option value="${id}">${escapeHTML(name)}</option>`);
  });
  logFilter.innerHTML = opts.join("");
  logFilter.value = [...logFilter.options].some(o => o.value === current) ? current : "__all__";
}

async function loadInitialLogs() {
  try {
    const logs = await api("/api/logs?limit=200");
    logs.forEach(appendLogLine);
    logStream.scrollTop = logStream.scrollHeight;
  } catch (e) { /* ignore */ }
}

function appendLogLine(entry) {
  const filterVal = logFilter.value;
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

logFilter.addEventListener("change", () => {
  logStream.innerHTML = "";
  loadInitialLogs();
});

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
document.getElementById("btnLogout").addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
});

(async function init() {
  try {
    const authStatus = await fetch("/api/auth/status").then(r => r.json());
    if (!authStatus.auth_enabled) {
      document.getElementById("btnLogout").classList.add("hidden");
    }
  } catch (e) { /* ignore — leave logout button visible */ }

  await loadSymbols();
  await loadInitialLogs();
  connectWS();
  setInterval(loadSymbols, 15000); // periodic full refresh as a safety net
})();