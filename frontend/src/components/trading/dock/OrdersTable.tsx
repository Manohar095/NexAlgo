/**
 * The order book as a dock table: every order today, across every symbol,
 * with Cancel and Modify on the ones still working.
 *
 * Column order and vocabulary is the broker's own (Time, Symbol, Exchange,
 * norenordno, exchordid, Side, Price Type, Product Type, Qty, Trigger,
 * Average Price, Status, Remarks) — `prc` is NOT shown; what the row is worth
 * lives in the fill's average price, and the reject reason rides Remarks.
 */

import { Button } from '@/components/ui/button'
import type { SearchRow } from '@/lib/trading/terminal'
import { cn } from '@/lib/utils'
import { type DockOrder, isWorking } from './blotter'
import {
  EmptyRows,
  isActiveRow,
  isRowClick,
  ROW,
  ROW_ACTIVE,
  StatusBadge,
  SymbolCell,
  sideClass,
  TD,
  TD_NUM,
  TH,
  TH_NUM,
} from './cells'
import { fmt2, formatTime } from './format'

interface Props {
  orders: DockOrder[]
  activeSymbol?: string | null
  onPick(row: SearchRow): void
  onCancel(order: DockOrder): void
  onModify(order: DockOrder): void
  isLoading?: boolean
}

/** Columns the dock paints = data columns + the trailing Actions column. */
const COLS = 14

/** What a row remarks: the reject reason when the broker refused, else the
 * order-entry remarks the request carried. */
function remarksText(order: DockOrder): string {
  return order.rejection_reason || order.remarks || ''
}

export function OrdersTable({
  orders,
  activeSymbol,
  onPick,
  onCancel,
  onModify,
  isLoading,
}: Props) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr>
          <th scope="col" className={TH}>
            Time
          </th>
          <th scope="col" className={TH}>
            Symbol
          </th>
          <th scope="col" className={TH}>
            Exchange
          </th>
          <th scope="col" className={TH}>
            Order No
          </th>
          <th scope="col" className={TH}>
            Exch Ord ID
          </th>
          <th scope="col" className={TH}>
            Side
          </th>
          <th scope="col" className={TH}>
            Price Type
          </th>
          <th scope="col" className={TH}>
            Product Type
          </th>
          <th scope="col" className={TH_NUM}>
            Qty
          </th>
          <th scope="col" className={TH_NUM}>
            Trigger
          </th>
          <th scope="col" className={TH_NUM}>
            Average Price
          </th>
          <th scope="col" className={TH}>
            Status
          </th>
          <th scope="col" className={TH}>
            Remarks
          </th>
          <th scope="col" className={cn(TH, 'text-right')}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {orders.length === 0 && (
          <EmptyRows colSpan={COLS}>{isLoading ? 'Loading orders' : 'No orders today.'}</EmptyRows>
        )}
        {orders.map((order, i) => {
          const working = isWorking(order.order_status)
          const active = isActiveRow(activeSymbol, order)
          const remarks = remarksText(order)
          return (
            <tr
              key={order.orderid || `${i}-${order.timestamp}-${order.exchange_order_id}-${order.symbol}`}
              className={cn(ROW, active && ROW_ACTIVE)}
              onClick={(e) => {
                if (isRowClick(e)) onPick({ symbol: order.symbol, exchange: order.exchange })
              }}
            >
              <td className={cn(TD, 'tabular-nums text-muted-foreground')}>
                {formatTime(order.timestamp)}
              </td>
              <SymbolCell
                symbol={order.symbol}
                exchange={order.exchange}
                active={active}
                onPick={onPick}
              />
              <td className={cn(TD, 'text-muted-foreground')}>{order.exchange}</td>
              <td className={cn(TD, 'max-w-[170px] truncate tabular-nums')} title={order.order_no}>
                {order.order_no || '-'}
              </td>
              <td
                className={cn(TD, 'max-w-[170px] truncate tabular-nums')}
                title={order.exchange_order_id}
              >
                {order.exchange_order_id || '-'}
              </td>
              <td className={cn(TD, 'font-medium', sideClass(order.action))}>{order.action}</td>
              <td className={TD}>{order.pricetype}</td>
              <td className={cn(TD, 'text-muted-foreground')}>{order.product}</td>
              <td className={TD_NUM}>{qtyText(order)}</td>
              <td className={cn(TD_NUM, !order.trigger_price && 'text-muted-foreground')}>
                {order.trigger_price ? fmt2(order.trigger_price) : '-'}
              </td>
              <td className={cn(TD_NUM, !order.average_price && 'text-muted-foreground')}>
                {order.average_price ? fmt2(order.average_price) : '-'}
              </td>
              <td className={TD}>
                <StatusBadge status={order.order_status} />
              </td>
              <td
                className={cn(TD, 'max-w-[240px] truncate text-[11px] text-muted-foreground')}
                title={remarks}
              >
                {remarks || '-'}
              </td>
              <td className={cn(TD, 'text-right')}>
                {working && (
                  <span className="inline-flex gap-1">
                    {order.pricetype !== 'MARKET' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() => onModify(order)}
                        aria-label={`Modify order ${order.orderid} for ${order.symbol}`}
                      >
                        Modify
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-rose-600 hover:text-rose-600 dark:text-rose-400"
                      onClick={() => onCancel(order)}
                      aria-label={`Cancel order ${order.orderid} for ${order.symbol}`}
                    >
                      Cancel
                    </Button>
                  </span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/* qtyText stays the book's own 0/100 fill accounting; it was kept from the
   previous table. priceText was dropped with the Price column — a LIMIT's
   undressed price round-trips through Modify's dialog and the wire
   (o.price) stays in the payload for the actions, just not painted. */

function qtyText(order: DockOrder): string {
  if (order.filled_quantity === undefined) return String(order.quantity)
  return `${order.filled_quantity}/${order.quantity}`
}
