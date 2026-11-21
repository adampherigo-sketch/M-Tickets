/**
 * Turns a buyer's request into an order plan: which tickets, at what price,
 * for whom. Prices here are for display and pre-checks; the database charges
 * from ticket_types when it places the order.
 */
import { checkPurchase, type InventoryInput, type PurchaseRejection } from './inventory'
import { err, ok, type Result, type TicketKind } from './types'

export const MAX_TICKETS_PER_ORDER = 50

export interface OrderRequest {
  buyerName: string
  buyerEmail: string
  lines: readonly { ticketTypeId: string; quantity: number }[]
}

export interface PlannableTicketType extends InventoryInput {
  id: string
  name: string
  kind: TicketKind
  priceCents: number
  currency: string
}

export interface PlannedLine {
  ticketTypeId: string
  name: string
  kind: TicketKind
  quantity: number
  unitPriceCents: number
}

export interface PlannedAttendee {
  ticketTypeId: string
  attendeeName: string
  attendeeEmail: string
}

export interface OrderPlan {
  kind: 'free' | 'paid'
  currency: string
  totalCents: number
  lines: PlannedLine[]
  /** One per ticket to issue. Named after the buyer until attendee names are collected. */
  attendees: PlannedAttendee[]
}

export type OrderRejection =
  | { code: 'invalid_buyer'; field: 'buyerName' | 'buyerEmail' }
  | { code: 'empty_order' }
  | { code: 'too_many_tickets'; max: number }
  | { code: 'unknown_ticket_type'; ticketTypeId: string }
  | { code: 'mixed_currency' }
  | { code: PurchaseRejection; ticketTypeId: string; ticketTypeName: string }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function planOrder(
  request: OrderRequest,
  ticketTypes: readonly PlannableTicketType[],
  now: Date,
): Result<OrderPlan, OrderRejection> {
  const buyerName = request.buyerName.trim()
  const buyerEmail = request.buyerEmail.trim().toLowerCase()
  if (buyerName.length === 0 || buyerName.length > 200) return err({ code: 'invalid_buyer', field: 'buyerName' })
  if (!EMAIL.test(buyerEmail) || buyerEmail.length > 320) return err({ code: 'invalid_buyer', field: 'buyerEmail' })

  // Merge duplicate lines and drop zero quantities (an untouched form field).
  const quantities = new Map<string, number>()
  for (const line of request.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      return err({ code: 'invalid_quantity', ticketTypeId: line.ticketTypeId, ticketTypeName: '' })
    }
    if (line.quantity === 0) continue
    quantities.set(line.ticketTypeId, (quantities.get(line.ticketTypeId) ?? 0) + line.quantity)
  }
  if (quantities.size === 0) return err({ code: 'empty_order' })

  const total = [...quantities.values()].reduce((sum, q) => sum + q, 0)
  if (total > MAX_TICKETS_PER_ORDER) return err({ code: 'too_many_tickets', max: MAX_TICKETS_PER_ORDER })

  const byId = new Map(ticketTypes.map((type) => [type.id, type]))
  const lines: PlannedLine[] = []
  let currency: string | null = null
  for (const [ticketTypeId, quantity] of quantities) {
    const type = byId.get(ticketTypeId)
    if (!type) return err({ code: 'unknown_ticket_type', ticketTypeId })
    const check = checkPurchase(type, quantity, now)
    if (!check.ok) return err({ code: check.reason, ticketTypeId, ticketTypeName: type.name })
    if (currency === null) currency = type.currency
    else if (currency !== type.currency) return err({ code: 'mixed_currency' })
    lines.push({ ticketTypeId, name: type.name, kind: type.kind, quantity, unitPriceCents: type.priceCents })
  }

  const totalCents = lines.reduce((sum, line) => sum + line.unitPriceCents * line.quantity, 0)
  const attendees = lines.flatMap((line) =>
    Array.from({ length: line.quantity }, () => ({
      ticketTypeId: line.ticketTypeId,
      attendeeName: buyerName,
      attendeeEmail: buyerEmail,
    })),
  )
  return ok({ kind: totalCents > 0 ? 'paid' : 'free', currency: currency!, totalCents, lines, attendees })
}

export const ORDER_REJECTION_MESSAGES: Readonly<Record<OrderRejection['code'], string>> = {
  invalid_buyer: 'Please enter your name and a valid email address.',
  empty_order: 'Choose at least one ticket.',
  too_many_tickets: `You can get up to ${MAX_TICKETS_PER_ORDER} tickets in one order.`,
  unknown_ticket_type: 'That ticket is no longer available.',
  mixed_currency: 'Tickets priced in different currencies must be bought separately.',
  invalid_quantity: 'Quantities must be whole numbers.',
  not_on_sale_yet: 'Sales for that ticket have not started yet.',
  sales_ended: 'Sales for that ticket have ended.',
  sold_out: 'That ticket is sold out.',
  exceeds_remaining: 'Not enough tickets left for that quantity.',
  exceeds_per_order_max: 'That is more than one order can include.',
}
