import { listMyMemberships } from '@zevaryn/core/tenancy'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Banners, type SearchParams } from '@/app/messages'
import { signedInUser } from '@/lib/auth'
import { createTenantAction } from './actions'

export const metadata: Metadata = { title: 'Set up your business' }

/** First run for a signed-in user with no tenant: create one and become its owner. */
export default async function SetupPage({ searchParams }: { searchParams: SearchParams }) {
  const { supabase, user } = await signedInUser()
  if (!user) redirect('/login')
  if ((await listMyMemberships(supabase, user.id)).length > 0) redirect('/organizer/events')

  return (
    <main className="mt-page mt-narrow">
      <h1>Set up your business</h1>
      <Banners params={await searchParams} />
      <form action={createTenantAction} className="mt-card mt-stack">
        <label className="mt-field">
          <span>Business name</span>
          <input name="name" required maxLength={200} />
        </label>
        <label className="mt-field">
          <span>Ticket page link: /t/…</span>
          <input name="slug" required pattern="[a-z0-9](?:[a-z0-9\-]{0,46}[a-z0-9])?" placeholder="acme-plumbing" />
        </label>
        <label className="mt-field">
          <span>Time zone</span>
          <input name="timezone" defaultValue="America/New_York" required />
        </label>
        <button type="submit" className="mt-button mt-button--primary">
          Create
        </button>
      </form>
    </main>
  )
}
