# M-System

Modules Zevaryn Systems builds for small field-service and contractor
businesses. This repo starts the monorepo with its first module, **M-Tickets**
(RSVPs, ticket sales, attendee lists). Module details: [packages/m-tickets/README.md](packages/m-tickets/README.md).

**Stack:** TypeScript, React 19, Next.js 16 (App Router), Supabase (Postgres with RLS, Auth). npm workspaces.
Tests: Vitest; database tests run on PGlite (Postgres in WASM), so they need no Docker.

```
apps/web/              Next.js app: public ticket pages, organizer screens, API routes
packages/core/         tenants, roles, domain-event envelope + outbox publisher
packages/database/     generated DB types, migration sync, PGlite test harness
packages/m-tickets/    the M-Tickets module (domain, payments, events, db, server, ui, migrations)
supabase/              Supabase CLI config; migrations/ is generated from the packages
```

## Run it locally

Needs Node 24 and, for a real local database, Docker (the Supabase CLI runs through `npx`).

```sh
npm install
cp apps/web/.env.example apps/web/.env.local   # fill in TICKETS_QR_SECRET at least
npm run db:start      # syncs migrations, starts local Supabase; copy its URL/keys into .env.local
npm run db:seed       # demo tenant, published event, tickets; prints logins and ticket links
npm run dev           # http://localhost:3000
```

- Public page: http://localhost:3000/t/demo-co
- Organizer: `organizer@zevaryn.test` / `m-tickets-local-dev` (door staff: `door@zevaryn.test`)
- Paid tickets need Stripe in test mode: see the module README.

## Environment

All variables are documented in [apps/web/.env.example](apps/web/.env.example). No real keys are committed.

| Variable                                                                            | Where it is used                                |
| ----------------------------------------------------------------------------------- | ----------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`                         | All Supabase clients                            |
| `SUPABASE_SERVICE_ROLE_KEY`                                                         | Server only: orders, webhooks, payment accounts |
| `NEXT_PUBLIC_APP_URL`                                                               | Checkout and onboarding redirect URLs           |
| `TICKETS_QR_SECRET`                                                                 | Signs ticket QR codes (32+ chars)               |
| `TICKETS_HOLD_MINUTES`                                                              | Seat hold for unpaid checkouts (default 35)     |
| `STRIPE_SECRET_KEY`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `STRIPE_CONNECT_ACCOUNT_TYPE` | Stripe Connect (optional; RSVP-only without)    |
| `SUPABASE_DB_URL`                                                                   | `npm run db:seed` only (local database)         |

## Scripts

| Command                                     | What it does                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm run check`                             | Migration sync check, typecheck, lint, all tests                                    |
| `npm test` / `test:unit` / `test:db`        | Vitest; db tests use PGlite                                                         |
| `npm run test:db:supabase`                  | The same db tests against local Supabase                                            |
| `npm run build`                             | Production build of the web app                                                     |
| `npm run db:migrations:sync`                | Copy package migrations into `supabase/migrations` (commit the result)              |
| `npm run db:types:offline`                  | Regenerate `packages/database/src/database.types.ts` from the migrations, no Docker |
| `npm run db:types`                          | Same, from a running local Supabase via the CLI                                     |
| `npm run db:start` / `db:reset` / `db:seed` | Local Supabase lifecycle and demo data                                              |
| `npm run stripe:listen`                     | Forward Stripe Connect test events to the local webhook                             |

## Adding a module

Create `packages/m-<name>/` with its own `supabase/migrations/<timestamp>_<name>.sql`
(timestamps order migrations across packages), tables carrying `tenant_id` with
RLS through `app.is_tenant_member()`, and domain events published via
`@zevaryn/core/events`. Never import another module's package or read its tables.

## Next steps (in order)

1. **Local Supabase run-through of every screen, plus Stripe in test mode** (`npm run db:start`, `db:seed`, `test:db:supabase`, `stripe:listen`). This pass was verified on PGlite and with `next build`, not against a live PostgREST or Stripe.
2. **Transactional outbox**: write `domain_events` rows inside the same database transaction as the state change, plus a relay that delivers them and stamps `published_at`. Today publishing happens after the commit and can drop an event.
3. **Rate limiting / bot protection** on the public order form and on check-in.
4. **Confirmation email with the ticket link** (sender behind `MessageSender`), then a dispatcher for `ticket_messages` so "Thank attendees" actually sends.
5. **Organizer order management**: order list, refund button (service exists: `refundOrderAsOrganizer`), attendee name edits, resend ticket link, and the `ticket_order_log` history.
6. **Cron for `tickets_expire_stale_orders()`** (Supabase scheduled function or pg_cron).
7. **Per-attendee names** at checkout and partial refunds.
8. **Realtime tally** (Supabase Realtime) in place of 5-second polling; tenant switcher; team invites.
9. **Square adapter** behind the same `PaymentProvider` interface.
10. **M-Events integration**: wire `subscribeToMEvents`, populate `external_event_ref`.
