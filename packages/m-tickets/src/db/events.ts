/**
 * Organizer event management. Pass a signed-in user's client: RLS limits reads
 * to the user's tenants and writes to owners and admins.
 */
import type { DbClient, Tables } from '@zevaryn/database'
import type { EventStatus, TicketKind } from '../domain'
import { toTicketsDbError, unwrap } from './errors'

export interface OrganizerEvent {
  id: string
  tenantId: string
  slug: string
  title: string
  description: string
  venueName: string | null
  venueAddress: string | null
  timezone: string
  startsAt: Date
  endsAt: Date
  status: EventStatus
  showPublicCounts: boolean
  externalEventRef: string | null
  publishedAt: Date | null
}

export interface EventStats {
  ticketsSold: number
  rsvps: number
  checkedIn: number
  attendees: number
  grossCents: number
}

export interface EventInput {
  slug: string
  title: string
  description: string
  venueName: string | null
  venueAddress: string | null
  timezone: string
  startsAt: Date
  endsAt: Date
  showPublicCounts: boolean
}

export interface TicketTypeRecord {
  id: string
  eventId: string
  name: string
  description: string
  kind: TicketKind
  priceCents: number
  currency: string
  quantityLimit: number | null
  maxPerOrder: number
  salesStart: Date | null
  salesEnd: Date | null
  sortOrder: number
  taken: number
}

export interface TicketTypeInput {
  name: string
  description: string
  kind: TicketKind
  priceCents: number
  currency: string
  quantityLimit: number | null
  maxPerOrder: number
  salesStart: Date | null
  salesEnd: Date | null
  sortOrder: number
}

const EMPTY_STATS: EventStats = { ticketsSold: 0, rsvps: 0, checkedIn: 0, attendees: 0, grossCents: 0 }

const toDate = (value: string | null) => (value ? new Date(value) : null)

export function toOrganizerEvent(row: Tables<'tickets_events'>): OrganizerEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    venueName: row.venue_name,
    venueAddress: row.venue_address,
    timezone: row.timezone,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    status: row.status,
    showPublicCounts: row.show_public_counts,
    externalEventRef: row.external_event_ref,
    publishedAt: toDate(row.published_at),
  }
}

function toStats(row: Partial<Tables<'tickets_event_stats'>> | undefined): EventStats {
  if (!row) return EMPTY_STATS
  return {
    ticketsSold: row.tickets_sold ?? 0,
    rsvps: row.rsvps ?? 0,
    checkedIn: row.checked_in ?? 0,
    attendees: row.attendees ?? 0,
    grossCents: row.gross_cents ?? 0,
  }
}

function eventColumns(input: Partial<EventInput>) {
  return {
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.venueName !== undefined ? { venue_name: input.venueName } : {}),
    ...(input.venueAddress !== undefined ? { venue_address: input.venueAddress } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.startsAt !== undefined ? { starts_at: input.startsAt.toISOString() } : {}),
    ...(input.endsAt !== undefined ? { ends_at: input.endsAt.toISOString() } : {}),
    ...(input.showPublicCounts !== undefined ? { show_public_counts: input.showPublicCounts } : {}),
  }
}

export async function listEventsWithStats(
  client: DbClient,
  tenantId: string,
): Promise<(OrganizerEvent & { stats: EventStats })[]> {
  const [events, stats] = await Promise.all([
    client.from('tickets_events').select('*').eq('tenant_id', tenantId).order('starts_at', { ascending: false }),
    client.from('tickets_event_stats').select('*').eq('tenant_id', tenantId),
  ])
  const rows = unwrap(events, 'List events')
  const byEvent = new Map(unwrap(stats, 'Load event stats').map((row) => [row.event_id, row]))
  return rows.map((row) => ({ ...toOrganizerEvent(row), stats: toStats(byEvent.get(row.id)) }))
}

export async function getEvent(client: DbClient, eventId: string): Promise<OrganizerEvent | null> {
  const { data, error } = await client.from('tickets_events').select('*').eq('id', eventId).maybeSingle()
  if (error) throw toTicketsDbError(error, 'Load event')
  return data ? toOrganizerEvent(data) : null
}

export async function getEventStats(client: DbClient, eventId: string): Promise<EventStats> {
  const { data, error } = await client.from('tickets_event_stats').select('*').eq('event_id', eventId).maybeSingle()
  if (error) throw toTicketsDbError(error, 'Load event stats')
  return toStats(data ?? undefined)
}

export async function createEvent(client: DbClient, tenantId: string, input: EventInput): Promise<string> {
  const row = unwrap(
    await client
      .from('tickets_events')
      .insert({
        tenant_id: tenantId,
        slug: input.slug,
        title: input.title,
        description: input.description,
        venue_name: input.venueName,
        venue_address: input.venueAddress,
        timezone: input.timezone,
        starts_at: input.startsAt.toISOString(),
        ends_at: input.endsAt.toISOString(),
        show_public_counts: input.showPublicCounts,
      })
      .select('id')
      .single(),
    'Create event',
  )
  return row.id
}

export async function updateEvent(
  client: DbClient,
  eventId: string,
  input: Partial<EventInput>,
): Promise<OrganizerEvent> {
  return toOrganizerEvent(
    unwrap(
      await client.from('tickets_events').update(eventColumns(input)).eq('id', eventId).select('*').single(),
      'Update event',
    ),
  )
}

export async function setEventStatus(client: DbClient, eventId: string, status: EventStatus): Promise<OrganizerEvent> {
  const patch = status === 'published' ? { status, published_at: new Date().toISOString() } : { status }
  return toOrganizerEvent(
    unwrap(
      await client.from('tickets_events').update(patch).eq('id', eventId).select('*').single(),
      'Change event status',
    ),
  )
}

// ---------------------------------------------------------------------------
// Ticket types
// ---------------------------------------------------------------------------

function ticketTypeColumns(input: Partial<TicketTypeInput>) {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(input.priceCents !== undefined ? { price_cents: input.priceCents } : {}),
    ...(input.currency !== undefined ? { currency: input.currency } : {}),
    ...(input.quantityLimit !== undefined ? { quantity_limit: input.quantityLimit } : {}),
    ...(input.maxPerOrder !== undefined ? { max_per_order: input.maxPerOrder } : {}),
    ...(input.salesStart !== undefined ? { sales_start: input.salesStart?.toISOString() ?? null } : {}),
    ...(input.salesEnd !== undefined ? { sales_end: input.salesEnd?.toISOString() ?? null } : {}),
    ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
  }
}

export async function listTicketTypes(client: DbClient, eventId: string): Promise<TicketTypeRecord[]> {
  const [types, availability] = await Promise.all([
    client.from('ticket_types').select('*').eq('event_id', eventId).order('sort_order').order('created_at'),
    client.from('ticket_type_availability').select('ticket_type_id, taken').eq('event_id', eventId),
  ])
  const taken = new Map(unwrap(availability, 'Load availability').map((row) => [row.ticket_type_id, row.taken ?? 0]))
  return unwrap(types, 'List ticket types').map((row) => ({
    id: row.id,
    eventId: row.event_id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    priceCents: row.price_cents,
    currency: row.currency,
    quantityLimit: row.quantity_limit,
    maxPerOrder: row.max_per_order,
    salesStart: toDate(row.sales_start),
    salesEnd: toDate(row.sales_end),
    sortOrder: row.sort_order,
    taken: taken.get(row.id) ?? 0,
  }))
}

export async function createTicketType(
  client: DbClient,
  event: { id: string; tenantId: string },
  input: TicketTypeInput,
): Promise<string> {
  const row = unwrap(
    await client
      .from('ticket_types')
      .insert({
        tenant_id: event.tenantId,
        event_id: event.id,
        name: input.name,
        description: input.description,
        kind: input.kind,
        price_cents: input.priceCents,
        currency: input.currency,
        quantity_limit: input.quantityLimit,
        max_per_order: input.maxPerOrder,
        sales_start: input.salesStart?.toISOString() ?? null,
        sales_end: input.salesEnd?.toISOString() ?? null,
        sort_order: input.sortOrder,
      })
      .select('id')
      .single(),
    'Create ticket type',
  )
  return row.id
}

export async function updateTicketType(
  client: DbClient,
  ticketTypeId: string,
  input: Partial<TicketTypeInput>,
): Promise<void> {
  const { error } = await client.from('ticket_types').update(ticketTypeColumns(input)).eq('id', ticketTypeId)
  if (error) throw toTicketsDbError(error, 'Update ticket type')
}

/** Fails with code "in_use" once tickets exist for the type. */
export async function deleteTicketType(client: DbClient, ticketTypeId: string): Promise<void> {
  const { error } = await client.from('ticket_types').delete().eq('id', ticketTypeId)
  if (error) throw toTicketsDbError(error, 'Delete ticket type')
}
