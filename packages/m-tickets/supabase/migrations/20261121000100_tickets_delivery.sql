-- =============================================================================
-- M-Tickets · 20261121000100_tickets_delivery.sql
--
-- Ticket delivery: the buyer's confirmation (ticket link + codes) by email now,
-- by text message once an SMS sender is configured, plus the dispatcher that
-- sends everything in ticket_messages.
--
--   ticket_order_delivery        how one order wants its tickets delivered, and
--                                its ticket-link token encrypted until sent
--   ticket_messages (extended)   order_confirmation template, sms channel,
--                                retry and claim bookkeeping
--   trigger on ticket_orders     queues the confirmation in the same
--                                transaction that completes the order
--
--   Service role only:
--     tickets_claim_messages(limit)              lock due messages for sending
--     tickets_finish_message(id, sent, ...)      record a send or schedule a retry
--     tickets_housekeeping()                     cron: expire stale holds, purge
--                                                leftover delivery rows
-- =============================================================================

-- -----------------------------------------------------------------------------
-- ticket_order_delivery
--
-- Keyed by the order's access_token_hash so the server can write it BEFORE
-- tickets_place_order runs: a free order completes inside that call, and its
-- confirmation trigger must already see the buyer's choice.
--
-- token_ciphertext is the ticket-link token (only its hash is on the order),
-- AES-GCM encrypted by the server with TICKETS_DELIVERY_KEY and bound to the
-- hash. It exists only so a confirmation can carry the link after a paid order
-- completes in a webhook; it is wiped once the confirmation is sent.
-- Never readable by organizers: no grants to authenticated at all.
-- -----------------------------------------------------------------------------
create table public.ticket_order_delivery (
  access_token_hash text primary key check (char_length(access_token_hash) between 16 and 128),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel text not null default 'email' check (channel in ('email', 'sms')),
  phone text check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  token_ciphertext text check (char_length(token_ciphertext) <= 512),
  created_at timestamptz not null default now(),
  check (channel <> 'sms' or phone is not null)
);
create index ticket_order_delivery_created_idx on public.ticket_order_delivery (created_at);

alter table public.ticket_order_delivery enable row level security;
revoke all on table public.ticket_order_delivery from anon, authenticated;

comment on table public.ticket_order_delivery is
  'Per-order delivery choice and the encrypted ticket-link token until the confirmation is sent. Service role only.';

-- -----------------------------------------------------------------------------
-- ticket_messages: confirmations, sms, retries
-- -----------------------------------------------------------------------------
alter table public.ticket_messages
  alter column ticket_id drop not null,
  alter column to_email drop not null,
  add column order_id uuid references public.ticket_orders (id) on delete cascade,
  add column to_phone text check (to_phone ~ '^\+[1-9][0-9]{7,14}$'),
  add column attempts integer not null default 0 check (attempts >= 0),
  add column next_attempt_at timestamptz not null default now(),
  add column locked_until timestamptz,
  add column last_error text check (char_length(last_error) <= 1000),
  add column provider_message_id text check (char_length(provider_message_id) <= 256);

alter table public.ticket_messages
  drop constraint ticket_messages_template_check,
  add constraint ticket_messages_template_check check (template in ('thank_you', 'order_confirmation')),
  drop constraint ticket_messages_channel_check,
  add constraint ticket_messages_channel_check check (channel in ('email', 'sms')),
  -- A thank-you is about one ticket; a confirmation is about one order.
  add constraint ticket_messages_subject_check check (
    (template = 'thank_you' and ticket_id is not null and order_id is null)
    or (template = 'order_confirmation' and order_id is not null and ticket_id is null)
  ),
  add constraint ticket_messages_recipient_check check (
    (channel = 'email' and to_email is not null) or (channel = 'sms' and to_phone is not null)
  );

create unique index ticket_messages_order_template_key
  on public.ticket_messages (order_id, template) where order_id is not null;
create index ticket_messages_due_idx
  on public.ticket_messages (next_attempt_at) where status = 'queued';

-- -----------------------------------------------------------------------------
-- Queue the confirmation when an order becomes completed: inside
-- tickets_place_order for free orders, inside tickets_complete_order for paid
-- ones. Same transaction as the state change, so a completed order can never
-- be missing its confirmation. Refund-pending (sold-out) orders get none.
-- -----------------------------------------------------------------------------
create or replace function app.tickets_queue_order_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_channel text := 'email';
  v_phone text;
begin
  if new.status <> 'completed' or (tg_op = 'UPDATE' and old.status = 'completed') then
    return null;
  end if;

  select d.channel, d.phone into v_channel, v_phone
  from public.ticket_order_delivery d
  where d.access_token_hash = new.access_token_hash;
  v_channel := coalesce(v_channel, 'email');

  insert into public.ticket_messages (tenant_id, event_id, order_id, template, channel, to_email, to_phone)
  values (
    new.tenant_id, new.event_id, new.id, 'order_confirmation', v_channel,
    case when v_channel = 'email' then new.buyer_email end,
    case when v_channel = 'sms' then v_phone end
  )
  on conflict do nothing;
  return null;
end
$$;
revoke all on function app.tickets_queue_order_confirmation() from public;

create trigger ticket_orders_queue_confirmation
  after insert or update of status on public.ticket_orders
  for each row execute function app.tickets_queue_order_confirmation();

-- -----------------------------------------------------------------------------
-- Dispatcher. Claims due messages (skipping rows another worker holds), with
-- everything needed to render them. A claim lasts 5 minutes; a worker that
-- dies mid-send leaves the row to be claimed again after that.
-- -----------------------------------------------------------------------------
create or replace function public.tickets_claim_messages(p_limit integer default 20)
returns jsonb
language sql
volatile
set search_path = ''
as $$
  with picked as (
    select m.id
    from public.ticket_messages m
    where m.status = 'queued'
      and m.next_attempt_at <= now()
      and (m.locked_until is null or m.locked_until < now())
    order by m.next_attempt_at, m.created_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update skip locked
  ),
  claimed as (
    update public.ticket_messages m
    set attempts = m.attempts + 1, locked_until = now() + interval '5 minutes'
    from picked
    where m.id = picked.id
    returning m.*
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id,
    'template', c.template,
    'channel', c.channel,
    'to_email', c.to_email,
    'to_phone', c.to_phone,
    'attempts', c.attempts,
    'tenant_id', c.tenant_id,
    'tenant_name', tn.name,
    'tenant_slug', tn.slug,
    'event', jsonb_build_object(
      'title', e.title,
      'slug', e.slug,
      'starts_at', e.starts_at,
      'ends_at', e.ends_at,
      'timezone', e.timezone,
      'venue_name', e.venue_name,
      'venue_address', e.venue_address
    ),
    'order', case when o.id is null then null else jsonb_build_object(
      'id', o.id,
      'status', o.status,
      'buyer_name', o.buyer_name,
      'total_cents', o.total_cents,
      'currency', o.currency,
      'access_token_hash', o.access_token_hash,
      'token_ciphertext', d.token_ciphertext,
      'tickets', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'code', t.ticket_code,
          'type_name', tt.name,
          'attendee_name', t.attendee_name,
          'status', t.status
        ) order by t.created_at, t.id), '[]'::jsonb)
        from public.tickets t
        join public.ticket_types tt on tt.id = t.ticket_type_id
        where t.order_id = o.id
      )
    ) end,
    'attendee_name', tk.attendee_name
  ) order by c.next_attempt_at), '[]'::jsonb)
  from claimed c
  join public.tenants tn on tn.id = c.tenant_id
  join public.tickets_events e on e.id = c.event_id
  left join public.ticket_orders o on o.id = c.order_id
  left join public.ticket_order_delivery d on d.access_token_hash = o.access_token_hash
  left join public.tickets tk on tk.id = c.ticket_id;
$$;

-- Records the outcome of one claimed message. Sent: stamps it and, for a
-- confirmation, wipes the encrypted token. Failed: retries with backoff
-- (2, 4, 8, 16 minutes) up to 5 attempts, or gives up at once when p_retry is
-- false (a permanent error such as an invalid address). Returns the new status.
create or replace function public.tickets_finish_message(
  p_message_id uuid,
  p_sent boolean,
  p_error text default null,
  p_retry boolean default true,
  p_provider_message_id text default null
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_msg public.ticket_messages%rowtype;
begin
  select * into v_msg from public.ticket_messages where id = p_message_id for update;
  if not found then
    raise exception 'MT_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_msg.status <> 'queued' then
    return v_msg.status::text;
  end if;

  if p_sent then
    update public.ticket_messages
    set status = 'sent', sent_at = now(), locked_until = null, last_error = null,
        provider_message_id = left(p_provider_message_id, 256)
    where id = p_message_id;
    if v_msg.template = 'order_confirmation' then
      update public.ticket_order_delivery d
      set token_ciphertext = null
      from public.ticket_orders o
      where o.id = v_msg.order_id and d.access_token_hash = o.access_token_hash;
    end if;
    return 'sent';
  end if;

  if not coalesce(p_retry, true) or v_msg.attempts >= 5 then
    update public.ticket_messages
    set status = 'failed', locked_until = null, last_error = left(coalesce(p_error, 'unknown error'), 1000)
    where id = p_message_id;
    return 'failed';
  end if;

  update public.ticket_messages
  set locked_until = null,
      last_error = left(coalesce(p_error, 'unknown error'), 1000),
      next_attempt_at = now() + make_interval(mins => (2 ^ greatest(v_msg.attempts, 1))::integer)
  where id = p_message_id;
  return 'queued';
end
$$;

-- Cron entry point (apps/web /api/cron/tickets every few minutes). Expires
-- holds whose checkout was abandoned without a webhook, drops delivery rows
-- whose order was never created, and wipes tokens for orders that will never
-- get a confirmation.
create or replace function public.tickets_housekeeping()
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_expired integer;
  v_purged integer;
  v_wiped integer;
begin
  v_expired := public.tickets_expire_stale_orders();

  delete from public.ticket_order_delivery d
  where d.created_at < now() - interval '1 day'
    and not exists (select 1 from public.ticket_orders o where o.access_token_hash = d.access_token_hash);
  get diagnostics v_purged = row_count;

  update public.ticket_order_delivery d
  set token_ciphertext = null
  from public.ticket_orders o
  where o.access_token_hash = d.access_token_hash
    and d.token_ciphertext is not null
    and o.status in ('expired', 'refunded', 'refund_pending');
  get diagnostics v_wiped = row_count;

  return jsonb_build_object('expired_orders', v_expired, 'purged_deliveries', v_purged, 'wiped_tokens', v_wiped);
end
$$;

revoke all on function public.tickets_claim_messages(integer) from public, anon, authenticated;
revoke all on function public.tickets_finish_message(uuid, boolean, text, boolean, text) from public, anon, authenticated;
revoke all on function public.tickets_housekeeping() from public, anon, authenticated;
grant execute on function public.tickets_claim_messages(integer) to service_role;
grant execute on function public.tickets_finish_message(uuid, boolean, text, boolean, text) to service_role;
grant execute on function public.tickets_housekeeping() to service_role;
