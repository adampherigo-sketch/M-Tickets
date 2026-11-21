import type { DomainEvent } from '@zevaryn/core/events'
import type { TicketsContext } from './context'

/**
 * Publishes after the state change has committed. A failure is logged, not
 * thrown: the buyer's ticket or the door check-in must not fail because the
 * outbox write did. Known gap: an event can be lost if this write fails. The
 * fix is to insert outbox rows inside the same database function as the state
 * change (see the README's next steps).
 */
export async function publishSafely(ctx: TicketsContext, events: readonly DomainEvent[]): Promise<void> {
  if (events.length === 0) return
  try {
    await ctx.publisher.publish(events)
  } catch (error) {
    console.error(
      '[m-tickets] could not publish domain events',
      events.map((e) => e.type),
      error,
    )
  }
}
