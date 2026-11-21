import { actAs, actAsAdmin, actAsAnon, setupDb } from '@zevaryn/database/testing'
import { describe, expect, it } from 'vitest'
import { DEMO, seedDemo } from '../../seed/demo'
import { QR_SECRET, checkIn } from './fixtures'

const getDb = setupDb()

describe('demo seed', () => {
  it('creates a working demo tenant once', async () => {
    const db = getDb()
    await actAsAdmin(db)
    const summary = await seedDemo(db, { qrSecret: QR_SECRET })
    expect(summary).not.toBeNull()
    expect(summary!.orders.flatMap((o) => o.tickets)).toHaveLength(4)
    expect(await seedDemo(db, { qrSecret: QR_SECRET })).toBeNull()

    await actAsAnon(db)
    const [row] = await db.query<{ s: { events: { slug: string }[] } }>(
      `select public.tickets_public_storefront($1) as s`,
      [DEMO.tenantSlug],
    )
    expect(row!.s.events.map((e) => e.slug)).toEqual([DEMO.eventSlug])

    await actAs(db, summary!.staffId)
    const grace = summary!.orders[0]!.tickets[0]!
    expect((await checkIn(db, summary!.eventId, grace.code)).result).toBe('checked_in')
    const alan = summary!.orders[2]!.tickets[0]!
    expect((await checkIn(db, summary!.eventId, alan.code)).result).toBe('already_checked_in')
  })
})
