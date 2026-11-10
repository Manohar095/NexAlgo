import { Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { showToast } from '@/utils/toast'
import { algoApi, apiErrorMessage } from './api'
import type { AlgoSymbolRow, BrickMethod, SymbolSearchResult, SymbolSettings } from './types'

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NCO']

type FormState = Record<keyof SymbolSettings, string> & { symbol: string; exchange: string }

const METHOD_LABELS: Record<string, string> = {
  fixed: 'Fixed size',
  atr: 'ATR',
  ltp_pct: 'LTP %',
}

interface FieldDef {
  key: keyof SymbolSettings
  label: string
  kind: 'number' | 'select' | 'time'
  step?: string
  options?: string[]
  labels?: Record<string, string>
  hint?: string
  /** for select: drop the "covers only some methods" pattern — hide per chosen method */
  method?: BrickMethod | BrickMethod[]
}

const FIELD_GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Order',
    fields: [
      { key: 'product', label: 'Product', kind: 'select', options: ['MIS', 'NRML', 'CNC'] },
      { key: 'quantity', label: 'Quantity', kind: 'number', hint: 'Multiple of the lot size' },
      {
        key: 'trade_mode',
        label: 'Trade mode',
        kind: 'select',
        options: ['LONG_ONLY', 'SHORT_ONLY', 'LONG_SHORT'],
      },
      {
        key: 'max_position_per_side',
        label: 'Max position / side',
        kind: 'number',
        hint: '0 = quantity (no scale-in)',
      },
    ],
  },
  {
    title: 'Renko',
    fields: [
      { key: 'brick_method', label: 'Brick method', kind: 'select', options: ['fixed', 'atr', 'ltp_pct'], labels: METHOD_LABELS },
      {
        key: 'brick_size',
        label: 'Brick size',
        kind: 'number',
        step: 'any',
        method: ['fixed', 'atr'],
      },
      { key: 'atr_period', label: 'ATR period', kind: 'number', method: 'atr' },
      { key: 'atr_multiplier', label: 'ATR multiplier', kind: 'number', step: '0.1', method: 'atr' },
      {
        key: 'ltp_percent',
        label: 'LTP %',
        kind: 'number',
        step: 'any',
        hint: 'Brick = % of the price band',
        method: 'ltp_pct',
      },
      { key: 'g2r', label: 'Green → Red reversal', kind: 'number' },
      { key: 'r2g', label: 'Red → Green reversal', kind: 'number' },
    ],
  },
  {
    title: 'Entries and trailing',
    fields: [
      { key: 'buy_brick_no', label: 'BUY brick no', kind: 'number', hint: 'Green brick, >= 0' },
      { key: 'limit_buy_brick_no', label: 'BUY limit = brick + N bricks', kind: 'number' },
      { key: 'sell_brick_no', label: 'SELL brick no', kind: 'number', hint: 'Red brick, <= 0' },
      { key: 'limit_sell_brick_no', label: 'SELL limit = brick − N bricks', kind: 'number' },
      { key: 'entry_trail_bricks', label: 'Entry trail (bricks)', kind: 'number' },
      { key: 'sl_trail_bricks', label: 'SL trail (bricks)', kind: 'number' },
    ],
  },
  {
    title: 'Prices and squareoff',
    fields: [
      { key: 'tick_size', label: 'Tick size', kind: 'number', step: 'any' },
      { key: 'limit_offset', label: 'SL trigger/limit offset', kind: 'number', step: 'any' },
      { key: 'sl_lmt_buffer', label: 'Squareoff limit buffer', kind: 'number', step: 'any' },
      { key: 'squareoff_time', label: 'Squareoff time (IST)', kind: 'time' },
    ],
  },
]

const SETTING_KEYS = FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.key))

const emptyForm = (): FormState => ({
  symbol: '',
  exchange: 'NFO',
  product: 'MIS',
  quantity: '1',
  brick_method: 'fixed',
  brick_size: '1',
  atr_period: '14',
  atr_multiplier: '1',
  ltp_percent: '0.25',
  g2r: '2',
  r2g: '2',
  buy_brick_no: '1',
  sell_brick_no: '-1',
  limit_buy_brick_no: '1',
  limit_sell_brick_no: '1',
  entry_trail_bricks: '2',
  sl_trail_bricks: '2',
  tick_size: '0.05',
  limit_offset: '0.05',
  sl_lmt_buffer: '0.05',
  trade_mode: 'LONG_ONLY',
  max_position_per_side: '0',
  squareoff_time: '15:15',
})

const settingsToForm = (s: SymbolSettings): Partial<FormState> =>
  Object.fromEntries(SETTING_KEYS.map((k) => [k, String(s[k])])) as Partial<FormState>

const formToSettings = (f: FormState): SymbolSettings => {
  const out: Record<string, string | number> = {}
  for (const g of FIELD_GROUPS) {
    for (const fd of g.fields) {
      out[fd.key] = fd.kind === 'number' ? Number(f[fd.key]) : f[fd.key]
    }
  }
  return out as unknown as SymbolSettings
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '-' : String(n))

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** edit mode: the row being edited (symbol and exchange are fixed) */
  editing: AlgoSymbolRow | null
  /** add mode: copy these settings, then pick a new symbol */
  cloneFrom: AlgoSymbolRow | null
  /** add mode: preselect this symbol (e.g. the one on the focused chart) */
  prefill: { symbol: string; exchange: string } | null
  /** current schedule stop per exchange, for the squareoff hint */
  scheduleStops: Record<string, string>
  onSaved: () => void
}

export function SymbolSettingsDialog({
  open,
  onOpenChange,
  editing,
  cloneFrom,
  prefill,
  scheduleStops,
  onSaved,
}: Props) {
  const [form, setForm] = useState<FormState>(emptyForm())
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SymbolSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [stopHint, setStopHint] = useState<string | null>(null)
  const searchSeq = useRef(0)
  const autoPicked = useRef(false)

  // Reset whenever the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-initialise only when it opens or its target changes
  useEffect(() => {
    if (!open) return
    autoPicked.current = false
    setFormError(null)
    setResults([])
    setStopHint(null)
    if (editing) {
      setForm({ ...emptyForm(), ...settingsToForm(editing), symbol: editing.symbol, exchange: editing.exchange })
      setStopHint(scheduleStops[editing.exchange] ?? null)
      setQuery('')
    } else if (cloneFrom) {
      setForm({ ...emptyForm(), ...settingsToForm(cloneFrom), symbol: '', exchange: cloneFrom.exchange })
      setStopHint(scheduleStops[cloneFrom.exchange] ?? null)
      setQuery('')
    } else if (prefill) {
      setForm({ ...emptyForm(), exchange: prefill.exchange || 'NFO' })
      setQuery(prefill.symbol)
    } else {
      setForm(emptyForm())
      setQuery('')
    }
  }, [open, editing, cloneFrom, prefill])

  const pickSymbol = async (r: SymbolSearchResult) => {
    try {
      const d = await algoApi.defaults(r.exchange)
      const defaults = d.data as SymbolSettings
      const tick = r.tick_size ?? defaults.tick_size
      setStopHint(d.schedule_stop)
      setForm((prev) => ({
        ...prev,
        // fresh add: exchange defaults + the contract's lot size; clone: keep the cloned settings
        ...(cloneFrom ? {} : { ...settingsToForm(defaults), quantity: String(r.lotsize ?? defaults.quantity) }),
        symbol: r.symbol,
        exchange: r.exchange,
        tick_size: String(tick),
        limit_offset: String(tick),
        sl_lmt_buffer: String(tick),
      }))
      setQuery('')
      setResults([])
    } catch (error) {
      showToast.error(apiErrorMessage(error, 'Could not load defaults'), 'pythonStrategy')
    }
  }

  // Debounced symbol search (add mode only)
  // biome-ignore lint/correctness/useExhaustiveDependencies: pickSymbol is stable enough; re-running on it would loop
  useEffect(() => {
    if (!open || editing || query.trim().length < 2) {
      setResults([])
      return
    }
    const seq = ++searchSeq.current
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await algoApi.search(query.trim(), form.exchange)
        if (seq !== searchSeq.current) return
        setResults(r)
        // The chart's own symbol: pick it straight away when it is an exact match.
        if (prefill && !autoPicked.current && !form.symbol) {
          const exact = r.find((x) => x.symbol === prefill.symbol && x.exchange === prefill.exchange)
          if (exact) {
            autoPicked.current = true
            void pickSymbol(exact)
          }
        }
      } catch {
        if (seq === searchSeq.current) setResults([])
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query, form.exchange, open, editing, prefill, form.symbol])

  const submit = async () => {
    setFormError(null)
    if (!editing && !form.symbol) {
      setFormError('Search and pick a symbol first')
      return
    }
    setSaving(true)
    try {
      const settings = formToSettings(form)
      const res = editing
        ? await algoApi.update(editing.id, settings)
        : await algoApi.create({ ...settings, symbol: form.symbol, exchange: form.exchange })
      if (res.status === 'success') {
        showToast.success(res.message || 'Saved', 'pythonStrategy')
        onOpenChange(false)
        onSaved()
      } else {
        setFormError(res.message || 'Save failed')
      }
    } catch (error) {
      setFormError(apiErrorMessage(error, 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  /** fields visible for the currently chosen brick method */
  const visibleFields = (fs: readonly FieldDef[]) => {
    const m = form.brick_method || 'fixed'
    return fs.filter((f) =>
      f.method === undefined ? true : Array.isArray(f.method) ? f.method.includes(m as never) : f.method === m,
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.symbol}` : 'Add symbol for trade'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Settings apply the next time this symbol is enabled.'
              : 'Search the symbol master, then set this symbol’s own configuration.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          <div className="space-y-2">
            <Label>Symbol</Label>
            {editing ? (
              <div className="font-mono text-sm">
                {editing.exchange}:{editing.symbol}
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <select
                    aria-label="Exchange"
                    className="h-9 rounded-md border bg-background px-2 text-sm"
                    value={form.exchange}
                    onChange={(e) => setForm({ ...form, exchange: e.target.value })}
                  >
                    {EXCHANGES.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                  <div className="relative flex-1">
                    <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                    <Input
                      className="pl-8"
                      placeholder="Search e.g. SENSEX 72600 CE or CRUDEOILM FUT"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                </div>
                {form.symbol && (
                  <div className="text-sm">
                    Selected:{' '}
                    <span className="font-mono font-medium">
                      {form.exchange}:{form.symbol}
                    </span>
                  </div>
                )}
                {(searching || results.length > 0) && (
                  <div className="border rounded-md max-h-48 overflow-y-auto divide-y">
                    {searching && <div className="p-2 text-sm text-muted-foreground">Searching…</div>}
                    {results.map((r) => (
                      <button
                        type="button"
                        key={`${r.exchange}:${r.symbol}`}
                        className="w-full text-left p-2 text-sm hover:bg-muted/50"
                        onClick={() => pickSymbol(r)}
                      >
                        <span className="font-mono">{r.symbol}</span>
                        <span className="text-xs text-muted-foreground ml-2">
                          {r.exchange} · lot {fmt(r.lotsize)} · tick {fmt(r.tick_size)}
                          {r.expiry ? ` · exp ${r.expiry}` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {FIELD_GROUPS.map((g) => (
            <div key={g.title} className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {g.title}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3">
                {visibleFields(g.fields).map((f) => (
                  <div key={f.key} className="space-y-1">
                    <Label htmlFor={`algo-f-${f.key}`} className="text-xs">
                      {f.label}
                    </Label>
                    {f.kind === 'select' ? (
                      <select
                        id={`algo-f-${f.key}`}
                        className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                        value={form[f.key]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      >
                        {f.options?.map((o) => (
                          <option key={o} value={o}>
                            {f.labels?.[o] ?? o}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Input
                        id={`algo-f-${f.key}`}
                        type={f.kind === 'time' ? 'time' : 'number'}
                        step={f.kind === 'number' ? (f.step ?? '1') : undefined}
                        value={form[f.key]}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      />
                    )}
                    {f.hint && <p className="text-[11px] text-muted-foreground">{f.hint}</p>}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {stopHint && (
            <p className="text-xs text-muted-foreground">
              Squareoff must be earlier than this exchange’s strategy schedule stop ({stopHint} IST).
            </p>
          )}
          {formError && <p className="text-sm text-red-600">{formError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : editing ? 'Save settings' : 'Add symbol'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
