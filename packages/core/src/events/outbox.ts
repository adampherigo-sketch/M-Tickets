import type { DbClient, Json } from '@zevaryn/database'
import type { DomainEvent, EventPublisher } from './envelope'

/**
 * Writes events to public.domain_events. Needs a service-role client: the
 * outbox has no write policy for signed-in users.
 *
 * Delivery from the outbox to subscribers (a relay that reads unpublished rows
 * and stamps published_at) is not built yet.
 */
export class SupabaseOutboxPublisher implements EventPublisher {
  constructor(private readonly serviceClient: DbClient) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return
    const { error } = await this.serviceClient.from('domain_events').insert(
      events.map((event) => ({
        id: event.id,
        tenant_id: event.tenantId,
        type: event.type,
        version: event.version,
        source: event.source,
        payload: event.payload as Json,
        occurred_at: event.occurredAt,
      })),
    )
    if (error) throw new Error(`Could not record domain events: ${error.message}`)
  }
}
