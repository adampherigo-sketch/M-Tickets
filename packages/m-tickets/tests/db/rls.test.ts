/**
 * Tenant isolation: a member of tenant B must see zero rows of tenant A in
 * every M-Tickets table and view, and must not be able to write into it.
 * Anonymous callers get no table access at all.
 */
import { actAs, actAsAdmin, actAsAnon, createUser, expectDbError, setupDb } from '@zevaryn/database/testing'
import { describe, expect, it } from 'vitest'
import { checkIn, count, createTenantWithEvent, placeOrder } from './fixtures'

const getDb = setupDb()

const TENANT_TABLES = [
  'tickets_events',
  'ticket_types',
  'ticket_orders',
  'tickets',
  'ticket_checkin_log',
  'ticket_order_log',
  'ticket_messages',
  'tenant_payment_accounts',
  'tenant_members',
  'domain_events',
] as const
const VIEWS = ['ticket_type_availability', 'tickets_event_stats'] as const

async function seedEverything(db: ReturnType<typeof getDb>, label: string) {
  const t = await createTenantWithEvent(db, label)
  const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 2)
  await actAs(db, t.staffId)
  await checkIn(db, t.eventId, order.codes[0]!)
  await actAs(db, t.ownerId)
  await db.query(`select public.tickets_queue_thank_you($1)`, [t.eventId])
  await actAsAdmin(db)
  await db.query(
    `insert into public.tenant_payment_accounts (tenant_id, provider, provider_account_id, status) values ($1, 'stripe', $2, 'connected')`,
    [t.tenantId, `acct_${label}`],
  )
  await db.query(
    `insert into public.ticket_order_log (tenant_id, event_id, order_id, action) values ($1, $2, $3, 'late_payment_honored')`,
    [t.tenantId, t.eventId, order.orderId],
  )
  await db.query(
    `insert into public.domain_events (id, tenant_id, type, source, occurred_at) values (gen_random_uuid(), $1, 'tickets.test.seeded', 'test', now())`,
    [t.tenantId],
  )
  return t
}

describe('M-Tickets row level security', () => {
  it('shows another tenant zero rows in every table and view', async () => {
    const db = getDb()
    const a = await seedEverything(db, 'alpha')
    const b = await seedEverything(db, 'bravo')

    for (const relation of [...TENANT_TABLES, ...VIEWS]) {
      expect(
        await count(db, `select count(*)::int as n from public.${relation} where tenant_id = $1`, [a.tenantId]),
        `${relation} seeded`,
      ).toBeGreaterThan(0)
    }

    await actAs(db, b.ownerId)
    for (const relation of [...TENANT_TABLES, ...VIEWS]) {
      expect(
        await count(db, `select count(*)::int as n from public.${relation} where tenant_id = $1`, [a.tenantId]),
        `${relation} leaked`,
      ).toBe(0)
      expect(
        await count(db, `select count(*)::int as n from public.${relation} where tenant_id = $1`, [b.tenantId]),
        `${relation} own`,
      ).toBeGreaterThan(0)
    }
    expect(await count(db, `select count(*)::int as n from public.tenants where id = $1`, [a.tenantId])).toBe(0)
  })

  it('shows a signed-in user with no tenant nothing at all', async () => {
    const db = getDb()
    await seedEverything(db, 'alpha')
    await actAsAdmin(db)
    const stranger = await createUser(db, 'stranger')
    await actAs(db, stranger)
    for (const relation of ['tenants', ...TENANT_TABLES, ...VIEWS]) {
      expect(await count(db, `select count(*)::int as n from public.${relation}`), relation).toBe(0)
    }
  })

  it('gives anonymous callers no table access', async () => {
    const db = getDb()
    await seedEverything(db, 'alpha')
    await actAsAnon(db)
    for (const relation of ['tenants', ...TENANT_TABLES, ...VIEWS]) {
      await expectDbError(db, () => db.query(`select * from public.${relation} limit 1`), /permission denied/)
    }
  })

  it('blocks writes into another tenant', async () => {
    const db = getDb()
    const a = await createTenantWithEvent(db, 'alpha')
    const b = await createTenantWithEvent(db, 'bravo')
    await actAs(db, b.ownerId)

    await expectDbError(
      db,
      () =>
        db.query(
          `insert into public.tickets_events (tenant_id, slug, title, starts_at, ends_at) values ($1, 'x', 'Intruder', now(), now() + interval '1 hour')`,
          [a.tenantId],
        ),
      /row-level security/,
    )
    expect(
      await db.query(`update public.tickets_events set title = 'Hijacked' where id = $1 returning id`, [a.eventId]),
    ).toHaveLength(0)
    expect(await db.query(`delete from public.ticket_types where id = $1 returning id`, [a.rsvpTypeId])).toHaveLength(0)

    // A ticket type in B's tenant cannot point at A's event, even though FK checks bypass RLS.
    await expectDbError(
      db,
      () =>
        db.query(
          `insert into public.ticket_types (tenant_id, event_id, name, kind) values ($1, $2, 'Sneaky', 'rsvp')`,
          [b.tenantId, a.eventId],
        ),
      /foreign key/,
    )
  })

  it('lets staff read and check in but not manage events', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await actAs(db, t.staffId)
    expect(await count(db, `select count(*)::int as n from public.tickets_events`)).toBe(1)
    expect(
      await db.query(`update public.tickets_events set title = 'Renamed' where id = $1 returning id`, [t.eventId]),
    ).toHaveLength(0)
    await expectDbError(
      db,
      () =>
        db.query(`insert into public.ticket_types (tenant_id, event_id, name, kind) values ($1, $2, 'Extra', 'rsvp')`, [
          t.tenantId,
          t.eventId,
        ]),
      /row-level security/,
    )
    await expectDbError(db, () => db.query(`select public.tickets_queue_thank_you($1)`, [t.eventId]), /MT_FORBIDDEN/)
    expect(await count(db, `select count(*)::int as n from public.tenant_payment_accounts`)).toBe(0)
  })

  it('never lets organizers write money, tickets or payout accounts directly', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await actAs(db, t.ownerId)
    await expectDbError(
      db,
      () =>
        db.query(
          `insert into public.tenant_payment_accounts (tenant_id, provider, provider_account_id) values ($1, 'stripe', 'acct_someone_else')`,
          [t.tenantId],
        ),
      /permission denied/,
    )
    await expectDbError(db, () => db.query(`update public.tickets set status = 'valid'`), /permission denied/)
    await expectDbError(db, () => db.query(`delete from public.ticket_checkin_log`), /permission denied/)
    await expectDbError(db, () => db.query(`delete from public.ticket_order_log`), /permission denied/)
    await expectDbError(
      db,
      () => db.query(`select public.tickets_finish_late_refund(gen_random_uuid(), 're_x')`),
      /permission denied/,
    )
    await expectDbError(db, () => db.query(`update public.ticket_orders set total_cents = 0`), /permission denied/)
    await expectDbError(
      db,
      () => db.query(`select public.tickets_place_order($1, 'x', 'x@y.z', repeat('a', 64), '[]'::jsonb)`, [t.eventId]),
      /permission denied/,
    )
    await expectDbError(
      db,
      () => db.query(`select public.tickets_complete_order(gen_random_uuid(), 'stripe', 'pi', 0, 'USD')`),
      /permission denied/,
    )
  })

  it('denies anonymous callers every non-public function', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await actAsAnon(db)
    await expectDbError(db, () => checkIn(db, t.eventId, '0000000000'), /permission denied/)
    await expectDbError(
      db,
      () => db.query(`select public.tickets_queue_thank_you($1)`, [t.eventId]),
      /permission denied/,
    )
    await expectDbError(db, () => db.query(`select public.core_create_tenant('x', 'x')`), /permission denied/)
    await expectDbError(db, () => db.query(`select public.tickets_expire_stale_orders()`), /permission denied/)
  })
})
