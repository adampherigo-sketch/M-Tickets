import { describe, expect, it } from 'vitest'
import {
  checkPurchase,
  maxPurchasable,
  planOrder,
  remainingQuantity,
  salesState,
  type InventoryInput,
  type PlannableTicketType,
} from '../../src/domain'

const now = new Date('2026-12-01T12:00:00Z')
const base: InventoryInput = {
  quantityLimit: 10,
  taken: 0,
  salesStart: null,
  salesEnd: null,
  maxPerOrder: 4,
  eventEndsAt: new Date('2026-12-10T00:00:00Z'),
}

describe('inventory limits', () => {
  it('counts remaining seats, with null meaning unlimited', () => {
    expect(remainingQuantity({ quantityLimit: 10, taken: 3 })).toBe(7)
    expect(remainingQuantity({ quantityLimit: 10, taken: 12 })).toBe(0)
    expect(remainingQuantity({ quantityLimit: null, taken: 999 })).toBeNull()
  })

  it('derives the sales state from the window, the event end and the limit', () => {
    expect(salesState(base, now)).toBe('on_sale')
    expect(salesState({ ...base, salesStart: new Date('2026-12-02T00:00:00Z') }, now)).toBe('not_started')
    expect(salesState({ ...base, salesEnd: now }, now)).toBe('ended')
    expect(salesState({ ...base, eventEndsAt: now }, now)).toBe('ended')
    expect(salesState({ ...base, taken: 10 }, now)).toBe('sold_out')
    expect(salesState({ ...base, quantityLimit: null, taken: 10_000 }, now)).toBe('on_sale')
  })

  it('allows a purchase up to the remaining seats and the per-order max', () => {
    expect(checkPurchase(base, 4, now)).toEqual({ ok: true })
    expect(checkPurchase(base, 5, now)).toEqual({ ok: false, reason: 'exceeds_per_order_max' })
    expect(checkPurchase({ ...base, taken: 8 }, 3, now)).toEqual({ ok: false, reason: 'exceeds_remaining' })
    expect(checkPurchase({ ...base, taken: 8 }, 2, now)).toEqual({ ok: true })
    expect(checkPurchase({ ...base, taken: 10 }, 1, now)).toEqual({ ok: false, reason: 'sold_out' })
    expect(checkPurchase(base, 0, now)).toEqual({ ok: false, reason: 'invalid_quantity' })
    expect(checkPurchase(base, 1.5, now)).toEqual({ ok: false, reason: 'invalid_quantity' })
    expect(checkPurchase({ ...base, salesEnd: now }, 1, now)).toEqual({ ok: false, reason: 'sales_ended' })
  })

  it('caps the quantity picker at what can actually be bought', () => {
    expect(maxPurchasable(base, now)).toBe(4)
    expect(maxPurchasable({ ...base, taken: 9 }, now)).toBe(1)
    expect(maxPurchasable({ ...base, taken: 10 }, now)).toBe(0)
    expect(maxPurchasable({ ...base, quantityLimit: null }, now)).toBe(4)
  })
})

describe('order planning', () => {
  const rsvp: PlannableTicketType = { ...base, id: 'rsvp', name: 'RSVP', kind: 'rsvp', priceCents: 0, currency: 'USD' }
  const vip: PlannableTicketType = { ...base, id: 'vip', name: 'VIP', kind: 'paid', priceCents: 2500, currency: 'USD' }
  const buyer = { buyerName: ' Ada Lovelace ', buyerEmail: 'ADA@example.com ' }

  it('plans a free RSVP with one attendee per seat', () => {
    const plan = planOrder({ ...buyer, lines: [{ ticketTypeId: 'rsvp', quantity: 2 }] }, [rsvp, vip], now)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.kind).toBe('free')
    expect(plan.value.buyer).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com' })
    expect(plan.value.totalCents).toBe(0)
    expect(plan.value.attendees).toHaveLength(2)
    expect(plan.value.attendees[0]).toEqual({
      ticketTypeId: 'rsvp',
      attendeeName: 'Ada Lovelace',
      attendeeEmail: 'ada@example.com',
    })
  })

  it('totals a paid order and merges duplicate lines', () => {
    const plan = planOrder(
      {
        ...buyer,
        lines: [
          { ticketTypeId: 'vip', quantity: 1 },
          { ticketTypeId: 'vip', quantity: 2 },
          { ticketTypeId: 'rsvp', quantity: 0 },
        ],
      },
      [rsvp, vip],
      now,
    )
    expect(plan.ok && plan.value).toMatchObject({ kind: 'paid', totalCents: 7500, currency: 'USD' })
  })

  it('rejects empty orders, bad buyers, unknown types, mixed currencies and inventory problems', () => {
    expect(planOrder({ ...buyer, lines: [] }, [rsvp], now)).toEqual({ ok: false, error: { code: 'empty_order' } })
    expect(
      planOrder({ buyerName: '', buyerEmail: 'a@b.co', lines: [{ ticketTypeId: 'rsvp', quantity: 1 }] }, [rsvp], now),
    ).toEqual({
      ok: false,
      error: { code: 'invalid_buyer', field: 'buyerName' },
    })
    expect(
      planOrder({ ...buyer, buyerEmail: 'nope', lines: [{ ticketTypeId: 'rsvp', quantity: 1 }] }, [rsvp], now),
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_buyer', field: 'buyerEmail' },
    })
    expect(planOrder({ ...buyer, lines: [{ ticketTypeId: 'ghost', quantity: 1 }] }, [rsvp], now)).toMatchObject({
      ok: false,
      error: { code: 'unknown_ticket_type' },
    })
    const eur = { ...vip, id: 'eur', currency: 'EUR' }
    expect(
      planOrder(
        {
          ...buyer,
          lines: [
            { ticketTypeId: 'vip', quantity: 1 },
            { ticketTypeId: 'eur', quantity: 1 },
          ],
        },
        [vip, eur],
        now,
      ),
    ).toMatchObject({ ok: false, error: { code: 'mixed_currency' } })
    expect(
      planOrder({ ...buyer, lines: [{ ticketTypeId: 'vip', quantity: 3 }] }, [{ ...vip, taken: 9 }], now),
    ).toMatchObject({
      ok: false,
      error: { code: 'exceeds_remaining', ticketTypeName: 'VIP' },
    })
    expect(planOrder({ ...buyer, lines: [{ ticketTypeId: 'vip', quantity: 51 }] }, [vip], now)).toMatchObject({
      ok: false,
      error: { code: 'too_many_tickets' },
    })
  })
})
