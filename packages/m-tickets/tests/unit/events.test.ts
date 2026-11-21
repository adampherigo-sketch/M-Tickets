import { InMemoryEventBus } from '@zevaryn/core/events'
import { describe, expect, it } from 'vitest'
import {
  M_EVENTS_INTEGRATION_ENABLED,
  TICKETS_EVENT_TYPES,
  notWiredMEventsHandler,
  subscribeToMEvents,
  ticketsEvent,
} from '../../src/events'

const tenantId = '00000000-0000-4000-8000-000000000001'
const eventId = '00000000-0000-4000-8000-000000000002'

describe('domain event contracts', () => {
  it('publishes the documented event types', () => {
    expect(TICKETS_EVENT_TYPES.sort()).toEqual(
      [
        'tickets.attendee.checked_in',
        'tickets.attendees.thank_you_requested',
        'tickets.event.published',
        'tickets.event.unpublished',
        'tickets.order.completed',
        'tickets.order.refunded',
        'tickets.ticket.issued',
      ].sort(),
    )
  })

  it('builds a versioned envelope and validates the payload', () => {
    const event = ticketsEvent('tickets.event.unpublished', tenantId, { eventId, externalEventRef: null })
    expect(event).toMatchObject({ type: 'tickets.event.unpublished', version: 1, source: 'm-tickets', tenantId })
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(() =>
      ticketsEvent('tickets.event.unpublished', tenantId, { eventId: 'not-a-uuid', externalEventRef: null }),
    ).toThrow()
  })

  it('delivers through a bus to subscribers of that type only', async () => {
    const bus = new InMemoryEventBus()
    const seen: string[] = []
    bus.subscribe('tickets.event.unpublished', (e) => {
      seen.push(e.type)
    })
    await bus.publish([
      ticketsEvent('tickets.event.unpublished', tenantId, { eventId, externalEventRef: null }),
      ticketsEvent('tickets.attendees.thank_you_requested', tenantId, {
        eventId,
        queuedCount: 3,
        externalEventRef: null,
      }),
    ])
    expect(seen).toEqual(['tickets.event.unpublished'])
    expect(bus.published).toHaveLength(2)
  })

  it('keeps the M-Events inbound contract unwired', async () => {
    expect(M_EVENTS_INTEGRATION_ENABLED).toBe(false)
    expect(() => subscribeToMEvents(new InMemoryEventBus(), notWiredMEventsHandler)).toThrow(/disabled/)
    await expect(notWiredMEventsHandler.onEventCreated({} as never)).rejects.toThrow(/not built yet/)
  })
})
