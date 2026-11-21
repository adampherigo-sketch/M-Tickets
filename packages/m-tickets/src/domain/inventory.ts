/**
 * Inventory rules for a ticket type. The database re-checks the same rules
 * under a row lock when it places the order (tickets_place_order); these run
 * first so the buyer gets a clear message without a round trip, and so the
 * rules have one readable, tested definition.
 */
import type { SalesState } from './types'

export interface InventoryInput {
  /** null = unlimited */
  quantityLimit: number | null
  /** Issued tickets plus seats held by unexpired pending orders. */
  taken: number
  salesStart: Date | null
  salesEnd: Date | null
  maxPerOrder: number
  /** Sales close when the event ends, whatever salesEnd says. */
  eventEndsAt: Date
}

export type PurchaseRejection =
  'invalid_quantity' | 'not_on_sale_yet' | 'sales_ended' | 'sold_out' | 'exceeds_remaining' | 'exceeds_per_order_max'

/** null = unlimited */
export function remainingQuantity(input: Pick<InventoryInput, 'quantityLimit' | 'taken'>): number | null {
  if (input.quantityLimit === null) return null
  return Math.max(input.quantityLimit - input.taken, 0)
}

export function salesState(input: InventoryInput, now: Date): SalesState {
  if (input.salesStart && now < input.salesStart) return 'not_started'
  if ((input.salesEnd && now >= input.salesEnd) || now >= input.eventEndsAt) return 'ended'
  const remaining = remainingQuantity(input)
  if (remaining !== null && remaining <= 0) return 'sold_out'
  return 'on_sale'
}

/** Most a single order may take right now (0 when nothing can be bought). */
export function maxPurchasable(input: InventoryInput, now: Date): number {
  if (salesState(input, now) !== 'on_sale') return 0
  const remaining = remainingQuantity(input)
  return remaining === null ? input.maxPerOrder : Math.min(input.maxPerOrder, remaining)
}

export function checkPurchase(
  input: InventoryInput,
  quantity: number,
  now: Date,
): { ok: true } | { ok: false; reason: PurchaseRejection } {
  if (!Number.isInteger(quantity) || quantity < 1) return { ok: false, reason: 'invalid_quantity' }
  const state = salesState(input, now)
  if (state === 'not_started') return { ok: false, reason: 'not_on_sale_yet' }
  if (state === 'ended') return { ok: false, reason: 'sales_ended' }
  if (state === 'sold_out') return { ok: false, reason: 'sold_out' }
  if (quantity > input.maxPerOrder) return { ok: false, reason: 'exceeds_per_order_max' }
  const remaining = remainingQuantity(input)
  if (remaining !== null && quantity > remaining) return { ok: false, reason: 'exceeds_remaining' }
  return { ok: true }
}
