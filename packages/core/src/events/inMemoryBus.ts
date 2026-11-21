import type { DomainEvent, EventHandler, EventPublisher, EventSubscriber, Unsubscribe } from './envelope'

/**
 * Publisher and subscriber in one process. Used by tests and local wiring; in
 * production modules publish to the outbox and a relay fans events out.
 */
export class InMemoryEventBus implements EventPublisher, EventSubscriber {
  readonly published: DomainEvent[] = []
  private readonly handlers = new Map<string, Set<EventHandler>>()

  async publish(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      this.published.push(event)
      for (const handler of this.handlers.get(event.type) ?? []) {
        await handler(event)
      }
    }
  }

  subscribe<E extends DomainEvent>(type: E['type'], handler: EventHandler<E>): Unsubscribe {
    const set = this.handlers.get(type) ?? new Set<EventHandler>()
    set.add(handler as EventHandler)
    this.handlers.set(type, set)
    return () => set.delete(handler as EventHandler)
  }
}
