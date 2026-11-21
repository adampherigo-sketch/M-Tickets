/**
 * Order placement, inventory, payment transitions and check-in, exercised
 * through the database functions exactly as the server layer calls them.
 * Keeps the SQL in step with src/domain/ticketState.ts.
 */
import { actAs, actAsAdmin, actAsService, createUser, expectDbError, setupDb } from '@zevaryn/database/testing'
import { describe, expect, it } from 'vitest'
import { QR_SECRET, checkIn, count, createTenantWithEvent, placeOrder } from './fixtures'
import { signQrPayload } from '../../src/domain'

const getDb = setupDb()

const ticketStatuses = (db: ReturnType<typeof getDb>, orderId: string) =>
  db
    .query<{ status: string }>(`select status::text from public.tickets where order_id = $1 order by created_at`, [
      orderId,
    ])
    .then((rows) => rows.map((r) => r.status))

describe('placing orders', () => {
  it('completes a free RSVP immediately with valid tickets', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 2, { provider: null })
    expect(order).toMatchObject({ status: 'completed', totalCents: 0 })
    expect(await ticketStatuses(db, order.orderId)).toEqual(['valid', 'valid'])
  })

  it('holds seats for a pending paid order, priced from the database', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.paidTypeId, 2)
    expect(order).toMatchObject({ status: 'pending', totalCents: 5000 })
    expect(await ticketStatuses(db, order.orderId)).toEqual(['pending', 'pending'])
    expect(
      await count(db, `select taken as n from public.ticket_type_availability where ticket_type_id = $1`, [
        t.paidTypeId,
      ]),
    ).toBe(2)
  })

  it('enforces the quantity limit, counting live holds', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await placeOrder(db, t.eventId, t.paidTypeId, 2)
    await expectDbError(db, () => placeOrder(db, t.eventId, t.paidTypeId, 2), /MT_EXCEEDS_REMAINING/)
    await placeOrder(db, t.eventId, t.paidTypeId, 1)
    await expectDbError(db, () => placeOrder(db, t.eventId, t.paidTypeId, 1), /MT_SOLD_OUT/)
  })

  it('releases seats when a hold expires', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const held = await placeOrder(db, t.eventId, t.paidTypeId, 3)
    await db.query(`update public.ticket_orders set expires_at = now() - interval '1 minute' where id = $1`, [
      held.orderId,
    ])
    // An expired hold no longer counts, even before the sweeper runs.
    await placeOrder(db, t.eventId, t.paidTypeId, 3)
    await actAsService(db)
    const [swept] = await db.query<{ n: number }>(`select public.tickets_expire_stale_orders() as n`)
    expect(swept!.n).toBe(1)
    await actAsAdmin(db)
    expect(await ticketStatuses(db, held.orderId)).toEqual(['void', 'void', 'void'])
  })

  it('refuses drafts, per-order maximums and paid orders without a provider', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await expectDbError(db, () => placeOrder(db, t.eventId, t.rsvpTypeId, 6), /MT_EXCEEDS_PER_ORDER_MAX/)
    await expectDbError(
      db,
      () => placeOrder(db, t.eventId, t.paidTypeId, 1, { provider: null }),
      /MT_PAYMENTS_NOT_CONFIGURED/,
    )
    await actAsAdmin(db)
    await db.query(`update public.tickets_events set status = 'draft' where id = $1`, [t.eventId])
    await expectDbError(db, () => placeOrder(db, t.eventId, t.rsvpTypeId, 1), /MT_EVENT_NOT_ON_SALE/)
  })

  it('rejects a ticket type from another event', async () => {
    const db = getDb()
    const a = await createTenantWithEvent(db, 'alpha')
    const b = await createTenantWithEvent(db, 'bravo')
    await expectDbError(db, () => placeOrder(db, a.eventId, b.rsvpTypeId, 1), /MT_UNKNOWN_TICKET_TYPE/)
  })
})

describe('payment results', () => {
  it('completes once, refuses a wrong amount, and refunds', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.paidTypeId, 2)
    await actAsService(db)

    await expectDbError(
      db,
      () => db.query(`select public.tickets_complete_order($1, 'stripe', 'pi_1', 100, 'USD')`, [order.orderId]),
      /MT_AMOUNT_MISMATCH/,
    )
    const [first] = await db.query<{ r: { result: string; ticket_ids: string[] } }>(
      `select public.tickets_complete_order($1, 'stripe', 'pi_1', 5000, 'usd') as r`,
      [order.orderId],
    )
    expect(first!.r.result).toBe('completed')
    expect(first!.r.ticket_ids).toHaveLength(2)
    const [again] = await db.query<{ r: { result: string } }>(
      `select public.tickets_complete_order($1, 'stripe', 'pi_1', 5000, 'USD') as r`,
      [order.orderId],
    )
    expect(again!.r.result).toBe('already_completed')
    expect(await ticketStatuses(db, order.orderId)).toEqual(['valid', 'valid'])

    const [refund] = await db.query<{ r: { result: string } }>(`select public.tickets_refund_order($1) as r`, [
      order.orderId,
    ])
    expect(refund!.r.result).toBe('refunded')
    expect(await ticketStatuses(db, order.orderId)).toEqual(['refunded', 'refunded'])
    const [refundAgain] = await db.query<{ r: { result: string } }>(`select public.tickets_refund_order($1) as r`, [
      order.orderId,
    ])
    expect(refundAgain!.r.result).toBe('already_refunded')
  })
})

describe('late payments (hold expired before the webhook)', () => {
  type Completion = { result: string; ticket_ids: string[] }
  const complete = async (db: ReturnType<typeof getDb>, orderId: string, ref = 'pi_late', amount = 2500) => {
    await actAsService(db)
    const [row] = await db.query<{ r: Completion }>(
      `select public.tickets_complete_order($1, 'stripe', $2, $3, 'USD') as r`,
      [orderId, ref, amount],
    )
    await actAsAdmin(db)
    return row!.r
  }
  const orderRow = (db: ReturnType<typeof getDb>, orderId: string) =>
    db
      .query<{ status: string; refund_reason: string | null; provider_payment_ref: string | null }>(
        `select status::text, refund_reason, provider_payment_ref from public.ticket_orders where id = $1`,
        [orderId],
      )
      .then((rows) => rows[0]!)
  const logActions = (db: ReturnType<typeof getDb>, orderId: string) =>
    db
      .query<{ action: string }>(`select action from public.ticket_order_log where order_id = $1 order by id`, [
        orderId,
      ])
      .then((rows) => rows.map((r) => r.action))
  const taken = (db: ReturnType<typeof getDb>, typeId: string) =>
    count(db, `select taken as n from public.ticket_type_availability where ticket_type_id = $1`, [typeId])

  it('honors the payment when seats are still available, and logs it', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.paidTypeId, 1)
    await actAsService(db)
    await db.query(`select public.tickets_expire_order($1)`, [order.orderId])
    expect(await ticketStatuses(db, order.orderId)).toEqual(['void'])

    expect((await complete(db, order.orderId)).result).toBe('completed')
    expect(await ticketStatuses(db, order.orderId)).toEqual(['valid'])
    expect(await logActions(db, order.orderId)).toEqual(['late_payment_honored'])
  })

  it('treats an unswept pending order past its expiry as late too', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.paidTypeId, 1)
    await db.query(`update public.ticket_orders set expires_at = now() - interval '1 minute' where id = $1`, [
      order.orderId,
    ])
    expect((await complete(db, order.orderId)).result).toBe('completed')
    expect(await logActions(db, order.orderId)).toEqual(['late_payment_honored'])
  })

  it('refuses to oversell: sold out means refund_pending, void tickets, logged', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha') // VIP limit 3
    const late = await placeOrder(db, t.eventId, t.paidTypeId, 2)
    await actAsService(db)
    await db.query(`select public.tickets_expire_order($1)`, [late.orderId])
    // Other buyers take every seat while the late buyer is still on the payment page.
    await placeOrder(db, t.eventId, t.paidTypeId, 3)
    expect(await taken(db, t.paidTypeId)).toBe(3)

    const result = await complete(db, late.orderId, 'pi_late', 5000)
    expect(result).toMatchObject({ result: 'sold_out', ticket_ids: [] })
    expect(await ticketStatuses(db, late.orderId)).toEqual(['void', 'void'])
    expect(await orderRow(db, late.orderId)).toEqual({
      status: 'refund_pending',
      refund_reason: 'sold_out',
      provider_payment_ref: 'pi_late',
    })
    expect(await taken(db, t.paidTypeId)).toBe(3)
    expect(await logActions(db, late.orderId)).toEqual(['late_payment_sold_out'])
  })

  it('refunds when only part of the order still fits', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const late = await placeOrder(db, t.eventId, t.paidTypeId, 2)
    await actAsService(db)
    await db.query(`select public.tickets_expire_order($1)`, [late.orderId])
    await placeOrder(db, t.eventId, t.paidTypeId, 2) // one seat left, the late order needs two
    expect((await complete(db, late.orderId, 'pi_late', 5000)).result).toBe('sold_out')
    expect(await taken(db, t.paidTypeId)).toBe(2)
  })

  it('keeps the sold-out decision even if a seat frees up before a retried webhook', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const late = await placeOrder(db, t.eventId, t.paidTypeId, 1)
    await actAsService(db)
    await db.query(`select public.tickets_expire_order($1)`, [late.orderId])
    const others = await placeOrder(db, t.eventId, t.paidTypeId, 3)
    expect((await complete(db, late.orderId)).result).toBe('sold_out')

    // Someone else's hold lapses, freeing seats; the webhook is retried.
    await actAsService(db)
    await db.query(`select public.tickets_expire_order($1)`, [others.orderId])
    expect((await complete(db, late.orderId)).result).toBe('sold_out')
    expect(await ticketStatuses(db, late.orderId)).toEqual(['void'])
  })

  it('finishes the refund once, and the refund webhook cannot reopen it', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const late = await placeOrder(db, t.eventId, t.paidTypeId, 1)
    await actAsService(db)
    await db.query(`select public.tickets_expire_order($1)`, [late.orderId])
    await placeOrder(db, t.eventId, t.paidTypeId, 3)
    await complete(db, late.orderId)

    await actAsService(db)
    await expectDbError(
      db,
      () => db.query(`select public.tickets_refund_order($1)`, [late.orderId]),
      /MT_ORDER_NOT_REFUNDABLE/,
    )
    const [done] = await db.query<{ r: { result: string } }>(
      `select public.tickets_finish_late_refund($1, 're_1') as r`,
      [late.orderId],
    )
    expect(done!.r.result).toBe('refunded')
    const [again] = await db.query<{ r: { result: string } }>(
      `select public.tickets_finish_late_refund($1, 're_1') as r`,
      [late.orderId],
    )
    expect(again!.r.result).toBe('already_refunded')
    expect((await complete(db, late.orderId)).result).toBe('already_refunded')

    expect(await orderRow(db, late.orderId)).toMatchObject({ status: 'refunded', refund_reason: 'sold_out' })
    expect(await logActions(db, late.orderId)).toEqual(['late_payment_sold_out', 'late_payment_refunded'])
  })

  it('refuses finish_late_refund for orders that were not sold out', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.paidTypeId, 1)
    await actAsService(db)
    await expectDbError(
      db,
      () => db.query(`select public.tickets_finish_late_refund($1, 're_x')`, [order.orderId]),
      /MT_ORDER_NOT_REFUNDABLE/,
    )
  })

  it('also refuses to oversell when the organizer lowered the limit under a live hold', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await placeOrder(db, t.eventId, t.paidTypeId, 1, { provider: 'stripe' })
    const held = await placeOrder(db, t.eventId, t.paidTypeId, 2)
    // First buyer pays; then the organizer cuts the limit to 1 while the second is paying.
    const [first] = await db.query<{ id: string }>(
      `select id from public.ticket_orders where event_id = $1 and id <> $2`,
      [t.eventId, held.orderId],
    )
    await complete(db, first!.id)
    await db.query(`update public.ticket_types set quantity_limit = 1 where id = $1`, [t.paidTypeId])
    expect((await complete(db, held.orderId, 'pi_held', 5000)).result).toBe('sold_out')
    expect(await taken(db, t.paidTypeId)).toBe(1)
  })
})

describe('check-in', () => {
  it('admits a ticket once and logs every attempt', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 1)
    await actAs(db, t.staffId)

    const first = await checkIn(db, t.eventId, order.codes[0]!, { method: 'qr' })
    expect(first.result).toBe('checked_in')
    expect(first.ticket?.status).toBe('checked_in')
    const second = await checkIn(db, t.eventId, order.codes[0]!)
    expect(second.result).toBe('already_checked_in')

    await actAsAdmin(db)
    const [ticket] = await db.query<{ checked_in_by: string; checked_in_at: string | null }>(
      `select checked_in_by, checked_in_at from public.tickets where order_id = $1`,
      [order.orderId],
    )
    expect(ticket!.checked_in_by).toBe(t.staffId)
    expect(ticket!.checked_in_at).not.toBeNull()
    const log = await db.query<{ result: string; method: string }>(
      `select result::text, method::text from public.ticket_checkin_log where event_id = $1 order by id`,
      [t.eventId],
    )
    expect(log).toEqual([
      { result: 'checked_in', method: 'qr' },
      { result: 'already_checked_in', method: 'manual' },
    ])
  })

  it('logs failures: unknown codes, garbage, forged QR codes', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await actAs(db, t.staffId)
    expect((await checkIn(db, t.eventId, '0000000000')).result).toBe('not_found')
    expect((await checkIn(db, t.eventId, 'nope')).result).toBe('invalid_input')
    expect((await checkIn(db, t.eventId, null, { method: 'qr', rejectedReason: 'invalid_signature' })).result).toBe(
      'invalid_signature',
    )
    await expectDbError(db, () => checkIn(db, t.eventId, null, { rejectedReason: 'checked_in' }), /MT_BAD_REQUEST/)
    await actAsAdmin(db)
    expect(
      await count(db, `select count(*)::int as n from public.ticket_checkin_log where event_id = $1`, [t.eventId]),
    ).toBe(3)
  })

  it('refuses unpaid and refunded tickets', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const pending = await placeOrder(db, t.eventId, t.paidTypeId, 1)
    await actAs(db, t.staffId)
    expect((await checkIn(db, t.eventId, pending.codes[0]!)).result).toBe('not_valid')
  })

  it('reports wrong_event inside a tenant but not_found across tenants', async () => {
    const db = getDb()
    const a = await createTenantWithEvent(db, 'alpha')
    const b = await createTenantWithEvent(db, 'bravo')
    const otherEvent = await (async () => {
      const [row] = await db.query<{ id: string }>(
        `insert into public.tickets_events (tenant_id, slug, title, starts_at, ends_at, status)
         values ($1, 'second', 'Second', now() + interval '1 day', now() + interval '2 days', 'published') returning id`,
        [a.tenantId],
      )
      return row!.id
    })()
    const aOrder = await placeOrder(db, a.eventId, a.rsvpTypeId, 1)
    const bOrder = await placeOrder(db, b.eventId, b.rsvpTypeId, 1)

    await actAs(db, a.staffId)
    expect((await checkIn(db, otherEvent, aOrder.codes[0]!)).result).toBe('wrong_event')
    const probe = await checkIn(db, a.eventId, bOrder.codes[0]!)
    expect(probe).toEqual({ result: 'not_found', ticket: null })
    await actAsAdmin(db)
    expect(
      await count(
        db,
        `select count(*)::int as n from public.ticket_checkin_log where ticket_id is not null and tenant_id = $1 and result = 'not_found'`,
        [a.tenantId],
      ),
    ).toBe(0)
  })

  it('forbids people outside the tenant', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 1)
    const outsider = await createUser(db, 'outsider')
    await actAs(db, outsider)
    await expectDbError(db, () => checkIn(db, t.eventId, order.codes[0]!), /MT_FORBIDDEN/)
  })

  it('stores signed QR payloads the server can verify', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 1)
    const [row] = await db.query<{ qr_payload: string }>(`select qr_payload from public.tickets where order_id = $1`, [
      order.orderId,
    ])
    expect(row!.qr_payload).toBe(await signQrPayload(order.codes[0]!, QR_SECRET))
    expect(row!.qr_payload).not.toContain(order.orderId)
  })
})

describe('thank attendees', () => {
  it('queues one message per checked-in guest, once', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 3)
    await actAs(db, t.staffId)
    await checkIn(db, t.eventId, order.codes[0]!)
    await checkIn(db, t.eventId, order.codes[1]!)

    await actAs(db, t.ownerId)
    const [first] = await db.query<{ n: number }>(`select public.tickets_queue_thank_you($1) as n`, [t.eventId])
    expect(first!.n).toBe(2)
    const [second] = await db.query<{ n: number }>(`select public.tickets_queue_thank_you($1) as n`, [t.eventId])
    expect(second!.n).toBe(0)
    const messages = await db.query<{ to_email: string; status: string }>(
      `select to_email, status::text from public.ticket_messages where event_id = $1 and template = 'thank_you'`,
      [t.eventId],
    )
    expect(messages).toEqual([
      { to_email: 'buyer@example.com', status: 'queued' },
      { to_email: 'buyer@example.com', status: 'queued' },
    ])
  })
})
