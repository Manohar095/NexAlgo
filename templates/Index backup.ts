<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CogniX Algo</title>
  <link rel="stylesheet" href="/static/style.css" />

  <style>
    /* ==========================================================================
       THEME DEFINITIONS & ANIMATED BACKGROUND
       ========================================================================== */
    :root, [data-theme="dark"] {
      --bg-base: #080c1a;
      --bg-card: rgba(18, 26, 45, 0.72);
      --border-color: rgba(255, 255, 255, 0.06);
      --border-glow: rgba(99, 102, 241, 0.35);
      --text-main: #f1f5f9;
      --text-muted: #94a3b8;
      --input-bg: rgba(15, 23, 42, 0.75);
      --input-border: #1e293b;
      --shadow-color: rgba(0, 0, 0, 0.4);

      --brand-gradient: linear-gradient(135deg, #00f2fe 0%, #4facfe 50%, #6366f1 100%);
      --btn-primary-grad: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      --table-header-grad: linear-gradient(180deg, rgba(30, 41, 59, 0.9) 0%, rgba(15, 23, 42, 0.9) 100%);
      --modal-grad: linear-gradient(160deg, rgba(18, 26, 45, 0.95) 0%, rgba(8, 12, 26, 0.98) 100%);
      --overlay-bg: rgba(3, 7, 18, 0.7);

      --orb-1: rgba(79, 70, 229, 0.18);
      --orb-2: rgba(139, 92, 246, 0.14);
      --orb-3: rgba(236, 72, 153, 0.10);
    }

    [data-theme="light"] {
      --bg-base: #f1f5f9;
      --bg-card: rgba(255, 255, 255, 0.78);
      --border-color: rgba(0, 0, 0, 0.06);
      --border-glow: rgba(79, 70, 229, 0.25);
      --text-main: #0f172a;
      --text-muted: #475569;
      --input-bg: #ffffff;
      --input-border: #cbd5e1;
      --shadow-color: rgba(0, 0, 0, 0.08);

      --brand-gradient: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
      --btn-primary-grad: linear-gradient(135deg, #4f46e5 0%, #2563eb 100%);
      --table-header-grad: linear-gradient(180deg, #f8fafc 0%, #e2e8f0 100%);
      --modal-grad: linear-gradient(160deg, #ffffff 0%, #f8fafc 100%);
      --overlay-bg: rgba(15, 23, 42, 0.3);

      --orb-1: rgba(79, 70, 229, 0.10);
      --orb-2: rgba(147, 51, 234, 0.06);
      --orb-3: rgba(236, 72, 153, 0.06);
    }

    /* ==========================================================================
       ANIMATIONS
       ========================================================================== */
    @keyframes ambientGlow {
      0%   { transform: translate(0,0) scale(1); }
      33%  { transform: translate(40px,-60px) scale(1.08); }
      66%  { transform: translate(-30px,30px) scale(0.95); }
      100% { transform: translate(0,0) scale(1); }
    }

    @keyframes shimmerSweep {
      0%   { left: -200%; }
      100% { left: 200%; }
    }

    @keyframes beaconPulse {
      0%   { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34,197,94,0.7); }
      70%  { transform: scale(1); box-shadow: 0 0 0 10px rgba(34,197,94,0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34,197,94,0); }
    }

    @keyframes modalPop {
      from { opacity: 0; transform: translateY(20px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* ==========================================================================
       BASE
       ========================================================================== */
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background-color: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      margin: 0;
      padding: 0;
      position: relative;
      overflow-x: hidden;
      transition: background-color 0.3s, color 0.3s;
    }

    body::before,
    body::after {
      content: "";
      position: fixed;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      filter: blur(110px);
      pointer-events: none;
      z-index: -1;
      animation: ambientGlow 18s infinite ease-in-out;
    }

    body::before {
      background: radial-gradient(circle, var(--orb-1) 0%, transparent 70%);
      top: -120px;
      left: -120px;
    }

    body::after {
      background: radial-gradient(circle, var(--orb-2) 0%, transparent 70%);
      bottom: -180px;
      right: -120px;
      animation-delay: -8s;
    }

    /* ==========================================================================
       TOPBAR
       ========================================================================== */
    .topbar {
      background: var(--bg-card);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border-bottom: 1px solid var(--border-color);
      box-shadow: 0 4px 30px var(--shadow-color);
      padding: 0.8rem 2rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      position: sticky;
      top: 0;
      z-index: 10;
      transition: background 0.3s, border-color 0.3s;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.8rem;
    }

    .brand-mark {
      font-size: 2.2rem;
      background: var(--brand-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      filter: drop-shadow(0 0 12px rgba(79,70,229,0.3));
      display: inline-block;
      line-height: 1;
    }

    .brand-title {
      font-size: 1.5rem;
      font-weight: 700;
      color: var(--text-main);
      letter-spacing: -0.02em;
      line-height: 1.2;
    }

    .brand-sub {
      font-size: 0.8rem;
      color: var(--text-muted);
      font-weight: 400;
      letter-spacing: 0.02em;
    }

    .topbar-actions {
      display: flex;
      align-items: center;
      gap: 0.8rem;
      flex-wrap: wrap;
    }

    /* ==========================================================================
       BUTTONS
       ========================================================================== */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 1rem;
      font-size: 0.85rem;
      font-weight: 500;
      border-radius: 0.6rem;
      border: 1px solid var(--border-color);
      background: transparent;
      color: var(--text-main);
      cursor: pointer;
      transition: all 0.2s ease;
      font-family: inherit;
      gap: 0.4rem;
      white-space: nowrap;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.06);
      border-color: var(--border-glow);
    }

    .btn-primary {
      background: var(--btn-primary-grad) !important;
      border: none !important;
      color: #fff !important;
      box-shadow: 0 4px 14px rgba(79, 70, 229, 0.3);
      position: relative;
      overflow: hidden;
    }

    .btn-primary::after {
      content: "";
      position: absolute;
      top: 0;
      left: -200%;
      width: 60%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
      transform: skewX(-20deg);
      transition: none;
    }

    .btn-primary:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(79, 70, 229, 0.5);
    }

    .btn-primary:hover::after {
      animation: shimmerSweep 1.4s ease-in-out infinite;
    }

    .btn-ghost {
      background: transparent;
      border: 1px solid transparent;
    }
    .btn-ghost:hover {
      background: rgba(255,255,255,0.05);
      border-color: var(--border-color);
    }

    .btn-secondary {
      background: var(--input-bg);
      border: 1px solid var(--border-color);
      color: var(--text-main);
    }
    .btn-secondary:hover {
      background: rgba(255,255,255,0.08);
    }

    .btn-full {
      width: 100%;
      justify-content: center;
    }

    .icon-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 1.2rem;
      padding: 0.2rem 0.5rem;
      cursor: pointer;
      transition: color 0.2s;
    }
    .icon-btn:hover {
      color: var(--text-main);
    }

    .theme-select {
      background: var(--input-bg);
      color: var(--text-main);
      border: 1px solid var(--input-border);
      border-radius: 0.5rem;
      padding: 0.4rem 0.8rem;
      font-size: 0.8rem;
      cursor: pointer;
      outline: none;
      transition: border-color 0.2s;
    }
    .theme-select:focus {
      border-color: #4f46e5;
    }

    .conn-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #22c55e;
      display: inline-block;
      animation: beaconPulse 2s infinite ease-in-out;
    }

    .conn-label {
      font-size: 0.8rem;
      color: var(--text-muted);
    }

    /* ==========================================================================
       BOARD TABLE
       ========================================================================== */
    .board {
      padding: 1.5rem 2rem;
      overflow-x: auto;
    }

    .board-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 0.9rem;
      border-radius: 0.8rem;
      overflow: hidden;
      box-shadow: 0 2px 20px var(--shadow-color);
      background: var(--bg-card);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid var(--border-color);
      transition: background 0.3s, border-color 0.3s;
    }

    .board-table thead th {
      background: var(--table-header-grad);
      color: var(--text-main);
      font-weight: 600;
      padding: 0.8rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border-color);
      letter-spacing: 0.03em;
      font-size: 0.75rem;
      text-transform: uppercase;
      white-space: nowrap;
    }

    .board-table tbody td {
      padding: 0.8rem 1rem;
      border-bottom: 1px solid var(--border-color);
      color: var(--text-main);
      transition: background 0.2s;
    }

    .board-table tbody tr {
      transition: background 0.15s ease;
    }

    .board-table tbody tr:hover {
      background: rgba(255,255,255,0.03);
    }

    .board-table tbody tr:last-child td {
      border-bottom: none;
    }

    .empty-row td {
      text-align: center;
      padding: 2.5rem 0;
      color: var(--text-muted);
      font-style: italic;
    }

    /* ==========================================================================
       LOGS PANEL
       ========================================================================== */
    .logs-panel {
      background: var(--bg-card);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid var(--border-color);
      border-radius: 0.8rem;
      margin: 0 2rem 2rem 2rem;
      padding: 1rem 1.5rem;
      transition: background 0.3s, border-color 0.3s;
      box-shadow: 0 2px 20px var(--shadow-color);
    }

    .logs-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.8rem;
      flex-wrap: wrap;
      gap: 0.8rem;
    }

    .logs-title {
      font-weight: 600;
      font-size: 1.1rem;
      color: var(--text-main);
    }

    .logs-header select {
      background: var(--input-bg);
      color: var(--text-main);
      border: 1px solid var(--input-border);
      border-radius: 0.4rem;
      padding: 0.3rem 0.8rem;
      font-size: 0.8rem;
      cursor: pointer;
      outline: none;
    }
    .logs-header select:focus {
      border-color: #4f46e5;
    }

    .log-stream {
      max-height: 200px;
      overflow-y: auto;
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-muted);
      background: rgba(0,0,0,0.2);
      border-radius: 0.4rem;
      padding: 0.5rem 0.8rem;
      line-height: 1.6;
      scroll-behavior: smooth;
    }

    .log-stream::-webkit-scrollbar {
      width: 5px;
    }
    .log-stream::-webkit-scrollbar-thumb {
      background: var(--border-glow);
      border-radius: 10px;
    }
    .log-stream::-webkit-scrollbar-track {
      background: transparent;
    }

    /* ==========================================================================
       MODALS (REVERTED TO DISPLAY: FLEX VIA .hidden COMPATIBILITY)
       ========================================================================== */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: var(--overlay-bg);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      z-index: 100;
      transition: opacity 0.3s, visibility 0.3s;
    }

    .modal {
      background: var(--modal-grad);
      color: var(--text-main);
      border: 1px solid var(--border-color);
      border-radius: 1rem;
      box-shadow: 0 30px 60px var(--shadow-color);
      max-width: 780px;
      width: 100%;
      max-height: 90vh;
      overflow-y: auto;
      padding: 1.8rem;
      animation: modalPop 0.35s cubic-bezier(0.16,1,0.3,1) forwards;
      transition: background 0.3s, border-color 0.3s;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.2rem;
    }

    .modal-header h2 {
      font-size: 1.5rem;
      font-weight: 700;
      background: var(--brand-gradient);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .modal-body {
      display: flex;
      flex-direction: column;
      gap: 1.2rem;
    }

    .modal-body fieldset {
      border: 1px solid var(--border-color);
      border-radius: 0.6rem;
      padding: 1rem 1.2rem;
      transition: border-color 0.2s;
    }
    .modal-body fieldset:hover {
      border-color: var(--border-glow);
    }

    .modal-body legend {
      font-weight: 600;
      font-size: 0.85rem;
      color: var(--text-muted);
      padding: 0 0.4rem;
    }

    .grid2 {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.8rem 1.2rem;
    }
    .grid3 {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 0.8rem 1.2rem;
    }

    .modal-body label {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
      font-size: 0.8rem;
      font-weight: 500;
      color: var(--text-muted);
    }

    .modal-body input,
    .modal-body select {
      background: var(--input-bg);
      color: var(--text-main);
      border: 1px solid var(--input-border);
      border-radius: 0.4rem;
      padding: 0.45rem 0.7rem;
      font-size: 0.9rem;
      font-family: inherit;
      transition: border-color 0.2s, box-shadow 0.2s;
      outline: none;
      width: 100%;
    }

    .modal-body input:focus,
    .modal-body select:focus {
      border-color: #4f46e5;
      box-shadow: 0 0 0 3px rgba(79,70,229,0.15);
    }

    .checkbox-row {
      flex-direction: row !important;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
    }
    .checkbox-row input[type="checkbox"] {
      width: auto;
      margin-right: 0.3rem;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 0.8rem;
      margin-top: 1rem;
      padding-top: 0.8rem;
      border-top: 1px solid var(--border-color);
    }

    .token-hint {
      font-size: 0.9rem;
      color: var(--text-muted);
      background: rgba(0,0,0,0.15);
      padding: 0.8rem 1rem;
      border-radius: 0.6rem;
      border-left: 3px solid var(--border-glow);
    }

    .token-status {
      font-size: 0.9rem;
      padding: 0.4rem 0.8rem;
      background: rgba(0,0,0,0.1);
      border-radius: 0.4rem;
      color: var(--text-muted);
    }

    .token-divider {
      display: flex;
      align-items: center;
      gap: 1rem;
      color: var(--text-muted);
      font-size: 0.8rem;
      margin: 0.8rem 0;
    }
    .token-divider::before,
    .token-divider::after {
      content: "";
      flex: 1;
      height: 1px;
      background: var(--border-color);
    }

    .hidden {
      display: none !important;
    }

    /* ==========================================================================
       RESPONSIVE
       ========================================================================== */
    @media (max-width: 768px) {
      .topbar {
        flex-direction: column;
        align-items: stretch;
        padding: 0.8rem 1rem;
      }
      .topbar-actions {
        justify-content: flex-start;
        flex-wrap: wrap;
      }
      .brand-title {
        font-size: 1.2rem;
      }
      .board {
        padding: 0.8rem 1rem;
      }
      .logs-panel {
        margin: 0 1rem 1rem 1rem;
        padding: 0.8rem 1rem;
      }
      .modal {
        padding: 1.2rem;
        max-width: 95%;
      }
      .grid2, .grid3 {
        grid-template-columns: 1fr;
      }
      .board-table {
        font-size: 0.75rem;
      }
      .board-table thead th,
      .board-table tbody td {
        padding: 0.5rem 0.6rem;
      }
    }

    @media (max-width: 480px) {
      .topbar-actions .btn {
        font-size: 0.75rem;
        padding: 0.3rem 0.6rem;
      }
      .brand-mark {
        font-size: 1.8rem;
      }
    }
  </style>
</head>
<body>

  <div id="app">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">◈</span>
        <div class="brand-text">
          <h1 class="brand-title">CogniX Algo</h1>
          <p class="brand-sub">Control the Risk – Compound the Edge</p>
        </div>
      </div>
      <div class="topbar-actions">
        <select id="themeSelect" class="theme-select" title="Switch UI Theme">
          <option value="dark">🌙 Dark</option>
          <option value="light">☀️ Light</option>
        </select>

        <span id="connDot" class="conn-dot" title="Live feed"></span>
        <span id="connLabel" class="conn-label">connecting…</span>
        <button id="btnBrokerToken" class="btn">🔑 Access Token</button>
        <button id="btnAddSymbol" class="btn btn-primary">+ Add Symbol</button>
        <button id="btnLogout" class="btn btn-ghost" title="Sign out">⎋ Logout</button>
      </div>
    </header>

    <main class="board">
      <table class="board-table">
        <thead>
          <tr>
            <th>Symbol</th><th>LTP</th><th>Brick</th><th>Trend</th>
            <th>Position</th><th>Entry</th><th>Stop Loss</th>
            <th>Qty</th><th>Mode</th><th>Status</th>
            <th>Updated</th><th></th>
          </tr>
        </thead>
        <tbody id="boardBody">
          <tr class="empty-row"><td colspan="12">No symbols yet. Click “+ Add Symbol” to configure your first Renko strategy.</td></tr>
        </tbody>
      </table>
    </main>

    <section class="logs-panel">
      <div class="logs-header">
        <div class="logs-title">Global Log</div>
        <select id="logFilter">
          <option value="__all__">All symbols</option>
        </select>
      </div>
      <div id="logStream" class="log-stream"></div>
    </section>
  </div>

  <!-- Symbol Modal (Restored class="modal-overlay hidden") -->
  <div id="modalOverlay" class="modal-overlay hidden">
    <div class="modal">
      <div class="modal-header">
        <h2 id="modalTitle">New Symbol</h2>
        <button id="modalClose" class="icon-btn">✕</button>
      </div>
      <form id="symbolForm" class="modal-body">
        <input type="hidden" id="symbolId" />

        <fieldset>
          <legend>General</legend>
          <div class="grid2">
            <label>Strategy Name <input required id="strategy_name" placeholder="SENSEX CE" /></label>
            <label>Exchange <input required id="exchange" placeholder="BFO" /></label>
            <label>Trading Symbol <input required id="trading_symbol" placeholder="SENSEX2670276500PE" /></label>
            <label>Token <input required id="token" placeholder="820767" /></label>
            <label>Quantity <input required type="number" min="1" id="quantity" value="20" /></label>
            <label>Product Type
              <select id="product_type">
                <option value="I">Intraday (I)</option>
                <option value="C">CNC (C)</option>
                <option value="M">Margin (M)</option>
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Renko Settings</legend>
          <div class="grid3">
            <label>Brick Size <input required type="number" step="any" id="brick_size" value="4" /></label>
            <label>Green→Red Rev <input required type="number" id="green_to_red_rev" value="2" /></label>
            <label>Red→Green Rev <input required type="number" id="red_to_green_rev" value="2" /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Entry Settings</legend>
          <div class="grid3">
            <label>Buy Brick # <input required type="number" id="buy_brick_no" value="1" /></label>
            <label>Sell Brick # <input required type="number" id="sell_brick_no" value="-1" /></label>
            <label>Tick Size <input required type="number" step="0.01" id="tick_size" value="0.05" /></label>
            <label>Buy Limit Offset (bricks) <input required type="number" id="limit_price_buy_brick_no" value="3" /></label>
            <label>Sell Limit Offset (bricks) <input required type="number" id="limit_price_sell_brick_no" value="3" /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Stop Loss &amp; Entry Trailing</legend>
          <div class="grid3">
            <label>SL_Trail_Brick_Number <input required type="number" step="0.5" id="sl_trail_brick_number" value="2" /></label>
            <label>Entry_Trail_Brick_Number <input required type="number" step="0.5" id="entry_trail_brick_number" value="2" /></label>
            <label>Limit_Offset <input type="number" step="0.01" id="limit_offset" placeholder="defaults to tick size" /></label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Trading</legend>
          <div class="grid3">
            <label>Trade Mode
              <select id="trade_mode">
                <option value="LONG_ONLY">Long Only</option>
                <option value="SHORT_ONLY">Short Only</option>
                <option value="LONG_SHORT">Long &amp; Short</option>
              </select>
            </label>
            <label>Squareoff Hour (IST) <input required type="number" min="0" max="23" id="squareoff_hour" value="15" /></label>
            <label>Squareoff Minute <input required type="number" min="0" max="59" id="squareoff_minute" value="15" /></label>
            <label>SL-LMT Buffer <input required type="number" step="0.01" id="sl_lmt_buffer" value="0.10" /></label>
            <label class="checkbox-row"><input type="checkbox" id="autostart" /> Auto-start with platform</label>
          </div>
        </fieldset>

        <div class="modal-footer">
          <button type="button" id="btnCancel" class="btn btn-ghost">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Symbol</button>
        </div>
      </form>
    </div>
  </div>

  <!-- Broker Token Modal (Restored class="modal-overlay hidden") -->
  <div id="brokerModalOverlay" class="modal-overlay hidden">
    <div class="modal" style="max-width: 480px;">
      <div class="modal-header">
        <h2>Broker Access Token</h2>
        <button id="brokerModalClose" class="icon-btn">✕</button>
      </div>
      <div class="modal-body">
        <p class="token-hint">
          User ID and password live in <code>.env</code> and don't change.
          The access token is regenerated every trading day and is shared
          by every symbol — generate a fresh one below, or paste one
          manually if you already have it.
        </p>
        <div id="brokerTokenStatus" class="token-status">Loading…</div>

        <button type="button" id="btnGenerateToken" class="btn btn-primary btn-full">
          ⚡ Generate Access Token
        </button>
        <button type="button" id="btnCloseAfterGenerate" class="btn btn-secondary btn-full hidden">
          Close
        </button>

        <div class="token-divider"><span>or paste manually</span></div>

        <form id="brokerTokenForm">
          <label>New Access Token
            <input id="newAccessToken" type="password" autocomplete="off" placeholder="Paste today's token" />
          </label>
          <div class="modal-footer">
            <button type="button" id="brokerModalCancel" class="btn btn-ghost">Cancel</button>
            <button type="submit" class="btn btn-primary">Save & Apply</button>
          </div>
        </form>
      </div>
    </div>
  </div>

  <script>
    const themeSelect = document.getElementById('themeSelect');
    const savedTheme = localStorage.getItem('cognix_theme') || 'dark';
    const activeTheme = (savedTheme === 'light') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', activeTheme);
    themeSelect.value = activeTheme;

    themeSelect.addEventListener('change', (e) => {
      const selected = e.target.value;
      document.documentElement.setAttribute('data-theme', selected);
      localStorage.setItem('cognix_theme', selected);
    });
  </script>

  <script src="/static/app.js"></script>

</body>
</html>