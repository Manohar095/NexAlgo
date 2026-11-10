import { ArrowLeft, Pencil, Play, Plus, RefreshCw, Search, Square, Trash2, Zap } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { apiErrorMessage, strategySymbolsApi } from '@/api/strategy-symbols'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type {
  BrickMethod,
  StrategyInfo,
  StrategySymbolRow,
  SymbolSearchResult,
  SymbolSettings,
} from '@/types/strategy-symbols'
import { showToast } from '@/utils/toast'

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD', 'NCO']
const POLL_MS = 3000

type FormState = Record<keyof SymbolSettings, string> & { symbol: string; exchange: string }

interface FieldDef {
  key: keyof SymbolSettings
  label: string
  kind: 'number' | 'select' | 'time'
  step?: string
  options?: string[]
  labels?: Record<string, string>
  hint?: string
  /** only visible while this brick method (or one of them) is chosen */
  method?: BrickMethod | BrickMethod[]
}

const METHOD_LABELS: Record<string, string> = {
  fixed: 'Fixed size',
  atr: 'ATR',
  ltp_pct: 'LTP %',
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
      { key: 'brick_size', label: 'Brick size', kind: 'number', step: 'any', method: ['fixed', 'atr'] },
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

interface ConfirmState {
  title: string
  description: string
  action: string
  destructive?: boolean
  run: () => Promise<void>
}

export default function StrategySymbols() {
  const { strategyId = '' } = useParams<{ strategyId: string }>()
  const [rows, setRows] = useState<StrategySymbolRow[]>([])
  const [strategy, setStrategy] = useState<StrategyInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<number | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<StrategySymbolRow | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SymbolSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)
  // true when the form was opened via "clone": keep the cloned settings when a symbol is picked
  const [keepSettings, setKeepSettings] = useState(false)

  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const load = useCallback(
    async (silent = false) => {
      try {
        const res = await strategySymbolsApi.list(strategyId)
        setRows(res.data ?? [])
        setStrategy(res.strategy)
      } catch (error) {
        if (!silent) showToast.error(apiErrorMessage(error, 'Failed to load symbols'), 'pythonStrategy')
      } finally {
        setLoading(false)
      }
    },
    [strategyId]
  )

  useEffect(() => {
    load()
    const t = setInterval(() => load(true), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  // Debounced symbol search (add mode only)
  useEffect(() => {
    if (!formOpen || editing || query.trim().length < 2) {
      setResults([])
      return
    }
    const seq = ++searchSeq.current
    const t = setTimeout(async () => {
      setSearching(true)
      try {
        const r = await strategySymbolsApi.search(query.trim(), form.exchange)
        if (seq === searchSeq.current) setResults(r)
      } catch {
        if (seq === searchSeq.current) setResults([])
      } finally {
        if (seq === searchSeq.current) setSearching(false)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [query, form.exchange, formOpen, editing])

  const openAdd = () => {
    setKeepSettings(false)
    setEditing(null)
    setForm(emptyForm())
    setQuery('')
    setResults([])
    setFormError(null)
    setFormOpen(true)
  }

  const openEdit = (row: StrategySymbolRow) => {
    setKeepSettings(false)
    setEditing(row)
    setForm({
      ...emptyForm(),
      ...settingsToForm(row),
      symbol: row.symbol,
      exchange: row.exchange,
    })
    setFormError(null)
    setFormOpen(true)
  }

  const openClone = (row: StrategySymbolRow) => {
    setKeepSettings(true)
    setEditing(null)
    setForm({ ...emptyForm(), ...settingsToForm(row), symbol: '', exchange: row.exchange })
    setQuery('')
    setResults([])
    setFormError(null)
    setFormOpen(true)
  }

  const pickSymbol = async (r: SymbolSearchResult) => {
    try {
      const d = await strategySymbolsApi.defaults(r.exchange)
      const tick = r.tick_size ?? d.tick_size
      setForm((prev) => ({
        ...prev,
        // fresh add: start from the exchange defaults and the contract's lot size;
        // clone: keep the cloned settings and only refresh the contract-specific fields
        ...(keepSettings
          ? {}
          : { ...settingsToForm(d), quantity: String(r.lotsize ?? d.quantity) }),
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
        ? await strategySymbolsApi.update(strategyId, editing.id, settings)
        : await strategySymbolsApi.create(strategyId, {
            ...settings,
            symbol: form.symbol,
            exchange: form.exchange,
          })
      if (res.status === 'success') {
        showToast.success(res.message || 'Saved', 'pythonStrategy')
        setFormOpen(false)
        load(true)
      } else {
        setFormError(res.message || 'Save failed')
      }
    } catch (error) {
      setFormError(apiErrorMessage(error, 'Save failed'))
    } finally {
      setSaving(false)
    }
  }

  const act = async (row: StrategySymbolRow, fn: () => Promise<{ status: string; message?: string }>) => {
    setBusyId(row.id)
    try {
      const res = await fn()
      if (res.status === 'success') showToast.success(res.message || 'Done', 'pythonStrategy')
      else showToast.error(res.message || 'Failed', 'pythonStrategy')
    } catch (error) {
      showToast.error(apiErrorMessage(error, 'Request failed'), 'pythonStrategy')
    } finally {
      setBusyId(null)
      load(true)
    }
  }

  const toggle = (row: StrategySymbolRow) => {
    const doIt = () => act(row, () => strategySymbolsApi.setEnabled(strategyId, row.id, !row.enabled))
    if (row.enabled && ((row.status?.long_qty ?? 0) > 0 || (row.status?.short_qty ?? 0) > 0)) {
      setConfirm({
        title: `Disable ${row.symbol}?`,
        description:
          'This symbol has an open position. Disabling stops the bot but leaves the position and its stop-loss orders live at the broker. Use Squareoff first if you want to flatten.',
        action: 'Disable anyway',
        run: doIt,
      })
    } else {
      doIt()
    }
  }

  const squareoff = (row: StrategySymbolRow) =>
    setConfirm({
      title: `Square off ${row.symbol}?`,
      description:
        'Cancels all pending entries and stop-loss orders for this symbol and closes the position. Trading for this symbol stays halted until you disable and re-enable it.',
      action: 'Square off',
      destructive: true,
      run: () => act(row, () => strategySymbolsApi.command(strategyId, row.id, 'SQUAREOFF')),
    })

  const remove = (row: StrategySymbolRow) =>
    setConfirm({
      title: `Remove ${row.symbol}?`,
      description: 'Deletes this symbol and its settings from the strategy.',
      action: 'Remove',
      destructive: true,
      run: () => act(row, () => strategySymbolsApi.remove(strategyId, row.id)),
    })

  const statusBadge = (row: StrategySymbolRow) => {
    if (!row.enabled) return <Badge variant="secondary">Disabled</Badge>
    if (row.stale) {
      return (
        <Badge variant="outline" className="border-orange-500 text-orange-600">
          Waiting for strategy
        </Badge>
      )
    }
    const s = row.status?.state
    if (s === 'RUNNING') return <Badge className="bg-green-600">Running</Badge>
    if (s === 'HALTED') return <Badge className="bg-amber-500">Halted</Badge>
    if (s === 'ERROR') return <Badge variant="destructive">Error</Badge>
    return <Badge variant="secondary">{s ?? 'Starting'}</Badge>
  }

  if (loading) {
    return (
      <div className="container mx-auto py-6 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  const brickMethod = (form.brick_method || 'fixed') as BrickMethod
  const visibleFields = (fs: readonly FieldDef[]) =>
    fs.filter((f) =>
      f.method === undefined ? true : Array.isArray(f.method) ? f.method.includes(brickMethod) : f.method === brickMethod,
    )

  return (
    <div className="container mx-auto py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="space-y-1">
          <Button variant="ghost" size="sm" asChild className="-ml-3">
            <Link to="/python">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Python Strategies
            </Link>
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">{strategy?.name ?? strategyId} · Symbols</h1>
          <p className="text-muted-foreground text-sm">
            Each symbol has its own settings and is run by this strategy as the master.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <Badge variant={strategy?.is_running ? 'default' : 'secondary'}>
            Strategy {strategy?.is_running ? 'running' : 'stopped'}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => load()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
          <Button onClick={openAdd}>
            <Plus className="h-4 w-4 mr-2" />
            Add Symbol
          </Button>
        </div>
      </div>

      {!strategy?.is_running && rows.some((r) => r.enabled) && (
        <p className="text-sm text-orange-600">
          Enabled symbols will start trading once the strategy is started on the Python Strategies
          page (schedule stop: {strategy?.schedule_stop ?? '-'} IST).
        </p>
      )}

      <Card>
        <CardContent className="py-0">
          {rows.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No symbols yet. Use “Add Symbol” to search and configure one.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Symbol</TableHead>
                    <TableHead>Mode</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Brick</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">LTP</TableHead>
                    <TableHead>Last brick</TableHead>
                    <TableHead className="text-right">Long / Short</TableHead>
                    <TableHead className="text-right">Pending B / S</TableHead>
                    <TableHead className="text-right">SL long / short</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const st = row.enabled && !row.stale ? row.status : null
                    return (
                      <TableRow key={row.id}>
                        <TableCell>
                          <div className="font-medium">{row.symbol}</div>
                          <div className="text-xs text-muted-foreground">
                            {row.exchange} · {row.product}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">{row.trade_mode}</TableCell>
                        <TableCell className="text-right font-mono">{row.quantity}</TableCell>
                        <TableCell className="text-right font-mono">
                          {row.brick_method === 'atr'
                            ? `ATR ${row.atr_period}×${row.atr_multiplier}`
                            : row.brick_method === 'ltp_pct'
                              ? `LTP ${row.ltp_percent}%`
                              : row.brick_size}
                        </TableCell>
                        <TableCell>
                          {statusBadge(row)}
                          {st?.message ? (
                            <div className="text-xs text-muted-foreground mt-1">{st.message}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right font-mono">{fmt(st?.ltp)}</TableCell>
                        <TableCell className="text-xs">
                          {st?.brick_color ? `${st.brick_color} #${st.brick_no}` : '-'}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmt(st?.long_qty)} / {fmt(st?.short_qty)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmt(st?.buy_pending)} / {fmt(st?.sell_pending)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmt(st?.sl_long)} / {fmt(st?.sl_short)}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant={row.enabled ? 'destructive' : 'default'}
                              className={row.enabled ? '' : 'bg-green-600 hover:bg-green-700'}
                              disabled={busyId === row.id}
                              onClick={() => toggle(row)}
                            >
                              {row.enabled ? (
                                <>
                                  <Square className="h-4 w-4 mr-1" />
                                  Disable
                                </>
                              ) : (
                                <>
                                  <Play className="h-4 w-4 mr-1" />
                                  Enable
                                </>
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Square off ${row.symbol}`}
                              disabled={!row.enabled || row.stale || busyId === row.id}
                              onClick={() => squareoff(row)}
                            >
                              <Zap className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Edit ${row.symbol}`}
                              disabled={row.enabled}
                              onClick={() => openEdit(row)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Clone ${row.symbol} settings to a new symbol`}
                              onClick={() => openClone(row)}
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={`Remove ${row.symbol}`}
                              disabled={row.enabled}
                              onClick={() => remove(row)}
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit dialog */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.symbol}` : 'Add symbol for trade'}</DialogTitle>
            <DialogDescription>
              {editing
                ? 'Settings apply the next time this symbol is enabled.'
                : 'Search the symbol master, then set this symbol’s individual configuration.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5 py-2">
            {/* Symbol picker */}
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
                      Selected: <span className="font-mono font-medium">{form.exchange}:{form.symbol}</span>
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
                      <Label htmlFor={`f-${f.key}`} className="text-xs">
                        {f.label}
                      </Label>
                      {f.kind === 'select' ? (
                        <select
                          id={`f-${f.key}`}
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
                          id={`f-${f.key}`}
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

            {strategy?.schedule_stop && (
              <p className="text-xs text-muted-foreground">
                Squareoff must be earlier than this strategy’s schedule stop ({strategy.schedule_stop} IST).
              </p>
            )}
            {formError && <p className="text-sm text-red-600">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save settings' : 'Add symbol'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm dialog */}
      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm?.destructive ? 'destructive' : 'default'}
              onClick={async () => {
                const c = confirm
                setConfirm(null)
                if (c) await c.run()
              }}
            >
              {confirm?.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
