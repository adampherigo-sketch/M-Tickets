# M-Tickets

RSVPs, ticket sales and attendee lists for M-System tenants (Zevaryn's clients).
Organizers post events and sell tickets or collect RSVPs; their customers buy
or RSVP on a public page; on the day, staff check guests in by QR code or typed code.

**Status: framework.** Structure, schema, security, interfaces, routes and
working stub screens are in place. Features get filled in from here (see
[Next steps](#next-steps)).

## Rules this module keeps

| Rule                                                  | Where it is enforced                                                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Works standalone; M-Events is optional and comes last | No imports of other modules (ESLint `no-restricted-imports`); `external_event_ref` column and inbound contract in `src/events/inbound/mEvents.ts`, not wired (`M_EVENTS_INTEGRATION_ENABLED = false`) |
| Ticket revenue goes 100% to the client                | Stripe **direct charges** on the client's own connected account, never an `application_fee_amount` (unit test asserts it)                                                                             |
| Nothing outside the adapter imports Stripe            | ESLint `no-restricted-imports` (only `src/payments/stripe/` is exempt)                                                                                                                                |
| Tenant isolation                                      | RLS on every table, composite `(tenant_id, …)` foreign keys; `tests/db/rls.test.ts`                                                                                                                   |
| Anonymous access is narrow                            | `anon` has no table privileges; public pages call two read-only `security definer` functions                                                                                                          |
| Organizers cannot write money or ticket state         | `ticket_orders`, `tickets`, `tenant_payment_accounts`, `ticket_checkin_log`, `ticket_order_log`, `ticket_messages` have no write privilege for `authenticated`; changes go through functions          |
| Public counts hidden by default                       | `show_public_counts default false`; the public functions return `counts: null` and `remaining: null` unless it is on                                                                                  |
| Domain layer is pure                                  | ESLint bans framework/db/provider imports in `src/domain/`                                                                                                                                            |

## Layout

```
packages/m-tickets/
  src/
    domain/      pure rules: ticket codes, QR signing, inventory, ticket states, order planning, time zones
    payments/    PaymentProvider interface, registry, Stripe Connect adapter, Square stub
    events/      outbound domain-event contracts (zod) + inbound M-Events contract (not wired)
    db/          repository layer: the only code that knows table and function names
    server/      application services: placeOrder, webhooks, check-in, publish, refunds, onboarding
    ui/          shared components (server-safe) and ui/client (QR scanner, command center)
  supabase/migrations/   schema, RLS, functions (copied to /supabase/migrations by db:migrations:sync)
  seed/          demo data (demo.ts) and its runner (run.ts)
  tests/unit/    domain, payments, event contracts
  tests/db/      RLS, public functions, orders, check-in, seed (PGlite; or real Supabase)
```

Routes live in `apps/web/src/app` and stay thin: they parse input, call
`server/` or `db/`, and render `ui/` components.

## Schema

| Table                     | Notes                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenants` (core)          | Client, with the public `slug` used in `/t/<slug>`                                                                                                     |
| `tenant_members` (core)   | `owner` / `admin` / `staff`                                                                                                                            |
| `tickets_events`          | `status` draft/published/cancelled, `show_public_counts`, `external_event_ref` (reserved for M-Events)                                                 |
| `ticket_types`            | `kind` rsvp/paid (rsvp ⇒ price 0, paid ⇒ price > 0), `quantity_limit` (null = unlimited), `max_per_order`, sales window                                |
| `ticket_orders`           | The brief's `orders`, prefixed to avoid collisions in the shared DB. Buyer contact, totals, provider refs, `access_token_hash`, `expires_at` for holds |
| `tickets`                 | One per attendee. `ticket_code` (unique), `qr_payload` (signed, opaque), `status`, `checked_in_at/by`                                                  |
| `tenant_payment_accounts` | Provider account per tenant; at most one `connected` decides checkout                                                                                  |
| `ticket_checkin_log`      | The brief's `checkin_log`. Every scan or typed code, failures included. Append-only                                                                    |
| `ticket_order_log`        | Out-of-the-ordinary order history: late payments honored or refunded, refund failures. Append-only                                                     |
| `ticket_messages`         | Outbound message queue (thank-you notes). Sending is a stub                                                                                            |
| `domain_events` (core)    | Outbox for module-to-module events                                                                                                                     |

Views (security invoker, so they obey RLS): `ticket_type_availability`
(seats taken incl. live holds), `tickets_event_stats` (sold, RSVPs, checked in, gross).

**Changes from the brief, and why**

- `tickets.status` adds **`pending`**: a seat held for an unpaid order, so two buyers can't both pay for the last seat.
- `ticket_orders.status` adds **`refund_pending`** and a `refund_reason` (`requested` / `sold_out`): see decision 5.
- `orders` → `ticket_orders`, `checkin_log` → `ticket_checkin_log`: module prefix in a shared database.
- Added `ticket_order_log`, `ticket_messages` (the thank-you queue) and core's `domain_events` (outbox).
- `ticket_types.max_per_order`, `tickets_events.timezone`/`venue_address`/`published_at`, and `ticket_orders.expires_at`/`access_token_hash` were needed by the flows.

## Database functions

| Function                                                     | Caller            | Purpose                                                                                           |
| ------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------- |
| `tickets_public_storefront(slug)`                            | anon              | Published upcoming events for a client                                                            |
| `tickets_public_event(slug, event_slug)`                     | anon              | One event + ticket types and sales state                                                          |
| `tickets_place_order(...)`                                   | service role      | Locks ticket types, re-checks windows/limits, prices from the DB, creates order + tickets         |
| `tickets_complete_order(...)`                                | service role      | Payment confirmed → tickets valid, or `sold_out` if the seats are gone. Idempotent; checks amount |
| `tickets_finish_late_refund(id, refund_ref)`                 | service role      | Sold-out late payment refunded by the provider → order refunded. Idempotent                       |
| `tickets_expire_order(id)` / `tickets_expire_stale_orders()` | service role      | Release holds                                                                                     |
| `tickets_refund_order(id)`                                   | service role      | Tickets → refunded. Idempotent                                                                    |
| `tickets_check_in(event, method, code, rejected_reason)`     | any tenant member | Row-locked, prevents double check-in, logs every attempt; cross-tenant codes report `not_found`   |
| `tickets_queue_thank_you(event)`                             | owner/admin       | One queued message per checked-in guest, idempotent                                               |

## Payments

```ts
interface PaymentProvider {
  readonly id: 'stripe' | 'square'
  connectAccount(req: ConnectAccountRequest): Promise<ConnectAccountResult> // onboarding link
  getAccountStatus(providerAccountId: string): Promise<AccountStatusResult>
  createCheckout(order: CheckoutOrder, account: TenantPaymentAccount, urls: CheckoutUrls): Promise<CheckoutSession>
  handleWebhook(rawBody: string, signature: string | null): Promise<WebhookResult> // normalized
  refund(req: RefundRequest): Promise<RefundResult>
}
```

- **Stripe Connect, direct charges.** The Checkout Session is created _on_ the
  client's connected account (`Stripe-Account` header). The client is the
  merchant of record; money settles in their balance; no application fee.
- **Processing fees** are paid by the client, deducted by Stripe from each
  charge (the default). The buyer pays the listed price.
- **Webhook trust.** A completed checkout only completes an order if the event
  came from _that order's tenant's_ connected account and names the session we
  created. Otherwise one client could pay into their own account and validate
  another client's order.
- **Square**: `SquarePaymentProvider` throws `PaymentsNotImplementedError` and
  is not registered, so no tenant can be routed to it.
- **Free RSVPs** never touch a provider.

### Stripe in test mode, locally

1. In the Stripe dashboard (test mode), enable **Connect** for the platform account.
2. Put your **test** secret key in `apps/web/.env.local` as `STRIPE_SECRET_KEY=sk_test_…`
   (the app refuses `sk_live_` outside production).
3. Install the [Stripe CLI](https://docs.stripe.com/stripe-cli) and run
   `npm run stripe:listen`. It forwards **Connect** events to
   `localhost:3000/api/webhooks/stripe` and prints a `whsec_…` secret: put it in
   `STRIPE_CONNECT_WEBHOOK_SECRET`.
4. Sign in as the demo organizer → **Payments** → **Connect Stripe**, and finish
   test onboarding (Stripe's test data fills the forms).
5. Buy a VIP ticket on `/t/demo-co/spring-open-house` with card `4242 4242 4242 4242`.

In production, create a webhook endpoint with **"Events on connected accounts"**
for `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`,
`charge.refunded`, `account.updated`.

## Domain events

Published (envelope from `@zevaryn/core/events`; payloads carry ids, not PII):

| Type                                                    | When                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `tickets.event.published` / `tickets.event.unpublished` | Organizer changes visibility                               |
| `tickets.order.completed`                               | Free order placed, or payment confirmed                    |
| `tickets.ticket.issued`                                 | Each ticket that became valid                              |
| `tickets.attendee.checked_in`                           | Successful check-in                                        |
| `tickets.order.refunded`                                | Full refund recorded (`reason`: `requested` or `sold_out`) |
| `tickets.attendees.thank_you_requested`                 | Organizer pressed "Thank attendees"                        |

Consumed later (contract only, not wired): `events.event.created`,
`events.event.updated`, `events.event.cancelled` from M-Events.

## Decisions

Confirmed by Zevaryn on 2026-11-20:

1. **Stripe Connect account type: Standard** (controller properties: full dashboard,
   account pays fees, Stripe carries losses). With zero platform revenue it is the
   only option that costs Zevaryn nothing: Express makes the platform pay Stripe's
   fees and carry negative balances, which could only be recovered by taking a cut.
   Swappable with `STRIPE_CONNECT_ACCOUNT_TYPE`.
2. **Fees absorbed by the client**, out of each charge. The buyer pays the listed price.
3. **QR payload** = `MT1.<code>.<HMAC-SHA256 truncated to 128 bits>`. Opaque, no
   database ids. Rotating `TICKETS_QR_SECRET` invalidates printed QR codes; typed
   codes still work. Ticket codes: 10 Crockford base32 characters (~50 bits), globally unique.
4. **Monorepo tooling**: npm workspaces, no Turborepo yet.
5. **Late payments never oversell.** An unpaid checkout holds seats 35 minutes
   (Stripe sessions last 31). When a payment lands, `tickets_complete_order`
   re-checks the order's seats against everyone else's issued tickets and live
   holds, with the ticket types locked:
   - **Room left** → the order completes as normal (logged as `late_payment_honored` if the hold had lapsed).
   - **Sold out** → the order moves to `refund_pending` with its tickets void
     (logged `late_payment_sold_out`); the server refunds the full payment through
     the `PaymentProvider` (idempotency key `sold-out-refund:<order id>`), then
     `tickets_finish_late_refund` marks it `refunded` with `refund_reason = 'sold_out'`
     (logged `late_payment_refunded`) and `tickets.order.refunded` is published with
     `reason: 'sold_out'`. The buyer's page says "Sold out: you have been refunded".
   - A failed refund is logged (`late_payment_refund_failed`) and the webhook
     returns 500 so Stripe retries. The sold-out decision is sticky, so a retry
     never issues tickets for a refunded payment, even if a seat has freed up.
     The same check also catches an organizer lowering a limit under a live hold.
6. **One connected payment provider per tenant** at a time.

Still open: an organizer in several tenants sees their first one until a tenant switcher exists.

## Next steps

See the root README.
