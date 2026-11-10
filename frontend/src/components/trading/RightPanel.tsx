import { useEffect, useRef } from 'react'

/**
 * The right edge of the desk: the `/charts` panel (Watchlist / Option chain /
 * Algo symbols), mounted from the shared vanilla module.
 *
 * The panel is one implementation for both desks — `static/panels/right_panel.mjs`
 * is the same code `/charts` runs, extracted there and mounted here, so the
 * three tabs, their markup, their styles and every `/api` call behind them are
 * identical on both pages. The module is loaded at runtime (not bundled) for
 * the same reason: a second copy in the Vite bundle would be a second thing to
 * keep in sync.
 *
 * The module speaks the token-keyed market-data protocol itself when no
 * adapter is supplied (desired-state `/ws` subscriptions, 45s/60s watchdog,
 * 5s `/api/multiquotes` fallback while the socket is down), so this page needs
 * to hand it nothing but the symbol click: the panel's symbol rows and option
 * chain legs load into the focused chart pane.
 */

/** What `mountRightPanel` hands back (see static/panels/right_panel.mjs). */
interface RightPanelApi {
  open: (id: 'watchlist' | 'pichain' | 'algo') => void
  /** Toggle the floating Option-chain window (the band's Chain button). */
  toggleOptionChain?: () => void
  refreshAlgoSymbols: () => void
  destroy: () => void
}

interface MountOptions {
  host: HTMLElement
  adapter?: {
    subscribe?: (exchange: string, token: string) => unknown
    unsubscribe?: (exchange: string, token: string) => unknown
    connected?: () => boolean
    addChartToken?: (exchange: string, tsym: string, token: string) => void
    registerChartTokens?: (symbols: unknown[]) => void
    openSymbol?: (tsym: string, exchange: string) => void
    /** Reads the focused chart's symbol for the Algo panel's "This chart". */
    getChartContext?: () => unknown
  }
}

export function RightPanel({
  onOpenSymbol,
  getChartContext,
}: {
  /** Load a panel row's instrument into the focused chart pane. */
  onOpenSymbol?: (tsym: string, exchange: string) => void
  /** Read the focused chart's symbol — the Algo panel's "This chart" preselect. */
  getChartContext?: () => unknown
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<RightPanelApi | null>(null)
  // Read at call time: the panel outlives any one render, and the pane it
  // loads into is whatever the trader last focused.
  const openSymbolRef = useRef(onOpenSymbol)
  openSymbolRef.current = onOpenSymbol
  const chartContextRef = useRef(getChartContext)
  chartContextRef.current = getChartContext

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let dead = false
    void (async () => {
      // The URL is a variable so the bundler leaves it alone: the panel is one
      // file shared with the vanilla /charts page, not a second bundled copy.
      const url = '/static/panels/right_panel.mjs'
      const mod = (await import(/* @vite-ignore */ url)) as {
        mountRightPanel: (options: MountOptions) => RightPanelApi
      }
      // The effect may have been torn down while the module was in flight
      // (React's development double-mount); the host ref is the real answer.
      if (dead || !hostRef.current) return
      apiRef.current = mod.mountRightPanel({
        host: hostRef.current,
        adapter: {
          openSymbol: (tsym, exchange) => openSymbolRef.current?.(tsym, exchange),
          getChartContext: () => chartContextRef.current?.(),
        },
      })
      // The Chain button lives in the chart component and cannot import this
      // vanilla module, so the mounted module hands its toggle over globally;
      // ChartPane.tsx reads `window.__oaChainToggle` at call time. Cleared on
      // unmount so a torn-down panel can never be toggled.
      ;(window as unknown as { __oaChainToggle?: () => void }).__oaChainToggle =
        () => apiRef.current?.toggleOptionChain?.()
    })()
    return () => {
      dead = true
      delete (window as unknown as { __oaChainToggle?: () => void }).__oaChainToggle
      apiRef.current?.destroy()
      apiRef.current = null
    }
  }, [])

  return (
    <div
      ref={hostRef}
      // `oa-panel-scope` carries the panel's own dark `--oa-*` palette; the
      // flex row is what `#workArea` is on /charts — the shell and the rail
      // are injected here as its children.
      className="oa-panel-scope flex min-h-0 shrink-0 items-stretch"
      data-right-panel-host
    />
  )
}
