/**
 * M-Tickets fixtures for the database tests. Everything here runs as the
 * Postgres superuser (actAsAdmin) unless a helper says otherwise.
 */
import { actAsAdmin, actAsService, createUser, type Db } from '@zevaryn/database/testing'
import { generateAccessToken, generateUniqueTicketCodes, hashAccessToken, signQrPayload } from '../../src/domain'

export const QR_SECRET = 'db-test-secret-that-is-at-least-32-characters'

export interface TenantFixture {
  tenantId: string
  slug: string
  ownerId: string
  staffId: string
  eventId: string
  eventSlug: string
  rsvpTypeId: string
  paidTypeId: string
}

let counter = 0

export async function insertOne(db: Db, sql: string, params: unknown[]): Promise<string> {
  const [row] = await db.query<{ id: string }>(sql, params)
  return row!.id
}

/** A tenant with an owner, a staff member and one published event (RSVP limit 5, paid limit 3). */
export async function createTenantWithEvent(
  db: Db,
  label: string,
  options: { showPublicCounts?: boolean } = {},
): Promise<TenantFixture> {
  await actAsAdmin(db)
  counter += 1
  const slug = `${label}-${counter}`
  const ownerId = await createUser(db, `${label}-owner`)
  const staffId = await createUser(db, `${label}-staff`)
  const tenantId = await insertOne(db, `insert into public.tenants (slug, name) values ($1, $2) returning id`, [
    slug,
    `${label} LLC`,
  ])
  await db.query(
    `insert into public.tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'staff')`,
    [tenantId, ownerId, staffId],
  )
  const eventSlug = 'launch-party'
  const eventId = await insertOne(
    db,
    `insert into public.tickets_events (tenant_id, slug, title, starts_at, ends_at, status, show_public_counts)
     values ($1, $2, 'Launch party', now() + interval '7 days', now() + interval '7 days 3 hours', 'published', $3)
     returning id`,
    [tenantId, eventSlug, options.showPublicCounts ?? false],
  )
  const rsvpTypeId = await insertOne(
    db,
    `insert into public.ticket_types (tenant_id, event_id, name, kind, price_cents, quantity_limit, max_per_order)
     values ($1, $2, 'RSVP', 'rsvp', 0, 5, 5) returning id`,
    [tenantId, eventId],
  )
  const paidTypeId = await insertOne(
    db,
    `insert into public.ticket_types (tenant_id, event_id, name, kind, price_cents, quantity_limit, max_per_order)
     values ($1, $2, 'VIP', 'paid', 2500, 3, 3) returning id`,
    [tenantId, eventId],
  )
  return { tenantId, slug, ownerId, staffId, eventId, eventSlug, rsvpTypeId, paidTypeId }
}

export interface PlacedFixtureOrder {
  orderId: string
  status: string
  totalCents: number
  codes: string[]
  qrPayloads: string[]
  token: string
}

/** Calls tickets_place_order as the service role, the way the server layer does. */
export async function placeOrder(
  db: Db,
  eventId: string,
  ticketTypeId: string,
  quantity: number,
  options: { holdMinutes?: number; provider?: 'stripe' | null } = {},
): Promise<PlacedFixtureOrder> {
  const codes = generateUniqueTicketCodes(quantity)
  const qrPayloads = await Promise.all(codes.map((code) => signQrPayload(code, QR_SECRET)))
  const token = generateAccessToken()
  const tickets = codes.map((code, i) => ({
    ticket_type_id: ticketTypeId,
    ticket_code: code,
    qr_payload: qrPayloads[i],
  }))
  await actAsService(db)
  const [row] = await db.query<{ result: { order_id: string; status: string; total_cents: number } }>(
    `select public.tickets_place_order($1, 'Test Buyer', 'buyer@example.com', $2, $3::jsonb,
            now() + make_interval(mins => $4), $5::public.payment_provider) as result`,
    [
      eventId,
      await hashAccessToken(token),
      JSON.stringify(tickets),
      options.holdMinutes ?? 35,
      options.provider === null ? null : 'stripe',
    ],
  )
  await actAsAdmin(db)
  return {
    orderId: row!.result.order_id,
    status: row!.result.status,
    totalCents: row!.result.total_cents,
    codes,
    qrPayloads,
    token,
  }
}

export async function checkIn(
  db: Db,
  eventId: string,
  code: string | null,
  options: { method?: 'qr' | 'manual'; rejectedReason?: string } = {},
): Promise<{ result: string; ticket: { id: string; status: string; attendee_name: string } | null }> {
  const [row] = await db.query<{
    r: { result: string; ticket: { id: string; status: string; attendee_name: string } | null }
  }>(`select public.tickets_check_in($1, $2::public.checkin_method, $3, $4::public.checkin_result) as r`, [
    eventId,
    options.method ?? 'manual',
    code,
    options.rejectedReason ?? null,
  ])
  return row!.r
}

export async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const [row] = await db.query<{ n: number }>(sql, params)
  return row!.n
}
