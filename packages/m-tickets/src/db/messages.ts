/**
 * Ticket delivery and the outbound message queue. Service-role client only:
 * ticket_order_delivery holds encrypted ticket-link tokens and is invisible to
 * organizers, and the dispatcher functions are granted to service_role alone.
 */
import type { DbClient } from '@zevaryn/database'
import { z } from 'zod'
import type { DeliveryChoice } from '../domain'
import { toTicketsDbError } from './errors'

/** Written before tickets_place_order, keyed by the order's access-token hash. */
export async function saveOrderDelivery(
  service: DbClient,
  input: { accessTokenHash: string; tenantId: string; delivery: DeliveryChoice; tokenCiphertext: string },
): Promise<void> {
  const { error } = await service.from('ticket_order_delivery').upsert({
    access_token_hash: input.accessTokenHash,
    tenant_id: input.tenantId,
    channel: input.delivery.channel,
    phone: input.delivery.channel === 'sms' ? input.delivery.phone : null,
    token_ciphertext: input.tokenCiphertext,
  })
  if (error) throw toTicketsDbError(error, 'Save order delivery')
}

/** Best effort, after an order was rejected: housekeeping purges anything left over. */
export async function discardOrderDelivery(service: DbClient, accessTokenHash: string): Promise<void> {
  const { error } = await service.from('ticket_order_delivery').delete().eq('access_token_hash', accessTokenHash)
  if (error) console.error('[m-tickets] could not discard order delivery', toTicketsDbError(error, 'Discard delivery'))
}

/**
 * Gives a completed order a new ticket link: used only when its encrypted
 * token is gone (for example the delivery row was never written), so the
 * confirmation can still carry a working link. The old link stops working.
 */
export async function replaceAccessTokenHash(
  service: DbClient,
  orderId: string,
  input: { previousHash: string; nextHash: string },
): Promise<boolean> {
  const { data, error } = await service
    .from('ticket_orders')
    .update({ access_token_hash: input.nextHash })
    .eq('id', orderId)
    .eq('access_token_hash', input.previousHash)
    .select('id')
  if (error) throw toTicketsDbError(error, 'Replace ticket link')
  return (data ?? []).length === 1
}

const isoDate = z.string().transform((value) => new Date(value))

const claimedMessageSchema = z.object({
  id: z.uuid(),
  template: z.enum(['order_confirmation', 'thank_you']),
  channel: z.enum(['email', 'sms']),
  to_email: z.string().nullable(),
  to_phone: z.string().nullable(),
  attempts: z.number().int(),
  tenant_id: z.uuid(),
  tenant_name: z.string(),
  tenant_slug: z.string(),
  event: z.object({
    title: z.string(),
    slug: z.string(),
    starts_at: isoDate,
    ends_at: isoDate,
    timezone: z.string(),
    venue_name: z.string().nullable(),
    venue_address: z.string().nullable(),
  }),
  order: z
    .object({
      id: z.uuid(),
      status: z.string(),
      buyer_name: z.string(),
      total_cents: z.number(),
      currency: z.string(),
      access_token_hash: z.string(),
      token_ciphertext: z.string().nullable(),
      tickets: z.array(
        z.object({ code: z.string(), type_name: z.string(), attendee_name: z.string(), status: z.string() }),
      ),
    })
    .nullable(),
  attendee_name: z.string().nullable(),
})

export interface ClaimedMessage {
  id: string
  template: 'order_confirmation' | 'thank_you'
  channel: 'email' | 'sms'
  toEmail: string | null
  toPhone: string | null
  attempts: number
  tenantId: string
  tenantName: string
  tenantSlug: string
  event: {
    title: string
    slug: string
    startsAt: Date
    endsAt: Date
    timezone: string
    venueName: string | null
    venueAddress: string | null
  }
  order: {
    id: string
    status: string
    buyerName: string
    totalCents: number
    currency: string
    accessTokenHash: string
    tokenCiphertext: string | null
    tickets: { code: string; typeName: string; attendeeName: string; status: string }[]
  } | null
  attendeeName: string | null
}

/** Locks up to `limit` due messages for 5 minutes and returns them ready to render. */
export async function claimMessages(service: DbClient, limit: number): Promise<ClaimedMessage[]> {
  const { data, error } = await service.rpc('tickets_claim_messages', { p_limit: limit })
  if (error) throw toTicketsDbError(error, 'Claim messages')
  return z
    .array(claimedMessageSchema)
    .parse(data ?? [])
    .map((m) => ({
      id: m.id,
      template: m.template,
      channel: m.channel,
      toEmail: m.to_email,
      toPhone: m.to_phone,
      attempts: m.attempts,
      tenantId: m.tenant_id,
      tenantName: m.tenant_name,
      tenantSlug: m.tenant_slug,
      event: {
        title: m.event.title,
        slug: m.event.slug,
        startsAt: m.event.starts_at,
        endsAt: m.event.ends_at,
        timezone: m.event.timezone,
        venueName: m.event.venue_name,
        venueAddress: m.event.venue_address,
      },
      order: m.order && {
        id: m.order.id,
        status: m.order.status,
        buyerName: m.order.buyer_name,
        totalCents: m.order.total_cents,
        currency: m.order.currency,
        accessTokenHash: m.order.access_token_hash,
        tokenCiphertext: m.order.token_ciphertext,
        tickets: m.order.tickets.map((t) => ({
          code: t.code,
          typeName: t.type_name,
          attendeeName: t.attendee_name,
          status: t.status,
        })),
      },
      attendeeName: m.attendee_name,
    }))
}

export type MessageOutcome = { sent: true; providerMessageId?: string } | { sent: false; error: string; retry: boolean }

/** Returns the message's new status: sent, queued (retry scheduled) or failed. */
export async function finishMessage(
  service: DbClient,
  messageId: string,
  outcome: MessageOutcome,
): Promise<'sent' | 'queued' | 'failed'> {
  const { data, error } = await service.rpc('tickets_finish_message', {
    p_message_id: messageId,
    p_sent: outcome.sent,
    ...(outcome.sent
      ? outcome.providerMessageId
        ? { p_provider_message_id: outcome.providerMessageId }
        : {}
      : { p_error: outcome.error, p_retry: outcome.retry }),
  })
  if (error) throw toTicketsDbError(error, 'Finish message')
  return z.enum(['sent', 'queued', 'failed']).parse(data)
}

export interface HousekeepingResult {
  expiredOrders: number
  purgedDeliveries: number
  wipedTokens: number
}

export async function runHousekeeping(service: DbClient): Promise<HousekeepingResult> {
  const { data, error } = await service.rpc('tickets_housekeeping')
  if (error) throw toTicketsDbError(error, 'Housekeeping')
  const parsed = z
    .object({ expired_orders: z.number(), purged_deliveries: z.number(), wiped_tokens: z.number() })
    .parse(data)
  return {
    expiredOrders: parsed.expired_orders,
    purgedDeliveries: parsed.purged_deliveries,
    wipedTokens: parsed.wiped_tokens,
  }
}
