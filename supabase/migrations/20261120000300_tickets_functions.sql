-- =============================================================================
-- M-Tickets · 20261120000300_tickets_functions.sql
--
-- Every state change and every anonymous read goes through a function here.
--
--   Public (anon + authenticated), security definer, read-only:
--     tickets_public_storefront(slug)            published events for /t/<slug>
--     tickets_public_event(slug, event_slug)     one event + ticket types
--
--   Service role only (called from the server after it validated the request):
--     tickets_place_order(...)                   reserve inventory, create order + tickets
--     tickets_complete_order(...)                payment confirmed -> tickets valid, or
--                                                sold_out when the seats are gone (no overselling)
--     tickets_finish_late_refund(order_id, ref)  sold-out late payment refunded by the provider
--     tickets_expire_order(order_id)             checkout abandoned -> release hold
--     tickets_expire_stale_orders()              housekeeping sweep for a cron
--     tickets_refund_order(order_id)             refund recorded -> tickets refunded
--
--   Organizer (authenticated, membership checked inside), security definer:
--     tickets_check_in(event_id, method, code, rejected_reason)
--     tickets_queue_thank_you(event_id)
--
-- Errors raised for the app use SQLSTATE P0001 and a message starting MT_, which
-- packages/m-tickets/src/db/errors.ts maps to domain errors.
-- =============================================================================

-- Seats used by a ticket type: issued tickets plus holds on unexpired orders,
-- optionally leaving out one order (to ask "is there room for this order?").
-- Same formula as the ticket_type_availability view.
create or replace function app.ticket_type_taken(p_ticket_type_id uuid, p_exclude_order_id uuid default null)
returns integer
language sql
stable
set search_path = ''
as $$
  select count(*)::integer
  from public.tickets t
  join public.ticket_orders o on o.id = t.order_id
  where t.ticket_type_id = p_ticket_type_id
    and (p_exclude_order_id is null or t.order_id <> p_exclude_order_id)
    and (
      t.status in ('valid', 'checked_in')
      or (t.status = 'pending' and o.status = 'pending' and o.expires_at > now())
    );
$$;
revoke all on function app.ticket_type_taken(uuid, uuid) from public;
grant execute on function app.ticket_type_taken(uuid, uuid) to service_role;

create or replace function app.tickets_public_counts(p_event_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'rsvps', count(*) filter (where tt.kind = 'rsvp'),
    'tickets_sold', count(*) filter (where tt.kind = 'paid')
  )
  from public.tickets t
  join public.ticket_types tt on tt.id = t.ticket_type_id
  where t.event_id = p_event_id and t.status in ('valid', 'checked_in');
$$;
revoke all on function app.tickets_public_counts(uuid) from public;

-- -----------------------------------------------------------------------------
-- Public reads
-- -----------------------------------------------------------------------------
create or replace function public.tickets_public_storefront(p_client_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tenant', jsonb_build_object('name', t.name, 'slug', t.slug),
    'events', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'slug', e.slug,
          'title', e.title,
          'summary', left(e.description, 280),
          'venue_name', e.venue_name,
          'starts_at', e.starts_at,
          'ends_at', e.ends_at,
          'timezone', e.timezone,
          'price_from_cents', p.price_from_cents,
          'currency', p.currency,
          'has_rsvp', coalesce(p.has_rsvp, false),
          'counts', case when e.show_public_counts then app.tickets_public_counts(e.id) end
        )
        order by e.starts_at
      )
      from public.tickets_events e
      left join lateral (
        select
          min(tt.price_cents) filter (where tt.kind = 'paid') as price_from_cents,
          min(tt.currency) as currency,
          bool_or(tt.kind = 'rsvp') as has_rsvp
        from public.ticket_types tt
        where tt.event_id = e.id
      ) p on true
      where e.tenant_id = t.id and e.status = 'published' and e.ends_at > now()
    ), '[]'::jsonb)
  )
  from public.tenants t
  where t.slug = lower(p_client_slug);
$$;
comment on function public.tickets_public_storefront(text) is
  'Public: tenant name and its published, not-yet-ended events. Counts only where show_public_counts is on.';

create or replace function public.tickets_public_event(p_client_slug text, p_event_slug text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tenant', jsonb_build_object('name', t.name, 'slug', t.slug),
    'event', jsonb_build_object(
      'id', e.id,
      'slug', e.slug,
      'title', e.title,
      'description', e.description,
      'venue_name', e.venue_name,
      'venue_address', e.venue_address,
      'starts_at', e.starts_at,
      'ends_at', e.ends_at,
      'timezone', e.timezone,
      'counts', case when e.show_public_counts then app.tickets_public_counts(e.id) end
    ),
    'ticket_types', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', tt.id,
          'name', tt.name,
          'description', tt.description,
          'kind', tt.kind,
          'price_cents', tt.price_cents,
          'currency', tt.currency,
          'max_per_order', tt.max_per_order,
          'sales_start', tt.sales_start,
          'sales_end', tt.sales_end,
          'sales_state', case
            when tt.sales_start is not null and now() < tt.sales_start then 'not_started'
            when (tt.sales_end is not null and now() >= tt.sales_end) or now() >= e.ends_at then 'ended'
            when tt.quantity_limit is not null and app.ticket_type_taken(tt.id) >= tt.quantity_limit then 'sold_out'
            else 'on_sale'
          end,
          'remaining', case
            when e.show_public_counts and tt.quantity_limit is not null
              then greatest(tt.quantity_limit - app.ticket_type_taken(tt.id), 0)
          end
        )
        order by tt.sort_order, tt.created_at
      )
      from public.ticket_types tt
      where tt.event_id = e.id
    ), '[]'::jsonb)
  )
  from public.tenants t
  join public.tickets_events e on e.tenant_id = t.id
  where t.slug = lower(p_client_slug)
    and e.slug = lower(p_event_slug)
    and e.status = 'published';
$$;
comment on function public.tickets_public_event(text, text) is
  'Public: one published event with its ticket types and sales state. Remaining seats and counts only where show_public_counts is on.';

revoke all on function public.tickets_public_storefront(text) from public;
revoke all on function public.tickets_public_event(text, text) from public;
grant execute on function public.tickets_public_storefront(text) to anon, authenticated, service_role;
grant execute on function public.tickets_public_event(text, text) to anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Orders (service role only)
-- -----------------------------------------------------------------------------

-- p_tickets: [{ ticket_type_id, attendee_name?, attendee_email?, ticket_code, qr_payload }]
-- Prices always come from ticket_types, never from the caller. Ticket types are
-- locked in id order so two buyers racing for the last seat serialize cleanly.
create or replace function public.tickets_place_order(
  p_event_id uuid,
  p_buyer_name text,
  p_buyer_email text,
  p_access_token_hash text,
  p_tickets jsonb,
  p_hold_until timestamptz default null,
  p_provider public.payment_provider default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_event public.tickets_events%rowtype;
  v_type public.ticket_types%rowtype;
  v_line record;
  v_taken integer;
  v_total bigint := 0;
  v_currency text;
  v_order_id uuid;
  v_paid boolean;
begin
  select * into v_event from public.tickets_events where id = p_event_id for share;
  if not found or v_event.status <> 'published' or v_event.ends_at <= now() then
    raise exception 'MT_EVENT_NOT_ON_SALE' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_tickets) is distinct from 'array'
     or jsonb_array_length(p_tickets) = 0
     or jsonb_array_length(p_tickets) > 50 then
    raise exception 'MT_INVALID_QUANTITY' using errcode = 'P0001';
  end if;

  for v_line in
    select (x ->> 'ticket_type_id')::uuid as ticket_type_id, count(*)::integer as quantity
    from jsonb_array_elements(p_tickets) x
    group by 1
    order by 1
  loop
    select * into v_type
    from public.ticket_types
    where id = v_line.ticket_type_id and event_id = p_event_id
    for update;
    if not found then
      raise exception 'MT_UNKNOWN_TICKET_TYPE' using errcode = 'P0001';
    end if;
    if v_type.sales_start is not null and now() < v_type.sales_start then
      raise exception 'MT_NOT_ON_SALE_YET' using errcode = 'P0001';
    end if;
    if v_type.sales_end is not null and now() >= v_type.sales_end then
      raise exception 'MT_SALES_ENDED' using errcode = 'P0001';
    end if;
    if v_line.quantity > v_type.max_per_order then
      raise exception 'MT_EXCEEDS_PER_ORDER_MAX' using errcode = 'P0001';
    end if;
    if v_type.quantity_limit is not null then
      v_taken := app.ticket_type_taken(v_type.id);
      if v_taken >= v_type.quantity_limit then
        raise exception 'MT_SOLD_OUT' using errcode = 'P0001';
      elsif v_taken + v_line.quantity > v_type.quantity_limit then
        raise exception 'MT_EXCEEDS_REMAINING' using errcode = 'P0001';
      end if;
    end if;
    if v_currency is null then
      v_currency := v_type.currency;
    elsif v_currency <> v_type.currency then
      raise exception 'MT_MIXED_CURRENCY' using errcode = 'P0001';
    end if;
    v_total := v_total + v_type.price_cents * v_line.quantity;
  end loop;

  v_paid := v_total > 0;
  if v_paid and p_provider is null then
    raise exception 'MT_PAYMENTS_NOT_CONFIGURED' using errcode = 'P0001';
  end if;
  if v_paid and (p_hold_until is null or p_hold_until <= now()) then
    raise exception 'MT_INVALID_HOLD' using errcode = 'P0001';
  end if;

  insert into public.ticket_orders (
    tenant_id, event_id, buyer_name, buyer_email, status, currency, subtotal_cents, total_cents,
    provider, access_token_hash, expires_at, completed_at
  )
  values (
    v_event.tenant_id, v_event.id, btrim(p_buyer_name), lower(btrim(p_buyer_email)),
    case when v_paid then 'pending' else 'completed' end::public.ticket_order_status,
    v_currency, v_total, v_total,
    case when v_paid then p_provider end,
    p_access_token_hash,
    case when v_paid then p_hold_until end,
    case when v_paid then null else now() end
  )
  returning id into v_order_id;

  insert into public.tickets (
    tenant_id, event_id, order_id, ticket_type_id, attendee_name, attendee_email, ticket_code, qr_payload, status
  )
  select
    v_event.tenant_id, v_event.id, v_order_id, (x ->> 'ticket_type_id')::uuid,
    coalesce(nullif(btrim(x ->> 'attendee_name'), ''), btrim(p_buyer_name)),
    nullif(lower(btrim(x ->> 'attendee_email')), ''),
    x ->> 'ticket_code',
    x ->> 'qr_payload',
    case when v_paid then 'pending' else 'valid' end::public.ticket_status
  from jsonb_array_elements(p_tickets) x;

  return jsonb_build_object(
    'order_id', v_order_id,
    'tenant_id', v_event.tenant_id,
    'event_id', v_event.id,
    'status', case when v_paid then 'pending' else 'completed' end,
    'total_cents', v_total,
    'currency', v_currency,
    'ticket_ids', (select coalesce(jsonb_agg(t.id order by t.created_at), '[]'::jsonb) from public.tickets t where t.order_id = v_order_id)
  );
end
$$;

-- Payment confirmed. Idempotent: a repeated webhook returns already_completed.
--
-- No overselling. Before the order's tickets become valid, its seats are
-- re-checked against everyone else's issued tickets and live holds, with the
-- ticket types locked. That only fails when the hold lapsed (or the organizer
-- lowered a limit) and the seats went to other buyers. The order then moves to
-- refund_pending with its tickets void, the result is sold_out, and the server
-- refunds the payment through the provider and calls tickets_finish_late_refund.
--
-- The sold_out decision is sticky: a retried webhook gets sold_out again even
-- if a seat has freed up since, so nobody is both refunded and issued tickets.
create or replace function public.tickets_complete_order(
  p_order_id uuid,
  p_provider public.payment_provider,
  p_payment_ref text,
  p_amount_cents bigint,
  p_currency text
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_order public.ticket_orders%rowtype;
  v_line record;
  v_limit integer;
  v_late boolean;
  v_sold_out boolean := false;
  v_ticket_ids jsonb;
begin
  select * into v_order from public.ticket_orders where id = p_order_id for update;
  if not found then
    raise exception 'MT_ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_order.status in ('completed', 'refunded') then
    return jsonb_build_object(
      'result', 'already_' || v_order.status::text, 'order_id', v_order.id,
      'tenant_id', v_order.tenant_id, 'event_id', v_order.event_id, 'ticket_ids', '[]'::jsonb
    );
  end if;
  if v_order.status = 'refund_pending' then
    return jsonb_build_object(
      'result', 'sold_out', 'order_id', v_order.id,
      'tenant_id', v_order.tenant_id, 'event_id', v_order.event_id, 'ticket_ids', '[]'::jsonb
    );
  end if;
  if p_amount_cents <> v_order.total_cents or upper(p_currency) <> v_order.currency then
    raise exception 'MT_AMOUNT_MISMATCH' using errcode = 'P0001';
  end if;

  v_late := v_order.status = 'expired' or v_order.expires_at <= now();

  -- Lock in ticket-type id order, as tickets_place_order does, so a payment and
  -- a new order racing for the last seat serialize cleanly.
  for v_line in
    select t.ticket_type_id, count(*)::integer as quantity
    from public.tickets t
    where t.order_id = v_order.id
    group by t.ticket_type_id
    order by t.ticket_type_id
  loop
    select quantity_limit into v_limit from public.ticket_types where id = v_line.ticket_type_id for update;
    if v_limit is not null and app.ticket_type_taken(v_line.ticket_type_id, v_order.id) + v_line.quantity > v_limit then
      v_sold_out := true;
    end if;
  end loop;

  if v_sold_out then
    update public.ticket_orders
    set status = 'refund_pending', provider = p_provider, provider_payment_ref = p_payment_ref, refund_reason = 'sold_out'
    where id = v_order.id;
    update public.tickets set status = 'void' where order_id = v_order.id and status = 'pending';
    insert into public.ticket_order_log (tenant_id, event_id, order_id, action, detail)
    values (
      v_order.tenant_id, v_order.event_id, v_order.id, 'late_payment_sold_out',
      jsonb_build_object('provider', p_provider, 'payment_ref', p_payment_ref, 'amount_cents', p_amount_cents,
                         'hold_expired_at', v_order.expires_at)
    );
    return jsonb_build_object(
      'result', 'sold_out', 'order_id', v_order.id,
      'tenant_id', v_order.tenant_id, 'event_id', v_order.event_id, 'ticket_ids', '[]'::jsonb
    );
  end if;

  update public.ticket_orders
  set status = 'completed', provider = p_provider, provider_payment_ref = p_payment_ref, completed_at = now()
  where id = v_order.id;

  with issued as (
    update public.tickets
    set status = 'valid'
    where order_id = v_order.id and status in ('pending', 'void')
    returning id
  )
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_ticket_ids from issued;

  if v_late then
    insert into public.ticket_order_log (tenant_id, event_id, order_id, action, detail)
    values (
      v_order.tenant_id, v_order.event_id, v_order.id, 'late_payment_honored',
      jsonb_build_object('payment_ref', p_payment_ref, 'hold_expired_at', v_order.expires_at)
    );
  end if;

  return jsonb_build_object(
    'result', 'completed', 'order_id', v_order.id,
    'tenant_id', v_order.tenant_id, 'event_id', v_order.event_id, 'ticket_ids', v_ticket_ids
  );
end
$$;

-- The provider has refunded a sold-out late payment. Idempotent.
create or replace function public.tickets_finish_late_refund(p_order_id uuid, p_provider_refund_ref text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_order public.ticket_orders%rowtype;
begin
  select * into v_order from public.ticket_orders where id = p_order_id for update;
  if not found then
    raise exception 'MT_ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_order.status = 'refunded' then
    return jsonb_build_object(
      'result', 'already_refunded', 'order_id', v_order.id,
      'tenant_id', v_order.tenant_id, 'event_id', v_order.event_id, 'ticket_ids', '[]'::jsonb
    );
  end if;
  if v_order.status <> 'refund_pending' then
    raise exception 'MT_ORDER_NOT_REFUNDABLE' using errcode = 'P0001';
  end if;

  update public.ticket_orders set status = 'refunded', refunded_at = now() where id = v_order.id;
  insert into public.ticket_order_log (tenant_id, event_id, order_id, action, detail)
  values (
    v_order.tenant_id, v_order.event_id, v_order.id, 'late_payment_refunded',
    jsonb_build_object('refund_ref', p_provider_refund_ref, 'payment_ref', v_order.provider_payment_ref)
  );
  return jsonb_build_object(
    'result', 'refunded', 'order_id', v_order.id,
    'tenant_id', v_order.tenant_id, 'event_id', v_order.event_id, 'ticket_ids', '[]'::jsonb
  );
end
$$;

create or replace function public.tickets_expire_order(p_order_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  update public.ticket_orders set status = 'expired' where id = p_order_id and status = 'pending';
  if not found then
    return false;
  end if;
  update public.tickets set status = 'void' where order_id = p_order_id and status = 'pending';
  return true;
end
$$;

create or replace function public.tickets_expire_stale_orders()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
begin
  with expired as (
    update public.ticket_orders
    set status = 'expired'
    where status = 'pending' and expires_at <= now()
    returning id
  ), voided as (
    update public.tickets t
    set status = 'void'
    from expired e
    where t.order_id = e.id and t.status = 'pending'
    returning t.id
  )
  select count(*)::integer into v_count from expired;
  return v_count;
end
$$;

create or replace function public.tickets_refund_order(p_order_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_order public.ticket_orders%rowtype;
  v_ticket_ids jsonb;
begin
  select * into v_order from public.ticket_orders where id = p_order_id for update;
  if not found then
    raise exception 'MT_ORDER_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_order.status = 'refunded' then
    return jsonb_build_object(
      'result', 'already_refunded', 'order_id', v_order.id,
      'tenant_id', v_order.tenant_id, 'event_id', v_order.event_id, 'ticket_ids', '[]'::jsonb
    );
  end if;
  if v_order.status <> 'completed' then
    raise exception 'MT_ORDER_NOT_REFUNDABLE' using errcode = 'P0001';
  end if;

  update public.ticket_orders set status = 'refunded', refunded_at = now(), refund_reason = 'requested'
  where id = v_order.id;
  with refunded as (
    update public.tickets
    set status = 'refunded'
    where order_id = v_order.id and status in ('valid', 'checked_in')
    returning id
  )
  select coalesce(jsonb_agg(id), '[]'::jsonb) into v_ticket_ids from refunded;

  return jsonb_build_object(
    'result', 'refunded', 'order_id', v_order.id,
    'tenant_id', v_order.tenant_id, 'event_id', v_order.event_id, 'ticket_ids', v_ticket_ids
  );
end
$$;

revoke all on function public.tickets_place_order(uuid, text, text, text, jsonb, timestamptz, public.payment_provider) from public, anon, authenticated;
revoke all on function public.tickets_complete_order(uuid, public.payment_provider, text, bigint, text) from public, anon, authenticated;
revoke all on function public.tickets_expire_order(uuid) from public, anon, authenticated;
revoke all on function public.tickets_expire_stale_orders() from public, anon, authenticated;
revoke all on function public.tickets_refund_order(uuid) from public, anon, authenticated;
revoke all on function public.tickets_finish_late_refund(uuid, text) from public, anon, authenticated;
grant execute on function public.tickets_place_order(uuid, text, text, text, jsonb, timestamptz, public.payment_provider) to service_role;
grant execute on function public.tickets_complete_order(uuid, public.payment_provider, text, bigint, text) to service_role;
grant execute on function public.tickets_expire_order(uuid) to service_role;
grant execute on function public.tickets_expire_stale_orders() to service_role;
grant execute on function public.tickets_refund_order(uuid) to service_role;
grant execute on function public.tickets_finish_late_refund(uuid, text) to service_role;

-- -----------------------------------------------------------------------------
-- Check-in (any member of the event's tenant, staff included)
--
-- Locks the ticket row, so two scanners on the same ticket cannot both succeed.
-- Every attempt is logged, including unreadable input and forged QR codes
-- (passed in as p_rejected_reason by the server after it verified the signature).
-- A code that belongs to another tenant reports not_found, never wrong_event,
-- so the endpoint cannot be used to probe other tenants' tickets.
-- -----------------------------------------------------------------------------
create or replace function public.tickets_check_in(
  p_event_id uuid,
  p_method public.checkin_method,
  p_ticket_code text default null,
  p_rejected_reason public.checkin_result default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_actor uuid := (select auth.uid());
  v_ticket public.tickets%rowtype;
  v_found boolean := false;
  v_result public.checkin_result;
  v_type_name text;
begin
  select e.tenant_id into v_tenant_id from public.tickets_events e where e.id = p_event_id;
  if v_tenant_id is null or not app.is_tenant_member(v_tenant_id) then
    raise exception 'MT_FORBIDDEN' using errcode = '42501';
  end if;

  if p_rejected_reason is not null then
    if p_rejected_reason not in ('invalid_input', 'invalid_signature') then
      raise exception 'MT_BAD_REQUEST' using errcode = 'P0001';
    end if;
    insert into public.ticket_checkin_log (tenant_id, event_id, method, result, actor_id)
    values (v_tenant_id, p_event_id, p_method, p_rejected_reason, v_actor);
    return jsonb_build_object('result', p_rejected_reason, 'ticket', null);
  end if;

  if p_ticket_code is null or p_ticket_code !~ '^[0-9A-HJKMNP-TV-Z]{10}$' then
    insert into public.ticket_checkin_log (tenant_id, event_id, method, result, submitted_code, actor_id)
    values (v_tenant_id, p_event_id, p_method, 'invalid_input', left(p_ticket_code, 64), v_actor);
    return jsonb_build_object('result', 'invalid_input', 'ticket', null);
  end if;

  select * into v_ticket from public.tickets where ticket_code = p_ticket_code for update;
  v_found := found and v_ticket.tenant_id = v_tenant_id;

  if not v_found then
    v_result := 'not_found';
  elsif v_ticket.event_id <> p_event_id then
    v_result := 'wrong_event';
  elsif v_ticket.status = 'checked_in' then
    v_result := 'already_checked_in';
  elsif v_ticket.status = 'valid' then
    update public.tickets
    set status = 'checked_in', checked_in_at = now(), checked_in_by = v_actor
    where id = v_ticket.id
    returning * into v_ticket;
    v_result := 'checked_in';
  else
    v_result := 'not_valid';
  end if;

  insert into public.ticket_checkin_log (tenant_id, event_id, ticket_id, method, result, submitted_code, actor_id)
  values (v_tenant_id, p_event_id, case when v_found then v_ticket.id end, p_method, v_result, p_ticket_code, v_actor);

  if not v_found then
    return jsonb_build_object('result', v_result, 'ticket', null);
  end if;

  select tt.name into v_type_name from public.ticket_types tt where tt.id = v_ticket.ticket_type_id;
  return jsonb_build_object(
    'result', v_result,
    'ticket', jsonb_build_object(
      'id', v_ticket.id,
      'event_id', v_ticket.event_id,
      'ticket_type_id', v_ticket.ticket_type_id,
      'attendee_name', v_ticket.attendee_name,
      'ticket_type_name', v_type_name,
      'status', v_ticket.status,
      'checked_in_at', v_ticket.checked_in_at
    )
  );
end
$$;

-- Queues one thank-you per checked-in guest with an email. Idempotent per
-- ticket: pressing the button twice queues nothing new. Sending is a stub.
create or replace function public.tickets_queue_thank_you(p_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_count integer;
begin
  select e.tenant_id into v_tenant_id from public.tickets_events e where e.id = p_event_id;
  if v_tenant_id is null or not app.is_tenant_member(v_tenant_id, '{owner,admin}') then
    raise exception 'MT_FORBIDDEN' using errcode = '42501';
  end if;

  insert into public.ticket_messages (tenant_id, event_id, ticket_id, template, to_email, queued_by)
  select t.tenant_id, t.event_id, t.id, 'thank_you', coalesce(t.attendee_email, o.buyer_email), (select auth.uid())
  from public.tickets t
  join public.ticket_orders o on o.id = t.order_id
  where t.event_id = p_event_id and t.status = 'checked_in'
  on conflict (ticket_id, template) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

revoke all on function public.tickets_check_in(uuid, public.checkin_method, text, public.checkin_result) from public, anon;
revoke all on function public.tickets_queue_thank_you(uuid) from public, anon;
grant execute on function public.tickets_check_in(uuid, public.checkin_method, text, public.checkin_result) to authenticated, service_role;
grant execute on function public.tickets_queue_thank_you(uuid) to authenticated, service_role;
