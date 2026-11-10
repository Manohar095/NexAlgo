/**
 * "Algo symbols" side panel for the Trading page.
 *
 * Adds symbols to the master Renko strategy and trades them, each with its own settings.
 * The strategy itself lives in the backend (strategy_hub/masters/renko_multi.py); nothing is
 * uploaded. The bots run on the server whether or not this panel is open, so polling here
 * only runs while it is mounted.
 */

import { Layers, MoreVertical, Plus, RefreshCw } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { showToast } from '@/utils/toast'
import { algoApi, apiErrorMessage } from './api'
import { SymbolSettingsDialog } from './SymbolSettingsDialog'
import type { AlgoSymbolRow, Overview, ProcessInfo } from './types'

const POLL_MS = 3000
const WIDTH_KEY = 'oa-algo-width'
const DEFAULT_W = 380
const MIN_W = 280
const MAX_W = 760

const clampWidth = (w: number) =>
  Math.max(MIN_W, Math.min(w, MAX_W, Math.floor(window.innerWidth * 0.7)))

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(n) && n > 0 ? clampWidth(n) : DEFAULT_W
  } catch {
    return DEFAULT_W
  }
}

function persistWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(w))
  } catch {
    // storage refused: the width still applies for this visit
  }
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '-' : String(n))

/** A heading with its value directly underneath. */
function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="text-[10px] leading-4 text-muted-foreground">{label}</div>
      <div className="break-words font-mono text-[11px] leading-5">{children}</div>
    </div>
  )
}

/**
 * The focused chart's instrument, read defensively: the context's exact shape belongs to the
 * charting terminal, so several plausible shapes are accepted and anything else yields null.
 */
function readChartSymbol(ctx: unknown): { symbol: string; exchange: string } | null {
  if (!ctx || typeof ctx !== 'object') return null
  const c = ctx as Record<string, unknown>
  const inst = (
    c.instrument && typeof c.instrument === 'object' ? c.instrument : c
  ) as Record<string, unknown>
  let symbol = typeof inst.symbol === 'string' ? inst.symbol : ''
  let exchange = typeof inst.exchange === 'string' ? inst.exchange : ''
  if (symbol.includes(':')) {
    const [ex, sym] = symbol.split(':')
    exchange = exchange || ex
    symbol = sym
  }
  return symbol && exchange ? { symbol, exchange: exchange.toUpperCase() } : null
}

interface ConfirmState {
  title: string
  description: string
  action: string
  destructive?: boolean
  run: () => Promise<void> | void
}

interface Props {
  /** Reads the focused chart; used for the "This chart" shortcut. */
  getChartContext?: () => unknown
}

export function AlgoSymbolsPanel({ getChartContext }: Props) {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<AlgoSymbolRow | null>(null)
  const [cloneFrom, setCloneFrom] = useState<AlgoSymbolRow | null>(null)
  const [prefill, setPrefill] = useState<{ symbol: string; exchange: string } | null>(null)

  const [confirm, setConfirm] = useState<ConfirmState | null>(null)
  /* ── drag-to-resize: the panel sits on the right, so dragging its left edge LEFT widens it ── */
  const [width, setWidth] = useState<number>(readWidth)
  const drag = useRef<{ startX: number; startW: number } | null>(null)

  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { startX: e.clientX, startW: width }
  }
  const onResizeMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    setWidth(clampWidth(drag.current.startW + (drag.current.startX - e.clientX)))
  }
  const onResizeEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setWidth((w) => {
      persistWidth(w)
      return w
    })
  }
  const onResizeKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = clampWidth(width + (e.key === 'ArrowLeft' ? 24 : -24))
    setWidth(next)
    persistWidth(next)
  }

  const load = useCallback(async (silent = false) => {
    try {
      const o = await algoApi.overview()
      setOverview(o)
      setLoadError(null)
    } catch (error) {
      if (!silent) showToast.error(apiErrorMessage(error, 'Failed to load algo symbols'), 'pythonStrategy')
      setLoadError(apiErrorMessage(error, 'Could not reach the server'))
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(() => load(true), POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const symbols = overview?.symbols ?? []
  const processes = overview?.processes ?? []
  const scheduleStops = Object.fromEntries(processes.map((p) => [p.exchange, p.schedule_stop]))

  const openAdd = () => {
    setEditing(null)
    setCloneFrom(null)
    setPrefill(null)
    setFormOpen(true)
  }

  const openChartSymbol = () => {
    const found = readChartSymbol(getChartContext?.())
    if (!found) {
      showToast.error('Could not read the symbol on the focused chart', 'pythonStrategy')
      return
    }
    setEditing(null)
    setCloneFrom(null)
    setPrefill(found)
    setFormOpen(true)
  }

  const openEdit = (row: AlgoSymbolRow) => {
    setEditing(row)
    setCloneFrom(null)
    setPrefill(null)
    setFormOpen(true)
  }

  const openClone = (row: AlgoSymbolRow) => {
    setEditing(null)
    setCloneFrom(row)
    setPrefill(null)
    setFormOpen(true)
  }

  const report = (res: { status: string; message?: string; warning?: boolean }) => {
    if (res.status === 'success' && !res.warning) showToast.success(res.message || 'Done', 'pythonStrategy')
    else showToast.error(res.message || 'Failed', 'pythonStrategy')
  }

  const run = async (key: string, fn: () => Promise<{ status: string; message?: string; warning?: boolean }>) => {
    setBusy(key)
    try {
      report(await fn())
    } catch (error) {
      showToast.error(apiErrorMessage(error, 'Request failed'), 'pythonStrategy')
    } finally {
      setBusy(null)
      load(true)
    }
  }

  const toggle = (row: AlgoSymbolRow) => {
    const enabling = !row.enabled
    const go = () => run(`s${row.id}`, () => algoApi.setEnabled(row.id, enabling))
    const hasPosition = (row.status?.long_qty ?? 0) > 0 || (row.status?.short_qty ?? 0) > 0

    if (enabling && overview?.analyze_mode !== true) {
      const unknown = overview?.analyze_mode === null || overview?.analyze_mode === undefined
      setConfirm({
        title: `Enable ${row.symbol}?`,
        description: unknown
          ? 'OpenAlgo’s mode (Analyzer or Live) could not be determined. If it is Live, enabling starts real order placement for this symbol.'
          : 'OpenAlgo is in LIVE mode. Enabling starts the strategy for this symbol and it will place real orders as soon as a signal appears.',
        action: 'Enable and trade',
        destructive: true,
        run: go,
      })
    } else if (!enabling && hasPosition) {
      setConfirm({
        title: `Disable ${row.symbol}?`,
        description:
          'This symbol has an open position. Disabling stops the bot but leaves the position and its stop-loss orders live at the broker. Use Squareoff first if you want to flatten.',
        action: 'Disable anyway',
        run: go,
      })
    } else {
      go()
    }
  }

  const squareoff = (row: AlgoSymbolRow) =>
    setConfirm({
      title: `Square off ${row.symbol}?`,
      description:
        'Cancels all pending entries and stop-loss orders for this symbol and closes the position. Trading for this symbol stays halted until you disable and re-enable it.',
      action: 'Square off',
      destructive: true,
      run: () => run(`s${row.id}`, () => algoApi.command(row.id, 'SQUAREOFF')),
    })

  const remove = (row: AlgoSymbolRow) =>
    setConfirm({
      title: `Remove ${row.symbol}?`,
      description: 'Deletes this symbol and its settings.',
      action: 'Remove',
      destructive: true,
      run: () => run(`s${row.id}`, () => algoApi.remove(row.id)),
    })

  const statusBadge = (row: AlgoSymbolRow) => {
    if (!row.enabled) return <Badge variant="secondary">Disabled</Badge>
    if (row.stale) {
      return (
        <Badge variant="outline" className="border-orange-500 text-orange-600" title="Enabled, waiting for the strategy process to start">
          Waiting
        </Badge>
      )
    }
    const s = row.status?.state
    if (s === 'RUNNING') return <Badge className="bg-green-600">Running</Badge>
    if (s === 'HALTED') return <Badge className="bg-amber-500">Halted</Badge>
    if (s === 'ERROR') return <Badge variant="destructive">Error</Badge>
    return <Badge variant="secondary">{s ?? 'Starting'}</Badge>
  }

  const modeBadge =
    overview?.analyze_mode === true ? (
      <Badge variant="secondary">Analyzer</Badge>
    ) : overview?.analyze_mode === false ? (
      <Badge variant="destructive">LIVE</Badge>
    ) : (
      <Badge variant="outline">Mode unknown</Badge>
    )

  const processLabel = (p: ProcessInfo) => {
    if (p.is_running) return 'Running'
    if (p.status === 'not_registered') return 'Idle'
    if (p.manually_stopped) return 'Stopped'
    return p.status_message || 'Scheduled'
  }

  return (
    <aside
      id="oa-panel-algo"
      className="relative flex shrink-0 flex-col border-l bg-background"
      style={{ width, maxWidth: '70vw' }}
      aria-label="Algo symbols"
    >
      {/* Drag this edge to resize (arrow keys work when focused, double-click resets) */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Algo symbols panel"
        aria-valuenow={width}
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        tabIndex={0}
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onKeyDown={onResizeKey}
        onDoubleClick={() => {
          setWidth(DEFAULT_W)
          persistWidth(DEFAULT_W)
        }}
        className="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
      />
      {/* Header: title and mode on one line, actions on the next */}
      <div className="space-y-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Algo symbols</h2>
          {modeBadge}
          <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label="Refresh" onClick={() => load()}>
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="h-7 flex-1 px-2" onClick={openChartSymbol} title="Add the focused chart's symbol">
            <Plus className="mr-1 h-3.5 w-3.5" />
            <span className="text-xs">This chart</span>
          </Button>
          <Button size="sm" className="h-7 flex-1 px-2" onClick={openAdd}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            <span className="text-xs">Add symbol</span>
          </Button>
        </div>
      </div>

      {loadError && <p className="px-3 py-1 text-xs text-red-600">{loadError}</p>}

      {/* One block per exchange process; buttons wrap under the text when space is tight */}
      {processes.length > 0 && (
        <div className="space-y-1.5 border-b px-3 py-2">
          {processes.map((p) => {
            const pb = busy === `p${p.exchange}`
            return (
              <div key={p.exchange} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="font-mono font-medium">{p.exchange}</span>
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    p.is_running ? 'bg-green-500' : p.status === 'error' ? 'bg-red-500' : 'bg-muted-foreground/40'
                  )}
                />
                <span className="min-w-0 flex-1 basis-24 truncate" title={p.status_message}>
                  {processLabel(p)} · {p.schedule_start}-{p.schedule_stop}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  {p.is_running ? (
                    <>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pb} onClick={() => run(`p${p.exchange}`, () => algoApi.process(p.exchange, 'restart'))}>
                        Restart
                      </Button>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pb} onClick={() => run(`p${p.exchange}`, () => algoApi.process(p.exchange, 'stop'))}>
                        Stop
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={pb} onClick={() => run(`p${p.exchange}`, () => algoApi.process(p.exchange, 'start'))}>
                      Start
                    </Button>
                  )}
                  <a className="text-[11px] text-primary underline" href={`/python/${p.strategy_id}/logs`} target="_blank" rel="noreferrer">
                    Logs
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* One card per symbol, three lines:
          1. Symbol, enable switch, status, actions menu
          2. Mode / Qty / Brick / LTP                          (heading over value)
          3. Last brick / Long-Short / Pending B-S / SL long-short (heading over value) */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {overview === null && !loadError && <p className="text-sm text-muted-foreground">Loading…</p>}
        {overview !== null && symbols.length === 0 && (
          <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No symbols yet. Use <span className="font-medium">Add</span> to search a symbol, or{' '}
            <span className="font-medium">This chart</span> to add the one you are looking at.
          </div>
        )}

        {symbols.map((row) => {
          const st = row.enabled && !row.stale ? row.status : null
          const isBusy = busy === `s${row.id}`
          return (
            <div key={row.id} className="space-y-2 rounded-md border p-2">
              {/* Line 1: symbol, enable switch, status, actions */}
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-sm font-semibold" title={`${row.exchange}:${row.symbol} · ${row.product}`}>
                  {row.symbol}
                </span>
                <Switch
                  checked={row.enabled}
                  disabled={isBusy}
                  onCheckedChange={() => toggle(row)}
                  aria-label={`${row.enabled ? 'Disable' : 'Enable'} ${row.symbol}`}
                />
                <span className="shrink-0" title={st?.message ?? undefined}>
                  {statusBadge(row)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`${row.symbol} actions`}>
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={row.enabled} onSelect={() => openEdit(row)}>
                      Edit settings
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => openClone(row)}>Clone to new symbol</DropdownMenuItem>
                    <DropdownMenuItem disabled={!row.enabled || row.stale} onSelect={() => squareoff(row)}>
                      Square off
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-red-500" disabled={row.enabled} onSelect={() => remove(row)}>
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* Line 2: four columns, heading over value */}
              <div className="grid grid-cols-[1.35fr_0.7fr_0.8fr_1fr] gap-x-2 border-t pt-2">
                <Field label="Mode">{row.trade_mode}</Field>
                <Field label="Qty">{row.quantity}</Field>
                <Field label="Brick">
                  {row.brick_method === 'atr'
                    ? `ATR ${row.atr_period}×${row.atr_multiplier}`
                    : row.brick_method === 'ltp_pct'
                      ? `LTP ${row.ltp_percent}%`
                      : row.brick_size}
                </Field>
                <Field label="LTP">{fmt(st?.ltp)}</Field>
              </div>

              {/* Line 3: four columns, heading over value */}
              <div className="grid grid-cols-[1.1fr_0.85fr_1.2fr_1.2fr] gap-x-2 border-t pt-2">
                <Field label="Last brick">
                  {st?.brick_color ? (
                    <span className={st.brick_color === 'Green' ? 'text-green-600' : 'text-red-600'}>
                      {st.brick_color} #{st.brick_no}
                    </span>
                  ) : (
                    '-'
                  )}
                </Field>
                <Field label="Long / Short">
                  {fmt(st?.long_qty)} / {fmt(st?.short_qty)}
                </Field>
                <Field label="Pending B / S">
                  {fmt(st?.buy_pending)} / {fmt(st?.sell_pending)}
                </Field>
                <Field label="SL long / short">
                  {fmt(st?.sl_long)} / {fmt(st?.sl_short)}
                </Field>
              </div>

              {st?.message ? <p className="text-[11px] text-muted-foreground">{st.message}</p> : null}
            </div>
          )
        })}
      </div>

      <SymbolSettingsDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        cloneFrom={cloneFrom}
        prefill={prefill}
        scheduleStops={scheduleStops}
        onSaved={() => load(true)}
      />

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
    </aside>
  )
}