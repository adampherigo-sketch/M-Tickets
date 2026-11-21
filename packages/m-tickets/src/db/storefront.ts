/**
 * Public reads, through the security definer functions. Works with an
 * anonymous client: no session, no table access.
 */
import type { DbClient } from '@zevaryn/database'
import { z } from 'zod'
import { toTicketsDbError } from './errors'

const date = z.string().transform((value) => new Date(value))
const counts = z
  .object({ rsvps: z.number(), tickets_sold: z.number() })
  .nullable()
  .transform((value) => (value ? { rsvps: value.rsvps, ticketsSold: value.tickets_sold } : null))

const storefrontSchema = z.object({
  tenant: z.object({ name: z.string(), slug: z.string() }),
  events: z.array(
    z
      .object({
        slug: z.string(),
        title: z.string(),
        summary: z.string(),
        venue_name: z.string().nullable(),
        starts_at: date,
        ends_at: date,
        timezone: z.string(),
        price_from_cents: z.number().nullable(),
        currency: z.string().nullable(),
        has_rsvp: z.boolean(),
        counts,
      })
      .transform((e) => ({
        slug: e.slug,
        title: e.title,
        summary: e.summary,
        venueName: e.venue_name,
        startsAt: e.starts_at,
        endsAt: e.ends_at,
        timezone: e.timezone,
        priceFromCents: e.price_from_cents,
        currency: e.currency,
        hasRsvp: e.has_rsvp,
        counts: e.counts,
      })),
  ),
})

const publicEventSchema = z.object({
  tenant: z.object({ name: z.string(), slug: z.string() }),
  event: z
    .object({
      id: z.uuid(),
      slug: z.string(),
      title: z.string(),
      description: z.string(),
      venue_name: z.string().nullable(),
      venue_address: z.string().nullable(),
      starts_at: date,
      ends_at: date,
      timezone: z.string(),
      counts,
    })
    .transform((e) => ({
      id: e.id,
      slug: e.slug,
      title: e.title,
      description: e.description,
      venueName: e.venue_name,
      venueAddress: e.venue_address,
      startsAt: e.starts_at,
      endsAt: e.ends_at,
      timezone: e.timezone,
      counts: e.counts,
    })),
  ticket_types: z.array(
    z
      .object({
        id: z.uuid(),
        name: z.string(),
        description: z.string(),
        kind: z.enum(['rsvp', 'paid']),
        price_cents: z.number(),
        currency: z.string(),
        max_per_order: z.number(),
        sales_start: date.nullable(),
        sales_end: date.nullable(),
        sales_state: z.enum(['not_started', 'on_sale', 'ended', 'sold_out']),
        remaining: z.number().nullable(),
      })
      .transform((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        kind: t.kind,
        priceCents: t.price_cents,
        currency: t.currency,
        maxPerOrder: t.max_per_order,
        salesStart: t.sales_start,
        salesEnd: t.sales_end,
        salesState: t.sales_state,
        /** Only present when the organizer shows public counts. */
        remaining: t.remaining,
      })),
  ),
})

export type Storefront = z.output<typeof storefrontSchema>
export type PublicEvent = z.output<typeof publicEventSchema>
export type PublicTicketType = PublicEvent['ticket_types'][number]

export async function getStorefront(client: DbClient, clientSlug: string): Promise<Storefront | null> {
  const { data, error } = await client.rpc('tickets_public_storefront', { p_client_slug: clientSlug })
  if (error) throw toTicketsDbError(error, 'Load storefront')
  return data === null ? null : storefrontSchema.parse(data)
}

export async function getPublicEvent(
  client: DbClient,
  clientSlug: string,
  eventSlug: string,
): Promise<PublicEvent | null> {
  const { data, error } = await client.rpc('tickets_public_event', {
    p_client_slug: clientSlug,
    p_event_slug: eventSlug,
  })
  if (error) throw toTicketsDbError(error, 'Load event')
  return data === null ? null : publicEventSchema.parse(data)
}
