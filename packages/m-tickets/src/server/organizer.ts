/**
 * Organizer actions. `user` is the signed-in organizer's client, so RLS and
 * the database functions' own membership checks apply. Role checks that guard
 * service-role work (refunds, payment onboarding) are done here explicitly.
 */
import { MANAGER_ROLES, hasRole, type TenantRole } from '@zevaryn/core/tenancy'
import type { DbClient } from '@zevaryn/database'
import {
  canUnpublish,
  parseCheckInInput,
  publishProblems,
  PUBLISH_PROBLEM_MESSAGES,
  type PublishProblem,
} from '../domain'
import {
  checkInTicket,
  getEvent,
  getOrder,
  listPaymentAccounts,
  listTicketTypes,
  queueThankYou,
  setEventStatus,
  upsertPaymentAccount,
  type CheckInResponse,
} from '../db'
import { ticketsEvent } from '../events/contracts'
import type { PaymentProviderId } from '../payments/types'
import type { TicketsContext } from './context'
import { applyRefund } from './orders'
import { publishSafely } from './publish'

export class OrganizerActionError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid',
    message: string,
  ) {
    super(message)
    this.name = 'OrganizerActionError'
  }
}

function requireManager(role: TenantRole): void {
  if (!hasRole(role, MANAGER_ROLES)) throw new OrganizerActionError('forbidden', 'Only owners and admins can do that.')
}

export async function publishEvent(
  ctx: TicketsContext,
  user: DbClient,
  eventId: string,
): Promise<{ ok: true } | { ok: false; problems: PublishProblem[]; messages: string[] }> {
  const event = await getEvent(user, eventId)
  if (!event) throw new OrganizerActionError('not_found', 'Event not found')
  const ticketTypes = await listTicketTypes(user, eventId)
  const problems = publishProblems(event, ticketTypes.length, ctx.now())
  if (problems.length > 0) return { ok: false, problems, messages: problems.map((p) => PUBLISH_PROBLEM_MESSAGES[p]) }
  const updated = await setEventStatus(user, eventId, 'published')
  await publishSafely(ctx, [
    ticketsEvent('tickets.event.published', updated.tenantId, {
      eventId,
      slug: updated.slug,
      startsAt: updated.startsAt.toISOString(),
      endsAt: updated.endsAt.toISOString(),
      externalEventRef: updated.externalEventRef,
    }),
  ])
  return { ok: true }
}

export async function unpublishEvent(ctx: TicketsContext, user: DbClient, eventId: string): Promise<void> {
  const event = await getEvent(user, eventId)
  if (!event) throw new OrganizerActionError('not_found', 'Event not found')
  if (!canUnpublish(event.status))
    throw new OrganizerActionError('invalid', 'Only published events can be unpublished.')
  const updated = await setEventStatus(user, eventId, 'draft')
  await publishSafely(ctx, [
    ticketsEvent('tickets.event.unpublished', updated.tenantId, {
      eventId,
      externalEventRef: updated.externalEventRef,
    }),
  ])
}

/** One box at the door: camera scans and typed codes both land here. */
export async function checkIn(
  ctx: TicketsContext,
  user: DbClient,
  input: { eventId: string; input: string },
): Promise<CheckInResponse> {
  const parsed = await parseCheckInInput(input.input, ctx.config.qrSecret)
  const response = parsed.ok
    ? await checkInTicket(user, { eventId: input.eventId, method: parsed.method, code: parsed.code })
    : await checkInTicket(user, { eventId: input.eventId, method: parsed.method, rejectedReason: parsed.reason })

  if (response.result === 'checked_in' && response.ticket) {
    const event = await getEvent(user, input.eventId)
    if (event) {
      await publishSafely(ctx, [
        ticketsEvent('tickets.attendee.checked_in', event.tenantId, {
          ticketId: response.ticket.id,
          eventId: event.id,
          ticketTypeId: response.ticket.ticketTypeId,
          method: parsed.method,
          checkedInAt: new Date(response.ticket.checkedInAt ?? ctx.now()).toISOString(),
          externalEventRef: event.externalEventRef,
        }),
      ])
    }
  }
  return response
}

/** Queues a thank-you for every checked-in guest. Sending is stubbed (see messaging.ts). */
export async function thankAttendees(ctx: TicketsContext, user: DbClient, eventId: string): Promise<number> {
  const event = await getEvent(user, eventId)
  if (!event) throw new OrganizerActionError('not_found', 'Event not found')
  const queued = await queueThankYou(user, eventId)
  await publishSafely(ctx, [
    ticketsEvent('tickets.attendees.thank_you_requested', event.tenantId, {
      eventId,
      queuedCount: queued,
      externalEventRef: event.externalEventRef,
    }),
  ])
  return queued
}

/** Full refund of one order through the client's payment provider. */
export async function refundOrderAsOrganizer(
  ctx: TicketsContext,
  user: DbClient,
  input: { orderId: string; actorRole: TenantRole },
): Promise<void> {
  requireManager(input.actorRole)
  const order = await getOrder(user, input.orderId)
  if (!order) throw new OrganizerActionError('not_found', 'Order not found')
  if (order.status !== 'completed') throw new OrganizerActionError('invalid', 'Only completed orders can be refunded.')

  if (order.totalCents > 0) {
    if (!order.provider || !order.providerPaymentRef)
      throw new OrganizerActionError('invalid', 'Order has no payment to refund.')
    const account = (await listPaymentAccounts(ctx.service, order.tenantId)).find((a) => a.provider === order.provider)
    if (!account)
      throw new OrganizerActionError('invalid', 'The payment account for this order is no longer connected.')
    await ctx.payments.get(order.provider).refund({
      account,
      providerPaymentRef: order.providerPaymentRef,
      reason: 'requested_by_customer',
      idempotencyKey: `refund:${order.id}`,
    })
  }
  // The provider's refund webhook also lands here; applying twice is a no-op.
  await applyRefund(ctx, order.id)
}

// ---------------------------------------------------------------------------
// Payment account onboarding
// ---------------------------------------------------------------------------

export async function startPaymentOnboarding(
  ctx: TicketsContext,
  input: {
    tenantId: string
    tenantName: string
    email: string | null
    actorRole: TenantRole
    provider: PaymentProviderId
  },
): Promise<string> {
  requireManager(input.actorRole)
  const provider = ctx.payments.get(input.provider)
  const existing = (await listPaymentAccounts(ctx.service, input.tenantId)).find((a) => a.provider === input.provider)
  const base = `${ctx.config.appUrl}/organizer/payments`
  const result = await provider.connectAccount({
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    email: input.email,
    existingProviderAccountId: existing?.providerAccountId ?? null,
    returnUrl: `${base}/return?provider=${input.provider}`,
    refreshUrl: `${base}?resume=${input.provider}`,
  })
  await upsertPaymentAccount(ctx.service, {
    tenantId: input.tenantId,
    provider: input.provider,
    providerAccountId: result.providerAccountId,
    status: result.status,
    chargesEnabled: result.status === 'connected',
    detailsSubmitted: existing?.detailsSubmitted ?? false,
  })
  return result.onboardingUrl
}

/** Called when the organizer comes back from the provider's onboarding. */
export async function refreshPaymentAccount(
  ctx: TicketsContext,
  input: { tenantId: string; actorRole: TenantRole; provider: PaymentProviderId },
): Promise<void> {
  requireManager(input.actorRole)
  const existing = (await listPaymentAccounts(ctx.service, input.tenantId)).find((a) => a.provider === input.provider)
  if (!existing) return
  const status = await ctx.payments.get(input.provider).getAccountStatus(existing.providerAccountId)
  await upsertPaymentAccount(ctx.service, { ...existing, ...status })
}
