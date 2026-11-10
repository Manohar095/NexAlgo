import { LayoutGrid, Link2 as LinkIcon } from 'lucide-react'
import { type ChartObjects, createLinkGroup, type LinkGroup } from 'openalgo-charts'
import type { WorkspaceDocument, WorkspacePayload } from 'openalgo-charts/workspace'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'

import type { MagnetMode } from 'openalgo-charts/draw'
import {
  BOTTOM_BAR_PX,
  type BottomBarControl,
  ChartBottomBar,
} from '@/components/trading/ChartBottomBar'
import { ChartPane } from '@/components/trading/ChartPane'
import { DrawingRail, DrawingRailTab } from '@/components/trading/DrawingRail'
import {
  ChartOrderBridgeContext,
  type ChartOrderBridgeRef,
} from '@/components/trading/dock/chartOrderBridge'
import { DOCK_ID } from '@/components/trading/dock/DockShell'
import {
  type DockTab,
  escapeTarget,
  readDockTab,
  writeDockTab,
} from '@/components/trading/dock/dockState'
import { TradingDock } from '@/components/trading/dock/TradingDock'
import { GridDividers } from '@/components/trading/GridDividers'
import { IndicatorTemplates } from '@/components/trading/IndicatorTemplates'
import { RightPanel } from '@/components/trading/RightPanel'
import { TickBox } from '@/components/trading/TickBox'
import { Tip } from '@/components/trading/Tip'
import { TB_BTN, TB_ICON, TB_ON, TB_LABEL_2XL, ToolbarDivider } from '@/components/trading/toolbarStyles'
import { WorkspaceGrid } from '@/components/trading/WorkspaceGrid'
import { WorkspaceMenu } from '@/components/trading/WorkspaceMenu'
import { type ReplayPickSource, WorkspaceReplayBar } from '@/components/trading/WorkspaceReplayBar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useChartWorkspaceCatalog } from '@/hooks/useChartWorkspaceCatalog'
import { useWorkspaceAutosave } from '@/hooks/useWorkspaceAutosave'
import { useWorkspaceGridTransition } from '@/hooks/useWorkspaceGridTransition'
import { LAYOUTS, LayoutIcon, type LayoutPreset } from '@/lib/chart/layouts'
import { fetchLog, type LoggedFire } from '@/lib/trading/alertLog'
import { alertRuntimeKey, removeWorkspaceAlertRuntime } from '@/lib/trading/alertRuntime'
import { historyChord } from '@/lib/trading/chartHistory'
import { hasChartRequest, readChartRequest, withoutChartRequest } from '@/lib/trading/chartLink'
import { chartMayTakeKey } from '@/lib/trading/drawingKeys'
import { ChromeIcon, lineStroke24 } from '@/lib/trading/glyphs'
import {
  type GridWeights,
  parseAreas,
  parseTracks,
  readGridWeights,
  tracksTemplate,
  writeGridWeights,
} from '@/lib/trading/gridSizes'
import type { PreparedChartGrid } from '@/lib/trading/preparedGrid'
import type {
  AlertFire,
  AlertsView,
  DrawStats,
  SearchRow,
  TradingTerminal,
} from '@/lib/trading/terminal'
import { capturePresetWorkspace } from '@/lib/trading/workspaceGrid'
import {
  WorkspaceReplayCoordinator,
  type WorkspaceReplaySnapshot,
} from '@/lib/trading/workspaceReplay'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'

const NO_DRAW: DrawStats = {
  count: 0,
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  magnet: false,
  magnetMode: 'off',
  removable: 0,
  selectable: 0,
  stay: false,
  tool: null,
  shortcuts: {},
}

const LAYOUT_KEY = 'oa-trading-layout'
/**
 * One-Click, the scalping terminal's convention ('1' / '0'). Off by default
 * and off whenever the key is unreadable: a chart must never open with its
 * Buy button live because storage was cleared or blocked.
 */
const ARMED_KEY = 'oa-trading-armed'
/** The drawing rail folded away ('1') or shown ('0'), beside the rail's last tools. */
const RAIL_FOLDED_KEY = 'oa-trading-rail-folded'
/**
 * Every pane's last loaded instrument (`EXCH:SYMBOL` parts per pane id), so the
 * desk reopens the charts the trader was actually working on. The workspace
 * files only remember SAVED workspaces; a desk the user never names used to
 * reopen RELIANCE-EQ on every boot.
 */
const LAST_SYMBOLS_KEY = 'oa-trading-last-symbols'
interface LastSymbol { symbol: string; exchange: string }

function readLastSymbols(): Record<string, LastSymbol> {
  try {
    const stored = JSON.parse(localStorage.getItem(LAST_SYMBOLS_KEY) || '{}')
    return stored && typeof stored === 'object' ? stored : {}
  } catch {
    return {}
  }
}

function rememberLastSymbol(paneId: string, exchange: string, symbol: string) {
  try {
    localStorage.setItem(
      LAST_SYMBOLS_KEY,
      JSON.stringify({ ...readLastSymbols(), [paneId]: { symbol, exchange } })
    )
  } catch {
    /* storage disabled — the desk falls back to the default instrument */
  }
}

/** Shown unless the trader folded it: an unreadable key keeps the tools in reach. */
function readRailShown(): boolean {
  try {
    return localStorage.getItem(RAIL_FOLDED_KEY) !== '1'
  } catch {
    return true
  }
}

/**
 * Where the folded rail's tab sits, from the bottom of the chart area: the
 * bottom bar's strip, the grid's 8px gutter and a pane's 1px border, then
 * centred on the 22px time axis, so the tab sits at the left end of the axis
 * row rather than over the plot or the watermark in its corner.
 */
const RAIL_TAB_BOTTOM = BOTTOM_BAR_PX + 8 + 1 + (22 - 26) / 2
/**
 * How many firings the session log keeps.
 *
 * A repeating alert on a one-minute chart left running through a session fires
 * hundreds of times, and past the first screenful nobody is reading them: the
 * cost is memory that is never given back. The oldest go first, because the
 * question the log answers is what just happened.
 */
const ALERT_LOG_LIMIT = 200

/**
 * A stored firing as the panel renders one.
 *
 * Keyed on the row id rather than on the alert's, because one alert fires many
 * times and each firing is its own row. The `log-` prefix keeps a stored row
 * from ever colliding with a live one, which is keyed by alert and sequence.
 */
function loggedToFire(row: LoggedFire): AlertFire {
  return {
    key: `log-${row.id}`,
    alertId: row.alertId,
    title: row.title,
    message: row.message,
    symbol: row.symbol,
    exchange: row.exchange,
    ...(typeof row.price === 'number' ? { price: row.price } : {}),
    firedAt: row.firedAt ?? 0,
    delivered: row.delivered,
  }
}

function readArmed(): boolean {
  try {
    return localStorage.getItem(ARMED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * What a linked grid agrees on. The engine keeps the channels independent, so
 * the control does too: a trader watching one instrument across four timeframes
 * would link crosshair and time and leave the symbol emphatically not, while a
 * sector grid wants the opposite.
 *
 * Everything defaults off: each pane is its own chart — pan, zoom, crosshair,
 * symbol and interval all belong to the pane they happened on, and nothing in
 * the grid ever moves by itself. A trader who wants a channel back turns it on
 * in the sync menu.
 */
interface SyncState {
  crosshair: boolean
  viewport: boolean
  symbol: boolean
  interval: boolean
}
const SYNC_DEFAULT: SyncState = { crosshair: false, viewport: false, symbol: false, interval: false }
/**
 * The key bumped once when the defaults changed. The old 'oa-trading-sync'
 * numbers were written under defaults that are no longer the defaults — pan
 * and crosshair linked — so state saved before this change starts everyone
 * from the new "independent" reading rather than silently keeping the old.
 */
const SYNC_KEY = 'oa-trading-sync-v2'

/** A preset's own split, which a layout opens with until somebody drags it. */
function presetWeights(preset: LayoutPreset): GridWeights {
  return { columns: parseTracks(preset.cols), rows: parseTracks(preset.rows) }
}

function readSync(): SyncState {
  try {
    const raw = localStorage.getItem(SYNC_KEY)
    if (!raw) return SYNC_DEFAULT
    const p = JSON.parse(raw) as Partial<SyncState>
    return {
      crosshair: p.crosshair ?? SYNC_DEFAULT.crosshair,
      viewport: p.viewport ?? SYNC_DEFAULT.viewport,
      symbol: p.symbol ?? SYNC_DEFAULT.symbol,
      interval: p.interval ?? SYNC_DEFAULT.interval,
    }
  } catch {
    return SYNC_DEFAULT
  }
}

export default function Trading() {
  const account = useAuthStore((state) =>
    state.isAuthenticated ? (state.user?.username ?? null) : null
  )
  return <TradingWorkspace key={account ?? 'signed-out'} account={account} />
}

function TradingWorkspace({ account }: { account: string | null }) {
  const workspaceCatalog = useChartWorkspaceCatalog(account)
  const workspacePending = useRef(false)
  const visibleGrid = useRef<PreparedChartGrid | null>(null)
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const savedWorkspaceSnapshot = useRef<WorkspacePayload | undefined>(undefined)
  const [workspaceMessage, setWorkspaceMessage] = useState('Unsaved')
  const [saveStamp, setSaveStamp] = useState(0)
  const restoreAttempted = useRef(false)
  const [layoutId, setLayoutId] = useState(() => {
    const saved = localStorage.getItem(LAYOUT_KEY)
    return LAYOUTS.some((l) => l.id === saved) ? (saved as string) : 'single'
  })
  const [sync, setSync] = useState<SyncState>(readSync)
  /**
   * One-Click for the whole workspace. Every pane follows it, like sync: the
   * on-chart Buy in one pane must not fire while the same button in the next
   * pane asks first.
   */
  const [armed, setArmed] = useState<boolean>(readArmed)
  /**
   * One group for the whole workspace, created once and kept for the life of
   * the page. Panes join it as their charts are built and re-join after every
   * rebuild, so changing a layout, theme or chart type does not quietly drop a
   * pane out of the group it still thinks it belongs to.
   */
  const [linkGroup, setLinkGroup] = useState<LinkGroup | null>(null)

  const [apiKey, setApiKey] = useState<string | null>(null)
  const [wsUrl, setWsUrl] = useState<string | null>(null)
  const [noApiKey, setNoApiKey] = useState(false)

  /* ── one drawing rail for every pane ─────────────────────────────────── */
  const [tool, setTool] = useState<string | null>(null)
  const [magnet, setMagnet] = useState<MagnetMode>('off')
  const [stay, setStay] = useState(false)
  /** A tool held by a double-click on the rail, until Escape or another pick. */
  const [latched, setLatched] = useState(false)
  // Folded or not, remembered beside the rail's other choices. The rail stays
  // mounted while folded, so the armed tool, the drawings and the chords carry
  // on; a tool armed by its chord does not unfold it. The chart's right-click
  // "Hide drawing tools" folds it the same way.
  const [showRail, setShowRail] = useState(readRailShown)
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_FOLDED_KEY, showRail ? '0' : '1')
    } catch {
      // Storage refused: the fold holds for this visit.
    }
  }, [showRail])
  const [stats, setStats] = useState<DrawStats>(NO_DRAW)
  // Undo / delete act on the pane you last drew in; arming a tool hits them all,
  // so whichever pane you click next is the one that gets the shape.
  const activeRef = useRef<TradingTerminal | null>(null)

  /* ── side panels ─────────────────────────────────────────────────────── */
  // The right edge is the /charts panel now (RightPanel.tsx), so the page no
  // longer keeps a panel id, a script-source request or a backtest hand-off:
  // the three tabs own their own state inside the shared module.
  /**
   * The bottom dock: which book is open under the grid, or null for the
   * collapsed strip. Page-level like the side panels, and for the same
   * reason: the books span every symbol, so they belong to no one pane.
   */
  const [dock, setDock] = useState<DockTab | null>(readDockTab)
  /**
   * Which pane a panel click loads into, and whose instrument the watchlist
   * highlights. The first pane until the user touches another, so a click in
   * the panel does something sensible before any pane has been focused.
   */
  const [focusedPane, setFocusedPane] = useState('p0')
  /**
   * Bumped whenever what `readChartContext` would answer has changed.
   *
   * A panel acting on the chart needs its instrument and its timeframe, and the
   * chart is not a React value: it is a library holding its own state, so there
   * is nothing to depend on. The only way to notice a change was to read it on
   * a timer, a question asked every second and answered differently a few times
   * a day.
   *
   * Three things change the answer and all three are already known here: the
   * focused pane, that pane's symbol, and its timeframe. The counter is still
   * bumped on all three so the page re-renders around a chart change (the dock
   * and the band read the same pane state).
   */
  const [, setChartRevision] = useState(0)
  const noteChartChanged = useCallback(() => setChartRevision((at) => at + 1), [])
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  const [paneSymbols, setPaneSymbols] = useState<Record<string, string | null>>({})
  // The charts still report their objects and alerts; the side panels that
  // displayed them are gone, so the page keeps the reports for the dock/band
  // and nothing renders them.
  const [, setPaneObjects] = useState<Record<string, ChartObjects>>({})
  const [, setPaneAlerts] = useState<Record<string, AlertsView>>({})
  /**
   * Every alert that has fired, oldest first.
   *
   * Read back from the server on load and added to as firings happen. Alerts
   * are still evaluated by the chart that is open, so nothing fires because of
   * this list; what the server keeps is the history. Capped in the page as well
   * as on the server, because a repeating alert on a one-minute chart left
   * running all day is memory nobody gets back.
   */
  const [, setAlertLog] = useState<AlertFire[]>([])
  /**
   * Bumped whenever an alert changes.
   *
   * The controller is mutable and its `list()` hands back a copy, so nothing in
   * React knows that a drag, a Delete key or a firing has made anything stale.
   */
  const [, setAlertRevision] = useState(0)
  /**
   * Every live pane's terminal, keyed by pane id.
   *
   * activeRef alone is not enough: it is only set once the user has clicked
   * into a pane, so on a fresh page load the panels had nothing to act on and
   * their search returned no results at all. This is populated as each pane
   * builds, so the panels work from the first paint.
   */
  const terminalsRef = useRef<Record<string, TradingTerminal | null>>({})
  /** The bottom bar once its code has loaded; told when a pane finishes loading. */
  const bottomBar = useRef<BottomBarControl | null>(null)
  const layoutIdRef = useRef(layoutId)
  layoutIdRef.current = layoutId
  const replayCoordinator = useRef<WorkspaceReplayCoordinator | null>(null)
  const [replaySnapshot, setReplaySnapshot] = useState<WorkspaceReplaySnapshot>({
    phase: 'idle',
    scope: 'focused',
    ownerId: null,
    state: null,
  })
  const replaySnapshotRef = useRef(replaySnapshot)
  const [replayError, setReplayError] = useState<string | null>(null)
  const [confirmReplayExit, setConfirmReplayExit] = useState(false)
  /**
   * The start bar under the pointer while one is chosen, for the replay bar's
   * label. A listener set here rather than page state, so a crosshair sweep
   * re-renders the bar alone and not every pane. Held by the page because the
   * bar subscribes before the coordinator below exists.
   */
  const replayPickListeners = useRef(new Set<() => void>())
  const replayPick = useRef<ReplayPickSource>({
    subscribe: (listener) => {
      replayPickListeners.current.add(listener)
      return () => {
        replayPickListeners.current.delete(listener)
      }
    },
    time: () => {
      const owner = replaySnapshotRef.current.ownerId
      const terminal = owner ? terminalsRef.current[owner] : null
      return terminal?.replayPickingBar() ? (terminal.replayPickBar()?.time ?? null) : null
    },
  }).current
  const replayPaneIds = useCallback(
    () =>
      visibleGrid.current
        ? visibleGrid.current.payload.panes.map((pane) => pane.id)
        : (LAYOUTS.find((item) => item.id === layoutIdRef.current) ?? LAYOUTS[0]).cells.map(
            (_, index) => `p${index}`
          ),
    []
  )
  const updateReplayMembers = useCallback(() => {
    replayCoordinator.current?.setMembers(
      replayPaneIds().flatMap((id) => {
        const terminal = terminalsRef.current[id]
        return terminal ? [{ id, terminal }] : []
      })
    )
  }, [replayPaneIds])
  useEffect(() => {
    let current = true
    const coordinator = new WorkspaceReplayCoordinator({
      onChange: (snapshot) => {
        replaySnapshotRef.current = snapshot
        if (current) {
          setReplaySnapshot(snapshot)
          if (snapshot.phase !== 'active') setConfirmReplayExit(false)
        }
      },
      onError: (error) => {
        if (current)
          setReplayError(error instanceof Error ? error.message : 'Unable to replay this workspace')
      },
    })
    replayCoordinator.current = coordinator
    const offPick = coordinator.subscribePick(() => {
      for (const listener of [...replayPickListeners.current]) listener()
    })
    updateReplayMembers()
    return () => {
      current = false
      offPick()
      coordinator.destroy()
      if (replayCoordinator.current === coordinator) replayCoordinator.current = null
    }
  }, [updateReplayMembers])
  const stopWorkspaceReplay = useCallback(() => {
    setConfirmReplayExit(false)
    replayCoordinator.current?.stop()
  }, [])
  const requestReplayExit = useCallback(() => {
    if (replaySnapshotRef.current.phase === 'active') setConfirmReplayExit(true)
    else stopWorkspaceReplay()
  }, [stopWorkspaceReplay])
  const startWorkspaceReplay = useCallback(
    (paneId: string) => {
      if (workspacePending.current) return
      setReplayError(null)
      const coordinator = replayCoordinator.current
      if (!coordinator) return
      if (coordinator.state().phase !== 'idle') requestReplayExit()
      else {
        if (replayPaneIds().some((id) => !terminalsRef.current[id])) {
          setReplayError('Every visible chart must be ready before replay')
          return
        }
        updateReplayMembers()
        coordinator.start(paneId)
      }
    },
    [replayPaneIds, requestReplayExit, updateReplayMembers]
  )

  const noteTerminal = useCallback(
    (paneId: string, terminal: TradingTerminal | null) => {
      if (visibleGrid.current) return
      if (terminal) terminalsRef.current[paneId] = terminal
      else {
        if (activeRef.current === terminalsRef.current[paneId]) activeRef.current = null
        delete terminalsRef.current[paneId]
      }
      updateReplayMembers()
    },
    [updateReplayMembers]
  )

  const noteAlerts = useCallback((paneId: string, view: AlertsView | null) => {
    setPaneAlerts((previous) => {
      if (view) {
        if (previous[paneId] === view) return previous
        return { ...previous, [paneId]: view }
      }
      if (!(paneId in previous)) return previous
      const next = { ...previous }
      delete next[paneId]
      return next
    })
    setAlertRevision((n) => n + 1)
  }, [])

  const noteAlertFired = useCallback((fire: AlertFire) => {
    setAlertLog((previous) =>
      previous.length < ALERT_LOG_LIMIT
        ? [...previous, fire]
        : [...previous.slice(previous.length - ALERT_LOG_LIMIT + 1), fire]
    )
  }, [])

  /**
   * The history from before this tab was opened.
   *
   * Once, on load. Rows arrive live through `noteAlertFired`, so refetching
   * would only replace a list that is already correct.
   */
  useEffect(() => {
    let cancelled = false
    void fetchLog().then((fires) => {
      if (cancelled) return
      // The server answers newest first; this list is oldest first.
      setAlertLog((live) => [...fires.map(loggedToFire).reverse(), ...live])
    })
    return () => {
      cancelled = true
    }
  }, [])

  const noteObjects = useCallback((paneId: string, objects: ChartObjects | null) => {
    setPaneObjects((previous) => {
      if (objects) {
        if (previous[paneId] === objects) return previous
        return { ...previous, [paneId]: objects }
      }
      if (!(paneId in previous)) return previous
      const next = { ...previous }
      delete next[paneId]
      return next
    })
  }, [])

  /** The pane a panel acts on: the focused one, else any pane that is up. */
  const panelTarget = useCallback(
    () =>
      workspacePending.current
        ? null
        : (terminalsRef.current[focusedPane] ??
          activeRef.current ??
          Object.values(terminalsRef.current)[0] ??
          null),
    [focusedPane]
  )

  const focusPane = useCallback(
    (t: TradingTerminal | null, paneId?: string) => {
      if (workspacePending.current) return
      activeRef.current = t
      if (visibleGrid.current && t) {
        setMagnet(t.drawStats().magnetMode)
        setStay(t.drawStats().stay)
      }
      if (paneId) {
        setFocusedPane(paneId)
        // The context follows the focused pane, so focusing another one changes
        // the answer without any chart having changed.
        noteChartChanged()
      }
      if (t) setStats(t.drawStats())
    },
    [noteChartChanged]
  )

  const noteSymbol = useCallback(
    (paneId: string, key: string | null) => {
      setPaneSymbols((prev) => (prev[paneId] === key ? prev : { ...prev, [paneId]: key }))
      // The next boot reopens this instrument: the key is `EXCH:SYMBOL` and the
      // exchange never carries a colon, so one split round-trips it.
      if (key) {
        const sep = key.indexOf(':')
        if (sep > 0) rememberLastSymbol(paneId, key.slice(0, sep), key.slice(sep + 1))
      }
      noteChartChanged()
      // A pane on a preset range shows the same span of its new bars.
      const terminal = terminalsRef.current[paneId]
      if (terminal && !workspacePending.current) bottomBar.current?.paneLoaded(terminal)
    },
    [noteChartChanged]
  )

  /**
   * Load an instrument chosen in a side panel.
   *
   * Panels are page-level and panes are not, so the click has to be routed to
   * one. It goes to the pane the user last touched -- the same pane the drawing
   * rail acts on, so "the pane I am working in" means one thing everywhere.
   */
  const sendToFocusedPane = useCallback(
    (row: SearchRow) => {
      stopWorkspaceReplay()
      void panelTarget()?.loadSymbol(row)
    },
    [panelTarget, stopWorkspaceReplay]
  )

  /**
   * Whether any pane is replaying, or picking a bar to replay from. The
   * dock's actions go to the broker at the live price, and the chart already
   * refuses every order route while a replayed session is on screen; a
   * Cancel in the dock under that chart has to refuse in the same breath.
   * Any pane, not just the focused one: the dock is page-level and the
   * replayed chart is on screen whichever pane it is in.
   */
  const tradingLocked = useCallback(
    () =>
      workspacePending.current ||
      replaySnapshotRef.current.phase !== 'idle' ||
      Object.values(terminalsRef.current).some(
        (t) =>
          t !== null &&
          (t.replayActive() ||
            t.replayPickingBar() ||
            t.replayLoadingBars() ||
            t.dataUnavailable() ||
            t.alertDialogOpen())
      ),
    []
  )

  const railStats: DrawStats = {
    ...stats,
    tool,
    magnet: magnet !== 'off',
    magnetMode: magnet,
    stay,
  }
  /**
   * A pane's drawing state, for the rail. When the pane being drawn in drops
   * its tool (the shape is placed and nothing holds the tool, or Escape ended
   * the eraser there), the rail and every other pane return to the cursor
   * with it, rather than the rail showing a tool no pane is using.
   */
  const onPaneDrawStats = useCallback((value: DrawStats) => {
    setStats(value)
    if (activeRef.current?.drawStats().tool === null) {
      setTool(null)
      setLatched(false)
    }
  }, [])
  /** Pick a tool from the rail; `latch` holds it after each placement until Escape. */
  const pickTool = useCallback((id: string | null, latch = false) => {
    setTool(id)
    setLatched(id !== null && latch)
  }, [])
  /**
   * Hand a key event to the focused pane; it reports whether the drawing tier
   * claimed it, as a chord arming a tool or as an edit of the selection
   * (delete, duplicate, a nudge). Both tables ship with the lazily loaded
   * tier, so the terminal -- not this page and not the rail -- can answer.
   */
  const onDrawKey = useCallback((e: KeyboardEvent) => {
    if (workspacePending.current) return false
    const t = activeRef.current
    if (!t || !t.handleDrawKey(e)) return false
    setTool(t.drawStats().tool)
    setStats(t.drawStats())
    return true
  }, [])

  /**
   * Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z walk the focused chart's undo timeline:
   * drawings, studies, panes, scales, the chart type and the interval, in the
   * order they were made. Captured on the window so it is one press whether
   * the drawing rail is shown or not, and never taken from a field, a dialog,
   * an open menu or the order ticket (chartMayTakeKey). Nothing on the
   * timeline is an order, so no press can place, change or cancel one.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const direction = historyChord(e)
      if (!direction || e.repeat || workspacePending.current) return
      if (!chartMayTakeKey(e)) return
      const t = activeRef.current
      if (!t) return
      e.preventDefault()
      e.stopPropagation()
      t.historyPress(direction)
      setStats(t.drawStats())
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [])

  /** The dock fills this; each chart's right-click menu reads it as it opens. */
  const orderBridge = useRef<ChartOrderBridgeRef['current']>(null)

  const act = (fn: (t: TradingTerminal) => void) => {
    if (workspacePending.current) return
    const t = activeRef.current
    if (!t) return
    fn(t)
    setStats(t.drawStats())
  }

  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layoutId)
  }, [layoutId])

  useEffect(() => {
    writeDockTab(dock)
  }, [dock])

  useEffect(() => {
    try {
      localStorage.setItem(ARMED_KEY, armed ? '1' : '0')
    } catch {
      // Storage refused (private mode, quota): the switch still works for
      // this visit, it just does not survive a reload.
    }
  }, [armed])

  /**
   * Escape closes the open dock, the way it disarms a drawing tool.
   *
   * The right edge panel closes itself (the shared module owns its own Escape
   * handling, the same one /charts uses), so this handler only yields to the
   * surfaces that sit above it and then to the dock:
   *
   * - to any open Radix surface. Checking only the scroll lock and role=dialog
   *   missed the non-modal ones: the option chain's underlying combobox is a
   *   Popover, which sets neither, so dismissing the search closed the whole
   *   panel underneath it.
   * - to an armed drawing tool, which DrawingRail disarms on the same key
   *   without stopping propagation. One Escape did both.
   */
  useEffect(() => {
    if (!dock) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (tool) return
      // Never steal Escape from a field, the way DrawingRail does not.
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) {
        return
      }
      if (document.body.hasAttribute('data-scroll-locked')) return
      if (
        document.querySelector(
          '[data-trading-dialog-open="true"],' +
            '[data-state="open"][role="dialog"],' +
            '[data-state="open"][data-slot="popover-content"],' +
            '[data-state="open"][role="menu"],' +
            '[data-state="open"][role="listbox"]'
        )
      ) {
        return
      }
      const dockEl = document.getElementById(DOCK_ID)
      const closes = escapeTarget({
        dock: dock !== null,
        panel: false,
        focusInDock: !!dockEl && dockEl.contains(document.activeElement),
      })
      if (closes === 'dock') setDock(null)
    }
    // Capture sees an open pane dialog before that dialog's own window-level
    // Escape listener unmounts it. In bubble order the dialog could disappear
    // first, making this handler also close the surface underneath it.
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [dock, tool])

  useEffect(() => {
    localStorage.setItem(SYNC_KEY, JSON.stringify(sync))
    // setOptions, not a rebuild: the engine clears the linked crosshairs when
    // that switch goes off and converges the group on its agreed symbol when
    // the symbol switch comes on, neither of which a fresh group would do.
    linkGroup?.setOptions(sync)
    visibleGrid.current?.linkGroup.setOptions(sync)
  }, [sync, linkGroup])

  useEffect(() => {
    // Setup owns the group so an effect restart cannot reuse a destroyed one.
    const group = createLinkGroup()
    setLinkGroup(group)
    return () => group.destroy()
  }, [])

  // Fetch the API key + WS URL once; every pane shares them.
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const [keyRes, cfgRes] = await Promise.all([
          fetch('/api/websocket/apikey').then((r) => r.json()),
          fetch('/api/websocket/config').then((r) => r.json()),
        ])
        if (!alive) return
        if (keyRes.status !== 'success') {
          setNoApiKey(true)
          return
        }
        setApiKey(keyRes.api_key)
        setWsUrl(cfgRes.websocket_url || 'ws://127.0.0.1:8765')
      } catch {
        if (alive) setNoApiKey(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const layout = LAYOUTS.find((l) => l.id === layoutId) ?? LAYOUTS[0]
  /**
   * The unnamed grid's split. Read once per layout from this browser, and held
   * here while a divider is dragged so the charts follow the pointer before
   * anything is written.
   */
  const storedWeights = useMemo(
    () => readGridWeights(localStorage, layout.id, presetWeights(layout)),
    [layout]
  )
  const [liveWeights, setLiveWeights] = useState<{ id: string; weights: GridWeights } | null>(null)
  const gridWeights = liveWeights?.id === layout.id ? liveWeights.weights : storedWeights
  const keepGridWeights = (weights: GridWeights) => {
    setLiveWeights({ id: layout.id, weights })
    writeGridWeights(localStorage, layout.id, weights, presetWeights(layout))
    autosave.changed()
  }
  /** The preset with the dragged split, which is what a save captures. */
  const sizedLayout: LayoutPreset = {
    ...layout,
    cols: tracksTemplate(gridWeights.columns),
    rows: tracksTemplate(gridWeights.rows),
  }

  const lockWorkspace = useCallback(
    (pending: boolean) => {
      if (pending) stopWorkspaceReplay()
      workspacePending.current = pending
      for (const terminal of Object.values(terminalsRef.current)) {
        terminal?.setWorkspaceTransitionLocked(pending)
        if (pending) terminal?.setArmed(false)
      }
    },
    [stopWorkspaceReplay]
  )
  const publishWorkspace = useCallback(
    (grid: PreparedChartGrid) => {
      visibleGrid.current = grid
      terminalsRef.current = Object.fromEntries(grid.terminals)
      updateReplayMembers()
      setPaneSymbols(Object.fromEntries(grid.symbols))
      setPaneObjects(Object.fromEntries(grid.objects))
      const focused = grid.terminals.get(grid.payload.activePaneId) ?? null
      activeRef.current = focused
      setFocusedPane(grid.payload.activePaneId)
      setSync(grid.payload.sync)
      setArmed(false)
      setTool(null)
      setLatched(false)
      const draw = focused?.drawStats() ?? NO_DRAW
      setStats(draw)
      setMagnet(draw.magnetMode)
      setStay(draw.stay)
    },
    [updateReplayMembers]
  )
  const workspace = useWorkspaceGridTransition(account, publishWorkspace, lockWorkspace)

  const bindAlertRuntime = (
    terminals: Iterable<[string, TradingTerminal | null]>,
    workspaceId: string | null,
    mode: 'restore' | 'seed'
  ) => {
    for (const [paneId, terminal] of terminals) {
      terminal?.setAlertRuntimeScope(
        account && workspaceId ? alertRuntimeKey(account, workspaceId, paneId) : null,
        mode
      )
    }
  }

  const captureWorkspace = () => {
    if (workspacePending.current) throw new Error('Wait for the workspace to finish loading')
    if (replaySnapshotRef.current.phase !== 'idle')
      throw new Error('Stop replay before saving the workspace')
    if (visibleGrid.current) return visibleGrid.current.capture(focusedPane, sync)
    const panes = layout.cells.map((_, index) => {
      const id = `p${index}`,
        terminal = terminalsRef.current[id]
      if (!terminal) throw new Error('Every chart must be ready before saving')
      return terminal.captureWorkspacePane(id)
    })
    return capturePresetWorkspace(
      sizedLayout,
      panes,
      panes.some((pane) => pane.id === focusedPane) ? focusedPane : panes[0].id,
      sync
    )
  }
  const autosave = useWorkspaceAutosave({
    identity: activeWorkspaceId ? `${account}:${activeWorkspaceId}` : null,
    enabled: workspaceCatalog.catalog?.autosave === true,
    paused: workspace.pending || replaySnapshot.phase !== 'idle',
    isPaused: () => workspacePending.current || replaySnapshotRef.current.phase !== 'idle',
    capture: captureWorkspace,
    save: async (payload) => {
      if (!activeWorkspaceId) throw new Error('Save this workspace with a name first')
      await workspaceCatalog.run((repository) =>
        repository.saveWorkspace(activeWorkspaceId, payload)
      )
    },
  })
  useEffect(() => {
    if (activeWorkspaceId && saveStamp > 0) {
      autosave.markSaved(savedWorkspaceSnapshot.current)
      savedWorkspaceSnapshot.current = undefined
    }
  }, [activeWorkspaceId, saveStamp, autosave.markSaved])
  useEffect(() => {
    if (workspace.pending) setArmed(false)
  }, [workspace.pending])
  const openWorkspace = async (document: WorkspaceDocument) => {
    const revision = workspaceCatalog.catalog?.revision
    await workspace.open(
      document,
      (signal) =>
        workspaceCatalog.run((repository) =>
          repository.openWorkspace(document.id, { signal, expectedRevision: revision })
        ),
      (grid) => bindAlertRuntime(grid.terminals, document.id, 'restore')
    )
    setActiveWorkspaceId(document.id)
    setWorkspaceMessage('Saved')
    setSaveStamp((value) => value + 1)
  }
  const saveWorkspaceAs = async (name: string) => {
    const payload = captureWorkspace()
    const document = await workspaceCatalog.run(async (repository) => {
      const saved = await repository.createWorkspace(name, payload)
      await repository.openWorkspace(saved.id)
      return saved
    })
    savedWorkspaceSnapshot.current = payload
    bindAlertRuntime(Object.entries(terminalsRef.current), document.id, 'seed')
    setActiveWorkspaceId(document.id)
    setWorkspaceMessage('Saved')
    setSaveStamp((value) => value + 1)
    return document
  }
  const createWorkspace = async (name: string) => {
    const payload = capturePresetWorkspace(
      LAYOUTS[0],
      [
        {
          id: 'p0',
          symbol: 'BHEL',
          exchange: 'NSE',
          interval: '5m',
          chartType: 'candlestick',
          chart: { version: 1 },
          settings: {},
          volume: true,
          magnet: 'off',
          stay: false,
          comparisons: [],
          comparisonMode: 'price',
        },
      ],
      'p0',
      SYNC_DEFAULT
    )
    return prepareNewWorkspace(payload, (repository) => repository.createWorkspace(name, payload))
  }
  const prepareNewWorkspace = async (
    payload: WorkspacePayload,
    create: Parameters<typeof workspaceCatalog.run<WorkspaceDocument>>[0]
  ) => {
    let saved: WorkspaceDocument | undefined
    await workspace.open(
      payload,
      (signal) =>
        workspaceCatalog.run(async (repository) => {
          signal.throwIfAborted()
          saved = await create(repository)
          signal.throwIfAborted()
          await repository.openWorkspace(saved.id, { signal })
        }),
      (grid) => {
        if (saved) bindAlertRuntime(grid.terminals, saved.id, 'seed')
      }
    )
    if (!saved) throw new Error('Workspace was not saved')
    setActiveWorkspaceId(saved.id)
    setWorkspaceMessage('Saved')
    setSaveStamp((value) => value + 1)
    return saved
  }
  const changeLayout = (id: string) => {
    if (workspacePending.current) return
    const next = LAYOUTS.find((item) => item.id === id)
    if (!next) return
    stopWorkspaceReplay()
    if (!visibleGrid.current && !activeWorkspaceId) {
      if (!next.cells.some((_, index) => `p${index}` === focusedPane)) {
        focusPane(terminalsRef.current.p0 ?? null, 'p0')
      }
      setLayoutId(id)
      setWorkspaceMessage('Unsaved')
      autosave.changed()
      return
    }
    try {
      const current = captureWorkspace()
      const panes = next.cells.map((_, index) => ({
        ...(current.panes[index] ?? current.panes[0]),
        id: `p${index}`,
      }))
      const focusedIndex = current.panes.findIndex((pane) => pane.id === focusedPane)
      const nextFocus = focusedIndex >= 0 && focusedIndex < panes.length ? `p${focusedIndex}` : 'p0'
      const payload = capturePresetWorkspace(next, panes, nextFocus, sync)
      void workspace
        .open(
          payload,
          async () => {},
          (grid) => bindAlertRuntime(grid.terminals, activeWorkspaceId, 'seed')
        )
        .then(() => {
          setLayoutId(id)
          setWorkspaceMessage('Unsaved')
          autosave.changed()
        })
        .catch(() => {})
    } catch (error) {
      setWorkspaceMessage(error instanceof Error ? error.message : String(error))
    }
  }
  useEffect(() => {
    if (
      restoreAttempted.current ||
      workspaceCatalog.loading ||
      !workspaceCatalog.catalog ||
      !apiKey ||
      !wsUrl
    )
      return
    restoreAttempted.current = true
    const document = workspaceCatalog.catalog.workspaces.find(
      (item) => item.id === workspaceCatalog.catalog?.activeWorkspaceId
    )
    if (document) void openWorkspace(document).catch(() => {})
  })
  /**
   * A chart link from the order book, trade book or positions page.
   *
   * Applied after the saved workspace has had its turn: declared after the
   * restore above, which locks the page synchronously when it opens one, so a
   * restore can never land on top of the instrument the link asked for. The
   * parameters are dropped once applied, so a refresh keeps whatever the
   * trader has charted since.
   */
  const [searchParams, setSearchParams] = useSearchParams()
  const handledChartQuery = useRef<string | null>(null)
  // One polling run per link query. The panes mount asynchronously (workspace
  // restore, layout chrome, the terminal's own feed handshake), so the first
  // attempt can land before a terminal exists — the original single-shot
  // version dropped the link in that case. The timer is owned by this ref so
  // a re-render (the effect has live deps) cannot restart or orphan it.
  const chartRequestTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    const stopPolling = () => {
      if (chartRequestTimer.current) {
        clearInterval(chartRequestTimer.current)
        chartRequestTimer.current = null
      }
    }
    if (!hasChartRequest(searchParams)) {
      stopPolling()
      return
    }
    const query = searchParams.toString()
    if (handledChartQuery.current === query) return
    if (workspacePending.current || workspaceCatalog.loading) return
    if (workspaceCatalog.catalog && !restoreAttempted.current) return
    const request = readChartRequest(searchParams)
    if (!request) return
    if (chartRequestTimer.current) return // already polling for a link
    let attempts = 0
    const apply = () => {
      if (workspacePending.current) return
      const target = panelTarget()
      if (!target) {
        if (++attempts > 80) stopPolling()
        return
      }
      stopPolling()
      void target.whenReady().then(() => {
        if (workspacePending.current || !panelTarget()) return
        sendToFocusedPane(request)
        handledChartQuery.current = query
        setSearchParams(withoutChartRequest(searchParams), { replace: true })
      })
    }
    chartRequestTimer.current = setInterval(apply, 250)
    apply()
  }, [searchParams, setSearchParams, panelTarget, sendToFocusedPane, workspaceCatalog])
  /**
   * Fresh profile: no saved workspace and no link — open a default instrument
   * so the page is usable on first run. Deferred to the URL effect above by
   * simply writing the link parameters; if a link was applied
   * (`handledChartQuery`) or a workspace was restored, nothing happens.
   */
  const seededDefaultSymbol = useRef(false)
  useEffect(() => {
    if (seededDefaultSymbol.current) return
    if (!restoreAttempted.current || workspacePending.current || workspaceCatalog.loading) return
    if (activeWorkspaceId || handledChartQuery.current) {
      seededDefaultSymbol.current = true
      return
    }
    if (hasChartRequest(searchParams)) return
    seededDefaultSymbol.current = true
    /**
     * Reopen what the trader last had on the chart. A named workspace would
     * restore through `activeWorkspaceId` above; the desk one never named
     * persisted nothing, so every boot fell back to the default instrument
     * no matter what was loaded since. `p0` is the boot grid's single pane —
     * multi-pane desks still remember every pane, and the first entry wins
     * if the saved map has no p0 (an odd storage state).
     */
    const last = readLastSymbols()
    const restore = last.p0 ?? Object.values(last)[0] ?? null
    if (restore && restore.symbol && restore.exchange) {
      setSearchParams(
        new URLSearchParams({ symbol: restore.symbol, exchange: restore.exchange }),
        { replace: true }
      )
      return
    }
    setSearchParams(
      new URLSearchParams({ symbol: 'RELIANCE-EQ', exchange: 'NSE' }),
      { replace: true }
    )
  })
  const workspaceMenu = (
    <WorkspaceMenu
      {...workspaceCatalog}
      activeId={activeWorkspaceId}
      transitionPending={workspace.pending}
      cancelOpening={workspace.cancel}
      status={autosave.status}
      error={autosave.error || workspaceCatalog.error}
      saveAs={saveWorkspaceAs}
      create={createWorkspace}
      openWorkspace={openWorkspace}
      importWorkspace={(document) =>
        prepareNewWorkspace(document, async (repository) => {
          const saved = await repository.importDocument(document)
          if (saved.kind !== 'workspace') throw new Error('Expected a chart workspace')
          return saved
        })
      }
      save={async () => {
        if (!activeWorkspaceId) throw new Error('Save this workspace with a name first')
        if (replaySnapshotRef.current.phase !== 'idle')
          throw new Error('Stop replay before saving the workspace')
        autosave.changed()
        await autosave.flush()
      }}
      onRemoved={(id) => {
        if (activeWorkspaceId === id) {
          bindAlertRuntime(Object.entries(terminalsRef.current), null, 'seed')
          setActiveWorkspaceId(null)
          setWorkspaceMessage('Unsaved')
        }
        if (account) {
          try {
            removeWorkspaceAlertRuntime(localStorage, account, id)
          } catch {
            setWorkspaceMessage('Workspace removed, but its alert history could not be cleared')
          }
        }
      }}
    />
  )
  const paneCount = workspace.current?.payload.panes.length ?? layout.cells.length
  const activeLayoutId = workspace.current?.payload.layout.preset ?? layoutId
  const activeLayoutLabel = LAYOUTS.find((item) => item.id === activeLayoutId)?.label ?? 'Custom'

  const chartIds =
    workspace.current?.geometry.panes.map((pane) => pane.id) ??
    layout.cells.map((_, index) => `p${index}`)

  /**
   * Workspace controls share one row with the selected chart's controls.
   *
   * Which chart the row drives is chosen here too, under the layouts, once
   * there is more than one chart to choose between. It used to be a "Chart 1"
   * button of its own at the head of the row, which on a single chart was a
   * label for the only chart there is. Clicking a chart still selects it, and
   * the selected chart's frame carries the accent, so the row needs no word
   * to say which one it is driving.
   */
  const layoutPicker = (
    <DropdownMenu>
      <Tip
        tip={{
          title: `Layout: ${activeLayoutLabel}`,
          sub: 'How many charts, and how they sit. Drag the gap between two charts to resize them; double-click the gap to put the sizes back.',
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(TB_BTN, TB_ICON)}
            data-workspace-control
            aria-label={`Chart layout: ${activeLayoutLabel}`}
          >
            <LayoutGrid className="h-4 w-4" strokeWidth={lineStroke24(16)} />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="start" className="w-56" data-workspace-control>
        <div className="grid grid-cols-4 gap-1 p-1">
          {LAYOUTS.map((l) => (
            <DropdownMenuItem
              key={l.id}
              onSelect={() => changeLayout(l.id)}
              title={l.label}
              className={cn(
                'flex aspect-square flex-col items-center justify-center gap-1 rounded border',
                l.id === layoutId
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'text-muted-foreground'
              )}
            >
              <LayoutIcon preset={l} />
              <span className="text-[9px] font-medium">{l.cells.length}</span>
            </DropdownMenuItem>
          ))}
        </div>
        {chartIds.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
              Selected chart
            </div>
            {chartIds.map((id, index) => (
              <DropdownMenuItem
                key={id}
                onSelect={() => focusPane(terminalsRef.current[id] ?? null, id)}
                className={cn('text-[13px]', id === focusedPane && 'bg-primary/10 text-primary')}
              >
                Chart {index + 1}
                {paneSymbols[id] ? `: ${paneSymbols[id]}` : ''}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  /**
   * Chart sync, beside the layout picker because the two describe the same
   * thing: how the panes relate to each other. Page-level, so only pane zero
   * carries it.
   *
   * The trigger lights up only while something is actually linked, and it is
   * disabled outright on a single-pane layout. A group of one has nobody to
   * sync with, so an inviting control there would promise something it cannot
   * do; disabled with its state still readable is the honest version.
   */
  const syncOn = sync.crosshair || sync.viewport || sync.symbol || sync.interval
  const syncPicker = (
    <DropdownMenu>
      <Tip
        tip={{
          title:
            paneCount < 2
              ? 'Chart sync needs more than one chart'
              : syncOn
                ? 'Chart sync is on'
                : 'Chart sync is off',
          sub: 'Link the crosshair, time range, symbol or interval across charts',
        }}
      >
        {/* Wrapped, so the label still shows while the button is disabled. */}
        <span className="inline-flex shrink-0">
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={paneCount < 2}
              className={cn(TB_BTN, TB_ICON, syncOn && paneCount > 1 && TB_ON)}
              aria-label="Chart sync"
            >
              <LinkIcon className="h-4 w-4" strokeWidth={lineStroke24(16)} />
            </button>
          </DropdownMenuTrigger>
        </span>
      </Tip>
      <DropdownMenuContent align="start" className="w-56">
        <div className="px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
          Sync across panes
        </div>
        {(
          [
            ['crosshair', 'Crosshair', 'Mirror the hovered bar'],
            ['viewport', 'Time range', 'Mirror pan and zoom'],
            ['symbol', 'Symbol', 'Load the same instrument everywhere'],
            ['interval', 'Interval', 'Use the same interval where supported'],
          ] as const
        ).map(([key, label, hint]) => (
          // A label, not a button, and the row carries no click handler of its
          // own. A <button> wrapping a checkbox is invalid HTML and behaves
          // exactly as badly as that suggests: the row handler and the input's
          // own change both fire, the switch toggles twice, and it appears to
          // do nothing at all. The label forwards a click on the text to the
          // input, so every part of the row toggles it exactly once.
          //
          // Independent switches keep the menu open while they are set.
          <label
            key={key}
            className="flex w-full cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-accent"
          >
            <TickBox
              checked={sync[key]}
              onChange={(next) => {
                if (key === 'symbol' || key === 'interval') stopWorkspaceReplay()
                setSync((p) => ({ ...p, [key]: next }))
                autosave.changed()
              }}
              label={label}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] leading-5">{label}</span>
              <span className="block text-[11px] leading-4 text-muted-foreground">{hint}</span>
            </span>
          </label>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  /**
   * One-Click, beside the layout and sync pickers because, like them, it is a
   * property of the workspace and not of one pane. The switch is the control
   * and the badge is its label, so clicking either toggles it once. A label,
   * not a button, for the reason the sync rows give: a button wrapping a
   * switch fires twice.
   */
  const armedControl = (
    <Tip
      tip={{
        title: armed ? 'One-Click is on' : 'One-Click is off',
        sub: armed
          ? 'Buy and Sell on the chart send a live order at once'
          : 'Buy and Sell on the chart open the order ticket first',
      }}
    >
      <label
        className={cn(
          'flex h-7 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-xs font-medium transition-colors',
          armed
            ? 'bg-destructive/15 text-destructive ring-1 ring-inset ring-destructive/40'
            : 'text-foreground/80 hover:bg-accent hover:text-foreground'
        )}
      >
        <Switch
          checked={armed}
          onCheckedChange={setArmed}
          aria-label="One-Click"
          // Switched on, the track carries the same red as the border and the
          // word.
          // Left on the app's accent it was a pale switch inside a red control
          // saying two different things about one state, and the accent is what
          // every harmless toggle on the page is already wearing.
          className={cn(armed && 'data-[state=checked]:bg-destructive')}
        />
        {/* One control, not two. The switch and a badge beside it were the same
          state said twice, and the badge said it in the loudest colour in the
          row while sitting at a different height from every button around it.
          The border makes it one control at the row's own height and the
          switch is still what you press.

          ON, not ARMED. The state is worth shouting about, because it is the
          one where a click on the chart sends a live order, and the capitals
          and the red are what do the shouting. The word itself only has to
          say which way the switch is thrown, and a trader should not have to
          learn a second vocabulary to read a toggle. */}
        <span className="whitespace-nowrap">
          {/* The name stays at every width, because "off" alone does not say
            what is off. The state word is the part that gives way: the switch
            beside it already shows the state, and when it is on the whole
            control is in the on-state red. The word comes back from 2xl, where
            the row has room. The accessible name is the switch's own
            aria-label, so it never depends on this text. */}
          One-Click
          <span className="hidden 2xl:inline"> {armed ? 'ON' : 'off'}</span>
        </span>
      </label>
    </Tip>
  )

  const workspaceControls = (
    <>
      {/* These are the workspace, not this chart: the grid and what syncs
          across it, the saved layouts and studies, and whether a click
          anywhere in it sends an order. Three groups, each behind a hairline. */}
      <ToolbarDivider />
      {layoutPicker}
      {syncPicker}
      <ToolbarDivider />
      {workspaceMenu}
      <IndicatorTemplates key={account} {...workspaceCatalog} target={panelTarget} />
      <ToolbarDivider />
      {armedControl}
      {/* The option chain opens as a floating window over the chart (same
        shared vanilla module the /charts band opens — see RightPanel.tsx,
        which publishes the toggle as window.__oaChainToggle at mount). */}
      <Tip
        tip={{
          title: 'Option chain',
          sub: 'Chain table over the chart (Esc closes it)',
        }}
      >
        <button
          type="button"
          aria-label="Option chain"
          className={TB_BTN}
          onClick={() => {
            const w = window as unknown as { __oaChainToggle?: () => void }
            w.__oaChainToggle?.()
          }}
        >
          <ChromeIcon id="chart-histogram" />
          <span className={`${TB_LABEL_2XL} whitespace-nowrap`}>Chain</span>
        </button>
      </Tip>
    </>
  )

  return (
    <ChartOrderBridgeContext.Provider value={orderBridge}>
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Rail + grid */}
        <div aria-live="polite">
          {autosave.error && (
            <p role="alert" className="px-3 py-1 text-sm text-destructive">
              Workspace not saved: {autosave.error}
            </p>
          )}
          {workspaceMessage !== 'Saved' && workspaceMessage !== 'Unsaved' && (
            <p role="alert" className="px-3 py-1 text-sm text-destructive">
              {workspaceMessage}
            </p>
          )}
          {workspace.pending && (
            <output className="flex items-center gap-3 px-3 py-1 text-sm">
              Loading workspace...
              <Button variant="ghost" size="sm" onClick={workspace.cancel}>
                Cancel
              </Button>
            </output>
          )}
          {workspace.error && (
            <p role="alert" className="px-3 py-1 text-sm text-destructive">
              {workspace.error}
            </p>
          )}
        </div>
        {/* The terminal's one header. The app's navbar is not on this page:
            the chart takes the viewport, and the way back to the dashboard
            sits at the left end of this row. The right end carries only the
            chart's own controls (rendered into the toolbar host), because the
            desk is not an account surface — no broker badge, no Live pill and
            no profile menu here. */}
        <div className="oa-terminal-band flex h-10 shrink-0 items-center border-b">
          <Tip tip={{ title: 'Dashboard', sub: 'Leave the terminal for the dashboard' }}>
            <Link to="/dashboard" aria-label="Dashboard" className={cn(TB_BTN, 'ml-1 gap-1')}>
              <ChromeIcon id="chevron-left" size={14} className="opacity-70" />
              <span className="hidden md:inline">Dashboard</span>
            </Link>
          </Tip>
          <ToolbarDivider />
          <div
            ref={setToolbarHost}
            className="h-full min-w-0 flex-1 [&>[role=toolbar]]:h-full"
            data-workspace-toolbar
          />
        </div>
        <main className="flex min-h-0 flex-1" inert={workspace.pending ? true : undefined}>
          {apiKey && wsUrl && (
            <DrawingRail
              folded={!showRail}
              onFold={() => setShowRail(false)}
              stats={railStats}
              latched={latched}
              onPick={pickTool}
              onUndo={() => act((t) => t.historyPress('undo'))}
              onRedo={() => act((t) => t.historyPress('redo'))}
              onDeleteSelected={() => act((t) => t.removeDrawings(false))}
              onRemoveAll={() => act((t) => t.requestRemoveAllDrawings())}
              onSelectAll={() => act((t) => t.selectAllDrawings())}
              onHideSelected={() => act((t) => t.hideSelectedDrawings())}
              onLockSelected={() => act((t) => t.styleSelectedDrawing({ locked: true }))}
              onMagnet={(v) => {
                setMagnet(v)
                if (visibleGrid.current)
                  for (const terminal of visibleGrid.current.terminals.values())
                    terminal.setMagnet(v)
              }}
              onStay={(v) => {
                setStay(v)
                if (visibleGrid.current)
                  for (const terminal of visibleGrid.current.terminals.values())
                    terminal.setDrawStay(v)
              }}
              onShortcut={onDrawKey}
            />
          )}
          <div className="relative min-h-0 min-w-0 flex-1">
            {noApiKey ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-sm text-muted-foreground">No API key found for charting.</p>
                <a href="/apikey" className="text-sm font-medium text-primary underline">
                  Generate an API key
                </a>
              </div>
            ) : apiKey && wsUrl && linkGroup ? (
              <div className="relative h-full">
                {/* The grid stops above the bottom bar's strip, kept clear from
                    the first render so nothing moves when the bar arrives. */}
                {!showRail && (
                  <DrawingRailTab onUnfold={() => setShowRail(true)} bottom={RAIL_TAB_BOTTOM} />
                )}
                <div className="absolute inset-x-0 top-0" style={{ bottom: BOTTOM_BAR_PX }}>
                  {!workspace.current && (
                    <div
                      key="unnamed"
                      className="grid h-full min-h-0 gap-2 p-2"
                      style={{
                        gridTemplateColumns: sizedLayout.cols,
                        gridTemplateRows: sizedLayout.rows,
                        gridTemplateAreas: layout.areas,
                      }}
                    >
                      {layout.cells.map((cell, i) => (
                        <ChartPane
                          key={`p${i}`}
                          paneId={`p${i}`}
                          paneLabel={`Chart ${i + 1}`}
                          toolbarHost={toolbarHost}
                          focused={focusedPane === `p${i}`}
                          apiKey={apiKey}
                          wsUrl={wsUrl}
                          style={{ gridArea: cell }}
                          sharedTool={tool}
                          sharedMagnet={magnet}
                          sharedStay={stay}
                          sharedLatch={latched}
                          onWorkspaceChange={autosave.changed}
                          onReplayStart={startWorkspaceReplay}
                          workspaceReplay={replaySnapshot}
                          onBeforeSourceChange={stopWorkspaceReplay}
                          onFocusPane={focusPane}
                          onSymbolChange={(id, key) => {
                            if (!visibleGrid.current) noteSymbol(id, key)
                          }}
                          onIntervalChange={() => {
                            if (!visibleGrid.current) noteChartChanged()
                          }}
                          onTerminalChange={noteTerminal}
                          onObjectsChange={(id, objects) => {
                            if (!visibleGrid.current) noteObjects(id, objects)
                          }}
                          onAlertsReady={(id, view) => {
                            if (!visibleGrid.current) noteAlerts(id, view)
                          }}
                          onAlertFired={noteAlertFired}
                          onAlertsChanged={() => setAlertRevision((n) => n + 1)}
                          onDrawStats={(value) => {
                            if (!visibleGrid.current) onPaneDrawStats(value)
                          }}
                          onToggleRail={() => setShowRail((v) => !v)}
                          railVisible={showRail}
                          linkGroup={linkGroup}
                          armed={armed}
                          transitionLocked={workspace.pending}
                          layoutPicker={workspaceControls}
                        />
                      ))}
                    </div>
                  )}
                  {!workspace.current && layout.cells.length > 1 && !workspace.pending && (
                    <GridDividers
                      key={layout.id}
                      cells={parseAreas(layout.areas)}
                      weights={gridWeights}
                      onChange={(weights) => setLiveWeights({ id: layout.id, weights })}
                      onCommit={keepGridWeights}
                      onReset={() => keepGridWeights(presetWeights(layout))}
                    />
                  )}
                  {workspace.grids.map((owner) => (
                    <WorkspaceGrid
                      key={owner.key}
                      owner={owner}
                      active={workspace.current === owner}
                      toolbarHost={toolbarHost}
                      focusedPaneId={focusedPane}
                      apiKey={apiKey}
                      wsUrl={wsUrl}
                      sharedTool={tool}
                      sharedLatch={latched}
                      transitionLocked={workspace.pending}
                      armed={armed}
                      railVisible={showRail}
                      onToggleRail={() => setShowRail((value) => !value)}
                      onWorkspaceChange={autosave.changed}
                      onReplayStart={startWorkspaceReplay}
                      workspaceReplay={replaySnapshot}
                      onBeforeSourceChange={stopWorkspaceReplay}
                      onFocusPane={focusPane}
                      onSymbolChange={noteSymbol}
                      onIntervalChange={noteChartChanged}
                      onObjectsChange={noteObjects}
                      onAlertsReady={noteAlerts}
                      onAlertFired={noteAlertFired}
                      onAlertsChanged={() => setAlertRevision((n) => n + 1)}
                      onDrawStats={onPaneDrawStats}
                      onTerminalChange={(id, terminal) => {
                        if (visibleGrid.current !== owner) return
                        if (terminal) terminalsRef.current[id] = terminal
                        else delete terminalsRef.current[id]
                        updateReplayMembers()
                      }}
                      layoutPicker={workspaceControls}
                    />
                  ))}
                  <WorkspaceReplayBar
                    snapshot={replaySnapshot}
                    error={replayError}
                    ownerLabel={
                      replaySnapshot.ownerId
                        ? (paneSymbols[replaySnapshot.ownerId] ?? replaySnapshot.ownerId)
                        : undefined
                    }
                    onScopeChange={(scope) => replayCoordinator.current?.setScope(scope)}
                    onPlay={(speed) => replayCoordinator.current?.play(speed)}
                    onPause={() => replayCoordinator.current?.pause()}
                    onStep={() => replayCoordinator.current?.step()}
                    onStepBack={() => replayCoordinator.current?.stepBack()}
                    onSeek={(index) => replayCoordinator.current?.seek(index)}
                    onStop={requestReplayExit}
                    confirmExit={confirmReplayExit}
                    onCancelExit={() => setConfirmReplayExit(false)}
                    onConfirmExit={stopWorkspaceReplay}
                    pick={replayPick}
                    interval={
                      replaySnapshot.ownerId
                        ? terminalsRef.current[replaySnapshot.ownerId]?.currentInterval()
                        : undefined
                    }
                  />
                </div>
                <ChartBottomBar
                  pane={panelTarget}
                  panes={() =>
                    Object.values(terminalsRef.current).filter(
                      (terminal): terminal is TradingTerminal => terminal !== null
                    )
                  }
                  focusKey={focusedPane}
                  control={bottomBar}
                />
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading charting terminal…
              </div>
            )}
          </div>

          {/* The right edge: the /charts panel (Watchlist / Option chain /
              Algo symbols), mounted from the shared module. Page-level, like
              the rail it replaces — it acts on the focused pane rather than
              belonging to one chart — and it owns its own /ws client, so it
              stays live independently of the grid feeds. */}
          {apiKey && wsUrl && (
            <RightPanel
              onOpenSymbol={(tsym, exchange) => sendToFocusedPane({ symbol: tsym, exchange })}
              getChartContext={() => {
                // The focused pane's instrument key — "EXCH:SYMBOL" (the same
                // shape the link groups agree on). The panel's readChartSymbol
                // splits it.
                return paneSymbols[focusedPane] ?? null
              }}
            />
          )}
        </main>

        {/* The bottom dock: orders, positions and trades across every symbol.
            Under the rails and the side panel, full width, because the books
            are the workspace's and not one pane's. */}
        {apiKey && wsUrl && (
          <TradingDock
            tab={dock}
            onTabChange={setDock}
            apiKey={apiKey}
            onPick={sendToFocusedPane}
            activeSymbol={paneSymbols[focusedPane] ?? null}
            tradingLocked={tradingLocked}
            bridge={orderBridge}
          />
        )}
      </div>
    </ChartOrderBridgeContext.Provider>
  )
}
