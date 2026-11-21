/**
 * Order placement and checkout-expiry webhooks, with the repository layer and
 * the payment provider faked.
 */
import { InMemoryEventBus } from '@zevaryn/core/events'
import type { DbClient } from '@zevaryn/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderFacts, PaymentAccountRecord } from '../../src/db'
import type { PlannableTicketType } from '../../src/domain'
import { PaymentProviderRegistry, type PaymentProvider, type WebhookResult } from '../../src/payments'
import type { TicketsContext } from '../../src/server'

const db = vi.hoisted(() => ({
  getPublishedEventForSale: vi.fn(),
  getTicketTypesForSale: vi.fn(),
  placeOrder: vi.fn(),
  getOrderFacts: vi.fn(),
  listPaymentAccounts: vi.fn(),
  expireOrder: vi.fn(),
  saveOrderDelivery: vi.fn(),
  discardOrderDelivery: vi.fn(),
}))
vi.mock('../../src/db', async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }))

const { applyWebhookResult, placeOrder } = await import('../../src/server')

const tenantId = '00000000-0000-4000-8000-000000000001'
const eventId = '00000000-0000-4000-8000-000000000002'
const orderId = '00000000-0000-4000-8000-000000000003'
const rsvpTypeId = '00000000-0000-4000-8000-000000000011'
const vipTypeId = '00000000-0000-4000-8000-000000000012'
const now = new Date('2026-12-01T12:00:00Z')

const sale = (id: string, name: string): PlannableTicketType => ({
  id,
  name,
  kind: 'rsvp',
  priceCents: 0,
  currency: 'USD',
  quantityLimit: null,
  taken: 0,
  salesStart: null,
  salesEnd: null,
  maxPerOrder: 10,
  eventEndsAt: new Date('2026-12-02T00:00:00Z'),
})

const account: PaymentAccountRecord = {
  tenantId,
  provider: 'stripe',
  providerAccountId: 'acct_client',
  status: 'connected',
  chargesEnabled: true,
  detailsSubmitted: true,
  updatedAt: now,
}

function context() {
  const bus = new InMemoryEventBus()
  const provider = { id: 'stripe' } as unknown as PaymentProvider
  const ctx: TicketsContext = {
    service: {} as DbClient,
    payments: new PaymentProviderRegistry([provider]),
    publisher: bus,
    config: {
      appUrl: 'http://localhost:3000',
      qrSecret: 'x'.repeat(32),
      holdMinutes: 35,
      checkoutSessionMinutes: 31,
      deliveryKey: 'd'.repeat(32),
      smsEnabled: false,
    },
    now: () => now,
  }
  return { ctx, bus }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.listPaymentAccounts.mockResolvedValue([account])
})

describe('placing a free order', () => {
  beforeEach(() => {
    db.getPublishedEventForSale.mockResolvedValue({
      id: eventId,
      tenantId,
      tenantSlug: 'demo-co',
      slug: 'open-house',
      title: 'Open House',
      endsAt: new Date('2026-12-02T00:00:00Z'),
    })
    db.getTicketTypesForSale.mockResolvedValue([sale(rsvpTypeId, 'RSVP'), sale(vipTypeId, 'Plus one')])
    // The database returns ticket ids in no particular order.
    db.placeOrder.mockResolvedValue({
      orderId,
      tenantId,
      eventId,
      status: 'completed',
      totalCents: 0,
      currency: 'USD',
      ticketIds: ['t-vip', 't-rsvp'],
    })
  })

  it('stores the normalized buyer and names each issued ticket with its own ticket type', async () => {
    const { ctx, bus } = context()
    const facts: OrderFacts = {
      id: orderId,
      tenantId,
      eventId,
      status: 'completed',
      totalCents: 0,
      currency: 'USD',
      provider: null,
      providerCheckoutRef: null,
      externalEventRef: null,
      tickets: [
        { id: '00000000-0000-4000-8000-0000000000a1', ticketTypeId: rsvpTypeId, status: 'valid' },
        { id: '00000000-0000-4000-8000-0000000000a2', ticketTypeId: vipTypeId, status: 'valid' },
      ],
    }
    db.getOrderFacts.mockResolvedValue(facts)

    const outcome = await placeOrder(ctx, {
      clientSlug: 'demo-co',
      eventSlug: 'open-house',
      request: {
        buyerName: '  Ada Lovelace ',
        buyerEmail: ' ADA@Example.com',
        lines: [
          { ticketTypeId: rsvpTypeId, quantity: 1 },
          { ticketTypeId: vipTypeId, quantity: 1 },
        ],
      },
    })

    expect(outcome.kind).toBe('confirmed')
    expect(db.placeOrder.mock.calls[0]![1]).toMatchObject({ buyerName: 'Ada Lovelace', buyerEmail: 'ada@example.com' })
    const issued = bus.published.filter((e) => e.type === 'tickets.ticket.issued').map((e) => e.payload)
    expect(issued).toEqual(
      facts.tickets.map((t) => expect.objectContaining({ ticketId: t.id, ticketTypeId: t.ticketTypeId })),
    )
  })

  it('still confirms the order when reading it back for events fails', async () => {
    const { ctx, bus } = context()
    db.getOrderFacts.mockRejectedValue(new Error('database blip'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const outcome = await placeOrder(ctx, {
      clientSlug: 'demo-co',
      eventSlug: 'open-house',
      request: { buyerName: 'Ada', buyerEmail: 'ada@example.com', lines: [{ ticketTypeId: rsvpTypeId, quantity: 1 }] },
    })

    expect(outcome.kind).toBe('confirmed')
    expect(bus.published).toHaveLength(0)
    spy.mockRestore()
  })
})

describe('a checkout-expired webhook', () => {
  const pending: OrderFacts = {
    id: orderId,
    tenantId,
    eventId,
    status: 'pending',
    totalCents: 2500,
    currency: 'USD',
    provider: 'stripe',
    providerCheckoutRef: 'cs_1',
    externalEventRef: null,
    tickets: [],
  }
  const expired: WebhookResult = {
    kind: 'checkout_expired',
    orderId,
    providerSessionId: 'cs_1',
    providerAccountId: 'acct_client',
  }

  beforeEach(() => db.getOrderFacts.mockResolvedValue(pending))

  it('releases the hold when it comes from the order own session and account', async () => {
    const { ctx } = context()
    expect(await applyWebhookResult(ctx, 'stripe', expired)).toBe('order_expired')
    expect(db.expireOrder).toHaveBeenCalledWith(ctx.service, orderId)
  })

  it('is ignored when another account or session names the order', async () => {
    const { ctx } = context()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await applyWebhookResult(ctx, 'stripe', { ...expired, providerAccountId: 'acct_other' })).toBe(
      'rejected_mismatch',
    )
    expect(await applyWebhookResult(ctx, 'stripe', { ...expired, providerSessionId: 'cs_other' })).toBe(
      'rejected_mismatch',
    )
    expect(db.expireOrder).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
