/** What anonymous visitors can see through the public functions, and nothing more. */
import { actAsAdmin, actAsAnon, setupDb } from '@zevaryn/database/testing'
import { describe, expect, it } from 'vitest'
import { createTenantWithEvent, placeOrder } from './fixtures'

const getDb = setupDb()

interface Storefront {
  tenant: { name: string; slug: string }
  events: { slug: string; counts: { rsvps: number; tickets_sold: number } | null }[]
}
interface PublicEvent {
  event: { id: string; counts: unknown }
  ticket_types: { id: string; sales_state: string; remaining: number | null }[]
}

async function storefront(db: ReturnType<typeof getDb>, slug: string) {
  const [row] = await db.query<{ s: Storefront | null }>(`select public.tickets_public_storefront($1) as s`, [slug])
  return row!.s
}

async function publicEvent(db: ReturnType<typeof getDb>, slug: string, eventSlug: string) {
  const [row] = await db.query<{ e: PublicEvent | null }>(`select public.tickets_public_event($1, $2) as e`, [
    slug,
    eventSlug,
  ])
  return row!.e
}

describe('public ticket pages', () => {
  it('list only published events that have not ended', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await db.query(
      `insert into public.tickets_events (tenant_id, slug, title, starts_at, ends_at, status) values
         ($1, 'secret-draft', 'Draft', now() + interval '1 day', now() + interval '2 days', 'draft'),
         ($1, 'last-year', 'Past', now() - interval '2 days', now() - interval '1 day', 'published'),
         ($1, 'called-off', 'Cancelled', now() + interval '1 day', now() + interval '2 days', 'cancelled')`,
      [t.tenantId],
    )
    await actAsAnon(db)
    const page = await storefront(db, t.slug)
    expect(page?.tenant.name).toBe('alpha LLC')
    expect(page?.events.map((e) => e.slug)).toEqual(['launch-party'])
    expect(await publicEvent(db, t.slug, 'secret-draft')).toBeNull()
    expect(await publicEvent(db, t.slug, 'called-off')).toBeNull()
    expect(await storefront(db, 'no-such-client')).toBeNull()
  })

  it('hide counts and remaining seats by default', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await placeOrder(db, t.eventId, t.rsvpTypeId, 2)
    await actAsAnon(db)
    expect((await storefront(db, t.slug))?.events[0]?.counts).toBeNull()
    const event = await publicEvent(db, t.slug, t.eventSlug)
    expect(event?.event.counts).toBeNull()
    expect(event?.ticket_types.every((type) => type.remaining === null)).toBe(true)
  })

  it('show counts and remaining seats when the organizer turns them on', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha', { showPublicCounts: true })
    await placeOrder(db, t.eventId, t.rsvpTypeId, 2)
    await actAsAnon(db)
    expect((await storefront(db, t.slug))?.events[0]?.counts).toEqual({ rsvps: 2, tickets_sold: 0 })
    const event = await publicEvent(db, t.slug, t.eventSlug)
    expect(event?.ticket_types.find((type) => type.id === t.rsvpTypeId)?.remaining).toBe(3)
  })

  it('still says "sold out" when counts are hidden', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await placeOrder(db, t.eventId, t.rsvpTypeId, 5)
    await actAsAnon(db)
    const event = await publicEvent(db, t.slug, t.eventSlug)
    expect(event?.ticket_types.find((type) => type.id === t.rsvpTypeId)?.sales_state).toBe('sold_out')
    await actAsAdmin(db)
  })
})
