export type TradeMode = 'LONG_ONLY' | 'SHORT_ONLY' | 'LONG_SHORT'
export type BrickMethod = 'fixed' | 'atr' | 'ltp_pct'

/** Editable per-symbol settings (mirrors strategy_hub.service.CONFIG_FIELDS). */
export interface SymbolSettings {
  product: string
  quantity: number
  brick_method: BrickMethod
  brick_size: number
  atr_period: number
  atr_multiplier: number
  ltp_percent: number
  g2r: number
  r2g: number
  buy_brick_no: number
  sell_brick_no: number
  limit_buy_brick_no: number
  limit_sell_brick_no: number
  entry_trail_bricks: number
  sl_trail_bricks: number
  tick_size: number
  limit_offset: number
  sl_lmt_buffer: number
  trade_mode: TradeMode
  max_position_per_side: number
  squareoff_time: string
}

export interface SymbolStatus {
  symbol_id: number
  updated_at: number | null
  pid: number | null
  state: 'RUNNING' | 'HALTED' | 'STOPPED' | 'ERROR' | null
  message: string | null
  ltp: number | null
  brick_color: 'Green' | 'Red' | null
  brick_no: number | null
  long_qty: number | null
  short_qty: number | null
  buy_pending: number | null
  sell_pending: number | null
  sl_long: number | null
  sl_short: number | null
  trades_blocked: number | null
}

export interface AlgoSymbolRow extends SymbolSettings {
  id: number
  strategy_id: string
  symbol: string
  exchange: string
  enabled: boolean
  version: number
  tag_base: string
  lot_size: number | null
  status: SymbolStatus | null
  /** enabled, but the strategy process is not publishing fresh status */
  stale: boolean
}

export interface ProcessInfo {
  exchange: string
  strategy_id: string
  registered: boolean
  is_running: boolean
  manually_stopped: boolean
  schedule_start: string
  schedule_stop: string
  status: string
  status_message: string
  symbols: number
  enabled: number
}

export interface Overview {
  status: 'success' | 'error'
  /** true = Analyzer (sandbox), false = LIVE, null = could not be determined */
  analyze_mode: boolean | null
  processes: ProcessInfo[]
  symbols: AlgoSymbolRow[]
}

export interface SymbolSearchResult {
  symbol: string
  exchange: string
  name: string | null
  expiry: string | null
  lotsize: number | null
  tick_size: number | null
  instrumenttype: string | null
  strike: number | null
}

export interface ApiResult<T = unknown> {
  status: 'success' | 'error'
  message?: string
  warning?: boolean
  errors?: string[]
  data?: T
  process_state?: string
}

export interface DefaultsResult extends ApiResult<SymbolSettings> {
  schedule_stop: string
}
