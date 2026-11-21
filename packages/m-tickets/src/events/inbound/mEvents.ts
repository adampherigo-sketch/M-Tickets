/**
 * Inbound contract: events M-Tickets will consume from M-Events once the two
 * modules are linked. NOT WIRED. Nothing subscribes these handlers yet, and
 * M-Tickets must keep working with M-Events absent.
 *
 * Plan for the link (see the module README, "M-Events integration"):
 *   - events.event.created  -> offer to create a draft tickets_events row with
 *                              external_event_ref = payload.eventId
 *   - events.event.updated  -> copy title/time/venue onto the linked event
 *   - events.event.cancelled -> cancel the linked event and notify buyers
 *
 * The shapes below are M-Tickets' expectation of M-Events. Confirm them against
 * M-Events' published contract before wiring.
 */
import type { DomainEvent, EventSubscriber, Unsubscribe } from '@zevaryn/core/events'
import { z } from 'zod'

export const M_EVENTS_INTEGRATION_ENABLED = false

const iso = z.iso.datetime({ offset: true })

export const mEventsInboundSchemas = {
  'events.event.created': z.object({
    eventId: z.string().min(1),
    title: z.string(),
    startsAt: iso,
    endsAt: iso,
    venueName: z.string().nullable(),
    venueAddress: z.string().nullable(),
  }),
  'events.event.updated': z.object({
    eventId: z.string().min(1),
    title: z.string().optional(),
    startsAt: iso.optional(),
    endsAt: iso.optional(),
    venueName: z.string().nullable().optional(),
    venueAddress: z.string().nullable().optional(),
  }),
  'events.event.cancelled': z.object({ eventId: z.string().min(1), reason: z.string().nullable() }),
} as const

export type MEventsEventType = keyof typeof mEventsInboundSchemas
export type MEventsInboundEvent<T extends MEventsEventType = MEventsEventType> = {
  [K in T]: DomainEvent<K, z.infer<(typeof mEventsInboundSchemas)[K]>>
}[T]

export interface MEventsInboundHandler {
  onEventCreated(event: MEventsInboundEvent<'events.event.created'>): Promise<void>
  onEventUpdated(event: MEventsInboundEvent<'events.event.updated'>): Promise<void>
  onEventCancelled(event: MEventsInboundEvent<'events.event.cancelled'>): Promise<void>
}

class NotWiredError extends Error {
  constructor(type: MEventsEventType) {
    super(`M-Events integration is not built yet (${type})`)
    this.name = 'NotWiredError'
  }
}

/** Placeholder implementation; replace when the integration is built. */
export const notWiredMEventsHandler: MEventsInboundHandler = {
  async onEventCreated() {
    throw new NotWiredError('events.event.created')
  },
  async onEventUpdated() {
    throw new NotWiredError('events.event.updated')
  },
  async onEventCancelled() {
    throw new NotWiredError('events.event.cancelled')
  },
}

/**
 * Registers the handler on a subscriber, validating each payload first.
 * Intentionally not called anywhere while M_EVENTS_INTEGRATION_ENABLED is false.
 */
export function subscribeToMEvents(subscriber: EventSubscriber, handler: MEventsInboundHandler): Unsubscribe {
  if (!M_EVENTS_INTEGRATION_ENABLED) {
    throw new Error('M-Events integration is disabled. Flip M_EVENTS_INTEGRATION_ENABLED once it is built.')
  }
  const validate = <T extends MEventsEventType>(type: T, event: DomainEvent) =>
    ({ ...event, payload: mEventsInboundSchemas[type].parse(event.payload) }) as MEventsInboundEvent<T>
  const subscriptions = [
    subscriber.subscribe('events.event.created', (e) => handler.onEventCreated(validate('events.event.created', e))),
    subscriber.subscribe('events.event.updated', (e) => handler.onEventUpdated(validate('events.event.updated', e))),
    subscriber.subscribe('events.event.cancelled', (e) =>
      handler.onEventCancelled(validate('events.event.cancelled', e)),
    ),
  ]
  return () => subscriptions.forEach((unsubscribe) => unsubscribe())
}
