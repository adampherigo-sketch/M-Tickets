import { getEvent, listAttendees, listTicketTypes } from '@zevaryn/m-tickets/db'
import { formatEventDateRange } from '@zevaryn/m-tickets/domain'
import { CommandCenter } from '@zevaryn/m-tickets/ui/client'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { toAttendeeView } from '@/lib/views'
import { requireOrganizer } from '@/lib/auth'
import { thankAttendeesAction } from './actions'

export const metadata: Metadata = { title: 'Command page' }
export const dynamic = 'force-dynamic'

type Params = Promise<{ eventId: string }>

/** Day-of operations. Any member (staff included) can check guests in. */
export default async function CommandPage({ params }: { params: Params }) {
  const { eventId } = await params
  const { supabase, isManager } = await requireOrganizer()
  const event = await getEvent(supabase, eventId)
  if (!event) notFound()
  const [attendees, ticketTypes] = await Promise.all([
    listAttendees(supabase, eventId),
    listTicketTypes(supabase, eventId),
  ])

  return (
    <main className="mt-page">
      <p>
        <Link href="/organizer/events">← Events</Link>
      </p>
      <h1>{event.title}</h1>
      <p className="mt-muted">{formatEventDateRange(event.startsAt, event.endsAt, event.timezone)}</p>
      <CommandCenter
        eventId={event.id}
        checkInUrl="/api/checkin"
        attendeesUrl={`/api/events/${event.id}/attendees`}
        initialAttendees={attendees.map(toAttendeeView)}
        ticketTypes={ticketTypes.map((t) => ({ id: t.id, name: t.name }))}
        {...(isManager ? { thankAttendeesAction: thankAttendeesAction.bind(null, event.id) } : {})}
      />
    </main>
  )
}
