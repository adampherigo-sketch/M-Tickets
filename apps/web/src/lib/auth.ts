import 'server-only'
import type { User } from '@supabase/supabase-js'
import {
  hasRole,
  listMyMemberships,
  MANAGER_ROLES,
  type TenantMembership,
  type TenantRole,
} from '@zevaryn/core/tenancy'
import type { DbClient } from '@zevaryn/database'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { userClient } from './supabase/clients'

export interface OrganizerContext {
  supabase: DbClient
  user: User
  membership: TenantMembership
  memberships: TenantMembership[]
  isManager: boolean
}

/** Cookie reserved for a future tenant switcher; the first membership wins until then. */
const TENANT_COOKIE = 'mt_tenant'

async function loadOrganizer(): Promise<OrganizerContext | 'signed_out' | 'no_tenant'> {
  const supabase = await userClient()
  // getUser() re-validates the session with Supabase Auth (not just the cookie).
  const { data } = await supabase.auth.getUser()
  if (!data.user) return 'signed_out'
  const memberships = await listMyMemberships(supabase, data.user.id)
  if (memberships.length === 0) return 'no_tenant'
  const preferred = (await cookies()).get(TENANT_COOKIE)?.value
  const membership = memberships.find((m) => m.tenantId === preferred) ?? memberships[0]!
  return { supabase, user: data.user, membership, memberships, isManager: hasRole(membership.role, MANAGER_ROLES) }
}

/** For pages and server actions: redirects when signed out or not allowed. */
export async function requireOrganizer(options: { roles?: readonly TenantRole[] } = {}): Promise<OrganizerContext> {
  const result = await loadOrganizer()
  if (result === 'signed_out') redirect('/login')
  if (result === 'no_tenant') redirect('/organizer/setup')
  if (options.roles && !hasRole(result.membership.role, options.roles))
    redirect('/organizer/events?notice=managers-only')
  return result
}

export async function requireManager(): Promise<OrganizerContext> {
  return requireOrganizer({ roles: MANAGER_ROLES })
}

/** For API routes: null instead of a redirect. */
export async function organizerForApi(): Promise<OrganizerContext | null> {
  const result = await loadOrganizer()
  return typeof result === 'string' ? null : result
}

export async function signedInUser(): Promise<{ supabase: DbClient; user: User | null }> {
  const supabase = await userClient()
  const { data } = await supabase.auth.getUser()
  return { supabase, user: data.user }
}
