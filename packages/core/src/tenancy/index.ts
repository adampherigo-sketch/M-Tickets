import type { DbClient, Enums } from '@zevaryn/database'

export type TenantRole = Enums<'tenant_role'>

export interface TenantMembership {
  tenantId: string
  tenantName: string
  tenantSlug: string
  timezone: string
  role: TenantRole
}

/** Roles allowed to manage events, ticket types and payments. */
export const MANAGER_ROLES: readonly TenantRole[] = ['owner', 'admin']

export function hasRole(role: TenantRole, allowed: readonly TenantRole[]): boolean {
  return allowed.includes(role)
}

/** The signed-in user's memberships (RLS: a user always sees their own rows). */
export async function listMyMemberships(client: DbClient, userId: string): Promise<TenantMembership[]> {
  const { data, error } = await client
    .from('tenant_members')
    .select('role, tenants!inner(id, name, slug, timezone)')
    .eq('user_id', userId)
    .order('created_at')
  if (error) throw new Error(`Could not load memberships: ${error.message}`)
  return data.map((row) => ({
    tenantId: row.tenants.id,
    tenantName: row.tenants.name,
    tenantSlug: row.tenants.slug,
    timezone: row.tenants.timezone,
    role: row.role,
  }))
}

export async function createTenant(
  client: DbClient,
  input: { name: string; slug: string; timezone?: string },
): Promise<string> {
  const { data, error } = await client.rpc('core_create_tenant', {
    p_name: input.name,
    p_slug: input.slug,
    ...(input.timezone ? { p_timezone: input.timezone } : {}),
  })
  if (error) {
    if (error.code === '23505') throw new Error('That link name is taken. Try another.')
    throw new Error(`Could not create the business: ${error.message}`)
  }
  return data
}
