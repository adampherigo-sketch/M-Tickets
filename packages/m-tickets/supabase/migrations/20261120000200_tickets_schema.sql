-- =============================================================================
-- M-Tickets · 20261120000200_tickets_schema.sql
--
-- Tables, constraints, RLS and read views for RSVPs, ticket sales and attendee
-- lists. State-changing operations (placing orders, payment results, check-in,
-- thank-you queueing) live in 20261120000300_tickets_functions.sql.
--
-- Rules this file enforces:
--   1. Every table carries tenant_id. Children reference parents through
--      composite foreign keys that include tenant_id (and event_id where it
--      matters), so the database refuses cross-tenant or cross-event links even
--      though foreign key checks bypass RLS.
--   2. anon has no table access. Public pages use the security definer read
--      functions in the functions migration, which return only published data.
--   3. Organizers cannot write money or ticket state directly: orders, tickets,
--      payment accounts, the check-in log and the message queue are written
--      only by functions or the service role.
--   4. Money is integer cents (bigint).
-- =============================================================================

create type public.ticket_event_status as enum ('draft', 'published', 'cancelled');
create type public.ticket_kind as enum ('rsvp', 'paid');
create type public.payment_provider as enum ('stripe', 'square');
create type public.payment_account_status as enum ('onboarding', 'connected', 'disabled');
-- pending: paid order awaiting the provider; tickets are held until expires_at.
-- refund_pending: payment arrived but the seats were gone (hold expired and the
--   event sold out); the server is refunding it through the provider.
create type public.ticket_order_status as enum ('pending', 'completed', 'expired', 'refund_pending', 'refunded');
-- pending is an addition to the brief's list: a seat held for an unpaid order.
create type public.ticket_status as enum ('pending', 'valid', 'checked_in', 'refunded', 'void');
create type public.checkin_method as enum ('qr', 'manual');
create type public.checkin_result as enum (
  'checked_in', 'already_checked_in', 'not_found', 'wrong_event', 'not_valid', 'invalid_input', 'invalid_signature'
);
create type public.ticket_message_status as enum ('queued', 'sent', 'failed');

-- -----------------------------------------------------------------------------
-- tickets_events
-- -----------------------------------------------------------------------------
create table public.tickets_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  description text not null default '' check (char_length(description) <= 10000),
  venue_name text check (char_length(venue_name) <= 200),
  venue_address text check (char_length(venue_address) <= 500),
  timezone text not null default 'America/New_York' check (char_length(timezone) between 1 and 64),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.ticket_event_status not null default 'draft',
  show_public_counts boolean not null default false,
  -- Reserved for the M-Events link: the id of the matching M-Events event.
  -- Nullable and opaque on purpose; M-Tickets never joins on it.
  external_event_ref text check (char_length(external_event_ref) <= 200),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (tenant_id, slug),
  unique (tenant_id, id)
);
create index tickets_events_tenant_starts_idx on public.tickets_events (tenant_id, starts_at);
create unique index tickets_events_external_ref_idx on public.tickets_events (tenant_id, external_event_ref)
  where external_event_ref is not null;

-- -----------------------------------------------------------------------------
-- ticket_types
-- -----------------------------------------------------------------------------
create table public.ticket_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  kind public.ticket_kind not null,
  price_cents bigint not null default 0,
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  -- null = unlimited
  quantity_limit integer check (quantity_limit > 0),
  max_per_order integer not null default 10 check (max_per_order between 1 and 50),
  sales_start timestamptz,
  sales_end timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, event_id) references public.tickets_events (tenant_id, id) on delete cascade,
  check ((kind = 'rsvp' and price_cents = 0) or (kind = 'paid' and price_cents > 0)),
  check (sales_start is null or sales_end is null or sales_end > sales_start),
  unique (tenant_id, id),
  unique (tenant_id, event_id, id)
);
create index ticket_types_event_idx on public.ticket_types (event_id, sort_order);

-- -----------------------------------------------------------------------------
-- tenant_payment_accounts. Written only by the service role after talking to
-- the provider, so an organizer can never point their tenant at someone else's
-- payout account.
-- -----------------------------------------------------------------------------
create table public.tenant_payment_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider public.payment_provider not null,
  provider_account_id text not null check (char_length(provider_account_id) between 1 and 255),
  status public.payment_account_status not null default 'onboarding',
  charges_enabled boolean not null default false,
  details_submitted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_account_id),
  unique (tenant_id, provider)
);
-- At most one connected provider per tenant decides where checkout goes.
create unique index tenant_payment_accounts_one_connected_idx on public.tenant_payment_accounts (tenant_id)
  where status = 'connected';

-- -----------------------------------------------------------------------------
-- ticket_orders (the brief's "orders"; prefixed so it cannot collide with other
-- modules in the shared database)
-- -----------------------------------------------------------------------------
create table public.ticket_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null,
  buyer_name text not null check (char_length(btrim(buyer_name)) between 1 and 200),
  buyer_email text not null check (char_length(buyer_email) between 3 and 320 and buyer_email like '%_@_%'),
  status public.ticket_order_status not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  subtotal_cents bigint not null check (subtotal_cents >= 0),
  total_cents bigint not null check (total_cents >= 0),
  provider public.payment_provider,
  provider_checkout_ref text,
  provider_payment_ref text,
  -- sha-256 (hex) of the buyer's ticket link token; the token itself is never stored.
  access_token_hash text not null unique check (access_token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  completed_at timestamptz,
  refunded_at timestamptz,
  -- requested: organizer or provider dashboard; sold_out: late payment auto-refunded.
  refund_reason text check (refund_reason in ('requested', 'sold_out')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, event_id) references public.tickets_events (tenant_id, id) on delete cascade,
  check (status <> 'pending' or expires_at is not null),
  check (status <> 'refund_pending' or (refund_reason = 'sold_out' and provider_payment_ref is not null)),
  check (total_cents = 0 or provider is not null or status in ('pending', 'expired')),
  unique (tenant_id, id),
  unique (tenant_id, event_id, id)
);
create index ticket_orders_event_idx on public.ticket_orders (event_id, created_at desc);
create unique index ticket_orders_payment_ref_idx on public.ticket_orders (provider, provider_payment_ref)
  where provider_payment_ref is not null;
create unique index ticket_orders_checkout_ref_idx on public.ticket_orders (provider, provider_checkout_ref)
  where provider_checkout_ref is not null;

-- -----------------------------------------------------------------------------
-- tickets (one row per attendee)
-- -----------------------------------------------------------------------------
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null,
  order_id uuid not null,
  ticket_type_id uuid not null,
  attendee_name text not null check (char_length(btrim(attendee_name)) between 1 and 200),
  attendee_email text check (char_length(attendee_email) <= 320),
  -- 10 characters of Crockford base32 (no I, L, O, U); typed at the door.
  ticket_code text not null unique check (ticket_code ~ '^[0-9A-HJKMNP-TV-Z]{10}$'),
  -- Signed, opaque QR content (MT1.<code>.<signature>); never a database id.
  qr_payload text not null unique check (qr_payload ~ '^MT1\.[0-9A-HJKMNP-TV-Z]{10}\.[A-Za-z0-9_-]{16,}$'),
  status public.ticket_status not null default 'pending',
  checked_in_at timestamptz,
  checked_in_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, event_id, order_id) references public.ticket_orders (tenant_id, event_id, id) on delete cascade,
  foreign key (tenant_id, event_id, ticket_type_id) references public.ticket_types (tenant_id, event_id, id),
  check (status <> 'checked_in' or checked_in_at is not null)
);
create index tickets_event_status_idx on public.tickets (event_id, status);
create index tickets_type_status_idx on public.tickets (ticket_type_id, status);
create index tickets_order_idx on public.tickets (order_id);

-- -----------------------------------------------------------------------------
-- ticket_checkin_log: every scan or typed code, including failures. Append-only.
-- -----------------------------------------------------------------------------
create table public.ticket_checkin_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  event_id uuid not null,
  ticket_id uuid references public.tickets (id) on delete set null,
  method public.checkin_method not null,
  result public.checkin_result not null,
  -- The normalized code that was looked up (null when the input was unreadable).
  submitted_code text check (char_length(submitted_code) <= 64),
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, event_id) references public.tickets_events (tenant_id, id) on delete cascade
);
create index ticket_checkin_log_event_idx on public.ticket_checkin_log (event_id, created_at desc);

-- -----------------------------------------------------------------------------
-- ticket_order_log: what happened to an order outside the normal flow (a late
-- payment honored, a late payment refunded because the event sold out, a refund
-- that failed and will be retried). Append-only.
-- -----------------------------------------------------------------------------
create table public.ticket_order_log (
  id bigint generated always as identity primary key,
  tenant_id uuid not null,
  event_id uuid not null,
  order_id uuid not null,
  action text not null check (action in (
    'late_payment_honored', 'late_payment_sold_out', 'late_payment_refunded', 'late_payment_refund_failed'
  )),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, event_id, order_id) references public.ticket_orders (tenant_id, event_id, id) on delete cascade
);
create index ticket_order_log_order_idx on public.ticket_order_log (order_id, created_at);

-- -----------------------------------------------------------------------------
-- ticket_messages: outbound message queue (thank-you notes). Sending is a stub.
-- -----------------------------------------------------------------------------
create table public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  template text not null check (template in ('thank_you')),
  channel text not null default 'email' check (channel in ('email')),
  to_email text not null check (char_length(to_email) <= 320),
  status public.ticket_message_status not null default 'queued',
  queued_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (tenant_id, event_id) references public.tickets_events (tenant_id, id) on delete cascade,
  unique (ticket_id, template)
);
create index ticket_messages_queue_idx on public.ticket_messages (created_at) where status = 'queued';

-- -----------------------------------------------------------------------------
-- updated_at
-- -----------------------------------------------------------------------------
create trigger tickets_events_touch before update on public.tickets_events
  for each row execute function app.touch_updated_at();
create trigger ticket_types_touch before update on public.ticket_types
  for each row execute function app.touch_updated_at();
create trigger tenant_payment_accounts_touch before update on public.tenant_payment_accounts
  for each row execute function app.touch_updated_at();
create trigger ticket_orders_touch before update on public.ticket_orders
  for each row execute function app.touch_updated_at();
create trigger tickets_touch before update on public.tickets
  for each row execute function app.touch_updated_at();

-- -----------------------------------------------------------------------------
-- Read views. security_invoker makes them obey the caller's RLS.
-- -----------------------------------------------------------------------------

-- Seats a ticket type has used: issued tickets plus holds on unexpired orders.
create view public.ticket_type_availability
with (security_invoker = true)
as
select
  tt.id as ticket_type_id,
  tt.tenant_id,
  tt.event_id,
  tt.quantity_limit,
  count(t.id) filter (
    where t.status in ('valid', 'checked_in')
       or (t.status = 'pending' and o.status = 'pending' and o.expires_at > now())
  )::integer as taken
from public.ticket_types tt
left join public.tickets t on t.ticket_type_id = tt.id
left join public.ticket_orders o on o.id = t.order_id
group by tt.id;

-- Per-event counts for the organizer dashboard.
create view public.tickets_event_stats
with (security_invoker = true)
as
select
  e.id as event_id,
  e.tenant_id,
  coalesce(c.tickets_sold, 0)::integer as tickets_sold,
  coalesce(c.rsvps, 0)::integer as rsvps,
  coalesce(c.checked_in, 0)::integer as checked_in,
  coalesce(c.attendees, 0)::integer as attendees,
  coalesce(r.gross_cents, 0)::bigint as gross_cents
from public.tickets_events e
left join (
  select
    t.event_id,
    count(*) filter (where tt.kind = 'paid' and t.status in ('valid', 'checked_in')) as tickets_sold,
    count(*) filter (where tt.kind = 'rsvp' and t.status in ('valid', 'checked_in')) as rsvps,
    count(*) filter (where t.status = 'checked_in') as checked_in,
    count(*) filter (where t.status in ('valid', 'checked_in')) as attendees
  from public.tickets t
  join public.ticket_types tt on tt.id = t.ticket_type_id
  group by t.event_id
) c on c.event_id = e.id
left join (
  select o.event_id, sum(o.total_cents) as gross_cents
  from public.ticket_orders o
  where o.status = 'completed'
  group by o.event_id
) r on r.event_id = e.id;

-- -----------------------------------------------------------------------------
-- Row Level Security
--
--   owner/admin: manage events and ticket types; read everything.
--   staff:       read events, ticket types, orders, tickets and the check-in
--                log (they run the door); check in through tickets_check_in().
--   anon:        nothing. Public pages go through tickets_public_* functions.
-- -----------------------------------------------------------------------------
alter table public.tickets_events enable row level security;
alter table public.ticket_types enable row level security;
alter table public.tenant_payment_accounts enable row level security;
alter table public.ticket_orders enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_checkin_log enable row level security;
alter table public.ticket_order_log enable row level security;
alter table public.ticket_messages enable row level security;

revoke all on table
  public.tickets_events, public.ticket_types, public.tenant_payment_accounts, public.ticket_orders,
  public.tickets, public.ticket_checkin_log, public.ticket_order_log, public.ticket_messages,
  public.ticket_type_availability, public.tickets_event_stats
from anon;

-- Function- and service-only tables: authenticated may read (filtered by RLS)
-- but has no write privilege at all.
revoke insert, update, delete on table
  public.tenant_payment_accounts, public.ticket_orders, public.tickets,
  public.ticket_checkin_log, public.ticket_order_log, public.ticket_messages
from authenticated;

create policy "members read events" on public.tickets_events
  for select to authenticated using (app.is_tenant_member(tenant_id));
create policy "owners and admins add events" on public.tickets_events
  for insert to authenticated with check (app.is_tenant_member(tenant_id, '{owner,admin}'));
create policy "owners and admins edit events" on public.tickets_events
  for update to authenticated
  using (app.is_tenant_member(tenant_id, '{owner,admin}'))
  with check (app.is_tenant_member(tenant_id, '{owner,admin}'));
create policy "owners and admins delete draft events" on public.tickets_events
  for delete to authenticated using (status = 'draft' and app.is_tenant_member(tenant_id, '{owner,admin}'));

create policy "members read ticket types" on public.ticket_types
  for select to authenticated using (app.is_tenant_member(tenant_id));
create policy "owners and admins add ticket types" on public.ticket_types
  for insert to authenticated with check (app.is_tenant_member(tenant_id, '{owner,admin}'));
create policy "owners and admins edit ticket types" on public.ticket_types
  for update to authenticated
  using (app.is_tenant_member(tenant_id, '{owner,admin}'))
  with check (app.is_tenant_member(tenant_id, '{owner,admin}'));
create policy "owners and admins delete ticket types" on public.ticket_types
  for delete to authenticated using (app.is_tenant_member(tenant_id, '{owner,admin}'));

create policy "owners and admins read payment accounts" on public.tenant_payment_accounts
  for select to authenticated using (app.is_tenant_member(tenant_id, '{owner,admin}'));

create policy "members read orders" on public.ticket_orders
  for select to authenticated using (app.is_tenant_member(tenant_id));

create policy "members read tickets" on public.tickets
  for select to authenticated using (app.is_tenant_member(tenant_id));

create policy "members read the check-in log" on public.ticket_checkin_log
  for select to authenticated using (app.is_tenant_member(tenant_id));

create policy "owners and admins read the order log" on public.ticket_order_log
  for select to authenticated using (app.is_tenant_member(tenant_id, '{owner,admin}'));

create policy "owners and admins read messages" on public.ticket_messages
  for select to authenticated using (app.is_tenant_member(tenant_id, '{owner,admin}'));
