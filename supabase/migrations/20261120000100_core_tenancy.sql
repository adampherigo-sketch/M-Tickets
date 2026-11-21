-- =============================================================================
-- M-System core · 20261120000100_core_tenancy.sql
--
-- Shared by every module: tenants (Zevaryn's clients), who belongs to them, the
-- RLS helper every module policy calls, and the domain-event outbox modules use
-- to talk to each other without reading each other's tables.
--
-- Every security definer function pins search_path to '' and schema-qualifies
-- what it touches.
-- =============================================================================

-- Private helper schema. Not exposed through the Data API; authenticated only
-- needs USAGE so RLS policies can call app.* helpers.
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- owner: everything, including members and payments.
-- admin: everything except members.
-- staff: read operational data and run day-of operations (check-in).
create type public.tenant_role as enum ('owner', 'admin', 'staff');

-- -----------------------------------------------------------------------------
-- tenants: one row per Zevaryn client. slug is the public handle used in links
-- such as /t/<slug>, so it is lowercase, url-safe and unique.
-- -----------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$'),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  timezone text not null default 'America/New_York' check (char_length(timezone) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.tenants is 'Zevaryn clients. slug is public (used in /t/<slug>); everything else is member-only.';

create table public.tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.tenant_role not null default 'staff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members (user_id);

-- -----------------------------------------------------------------------------
-- Domain-event outbox. Modules publish here; a relay (not built yet) delivers
-- rows to subscribers and stamps published_at. Payloads carry ids, not PII.
-- -----------------------------------------------------------------------------
create table public.domain_events (
  id uuid primary key,
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  type text not null check (type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  version smallint not null default 1 check (version > 0),
  source text not null check (char_length(source) between 1 and 64),
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  published_at timestamptz,
  attempts integer not null default 0
);
create index domain_events_unpublished_idx on public.domain_events (recorded_at) where published_at is null;
create index domain_events_tenant_type_idx on public.domain_events (tenant_id, type, occurred_at desc);
comment on table public.domain_events is
  'Transactional outbox for module-to-module events. Written by the service role only.';

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function app.is_tenant_member(
  p_tenant_id uuid,
  p_roles public.tenant_role[] default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tenant_members m
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and (p_roles is null or m.role = any (p_roles))
  );
$$;
comment on function app.is_tenant_member(uuid, public.tenant_role[]) is
  'RLS helper: is the signed-in user a member of this tenant (with one of these roles)?';
revoke all on function app.is_tenant_member(uuid, public.tenant_role[]) from public;
grant execute on function app.is_tenant_member(uuid, public.tenant_role[]) to authenticated, service_role;

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create trigger tenants_touch before update on public.tenants
  for each row execute function app.touch_updated_at();
create trigger tenant_members_touch before update on public.tenant_members
  for each row execute function app.touch_updated_at();

-- Signed-in user creates a tenant and becomes its owner, in one step.
create or replace function public.core_create_tenant(p_name text, p_slug text, p_timezone text default 'America/New_York')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_tenant uuid;
begin
  if v_user is null then
    raise exception 'MT_NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  insert into public.tenants (name, slug, timezone)
  values (btrim(p_name), lower(btrim(p_slug)), p_timezone)
  returning id into v_tenant;
  insert into public.tenant_members (tenant_id, user_id, role) values (v_tenant, v_user, 'owner');
  return v_tenant;
end
$$;
revoke all on function public.core_create_tenant(text, text, text) from public, anon;
grant execute on function public.core_create_tenant(text, text, text) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Row Level Security. anon gets no table access at all: public pages read
-- through narrowly scoped security definer functions owned by each module.
-- -----------------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.domain_events enable row level security;

revoke all on table public.tenants, public.tenant_members, public.domain_events from anon;

create policy "members read their tenant" on public.tenants
  for select to authenticated using (app.is_tenant_member(id));
create policy "owners and admins update their tenant" on public.tenants
  for update to authenticated
  using (app.is_tenant_member(id, '{owner,admin}'))
  with check (app.is_tenant_member(id, '{owner,admin}'));

create policy "members read memberships" on public.tenant_members
  for select to authenticated using (user_id = (select auth.uid()) or app.is_tenant_member(tenant_id));
create policy "owners add members" on public.tenant_members
  for insert to authenticated with check (app.is_tenant_member(tenant_id, '{owner}'));
create policy "owners change roles" on public.tenant_members
  for update to authenticated
  using (app.is_tenant_member(tenant_id, '{owner}'))
  with check (app.is_tenant_member(tenant_id, '{owner}'));
create policy "owners remove members" on public.tenant_members
  for delete to authenticated using (app.is_tenant_member(tenant_id, '{owner}'));

-- Outbox: owners and admins can read their tenant's events (activity feeds,
-- debugging). Only the service role writes.
create policy "owners and admins read domain events" on public.domain_events
  for select to authenticated using (app.is_tenant_member(tenant_id, '{owner,admin}'));
revoke insert, update, delete on table public.domain_events from authenticated;
