/**
 * Demo data for local development: one tenant, one published event, a few
 * tickets (one already checked in), an owner and a door-staff login.
 *
 * Runs as the Postgres superuser against any database with the migrations
 * applied: local Supabase (via seed/run.ts) or PGlite (tests/db/seed.test.ts).
 * Ticket codes and QR payloads are generated with the real domain functions,
 * signed with your TICKETS_QR_SECRET, so scanning works end to end.
 */
import { generateAccessToken, generateUniqueTicketCodes, hashAccessToken, signQrPayload } from '../src/domain'

export interface SqlRunner {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>
}

export const DEMO = {
  tenantSlug: 'demo-co',
  tenantName: 'Demo Co',
  eventSlug: 'spring-open-house',
  ownerEmail: 'organizer@zevaryn.test',
  staffEmail: 'door@zevaryn.test',
  password: 'm-tickets-local-dev',
} as const

export interface DemoSummary {
  tenantId: string
  eventId: string
  ownerId: string
  staffId: string
  orders: { buyer: string; orderPath: string; tickets: { attendee: string; code: string; status: string }[] }[]
}

async function createLogin(db: SqlRunner, email: string): Promise<string> {
  // GoTrue reads these token columns as strings, so they must be '' not null.
  const [user] = await db.query<{ id: string }>(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change_token_new, email_change
     ) values (
       '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', $1,
       extensions.crypt($2, extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', ''
     ) returning id`,
    [email, DEMO.password],
  )
  await db.query(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values ($1::text, $1::uuid, jsonb_build_object('sub', $1::text, 'email', $2::text, 'email_verified', true), 'email', now(), now(), now())`,
    [user!.id, email],
  )
  return user!.id
}

/** Returns null when the demo tenant already exists (the seed is idempotent). */
export async function seedDemo(db: SqlRunner, options: { qrSecret: string; now?: Date }): Promise<DemoSummary | null> {
  const existing = await db.query(`select 1 from public.tenants where slug = $1`, [DEMO.tenantSlug])
  if (existing.length > 0) return null

  const now = options.now ?? new Date()
  const ownerId = await createLogin(db, DEMO.ownerEmail)
  const staffId = await createLogin(db, DEMO.staffEmail)

  const [tenant] = await db.query<{ id: string }>(
    `insert into public.tenants (slug, name, timezone) values ($1, $2, 'America/New_York') returning id`,
    [DEMO.tenantSlug, DEMO.tenantName],
  )
  const tenantId = tenant!.id
  await db.query(
    `insert into public.tenant_members (tenant_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'staff')`,
    [tenantId, ownerId, staffId],
  )

  // Two weeks out, 6-9pm New York time (23:00-02:00 UTC in winter, close enough for a demo).
  const startsAt = new Date(now.getTime() + 14 * 86_400_000)
  startsAt.setUTCHours(23, 0, 0, 0)
  const endsAt = new Date(startsAt.getTime() + 3 * 3_600_000)

  const [event] = await db.query<{ id: string }>(
    `insert into public.tickets_events
       (tenant_id, slug, title, description, venue_name, venue_address, timezone, starts_at, ends_at,
        status, show_public_counts, published_at)
     values ($1, $2, 'Spring Open House', $3, 'Demo Co Workshop', '123 Main St, Columbus, OH',
             'America/New_York', $4, $5, 'published', true, now())
     returning id`,
    [
      tenantId,
      DEMO.eventSlug,
      'Tour the shop, meet the crew and see this season’s projects. Free to attend; VIP includes dinner.',
      startsAt.toISOString(),
      endsAt.toISOString(),
    ],
  )
  const eventId = event!.id

  const types = await db.query<{ id: string; name: string }>(
    `insert into public.ticket_types (tenant_id, event_id, name, description, kind, price_cents, quantity_limit, max_per_order, sort_order)
     values ($1, $2, 'Free RSVP', 'General admission', 'rsvp', 0, 100, 6, 0),
            ($1, $2, 'VIP dinner', 'Seated dinner with the team', 'paid', 2500, 20, 4, 1)
     returning id, name`,
    [tenantId, eventId],
  )
  const rsvpType = types.find((t) => t.name === 'Free RSVP')!.id
  const vipType = types.find((t) => t.name === 'VIP dinner')!.id

  const orders = [
    {
      buyer: 'Grace Hopper',
      email: 'grace@example.com',
      type: rsvpType,
      attendees: ['Grace Hopper', 'Guest of Grace'],
      paid: false,
      checkIn: [] as number[],
    },
    {
      buyer: 'Katherine Johnson',
      email: 'katherine@example.com',
      type: vipType,
      attendees: ['Katherine Johnson'],
      paid: true,
      checkIn: [],
    },
    {
      buyer: 'Alan Turing',
      email: 'alan@example.com',
      type: rsvpType,
      attendees: ['Alan Turing'],
      paid: false,
      checkIn: [0],
    },
  ]

  const summary: DemoSummary = { tenantId, eventId, ownerId, staffId, orders: [] }
  const codes = generateUniqueTicketCodes(orders.reduce((n, o) => n + o.attendees.length, 0))
  let next = 0

  for (const [index, order] of orders.entries()) {
    const token = generateAccessToken()
    const total = order.paid ? 2500 * order.attendees.length : 0
    const [row] = await db.query<{ id: string }>(
      `insert into public.ticket_orders
         (tenant_id, event_id, buyer_name, buyer_email, status, currency, subtotal_cents, total_cents,
          provider, provider_payment_ref, access_token_hash, completed_at)
       values ($1, $2, $3, $4, 'completed', 'USD', $5, $5, $6, $7, $8, now())
       returning id`,
      [
        tenantId,
        eventId,
        order.buyer,
        order.email,
        total,
        order.paid ? 'stripe' : null,
        order.paid ? `pi_seed_demo_${index}` : null,
        await hashAccessToken(token),
      ],
    )
    const tickets: DemoSummary['orders'][number]['tickets'] = []
    for (const [i, attendee] of order.attendees.entries()) {
      const code = codes[next++]!
      const checkedIn = order.checkIn.includes(i)
      const [ticket] = await db.query<{ id: string }>(
        `insert into public.tickets
           (tenant_id, event_id, order_id, ticket_type_id, attendee_name, attendee_email, ticket_code, qr_payload,
            status, checked_in_at, checked_in_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning id`,
        [
          tenantId,
          eventId,
          row!.id,
          order.type,
          attendee,
          i === 0 ? order.email : null,
          code,
          await signQrPayload(code, options.qrSecret),
          checkedIn ? 'checked_in' : 'valid',
          checkedIn ? now.toISOString() : null,
          checkedIn ? staffId : null,
        ],
      )
      if (checkedIn) {
        await db.query(
          `insert into public.ticket_checkin_log (tenant_id, event_id, ticket_id, method, result, submitted_code, actor_id)
           values ($1, $2, $3, 'manual', 'checked_in', $4, $5)`,
          [tenantId, eventId, ticket!.id, code, staffId],
        )
      }
      tickets.push({ attendee, code, status: checkedIn ? 'checked_in' : 'valid' })
    }
    summary.orders.push({ buyer: order.buyer, orderPath: `/t/${DEMO.tenantSlug}/orders/${token}`, tickets })
  }
  return summary
}
