/**
 * Ticket delivery: confirmations are queued in the same transaction that
 * completes an order, the dispatcher claims and finishes them with retries,
 * and the delivery table stays invisible to organizers.
 */
import { actAs, actAsAdmin, actAsService, expectDbError, setupDb, type Db } from '@zevaryn/database/testing'
import { describe, expect, it } from 'vitest'
import { QR_SECRET, checkIn, count, createTenantWithEvent, placeOrder, type TenantFixture } from './fixtures'
import { generateUniqueTicketCodes, hashAccessToken, signQrPayload } from '../../src/domain'

const getDb = setupDb()

interface MessageRow {
  id: string
  template: string
  channel: string
  to_email: string | null
  to_phone: string | null
  status: string
  attempts: number
}

const messages = (db: Db, orderId: string) =>
  db.query<MessageRow>(
    `select id, template, channel, to_email, to_phone, status::text, attempts
     from public.ticket_messages where order_id = $1 order by created_at`,
    [orderId],
  )

async function saveDelivery(
  db: Db,
  token: string,
  tenantId: string,
  delivery: { channel: 'email' | 'sms'; phone?: string; ciphertext?: string },
) {
  await actAsService(db)
  await db.query(
    `insert into public.ticket_order_delivery (access_token_hash, tenant_id, channel, phone, token_ciphertext)
     values ($1, $2, $3, $4, $5)`,
    [await hashAccessToken(token), tenantId, delivery.channel, delivery.phone ?? null, delivery.ciphertext ?? 'v1.x.y'],
  )
  await actAsAdmin(db)
}

/** One free RSVP placed with a known ticket-link token, as the server does after saving delivery. */
async function placeWithToken(db: Db, t: TenantFixture, token: string): Promise<string> {
  const [code] = generateUniqueTicketCodes(1)
  await actAsService(db)
  const [row] = await db.query<{ r: { order_id: string } }>(
    `select public.tickets_place_order($1, 'Buyer', 'b@example.com', $2, $3::jsonb) as r`,
    [
      t.eventId,
      await hashAccessToken(token),
      JSON.stringify([
        { ticket_type_id: t.rsvpTypeId, ticket_code: code, qr_payload: await signQrPayload(code!, QR_SECRET) },
      ]),
    ],
  )
  await actAsAdmin(db)
  return row!.r.order_id
}

async function claim(db: Db, limit = 20) {
  await actAsService(db)
  const [row] = await db.query<{ r: Record<string, unknown>[] }>(`select public.tickets_claim_messages($1) as r`, [
    limit,
  ])
  await actAsAdmin(db)
  return row!.r
}

async function finish(db: Db, id: string, sent: boolean, retry = true) {
  await actAsService(db)
  const [row] = await db.query<{ s: string }>(`select public.tickets_finish_message($1, $2, $3, $4) as s`, [
    id,
    sent,
    sent ? null : 'provider down',
    retry,
  ])
  await actAsAdmin(db)
  return row!.s
}

describe('queueing order confirmations', () => {
  it('queues one email confirmation when a free order completes', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 2, { provider: null })
    expect(await messages(db, order.orderId)).toEqual([
      expect.objectContaining({
        template: 'order_confirmation',
        channel: 'email',
        to_email: 'buyer@example.com',
        status: 'queued',
        attempts: 0,
      }),
    ])
  })

  it('queues nothing for a pending paid order, then exactly one on completion', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.paidTypeId, 2)
    expect(await messages(db, order.orderId)).toEqual([])

    await actAsService(db)
    await db.query(`select public.tickets_complete_order($1, 'stripe', 'pi_1', 5000, 'USD')`, [order.orderId])
    await db.query(`select public.tickets_complete_order($1, 'stripe', 'pi_1', 5000, 'USD')`, [order.orderId])
    await actAsAdmin(db)
    expect(await messages(db, order.orderId)).toHaveLength(1)
  })

  it('uses the text channel when the buyer chose it before ordering', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    // Without a delivery row the confirmation defaults to email.
    const placed = await placeOrder(db, t.eventId, t.rsvpTypeId, 1, { provider: null })
    expect((await messages(db, placed.orderId))[0]).toMatchObject({ channel: 'email' })

    const token = 'sms-test-token-sms-test-token-sms-test-token'
    await saveDelivery(db, token, t.tenantId, { channel: 'sms', phone: '+15551234567' })
    const orderId = await placeWithToken(db, t, token)
    expect(await messages(db, orderId)).toEqual([
      expect.objectContaining({ channel: 'sms', to_phone: '+15551234567', to_email: null }),
    ])
  })

  it('refuses a text delivery without a valid phone number', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await actAsService(db)
    await expectDbError(
      db,
      () =>
        db.query(
          `insert into public.ticket_order_delivery (access_token_hash, tenant_id, channel, phone) values ($1, $2, 'sms', null)`,
          ['0'.repeat(64), t.tenantId],
        ),
      /check/,
    )
    await expectDbError(
      db,
      () =>
        db.query(
          `insert into public.ticket_order_delivery (access_token_hash, tenant_id, channel, phone) values ($1, $2, 'sms', '555-1234')`,
          ['1'.repeat(64), t.tenantId],
        ),
      /check/,
    )
  })

  it('leaves thank-you queueing as it was', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 1)
    await actAs(db, t.staffId)
    await checkIn(db, t.eventId, order.codes[0]!)
    await actAs(db, t.ownerId)
    await db.query(`select public.tickets_queue_thank_you($1)`, [t.eventId])
    await actAsAdmin(db)
    expect(
      await count(
        db,
        `select count(*)::int as n from public.ticket_messages where event_id = $1 and template = 'thank_you'`,
        [t.eventId],
      ),
    ).toBe(1)
  })
})

describe('dispatching', () => {
  it('claims due messages with what the email needs, and not twice', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 2, { provider: null })

    const claimed = await claim(db)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({
      template: 'order_confirmation',
      attempts: 1,
      tenant_id: t.tenantId,
      tenant_slug: t.slug,
      event: { title: 'Launch party' },
      order: { id: order.orderId, status: 'completed', buyer_name: 'Test Buyer', total_cents: 0 },
    })
    const tickets = (claimed[0]!.order as { tickets: { code: string }[] }).tickets
    expect(tickets.map((x) => x.code).sort()).toEqual([...order.codes].sort())

    // Locked for 5 minutes: a second worker gets nothing.
    expect(await claim(db)).toEqual([])
  })

  it('marks a sent message and wipes the encrypted token', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const token = 'wipe-test-token-wipe-test-token-wipe-test-tok'
    await saveDelivery(db, token, t.tenantId, { channel: 'email', ciphertext: 'v1.iv.sealed' })
    const orderId = await placeWithToken(db, t, token)
    const [message] = await claim(db)
    expect((message!.order as { token_ciphertext: string }).token_ciphertext).toBe('v1.iv.sealed')

    expect(await finish(db, message!.id as string, true)).toBe('sent')
    expect(await messages(db, orderId)).toEqual([expect.objectContaining({ status: 'sent' })])
    const [delivery] = await db.query<{ token_ciphertext: string | null }>(
      `select token_ciphertext from public.ticket_order_delivery where access_token_hash = $1`,
      [await hashAccessToken(token)],
    )
    expect(delivery!.token_ciphertext).toBeNull()
    // Finishing again changes nothing.
    expect(await finish(db, message!.id as string, false)).toBe('sent')
  })

  it('retries with backoff, then gives up after five attempts', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 1, { provider: null })
    const [{ id }] = (await messages(db, order.orderId)) as [MessageRow]

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await claim(db)).toHaveLength(1)
      expect(await finish(db, id, false)).toBe('queued')
      // Not due yet: the next attempt is minutes away.
      expect(await claim(db)).toEqual([])
      await db.query(`update public.ticket_messages set next_attempt_at = now() where id = $1`, [id])
    }
    expect(await claim(db)).toHaveLength(1)
    expect(await finish(db, id, false)).toBe('failed')
    const [row] = await messages(db, order.orderId)
    expect(row).toMatchObject({ status: 'failed', attempts: 5 })
  })

  it('fails at once on a permanent error', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const order = await placeOrder(db, t.eventId, t.rsvpTypeId, 1, { provider: null })
    const [message] = await claim(db)
    expect(await finish(db, message!.id as string, false, false)).toBe('failed')
    expect((await messages(db, order.orderId))[0]).toMatchObject({ status: 'failed', attempts: 1 })
  })

  it('reclaims a message whose worker died mid-send', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await placeOrder(db, t.eventId, t.rsvpTypeId, 1, { provider: null })
    const [message] = await claim(db)
    await db.query(`update public.ticket_messages set locked_until = now() - interval '1 second' where id = $1`, [
      message!.id,
    ])
    expect(await claim(db)).toEqual([expect.objectContaining({ id: message!.id, attempts: 2 })])
  })
})

describe('housekeeping and access', () => {
  it('expires stale holds and purges delivery rows that never became orders', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    const held = await placeOrder(db, t.eventId, t.paidTypeId, 1)
    await db.query(`update public.ticket_orders set expires_at = now() - interval '1 minute' where id = $1`, [
      held.orderId,
    ])
    await saveDelivery(db, 'orphan-token-orphan-token-orphan-token-orpha', t.tenantId, { channel: 'email' })
    await db.query(`update public.ticket_order_delivery set created_at = now() - interval '2 days'`)

    await actAsService(db)
    const [row] = await db.query<{ r: { expired_orders: number; purged_deliveries: number } }>(
      `select public.tickets_housekeeping() as r`,
    )
    await actAsAdmin(db)
    expect(row!.r).toMatchObject({ expired_orders: 1, purged_deliveries: 1 })
  })

  it('keeps delivery rows and dispatcher functions away from organizers and the public', async () => {
    const db = getDb()
    const t = await createTenantWithEvent(db, 'alpha')
    await placeOrder(db, t.eventId, t.rsvpTypeId, 1, { provider: null })
    await saveDelivery(db, 'secret-token-secret-token-secret-token-secr', t.tenantId, { channel: 'email' })

    await actAs(db, t.ownerId)
    await expectDbError(db, () => db.query(`select * from public.ticket_order_delivery`), /permission denied/)
    await expectDbError(db, () => db.query(`select public.tickets_claim_messages(10)`), /permission denied/)
    await expectDbError(db, () => db.query(`select public.tickets_housekeeping()`), /permission denied/)
    await expectDbError(db, () => db.query(`update public.ticket_messages set status = 'sent'`), /permission denied/)
  })
})
