'use server'

import { redirect } from 'next/navigation'
import { safeNextPath, withMessage } from '@/lib/forms'
import { userClient } from '@/lib/supabase/clients'

export async function signIn(form: FormData): Promise<void> {
  const email = String(form.get('email') ?? '').trim()
  const password = String(form.get('password') ?? '')
  const next = safeNextPath(form.get('next'), '/organizer')
  const supabase = await userClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error)
    redirect(withMessage(`/login?next=${encodeURIComponent(next)}`, 'error', 'Email or password is incorrect.'))
  redirect(next)
}
