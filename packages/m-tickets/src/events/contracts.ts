/**
 * Outbound contracts: the domain events M-Tickets publishes. Other modules
 * (M-Events first) depend on these shapes, so changes follow the envelope rules
 * in @zevaryn/core/events: add fields freely, never remove or retype one; a
 * breaking change ships as a new version.
 *
 * Payloads carry ids and facts, not names or emails. externalEventRef is the
 * M-Events id when the event is linked, so M-Events can correlate without
 * reading M-Tickets tables.
 */
import { createDomainEvent, type DomainEvent } from '@zevaryn/core/events'
import { z } from 'zod'

export const TICKETS_SOURCE = 'm-tickets'

const id = z.uuid()
const iso = z.iso.datetime({ offset: true })
const externalEventRef = z.string().nullable()

export const ticketsEventSchemas = {
  'tickets.event.published': z.object({
    eventId: id,
    slug: z.string(),
    startsAt: iso,
    endsAt: iso,
    externalEventRef,
  }),
  'tickets.event.unpublished': z.object({ eventId: id, externalEventRef }),
  'tickets.order.completed': z.object({
    orderId: id,
    eventId: id,
    kind: z.enum(['free', 'paid']),
    totalCents: z.number().int().nonnegative(),
    currency: z.string().length(3),
    ticketCount: z.number().int().positive(),
    provider: z.enum(['stripe', 'square']).nullable(),
    externalEventRef,
  }),
  'tickets.ticket.issued': z.object({
    ticketId: id,
    orderId: id,
    eventId: id,
    ticketTypeId: id,
    externalEventRef,
  }),
  'tickets.attendee.checked_in': z.object({
    ticketId: id,
    eventId: id,
    ticketTypeId: id,
    method: z.enum(['qr', 'manual']),
    checkedInAt: iso,
    externalEventRef,
  }),
  'tickets.order.refunded': z.object({
    orderId: id,
    eventId: id,
    /** Tickets that were valid and are now refunded (empty for a sold-out late payment: none were issued). */
    ticketIds: z.array(id),
    /** requested: organizer or provider dashboard; sold_out: payment landed after the seats were gone. */
    reason: z.enum(['requested', 'sold_out']),
    externalEventRef,
  }),
  'tickets.attendees.thank_you_requested': z.object({
    eventId: id,
    queuedCount: z.number().int().nonnegative(),
    externalEventRef,
  }),
} as const

export type TicketsEventType = keyof typeof ticketsEventSchemas
export type TicketsEventPayload<T extends TicketsEventType> = z.infer<(typeof ticketsEventSchemas)[T]>
export type TicketsDomainEvent<T extends TicketsEventType = TicketsEventType> = {
  [K in T]: DomainEvent<K, TicketsEventPayload<K>>
}[T]

export const TICKETS_EVENT_TYPES = Object.keys(ticketsEventSchemas) as TicketsEventType[]

/** Builds an event and validates its payload against the contract. */
export function ticketsEvent<T extends TicketsEventType>(
  type: T,
  tenantId: string,
  payload: TicketsEventPayload<T>,
  occurredAt?: Date,
): TicketsDomainEvent<T> {
  const parsed = ticketsEventSchemas[type].parse(payload) as TicketsEventPayload<T>
  return createDomainEvent({
    type,
    source: TICKETS_SOURCE,
    tenantId,
    payload: parsed,
    ...(occurredAt ? { occurredAt } : {}),
  }) as TicketsDomainEvent<T>
}
