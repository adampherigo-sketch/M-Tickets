/**
 * Buying tickets and RSVPing, from the public event page to a confirmed order.
 *
 *   free (RSVP or $0)  -> order completed and tickets valid at once
 *   paid               -> order pending, seats held, buyer sent to the client's
 *                         own provider checkout; the webhook completes it
 */
import {
  generateAccessToken,
  generateUniqueTicketCodes,
  hashAccessToken,
  isAccessToken,
  ORDER_REJECTION_MESSAGES,
  planOrder,
  signQrPayload,
  type OrderRequest,
} from '../domain'
import {
  attachCheckout,
  completeOrder,
  expireOrder,
  findOrderIdByPaymentRef,
  finishLateRefund,
  getOrderByAccessTokenHash,
  getOrderFacts,
  getPublishedEventForSale,
  getTicketTypesForSale,
  listPaymentAccounts,
  logOrderEvent,
  placeOrder as placeOrderRow,
  refundOrder,
  TicketsDbError,
  updatePaymentAccountStatus,
  type BuyerOrder,
  type NewTicketRow,
  type OrderFacts,
  type PlacedOrder,
} from '../db'
import { ticketsEvent } from '../events/contracts'
import { selectCheckoutAccount } from '../payments/registry'
import type { PaymentProviderId, TenantPaymentAccount, WebhookResult } from '../payments/types'
import { tenantPaymentAccount } from './accounts'
import type { TicketsContext } from './context'
import { publishSafely } from './publish'

export type PlaceOrderOutcome =
  | { kind: 'confirmed'; orderToken: string }
  | { kind: 'checkout'; redirectUrl: string; orderToken: string }
  | { kind: 'rejected'; code: string; message: string }

const REJECTABLE_DB_CODES = new Set([
  'event_not_on_sale',
  'invalid_quantity',
  'unknown_ticket_type',
  'not_on_sale_yet',
  'sales_ended',
  'exceeds_per_order_max',
  'sold_out',
  'exceeds_remaining',
  'mixed_currency',
  'payments_not_configured',
])

const DB_REJECTION_MESSAGES: Record<string, string> = {
  ...ORDER_REJECTION_MESSAGES,
  event_not_on_sale: 'This event is not on sale.',
  payments_not_configured: 'This organizer is not taking online payments yet.',
  price_changed: 'Prices changed while you were ordering. Please review and try again.',
}

const rejected = (code: string): PlaceOrderOutcome => ({
  kind: 'rejected',
  code,
  message: DB_REJECTION_MESSAGES[code] ?? 'Something went wrong placing your order. Please try again.',
})

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000)

export async function placeOrder(
  ctx: TicketsContext,
  input: { clientSlug: string; eventSlug: string; request: OrderRequest },
): Promise<PlaceOrderOutcome> {
  const now = ctx.now()
  const event = await getPublishedEventForSale(ctx.service, input.clientSlug, input.eventSlug)
  if (!event) return rejected('event_not_on_sale')

  const plan = planOrder(input.request, await getTicketTypesForSale(ctx.service, event), now)
  if (!plan.ok) return rejected(plan.error.code)

  let account: TenantPaymentAccount | null = null
  if (plan.value.kind === 'paid') {
    account = selectCheckoutAccount(await listPaymentAccounts(ctx.service, event.tenantId))
    if (!account || !ctx.payments.has(account.provider)) return rejected('payments_not_configured')
  }

  const orderToken = generateAccessToken()
  const accessTokenHash = await hashAccessToken(orderToken)

  // Ticket codes are random; the unique index catches a collision and we retry.
  let placed: PlacedOrder | null = null
  for (let attempt = 1; placed === null; attempt += 1) {
    const codes = generateUniqueTicketCodes(plan.value.attendees.length)
    const tickets: NewTicketRow[] = await Promise.all(
      plan.value.attendees.map(async (attendee, i) => ({
        ticketTypeId: attendee.ticketTypeId,
        attendeeName: attendee.attendeeName,
        attendeeEmail: attendee.attendeeEmail,
        ticketCode: codes[i]!,
        qrPayload: await signQrPayload(codes[i]!, ctx.config.qrSecret),
      })),
    )
    try {
      placed = await placeOrderRow(ctx.service, {
        eventId: event.id,
        buyerName: plan.value.buyer.name,
        buyerEmail: plan.value.buyer.email,
        accessTokenHash,
        tickets,
        ...(account ? { holdUntil: addMinutes(now, ctx.config.holdMinutes), provider: account.provider } : {}),
      })
    } catch (error) {
      if (error instanceof TicketsDbError) {
        if (error.code === 'code_collision' && attempt < 3) continue
        if (REJECTABLE_DB_CODES.has(error.code)) return rejected(error.code)
      }
      throw error
    }
  }

  if (placed.status === 'completed') {
    // Read the tickets back to pair each id with its ticket type: the database
    // does not return them in request order. The order is already confirmed,
    // so a failure here is logged and never shown to the buyer.
    try {
      const order = await getOrderFacts(ctx.service, placed.orderId)
      if (order) await publishSafely(ctx, completionEvents(order, null, order.tickets))
    } catch (error) {
      console.error('[m-tickets] could not publish order completion', { orderId: placed.orderId }, error)
    }
    return { kind: 'confirmed', orderToken }
  }

  // The database priced the order; refuse to send the buyer to a checkout
  // whose line items disagree with it.
  if (placed.totalCents !== plan.value.totalCents || placed.currency !== plan.value.currency) {
    await expireOrder(ctx.service, placed.orderId)
    return rejected('price_changed')
  }

  const provider = ctx.payments.get(account!.provider)
  const base = `${ctx.config.appUrl}/t/${event.tenantSlug}/${event.slug}/checkout`
  try {
    const session = await provider.createCheckout(
      {
        orderId: placed.orderId,
        tenantId: placed.tenantId,
        eventId: placed.eventId,
        currency: placed.currency,
        buyerEmail: plan.value.buyer.email,
        totalCents: placed.totalCents,
        lines: plan.value.lines.map((line) => ({
          name: `${event.title}: ${line.name}`,
          quantity: line.quantity,
          unitAmountCents: line.unitPriceCents,
        })),
        expiresAt: addMinutes(now, ctx.config.checkoutSessionMinutes),
      },
      account!,
      {
        successUrl: `${base}/success?order=${orderToken}`,
        cancelUrl: `${base}/cancel?order=${orderToken}`,
      },
    )
    await attachCheckout(ctx.service, placed.orderId, provider.id, session.providerSessionId)
    return { kind: 'checkout', redirectUrl: session.redirectUrl, orderToken }
  } catch (error) {
    // Release the seats rather than hold them for a checkout that never opened.
    await expireOrder(ctx.service, placed.orderId)
    throw error
  }
}

/** order.completed, plus one ticket.issued per ticket that just became valid. */
function completionEvents(order: OrderFacts, provider: PaymentProviderId | null, issued: OrderFacts['tickets']) {
  return [
    ticketsEvent('tickets.order.completed', order.tenantId, {
      orderId: order.id,
      eventId: order.eventId,
      kind: order.totalCents > 0 ? 'paid' : 'free',
      totalCents: order.totalCents,
      currency: order.currency,
      ticketCount: issued.length,
      provider,
      externalEventRef: order.externalEventRef,
    }),
    ...issued.map((ticket) =>
      ticketsEvent('tickets.ticket.issued', order.tenantId, {
        ticketId: ticket.id,
        orderId: order.id,
        eventId: order.eventId,
        ticketTypeId: ticket.ticketTypeId,
        externalEventRef: order.externalEventRef,
      }),
    ),
  ]
}

export type WebhookOutcome =
  | 'order_completed'
  | 'order_already_completed'
  | 'order_already_refunded'
  | 'late_payment_refunded'
  | 'order_expired'
  | 'order_refunded'
  | 'partial_refund_ignored'
  | 'account_updated'
  | 'unknown_order'
  | 'rejected_mismatch'
  | 'ignored'

/**
 * Verifies and applies a provider webhook. Throws WebhookSignatureError on a
 * bad signature (respond 400) and other errors on transient failures (respond
 * 500 so the provider retries; every step is idempotent).
 */
export async function handlePaymentWebhook(
  ctx: TicketsContext,
  providerId: PaymentProviderId,
  rawBody: string,
  signature: string | null,
): Promise<WebhookOutcome> {
  const result = await ctx.payments.get(providerId).handleWebhook(rawBody, signature)
  return applyWebhookResult(ctx, providerId, result)
}

/** Exported for tests. */
export async function applyWebhookResult(
  ctx: TicketsContext,
  providerId: PaymentProviderId,
  result: WebhookResult,
): Promise<WebhookOutcome> {
  switch (result.kind) {
    case 'checkout_completed': {
      const order = await verifiedOrder(ctx, providerId, result)
      if (typeof order === 'string') return order
      const transition = await completeOrder(ctx.service, {
        orderId: order.id,
        provider: providerId,
        providerPaymentRef: result.providerPaymentRef,
        amountCents: result.amountCents,
        currency: result.currency,
      })
      if (transition.result === 'sold_out')
        return refundSoldOutPayment(ctx, providerId, order, result.providerPaymentRef)
      if (transition.result === 'already_refunded') return 'order_already_refunded'
      if (transition.result !== 'completed') return 'order_already_completed'
      const issued = new Set(transition.ticketIds)
      await publishSafely(
        ctx,
        completionEvents(
          order,
          providerId,
          order.tickets.filter((t) => issued.has(t.id)),
        ),
      )
      return 'order_completed'
    }
    case 'checkout_expired': {
      const order = await verifiedOrder(ctx, providerId, result)
      if (typeof order === 'string') return order
      await expireOrder(ctx.service, order.id)
      return 'order_expired'
    }
    case 'payment_refunded': {
      // Partial refunds (one ticket of several) are not modelled yet.
      if (!result.fullyRefunded) return 'partial_refund_ignored'
      const orderId = await findOrderIdByPaymentRef(ctx.service, providerId, result.providerPaymentRef)
      if (!orderId) return 'unknown_order'
      return applyRefund(ctx, orderId)
    }
    case 'account_updated':
      await updatePaymentAccountStatus(ctx.service, providerId, result.providerAccountId, result.account)
      return 'account_updated'
    case 'ignored':
      return 'ignored'
  }
}

/**
 * A client could create a checkout on their own connected account naming
 * another client's order id. Only act on a checkout event that happened on the
 * order's own tenant account, for the session we created.
 */
async function verifiedOrder(
  ctx: TicketsContext,
  providerId: PaymentProviderId,
  result: { orderId: string; providerSessionId: string; providerAccountId: string | null },
): Promise<OrderFacts | 'unknown_order' | 'rejected_mismatch'> {
  const order = await getOrderFacts(ctx.service, result.orderId)
  if (!order) return 'unknown_order'
  const account =
    order.provider === providerId && order.providerCheckoutRef === result.providerSessionId
      ? await tenantPaymentAccount(ctx, order.tenantId, providerId)
      : null
  if (!account || !result.providerAccountId || account.providerAccountId !== result.providerAccountId) {
    console.error('[m-tickets] webhook does not match the order it names', { orderId: order.id })
    return 'rejected_mismatch'
  }
  return order
}

/**
 * The payment landed after the order's seats went to other buyers (its hold
 * lapsed and the event sold out). Refund it in full on the client's account.
 * The provider call uses a stable idempotency key, so a retried webhook never
 * refunds twice; a failure is logged and rethrown so the provider retries.
 */
async function refundSoldOutPayment(
  ctx: TicketsContext,
  providerId: PaymentProviderId,
  order: OrderFacts,
  providerPaymentRef: string,
): Promise<WebhookOutcome> {
  const where = { tenantId: order.tenantId, eventId: order.eventId, orderId: order.id }
  const account = await tenantPaymentAccount(ctx, order.tenantId, providerId)
  try {
    if (!account) throw new Error(`No ${providerId} account for tenant ${order.tenantId}`)
    const refund = await ctx.payments.get(providerId).refund({
      account,
      providerPaymentRef,
      reason: 'requested_by_customer',
      idempotencyKey: `sold-out-refund:${order.id}`,
    })
    if (refund.status === 'failed') throw new Error(`Provider reported refund ${refund.providerRefundRef} failed`)
    const transition = await finishLateRefund(ctx.service, order.id, refund.providerRefundRef)
    if (transition.result === 'refunded') {
      await publishSafely(ctx, [
        ticketsEvent('tickets.order.refunded', order.tenantId, {
          orderId: order.id,
          eventId: order.eventId,
          ticketIds: [],
          reason: 'sold_out',
          externalEventRef: order.externalEventRef,
        }),
      ])
    }
    return 'late_payment_refunded'
  } catch (error) {
    await logOrderEvent(ctx.service, {
      ...where,
      action: 'late_payment_refund_failed',
      detail: { payment_ref: providerPaymentRef, message: error instanceof Error ? error.message : String(error) },
    }).catch((logError: unknown) => console.error('[m-tickets] could not write order log', logError))
    throw error
  }
}

/**
 * Records a full refund of a completed order (organizer action or the
 * provider's refund webhook). Orders that were never completed are left alone:
 * a sold-out late payment is finished by refundSoldOutPayment, and the
 * provider's charge.refunded webhook for it lands here as a no-op.
 */
export async function applyRefund(ctx: TicketsContext, orderId: string): Promise<WebhookOutcome> {
  const facts = await getOrderFacts(ctx.service, orderId)
  if (!facts) return 'unknown_order'
  if (facts.status === 'refunded' || facts.status === 'refund_pending') return 'order_already_refunded'
  if (facts.status !== 'completed') return 'ignored'
  const transition = await refundOrder(ctx.service, orderId)
  if (transition.result === 'refunded') {
    await publishSafely(ctx, [
      ticketsEvent('tickets.order.refunded', transition.tenantId, {
        orderId,
        eventId: transition.eventId,
        ticketIds: transition.ticketIds,
        reason: 'requested',
        externalEventRef: facts.externalEventRef,
      }),
    ])
  }
  return 'order_refunded'
}

/** The buyer's ticket page. Returns null for malformed or unknown tokens. */
export async function getBuyerOrder(ctx: TicketsContext, orderToken: string): Promise<BuyerOrder | null> {
  if (!isAccessToken(orderToken)) return null
  return getOrderByAccessTokenHash(ctx.service, await hashAccessToken(orderToken))
}
