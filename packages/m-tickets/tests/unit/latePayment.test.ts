/**
 * The webhook orchestration for late payments, with the repository layer and
 * the payment provider faked. The SQL side of the same rules is covered in
 * tests/db/orders-and-checkin.test.ts.
 */
import { InMemoryEventBus } from '@zevaryn/core/events'
import type { DbClient } from '@zevaryn/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrderFacts, OrderTransition, PaymentAccountRecord } from '../../src/db'
import { PaymentProviderRegistry, type PaymentProvider, type WebhookResult } from '../../src/payments'
import type { TicketsContext } from '../../src/server'

const db = vi.hoisted(() => ({
  getOrderFacts: vi.fn(),
  completeOrder: vi.fn(),
  finishLateRefund: vi.fn(),
  logOrderEvent: vi.fn(),
  listPaymentAccounts: vi.fn(),
  refundOrder: vi.fn(),
}))
vi.mock('../../src/db', async (importOriginal) => ({ ...(await importOriginal<object>()), ...db }))

const { applyWebhookResult, applyRefund } = await import('../../src/server')

const tenantId = '00000000-0000-4000-8000-000000000001'
const eventId = '00000000-0000-4000-8000-000000000002'
const orderId = '00000000-0000-4000-8000-000000000003'
const ticketId = '00000000-0000-4000-8000-000000000004'
const ticketTypeId = '00000000-0000-4000-8000-000000000005'

const facts: OrderFacts = {
  id: orderId,
  tenantId,
  eventId,
  status: 'expired',
  totalCents: 2500,
  currency: 'USD',
  provider: 'stripe',
  providerCheckoutRef: 'cs_1',
  externalEventRef: null,
  tickets: [{ id: ticketId, ticketTypeId, status: 'void' }],
}

const account: PaymentAccountRecord = {
  tenantId,
  provider: 'stripe',
  providerAccountId: 'acct_client',
  status: 'connected',
  chargesEnabled: true,
  detailsSubmitted: true,
  updatedAt: new Date(),
}

const paid: WebhookResult = {
  kind: 'checkout_completed',
  orderId,
  providerSessionId: 'cs_1',
  providerPaymentRef: 'pi_late',
  amountCents: 2500,
  currency: 'USD',
  providerAccountId: 'acct_client',
}

const transition = (result: OrderTransition['result'], ticketIds: string[] = []): OrderTransition => ({
  result,
  orderId,
  tenantId,
  eventId,
  ticketIds,
})

function context() {
  const refund = vi.fn().mockResolvedValue({ providerRefundRef: 're_1', status: 'succeeded' })
  const provider = { id: 'stripe', refund } as unknown as PaymentProvider
  const bus = new InMemoryEventBus()
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
    now: () => new Date(),
  }
  return { ctx, refund, bus }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.getOrderFacts.mockResolvedValue(facts)
  db.listPaymentAccounts.mockResolvedValue([account])
  db.logOrderEvent.mockResolvedValue(undefined)
})

describe('a payment that lands after its hold expired', () => {
  it('is honored when the database finds room: tickets issued, no refund', async () => {
    const { ctx, refund, bus } = context()
    db.completeOrder.mockResolvedValue(transition('completed', [ticketId]))

    expect(await applyWebhookResult(ctx, 'stripe', paid)).toBe('order_completed')
    expect(refund).not.toHaveBeenCalled()
    expect(bus.published.map((e) => e.type)).toEqual(['tickets.order.completed', 'tickets.ticket.issued'])
  })

  it('is refunded in full through the provider when the event sold out', async () => {
    const { ctx, refund, bus } = context()
    db.completeOrder.mockResolvedValue(transition('sold_out'))
    db.finishLateRefund.mockResolvedValue(transition('refunded'))

    expect(await applyWebhookResult(ctx, 'stripe', paid)).toBe('late_payment_refunded')
    expect(refund).toHaveBeenCalledWith({
      account,
      providerPaymentRef: 'pi_late',
      reason: 'requested_by_customer',
      idempotencyKey: `sold-out-refund:${orderId}`,
    })
    expect(db.finishLateRefund).toHaveBeenCalledWith(ctx.service, orderId, 're_1')
    expect(bus.published).toHaveLength(1)
    expect(bus.published[0]).toMatchObject({
      type: 'tickets.order.refunded',
      payload: { orderId, ticketIds: [], reason: 'sold_out' },
    })
  })

  it('uses the same idempotency key on a retried webhook, so it never refunds twice', async () => {
    const { ctx, refund } = context()
    db.completeOrder.mockResolvedValue(transition('sold_out'))
    db.finishLateRefund
      .mockResolvedValueOnce(transition('refunded'))
      .mockResolvedValueOnce(transition('already_refunded'))

    await applyWebhookResult(ctx, 'stripe', paid)
    await applyWebhookResult(ctx, 'stripe', paid)
    const keys = refund.mock.calls.map(([request]) => request.idempotencyKey)
    expect(new Set(keys)).toEqual(new Set([`sold-out-refund:${orderId}`]))
  })

  it('logs a failed refund and rethrows so the provider retries the webhook', async () => {
    const { ctx, refund, bus } = context()
    db.completeOrder.mockResolvedValue(transition('sold_out'))
    refund.mockRejectedValue(new Error('Stripe is down'))

    await expect(applyWebhookResult(ctx, 'stripe', paid)).rejects.toThrow('Stripe is down')
    expect(db.finishLateRefund).not.toHaveBeenCalled()
    expect(db.logOrderEvent).toHaveBeenCalledWith(ctx.service, {
      tenantId,
      eventId,
      orderId,
      action: 'late_payment_refund_failed',
      detail: { payment_ref: 'pi_late', message: 'Stripe is down' },
    })
    expect(bus.published).toHaveLength(0)
  })

  it('treats a refund the provider reports as failed like an error', async () => {
    const { ctx, refund } = context()
    db.completeOrder.mockResolvedValue(transition('sold_out'))
    refund.mockResolvedValue({ providerRefundRef: 're_bad', status: 'failed' })
    await expect(applyWebhookResult(ctx, 'stripe', paid)).rejects.toThrow(/failed/)
    expect(db.finishLateRefund).not.toHaveBeenCalled()
  })

  it('ignores the provider refund webhook for an auto-refunded order', async () => {
    const { ctx, bus } = context()
    db.getOrderFacts.mockResolvedValue({ ...facts, status: 'refund_pending' })
    expect(await applyRefund(ctx, orderId)).toBe('order_already_refunded')
    db.getOrderFacts.mockResolvedValue({ ...facts, status: 'refunded' })
    expect(await applyRefund(ctx, orderId)).toBe('order_already_refunded')
    expect(db.refundOrder).not.toHaveBeenCalled()
    expect(bus.published).toHaveLength(0)
  })
})
