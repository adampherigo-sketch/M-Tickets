import type { Metadata } from 'next'
import { Banners, type SearchParams } from '@/app/messages'
import { requireManager } from '@/lib/auth'
import { createEventAction } from '../actions'
import { EventForm } from '../EventForm'

export const metadata: Metadata = { title: 'New event' }

export default async function NewEventPage({ searchParams }: { searchParams: SearchParams }) {
  const { membership } = await requireManager()
  return (
    <main className="mt-page mt-narrow">
      <h1>New event</h1>
      <p className="mt-muted">Events start as drafts. Add ticket types, then publish.</p>
      <Banners params={await searchParams} />
      <EventForm action={createEventAction} defaultTimezone={membership.timezone} submitLabel="Create draft" />
    </main>
  )
}
