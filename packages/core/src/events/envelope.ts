/**
 * The envelope every M-System module uses for domain events. Modules talk to
 * each other only through these: a module never reads another module's tables.
 *
 * Conventions:
 *   - type is "<module>.<aggregate>.<past-tense verb>", e.g. tickets.order.completed
 *   - version starts at 1; a breaking payload change ships as version 2 alongside 1
 *   - payloads carry ids and facts, not personal data; consumers that need more
 *     ask the owning module through its public API
 */
export interface DomainEvent<TType extends string = string, TPayload = unknown> {
  /** Unique per event; consumers use it to deduplicate (delivery is at least once). */
  readonly id: string
  readonly type: TType
  readonly version: number
  /** The module that published it, e.g. "m-tickets". */
  readonly source: string
  readonly tenantId: string
  /** ISO 8601 */
  readonly occurredAt: string
  readonly payload: TPayload
}

export interface CreateEventInput<TType extends string, TPayload> {
  type: TType
  source: string
  tenantId: string
  payload: TPayload
  version?: number
  occurredAt?: Date
  id?: string
}

export function createDomainEvent<TType extends string, TPayload>(
  input: CreateEventInput<TType, TPayload>,
): DomainEvent<TType, TPayload> {
  return {
    id: input.id ?? crypto.randomUUID(),
    type: input.type,
    version: input.version ?? 1,
    source: input.source,
    tenantId: input.tenantId,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    payload: input.payload,
  }
}

export interface EventPublisher {
  publish(events: readonly DomainEvent[]): Promise<void>
}

export type EventHandler<E extends DomainEvent = DomainEvent> = (event: E) => Promise<void> | void
export type Unsubscribe = () => void

export interface EventSubscriber {
  subscribe<E extends DomainEvent>(type: E['type'], handler: EventHandler<E>): Unsubscribe
}
