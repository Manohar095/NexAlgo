/**
 * Chart settings form: the dialog behind the toolbar's gear.
 *
 * The chart engine is canvas-only and ships no DOM, so it describes its own
 * settings declaratively -- `chartSettingsSchema` returns the tabs and their
 * controls, `readChartSettings` the current values, `applyChartSettings` takes
 * a patch. Nothing here hardcodes a setting, so a control the engine adds in a
 * later version appears without a change to this file.
 *
 * It reuses `SettingsField` from the indicator dialog because the engine
 * deliberately describes chart settings with the same input vocabulary. The one
 * widget it adds is `colorPair`: a bullish/bearish pair is one row, and drawing
 * it as two stacked colour rows costs three times the height for the property a
 * trader changes most.
 *
 * The shell is a port of the vendored widget's own dialog -- the one `/charts`
 * opens from its gear (`oac-settings` / `oac-dialog` / `oac-form` in
 * `openalgo-charts.widget.mjs`). It is a port rather than a reuse because that
 * dialog is package-internal: the React host only gets `widget.openSettings()`,
 * with no way to mount it over its own request. So the metrics below are copied
 * verbatim from the package's stylesheet, which is what makes the two chart
 * pages read as one product:
 *
 *   dialog   600px wide, `calc(100% - 24px)` cap, radius 12, 1px hairline
 *   head     `12px 14px 8px`, title 14px/700, a 28px icon close
 *   body     `4px 14px 10px`, scrolls -- the pane does not
 *   main     grid `auto minmax(0,1fr)`, gap `0 12px`
 *   rail     138px, `2px 10px 2px 0`, 1px right hairline, 2px between tabs
 *   tab      30px tall, `0 10px`, gap 9, radius 7, nowrap
 *   form     grid, 1px between rows, rows `min-height 30px`, `gap 8px`
 *   row      a 15px switch/spacer column, then the label, then the controls in
 *            one fixed column -- `min(232px, 58%)` -- so their left edge never
 *            steps in and out as you read down the form
 *   head row 10px/600 uppercase, `10px 0 3px` (`2px` when first)
 *   foot     `10px 14px 12px`, top hairline, Restore left, Cancel/OK right
 *
 * The one behaviour that cannot be copied as a number is the package's
 * responsive rule. The package lays this dialog out inside the chart's own
 * container and switches to a single column with the tabs running horizontally
 * when that container is 720px or narrower -- i.e. in any multi-chart layout,
 * where each cell is narrower than a lone chart. `@container oac-widget` cannot
 * fire here (this dialog is not inside the package's DOM), so the cell width is
 * measured instead and the same rule applied at the same 720px threshold. A
 * single chart therefore keeps the rail, exactly as `/charts` does.
 */
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import type {
  ChartSettingsField,
  ChartSettingsPairField,
  ChartSettingsRequest,
} from '@/lib/trading/terminal'
import { conditionHolds } from '@/lib/trading/inputConditions'
import { ChromeIcon } from '@/lib/trading/glyphs'
import { cn } from '@/lib/utils'
import { SettingsField } from './IndicatorSettingsDialog'
import { TickBox } from './TickBox'

type Value = string | number | boolean

/**
 * The container width at which the package turns the rail into a row
 * (`@container oac-widget (max-width: 720px)`).
 */
const COMPACT_MAX = 720

/**
 * The engine's own glyphs, one per settings tab — the same map the vendored
 * widget's dialog uses (`price → chart-candlestick`, `readout → legend`,
 * `axes → axes`, `appearance → panels`, `trading → trading`). A tab this host
 * adds beyond that set (Volume) gets the closest glyph rather than no icon.
 */
const TAB_ICONS: Readonly<Record<string, string>> = {
  price: 'chart-candlestick',
  readout: 'legend',
  axes: 'axes',
  appearance: 'panels',
  trading: 'trading',
  volume: 'chart-histogram',
}

/**
 * The chart-settings palette, pinned on the dialog root.
 *
 * The trading desk is a dark surface, but this app's shadcn tokens resolve to
 * the LIGHT palette (`data-theme="zinc"` with no `.dark` on the root), which is
 * why this form used to paint white over a black chart. The values below are
 * the ones the `/charts` dialog actually renders (600×384 surface `#15161a`,
 * hairline `#2a3046`, text `#cbced7`, accent `#4f8cff`), so the two pages read
 * as one product. They are declared as the standard tokens rather than as
 * per-element colours: every control inside (TickBox, the shared
 * `SettingsField` inputs) keeps reading `--border` / `--background` /
 * `--primary` and comes out dark for free.
 */
const PALETTE = {
  '--background': '#1e1f23',
  '--foreground': '#cbced7',
  '--card': '#15161a',
  '--card-foreground': '#cbced7',
  '--popover': '#15161a',
  '--popover-foreground': '#cbced7',
  '--primary': '#4f8cff',
  '--primary-foreground': '#ffffff',
  '--secondary': '#23262f',
  '--secondary-foreground': '#cbced7',
  '--muted': '#1e1f23',
  '--muted-foreground': '#838690',
  '--accent': '#23262f',
  '--accent-foreground': '#e5e7eb',
  '--border': '#2a3046',
  '--input': '#2a3046',
  '--ring': '#4f8cff',
} as CSSProperties

/**
 * The package's row geometry, shared by every kind of row: the switch/spacer
 * column, then the label, then one fixed control column.
 */
const ROW = 'flex min-h-[30px] items-center gap-2 py-px'
const ROW_CTL = 'flex w-[min(232px,58%)] min-w-0 shrink-0 items-center justify-end gap-1.5'

interface Props {
  req: ChartSettingsRequest | null
  onApply(patch: Record<string, Value>): void
  onClose(): void
}

const isPair = (f: ChartSettingsField): f is ChartSettingsPairField => f.type === 'colorPair'

export function ChartSettingsDialog({ req, onApply, onClose }: Props) {
  const [values, setValues] = useState<Record<string, Value>>({})
  const [tabId, setTabId] = useState<string>('')
  /** Narrow cell (any multi-chart layout) → horizontal tabs, single column. */
  const [compact, setCompact] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setValues(req ? { ...req.values } : {})
    setTabId(req?.initialTab ?? req?.tabs[0]?.id ?? '')
  }, [req])

  // Attached before the form is painted. The form mounts on its first opening,
  // and a passive effect can run after the first paint, so an Escape pressed
  // the moment the form appeared went unheard.
  useLayoutEffect(() => {
    if (!req) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [req, onClose])

  /**
   * Measure the chart cell this dialog sits in, the way the package's container
   * query measures the widget. The overlay is `inset-0` of that cell, so its own
   * width IS the container width — and it is re-read on resize, because a layout
   * change under an open dialog moves the threshold too.
   */
  useLayoutEffect(() => {
    const el = hostRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      setCompact(w > 0 && w <= COMPACT_MAX)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [req])

  const tab = useMemo(
    () => req?.tabs.find((t) => t.id === tabId) ?? req?.tabs[0] ?? null,
    [req, tabId]
  )

  /**
   * What "Restore this tab" puts back: the host's own baseline for the controls
   * on the tab in front of the user, and nothing else.
   *
   * Deliberately NOT assembled from the schema's per-control defaults, even
   * though every engine input publishes one. Those are the ENGINE's defaults,
   * and this host does not build a bare engine chart: it turns the corner
   * session clock and the bar countdown on at construction, and the grid is
   * owned by the context menu under a separate key. Resetting to the schema
   * would switch off chrome nobody touched and pick a fight over the grid.
   * See `snapshotChartDefaults` for where the baseline is taken.
   *
   * Colours in it are the chart's ACTIVE THEME's, not a fixed palette, so
   * resetting in dark mode restores the dark candles rather than the light ones.
   */
  const defaults = useMemo(() => req?.defaults ?? {}, [req])

  /** Every key the visible tab owns — pairs contribute three keys, not one. */
  const tabKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const f of tab?.inputs ?? []) {
      if (isPair(f)) {
        keys.add(f.up.key)
        keys.add(f.down.key)
        if (f.enabled) keys.add(f.enabled.key)
      } else {
        keys.add(f.key)
      }
    }
    return [...keys]
  }, [tab])

  const tabDefaults = useMemo(() => {
    const out: Record<string, Value> = {}
    for (const k of tabKeys) {
      const v = defaults[k]
      if (v !== undefined) out[k] = v
    }
    return out
  }, [tabKeys, defaults])

  /**
   * Whether anything ON THIS TAB currently deviates. Restore stays pressable
   * either way (it is idempotent, like the package's), so this only feeds the
   * tooltip — but it is still the honest answer to "is this tab already at
   * defaults", which is what the hint should say.
   */
  const deviates = useMemo(
    () => Object.entries(tabDefaults).some(([k, v]) => values[k] !== undefined && values[k] !== v),
    [tabDefaults, values]
  )

  if (!req || !tab) return null

  const set = (key: string, v: unknown) => setValues((prev) => ({ ...prev, [key]: v as Value }))

  // A control that means something only beside another one (a point and
  // figure box size in fixed mode) shows only then. The empty state reads this
  // list too, so a tab whose every control is hidden says so.
  const shownInputs = tab.inputs.filter(
    (f) => isPair(f) || !f.visibleWhen || conditionHolds(f.visibleWhen, values)
  )

  /**
   * Send only what changed. The engine writes exactly the keys it is handed, so
   * a one-control edit stays a one-key patch -- which is also what gets
   * persisted, keeping a pane's stored settings to what the user actually
   * chose rather than a snapshot of every default.
   */
  const apply = () => {
    const patch: Record<string, Value> = {}
    for (const [k, v] of Object.entries(values)) {
      if (req.values[k] !== v) patch[k] = v
    }
    if (Object.keys(patch).length) onApply(patch)
    onClose()
  }

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 z-40 flex items-center justify-center bg-[rgba(6,8,12,0.55)]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="presentation"
    >
      <div
        className="dark flex max-h-[calc(100%-24px)] w-[600px] max-w-[calc(100%-24px)] flex-col rounded-[12px] border border-border bg-popover leading-[1.35] text-foreground shadow-2xl"
        style={PALETTE}
        role="dialog"
        aria-modal="true"
        aria-label="Chart settings"
      >
        {/* Title */}
        <div className="flex shrink-0 items-center gap-2 px-[14px] pb-2 pt-3">
          <h3 className="min-w-0 flex-1 text-[14px] font-bold text-[#e5e7eb]">Chart settings</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {/* Body: the whole main grid scrolls, as the package's dialog body does
            (`overflow: auto`), so a tall tab never stretches the card past the
            cell and the foot stays where it is. */}
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-[14px] pb-2.5 pt-1">
          <div
            className="grid min-h-0 gap-x-3"
            style={{ gridTemplateColumns: compact ? '1fr' : 'auto minmax(0,1fr)' }}
          >
            {/* Tabs. Down a 138px rail while the cell is wide; a horizontal,
                scrollable strip once it is not — the package's 720px container
                rule. The strip is `flex-none` so it takes its own height and
                the pane below it gets the rest. */}
            <div
              className={cn(
                'flex min-w-0 gap-0.5',
                compact
                  ? 'flex-none flex-row overflow-x-auto border-b border-[#1e2334] pb-1.5'
                  : 'min-w-[138px] flex-col border-r border-[#1e2334] pb-0.5 pr-2.5 pt-0.5'
              )}
              role="tablist"
              aria-orientation={compact ? 'horizontal' : 'vertical'}
              aria-label="Settings sections"
            >
              {req.tabs.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  role="tab"
                  aria-selected={t.id === tab.id}
                  onClick={() => setTabId(t.id)}
                  className={cn(
                    'flex h-[30px] shrink-0 items-center gap-[9px] whitespace-nowrap rounded-[7px] border px-2.5 text-left text-[12.5px] transition-colors',
                    t.id === tab.id
                      ? 'border-[#315394] bg-[#4f8cff]/16 text-[#72a3ff]'
                      : 'border-transparent text-[#8b91a7] hover:bg-accent hover:text-foreground'
                  )}
                >
                  <ChromeIcon id={TAB_ICONS[t.id] ?? 'settings'} size={16} />
                  <span className="truncate">{t.label}</span>
                </button>
              ))}
            </div>

            {/* Fields. The pane carries the package's `2px 4px 4px 0`, and the
                form inside it is a 1px-gap grid so every row keeps the same
                height whether or not it has help text under it. */}
            <div className="min-w-0 pb-1 pr-1 pt-0.5">
              <div className="grid min-w-0 content-start gap-px">
                {groupsOf(shownInputs).map(([heading, group], gi) => (
                  <Fragment key={`${tab.id}-${heading}`}>
                    {heading && (
                      <div
                        className={cn(
                          'pb-[3px] text-[10px] font-semibold uppercase tracking-[0.7px] text-muted-foreground',
                          gi === 0 ? 'pt-0.5' : 'pt-2.5'
                        )}
                      >
                        {heading}
                      </div>
                    )}
                    <FieldGroup
                      fields={group}
                      tabId={tab.id}
                      values={values}
                      onChange={set}
                    />
                  </Fragment>
                ))}
              </div>
              {shownInputs.length === 0 && (
                <p className="px-1.5 py-2.5 text-[12.5px] text-muted-foreground">
                  Nothing to configure here.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Footer: the tab's own restore on the left, the confirming action last.

            Restore covers THIS tab, matching its label — a press that silently
            reached into four other tabs would be the kind of half-truth worth
            not shipping. It is deferred like every other edit here: it fills the
            form, and Cancel still walks away from it. */}
        <div
          className={cn(
            'flex shrink-0 flex-wrap items-center border-t border-[#1e2334] px-[14px] pb-3 pt-2.5',
            compact ? 'gap-1.5' : 'gap-2'
          )}
        >
          <button
            type="button"
            onClick={() => setValues((prev) => ({ ...prev, ...tabDefaults }))}
            title={
              deviates
                ? 'Restore this tab to the chart’s defaults'
                : 'This tab is already at its defaults'
            }
            className="h-7 rounded-[7px] px-[9px] text-[12.5px] text-foreground transition-colors hover:bg-accent"
          >
            Restore this tab
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-7 rounded-[7px] border border-[#1e2334] px-[9px] text-[12.5px] transition-colors hover:border-muted-foreground hover:bg-accent"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              className="h-7 rounded-[7px] bg-primary px-[9px] text-[12.5px] font-semibold text-[#0d0e12] transition-opacity hover:opacity-90"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Controls bucketed by their `group` sub-heading, in first-seen order. */
function groupsOf(fields: ChartSettingsField[]): [string, ChartSettingsField[]][] {
  const out = new Map<string, ChartSettingsField[]>()
  for (const f of fields) {
    const k = f.group ?? ''
    const list = out.get(k) ?? []
    list.push(f)
    out.set(k, list)
  }
  return [...out]
}

/**
 * The rows of one sub-heading.
 *
 * Every row is the package's three columns: a 16px switch/spacer slot (the
 * checkbox's own width, so a column of checkboxes lines up with the labels of
 * the rows that have no checkbox), the label, and the controls in one fixed
 * column. The labels of checkbox rows sit AFTER their box, which is why the
 * rows without one carry the spacer — the text stays in one vertical line all
 * the way down the form.
 */
function FieldGroup({
  fields,
  tabId,
  values,
  onChange,
}: {
  fields: ChartSettingsField[]
  tabId: string
  values: Record<string, Value>
  onChange(key: string, v: unknown): void
}) {
  return (
    <>
      {fields.map((f) => {
        if (isPair(f)) {
          return (
            <div key={f.key} className={ROW}>
              <ColorPairRow field={f} values={values} onChange={onChange} />
            </div>
          )
        }
        // A checkbox belongs beside its own name, not a column away from it:
        // the package's rows read "☑ Wick", and a boolean drawn through
        // `SettingsField` would put the box in the control column, at the far
        // right of the row. Everything else keeps the shared field renderer.
        if (f.type === 'boolean') {
          const id = `chart-${tabId}-${f.key}`
          return (
            <div key={f.key} className={ROW}>
              <TickBox
                id={id}
                checked={values[f.key] === true}
                onChange={(v) => onChange(f.key, v)}
                label={f.label}
              />
              <label
                htmlFor={id}
                className="min-w-0 flex-1 cursor-pointer text-[12.5px] text-foreground"
              >
                {f.label}
              </label>
              <div className="w-[min(232px,58%)] min-w-0 shrink-0" />
            </div>
          )
        }
        // Selects, numbers and colours get a fixed control column, the way the
        // package's rows do: a select that sized itself to its own text ("Default")
        // would be a stub of a control in a 420px pane. The label is indented by
        // the same switch slot the checkbox rows use, so all the labels align.
        return (
          <div
            key={f.key}
            className="grid min-h-[30px] items-center gap-x-2 py-px [&>label]:pl-[23px] [&>label]:text-[12.5px] [&>label]:text-foreground"
            style={{ gridTemplateColumns: 'minmax(0,1fr) min(232px,58%)' }}
          >
            <SettingsField
              field={f}
              id={`chart-${tabId}-${f.key}`}
              value={values[f.key]}
              onChange={(v) => onChange(f.key, v)}
            />
          </div>
        )
      })}
    </>
  )
}

/**
 * `[x] Borders   [up] [down]` -- two swatches on one labelled row.
 *
 * The checkbox is drawn only when the pair actually has a visibility flag
 * behind it. A candle body is always painted, so a checkbox there would be a
 * control that does nothing.
 */
export function ColorPairRow({
  field,
  values,
  onChange,
}: {
  field: ChartSettingsPairField
  values: Record<string, Value>
  onChange(key: string, v: unknown): void
}) {
  const enabledKey = field.enabled?.key
  const on = enabledKey ? values[enabledKey] !== false : true
  const id = enabledKey ? `chart-${enabledKey}` : undefined

  return (
    <>
      {enabledKey ? (
        <TickBox
          id={id}
          checked={on}
          onChange={(next) => onChange(enabledKey, next)}
          label={field.label}
        />
      ) : (
        <span className="w-4 shrink-0" aria-hidden="true" />
      )}
      <label
        htmlFor={id}
        className="min-w-0 flex-1 cursor-pointer text-[12.5px] text-foreground"
      >
        {field.label}
      </label>
      <div className={cn(ROW_CTL, !on && 'pointer-events-none opacity-40')}>
        {[field.up, field.down].map((side) => (
          <input
            key={side.key}
            type="color"
            value={
              typeof values[side.key] === 'string' ? (values[side.key] as string) : side.default
            }
            onChange={(e) => onChange(side.key, e.target.value)}
            aria-label={`${field.label} ${side.label}`}
            title={side.label}
            className="h-[26px] w-[26px] cursor-pointer rounded-md border border-border bg-transparent p-0 [&::-moz-color-swatch]:rounded [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-[3px] [&::-webkit-color-swatch]:rounded [&::-webkit-color-swatch]:border-0"
          />
        ))}
      </div>
    </>
  )
}
