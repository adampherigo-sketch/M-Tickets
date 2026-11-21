/**
 * Order lifecycle. SERVICE-ROLE CLIENT ONLY: these functions are not granted to
 * signed-in users or anon. Callers must have validated the request first (the
 * server layer in src/server does).
 */
import type { DbClient, Json } from '@zevaryn/database'
import { z } from 'zod'
import type { OrderStatus, PlannableTicketType, RefundReason, TicketKind, TicketStatus } from '../domain'
import type { PaymentProviderId } from '../payments/types'
import { toTicketsDbError, unwrap } from './errors'

export interface EventForSale {
  id: string
  tenantId: string
  tenantSlug: string
  slug: string
  title: string
  endsAt: Date
}

export async function getPublishedEventForSale(
  service: DbClient,
  clientSlug: string,
  eventSlug: string,
): Promise<EventForSale | null> {
  const { data, error } = await service
    .from('tickets_events')
    .select('id, tenant_id, slug, title, ends_at, tenants!inner(slug)')
    .eq('tenants.slug', clientSlug.toLowerCase())
    .eq('slug', eventSlug.toLowerCase())
    .eq('status', 'published')
    .maybeSingle()
  if (error) throw toTicketsDbError(error, 'Load event for sale')
  if (!data) return null
  return {
    id: data.id,
    tenantId: data.tenant_id,
    tenantSlug: data.tenants.slug,
    slug: data.slug,
    title: data.title,
    endsAt: new Date(data.ends_at),
  }
}

export async function getTicketTypesForSale(
  service: DbClient,
  event: { id: string; endsAt: Date },
): Promise<PlannableTicketType[]> {
  const [types, availability] = await Promise.all([
    service.from('ticket_types').select('*').eq('event_id', event.id),
    service.from('ticket_type_availability').select('ticket_type_id, taken').eq('event_id', event.id),
  ])
  const taken = new Map(unwrap(availability, 'Load availability').map((row) => [row.ticket_type_id, row.taken ?? 0]))
  return unwrap(types, 'Load ticket types').map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    priceCents: row.price_cents,
    currency: row.currency,
    quantityLimit: row.quantity_limit,
    taken: taken.get(row.id) ?? 0,
    salesStart: row.sales_start ? new Date(row.sales_start) : null,
    salesEnd: row.sales_end ? new Date(row.sales_end) : null,
    maxPerOrder: row.max_per_order,
    eventEndsAt: event.endsAt,
  }))
}

export interface NewTicketRow {
  ticketTypeId: string
  attendeeName: string
  attendeeEmail: string | null
  ticketCode: string
  qrPayload: string
}

const placedOrderSchema = z.object({
  order_id: z.uuid(),
  tenant_id: z.uuid(),
  event_id: z.uuid(),
  status: z.enum(['pending', 'completed']),
  total_cents: z.number(),
  currency: z.string(),
  ticket_ids: z.array(z.uuid()),
})

export interface PlacedOrder {
  orderId: string
  tenantId: string
  eventId: string
  status: 'pending' | 'completed'
  totalCents: number
  currency: string
  ticketIds: string[]
}

export async function placeOrder(
  service: DbClient,
  input: {
    eventId: string
    buyerName: string
    buyerEmail: string
    accessTokenHash: string
    tickets: readonly NewTicketRow[]
    holdUntil?: Date
    provider?: PaymentProviderId
  },
): Promise<PlacedOrder> {
  const { data, error } = await service.rpc('tickets_place_order', {
    p_event_id: input.eventId,
    p_buyer_name: input.buyerName,
    p_buyer_email: input.buyerEmail,
    p_access_token_hash: input.accessTokenHash,
    p_tickets: input.tickets.map((t) => ({
      ticket_type_id: t.ticketTypeId,
      attendee_name: t.attendeeName,
      attendee_email: t.attendeeEmail,
      ticket_code: t.ticketCode,
      qr_payload: t.qrPayload,
    })) as Json,
    ...(input.holdUntil ? { p_hold_until: input.holdUntil.toISOString() } : {}),
    ...(input.provider ? { p_provider: input.provider } : {}),
  })
  if (error) throw toTicketsDbError(error, 'Place order')
  const parsed = placedOrderSchema.parse(data)
  return {
    orderId: parsed.order_id,
    tenantId: parsed.tenant_id,
    eventId: parsed.event_id,
    status: parsed.status,
    totalCents: parsed.total_cents,
    currency: parsed.currency,
    ticketIds: parsed.ticket_ids,
  }
}

export async function attachCheckout(
  service: DbClient,
  orderId: string,
  provider: PaymentProviderId,
  providerCheckoutRef: string,
): Promise<void> {
  const { error } = await service
    .from('ticket_orders')
    .update({ provider, provider_checkout_ref: providerCheckoutRef })
    .eq('id', orderId)
  if (error) throw toTicketsDbError(error, 'Attach checkout')
}

const transitionSchema = z.object({
  result: z.string(),
  order_id: z.uuid(),
  tenant_id: z.uuid(),
  event_id: z.uuid(),
  ticket_ids: z.array(z.uuid()),
})

export interface OrderTransition {
  /** sold_out: the payment arrived but the seats are gone; refund it through the provider. */
  result: 'completed' | 'already_completed' | 'already_refunded' | 'refunded' | 'sold_out'
  orderId: string
  tenantId: string
  eventId: string
  /** Tickets whose status changed in this call (empty on a repeat). */
  ticketIds: string[]
}

function toTransition(data: unknown): OrderTransition {
  const parsed = transitionSchema.parse(data)
  return {
    result: parsed.result as OrderTransition['result'],
    orderId: parsed.order_id,
    tenantId: parsed.tenant_id,
    eventId: parsed.event_id,
    ticketIds: parsed.ticket_ids,
  }
}

export async function completeOrder(
  service: DbClient,
  input: {
    orderId: string
    provider: PaymentProviderId
    providerPaymentRef: string
    amountCents: number
    currency: string
  },
): Promise<OrderTransition> {
  const { data, error } = await service.rpc('tickets_complete_order', {
    p_order_id: input.orderId,
    p_provider: input.provider,
    p_payment_ref: input.providerPaymentRef,
    p_amount_cents: input.amountCents,
    p_currency: input.currency,
  })
  if (error) throw toTicketsDbError(error, 'Complete order')
  return toTransition(data)
}

export async function expireOrder(service: DbClient, orderId: string): Promise<boolean> {
  const { data, error } = await service.rpc('tickets_expire_order', { p_order_id: orderId })
  if (error) throw toTicketsDbError(error, 'Expire order')
  return data
}

/** After the provider refunded a sold-out late payment (see tickets_complete_order). */
export async function finishLateRefund(
  service: DbClient,
  orderId: string,
  providerRefundRef: string,
): Promise<OrderTransition> {
  const { data, error } = await service.rpc('tickets_finish_late_refund', {
    p_order_id: orderId,
    p_provider_refund_ref: providerRefundRef,
  })
  if (error) throw toTicketsDbError(error, 'Finish late refund')
  return toTransition(data)
}

export type OrderLogAction =
  'late_payment_honored' | 'late_payment_sold_out' | 'late_payment_refunded' | 'late_payment_refund_failed'

/** Appends to ticket_order_log (service role). The database writes the other actions itself. */
export async function logOrderEvent(
  service: DbClient,
  entry: { tenantId: string; eventId: string; orderId: string; action: OrderLogAction; detail: Record<string, Json> },
): Promise<void> {
  const { error } = await service.from('ticket_order_log').insert({
    tenant_id: entry.tenantId,
    event_id: entry.eventId,
    order_id: entry.orderId,
    action: entry.action,
    detail: entry.detail,
  })
  if (error) throw toTicketsDbError(error, 'Write order log')
}

export async function refundOrder(service: DbClient, orderId: string): Promise<OrderTransition> {
  const { data, error } = await service.rpc('tickets_refund_order', { p_order_id: orderId })
  if (error) throw toTicketsDbError(error, 'Refund order')
  return toTransition(data)
}

export async function findOrderIdByPaymentRef(
  service: DbClient,
  provider: PaymentProviderId,
  providerPaymentRef: string,
): Promise<string | null> {
  const { data, error } = await service
    .from('ticket_orders')
    .select('id')
    .eq('provider', provider)
    .eq('provider_payment_ref', providerPaymentRef)
    .maybeSingle()
  if (error) throw toTicketsDbError(error, 'Find order by payment')
  return data?.id ?? null
}

export interface OrderSummary {
  id: string
  tenantId: string
  eventId: string
  status: OrderStatus
  totalCents: number
  currency: string
  provider: PaymentProviderId | null
  providerPaymentRef: string | null
}

/** Organizer view of one order (RLS applies when given a user client). */
export async function getOrder(client: DbClient, orderId: string): Promise<OrderSummary | null> {
  const { data, error } = await client
    .from('ticket_orders')
    .select('id, tenant_id, event_id, status, total_cents, currency, provider, provider_payment_ref')
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw toTicketsDbError(error, 'Load order')
  if (!data) return null
  return {
    id: data.id,
    tenantId: data.tenant_id,
    eventId: data.event_id,
    status: data.status,
    totalCents: data.total_cents,
    currency: data.currency,
    provider: data.provider,
    providerPaymentRef: data.provider_payment_ref,
  }
}

export interface OrderFacts {
  id: string
  tenantId: string
  eventId: string
  status: OrderStatus
  totalCents: number
  currency: string
  provider: PaymentProviderId | null
  providerCheckoutRef: string | null
  externalEventRef: string | null
  tickets: { id: string; ticketTypeId: string; status: TicketStatus }[]
}

/** Everything the payment flow needs to verify a webhook and publish events. */
export async function getOrderFacts(service: DbClient, orderId: string): Promise<OrderFacts | null> {
  const { data, error } = await service
    .from('ticket_orders')
    .select(
      'id, tenant_id, event_id, status, total_cents, currency, provider, provider_checkout_ref, tickets(id, ticket_type_id, status)',
    )
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw toTicketsDbError(error, 'Load order')
  if (!data) return null
  const event = unwrap(
    await service.from('tickets_events').select('external_event_ref').eq('id', data.event_id).single(),
    'Load order event',
  )
  return {
    id: data.id,
    tenantId: data.tenant_id,
    eventId: data.event_id,
    status: data.status,
    totalCents: data.total_cents,
    currency: data.currency,
    provider: data.provider,
    providerCheckoutRef: data.provider_checkout_ref,
    externalEventRef: event.external_event_ref,
    tickets: data.tickets.map((t) => ({ id: t.id, ticketTypeId: t.ticket_type_id, status: t.status })),
  }
}

export interface BuyerOrder {
  id: string
  status: OrderStatus
  refundReason: RefundReason | null
  buyerName: string
  totalCents: number
  currency: string
  tenantSlug: string
  tenantName: string
  event: {
    slug: string
    title: string
    startsAt: Date
    endsAt: Date
    timezone: string
    venueName: string | null
    venueAddress: string | null
  }
  tickets: {
    id: string
    attendeeName: string
    ticketTypeName: string
    kind: TicketKind
    ticketCode: string
    qrPayload: string
    status: TicketStatus
  }[]
}

/** The buyer's ticket page, found by the hash of the token in their link. */
export async function getOrderByAccessTokenHash(
  service: DbClient,
  accessTokenHash: string,
): Promise<BuyerOrder | null> {
  const { data, error } = await service
    .from('ticket_orders')
    .select(
      'id, status, refund_reason, buyer_name, total_cents, currency, tenant_id, event_id, tickets(id, attendee_name, ticket_code, qr_payload, status, ticket_types(name, kind))',
    )
    .eq('access_token_hash', accessTokenHash)
    .maybeSingle()
  if (error) throw toTicketsDbError(error, 'Load order')
  if (!data) return null
  const [event, tenant] = await Promise.all([
    service
      .from('tickets_events')
      .select('slug, title, starts_at, ends_at, timezone, venue_name, venue_address')
      .eq('id', data.event_id)
      .single(),
    service.from('tenants').select('slug, name').eq('id', data.tenant_id).single(),
  ])
  const e = unwrap(event, 'Load order event')
  const t = unwrap(tenant, 'Load order tenant')
  return {
    id: data.id,
    status: data.status,
    refundReason: data.refund_reason === 'requested' || data.refund_reason === 'sold_out' ? data.refund_reason : null,
    buyerName: data.buyer_name,
    totalCents: data.total_cents,
    currency: data.currency,
    tenantSlug: t.slug,
    tenantName: t.name,
    event: {
      slug: e.slug,
      title: e.title,
      startsAt: new Date(e.starts_at),
      endsAt: new Date(e.ends_at),
      timezone: e.timezone,
      venueName: e.venue_name,
      venueAddress: e.venue_address,
    },
    tickets: data.tickets.map((ticket) => ({
      id: ticket.id,
      attendeeName: ticket.attendee_name,
      ticketTypeName: ticket.ticket_types.name,
      kind: ticket.ticket_types.kind,
      ticketCode: ticket.ticket_code,
      qrPayload: ticket.qr_payload,
      status: ticket.status,
    })),
  }
}
