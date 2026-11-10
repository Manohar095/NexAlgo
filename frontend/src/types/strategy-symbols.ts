export type TradeMode = 'LONG_ONLY' | 'SHORT_ONLY' | 'LONG_SHORT'
export type BrickMethod = 'fixed' | 'atr' | 'ltp_pct'

/** Editable per-symbol settings (mirrors strategy_symbols.service.CONFIG_FIELDS). */
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

export interface StrategySymbolRow extends SymbolSettings {
  id: number
  strategy_id: string
  symbol: string
  exchange: string
  enabled: boolean
  version: number
  tag_base: string
  lot_size: number | null
  status: SymbolStatus | null
  /** enabled but no fresh status: the strategy process is not publishing */
  stale: boolean
}

export interface StrategyInfo {
  id: string
  name: string
  exchange: string | null
  is_running: boolean
  schedule_start: string | null
  schedule_stop: string | null
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
  errors?: string[]
  data?: T
}

export interface ListResult extends ApiResult<StrategySymbolRow[]> {
  strategy: StrategyInfo
}
