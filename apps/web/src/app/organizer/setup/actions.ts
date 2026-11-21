'use server'

import { createTenant } from '@zevaryn/core/tenancy'
import { slugify } from '@zevaryn/m-tickets/domain'
import { redirect } from 'next/navigation'
import { withMessage } from '@/lib/forms'
import { signedInUser } from '@/lib/auth'

export async function createTenantAction(form: FormData): Promise<void> {
  const { supabase, user } = await signedInUser()
  if (!user) redirect('/login')
  const name = String(form.get('name') ?? '').trim()
  const slug = slugify(String(form.get('slug') ?? '') || name, 48)
  const timezone = String(form.get('timezone') ?? '').trim() || 'America/New_York'
  try {
    await createTenant(supabase, { name, slug, timezone })
  } catch (error) {
    redirect(withMessage('/organizer/setup', 'error', error instanceof Error ? error.message : 'Could not create'))
  }
  redirect('/organizer/events')
}
