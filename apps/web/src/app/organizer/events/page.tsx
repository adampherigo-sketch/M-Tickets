import { listEventsWithStats } from '@zevaryn/m-tickets/db'
import { EmptyState, Money, StatusBadge } from '@zevaryn/m-tickets/ui'
import { formatEventDateRange } from '@zevaryn/m-tickets/domain'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Banners, type SearchParams } from '@/app/messages'
import { requireOrganizer } from '@/lib/auth'

export const metadata: Metadata = { title: 'Events' }

/** Every event for the tenant with sold / RSVP / checked-in counts. */
export default async function EventsPage({ searchParams }: { searchParams: SearchParams }) {
  const { supabase, membership, isManager } = await requireOrganizer()
  const events = await listEventsWithStats(supabase, membership.tenantId)

  return (
    <main className="mt-page">
      <div className="mt-row mt-wrap">
        <div className="mt-grow">
          <h1>{membership.tenantName} events</h1>
          <p className="mt-muted">
            Public page: <Link href={`/t/${membership.tenantSlug}`}>/t/{membership.tenantSlug}</Link>
          </p>
        </div>
        {isManager ? (
          <Link className="mt-button mt-button--primary" href="/organizer/events/new">
            New event
          </Link>
        ) : null}
      </div>
      <Banners params={await searchParams} />

      {events.length === 0 ? (
        <EmptyState title="No events yet">
          {isManager ? 'Create your first event to start taking RSVPs.' : null}
        </EmptyState>
      ) : (
        <div className="mt-card mt-table-wrap">
          <table className="mt-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Status</th>
                <th className="mt-num">RSVPs</th>
                <th className="mt-num">Sold</th>
                <th className="mt-num">Checked in</th>
                <th className="mt-num">Gross</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td>
                    <strong>{event.title}</strong>
                    <br />
                    <span className="mt-muted">
                      {formatEventDateRange(event.startsAt, event.endsAt, event.timezone)}
                    </span>
                  </td>
                  <td>
                    <StatusBadge status={event.status} />
                  </td>
                  <td className="mt-num">{event.stats.rsvps}</td>
                  <td className="mt-num">{event.stats.ticketsSold}</td>
                  <td className="mt-num">
                    {event.stats.checkedIn} / {event.stats.attendees}
                  </td>
                  <td className="mt-num">
                    <Money cents={event.stats.grossCents} currency={event.currency ?? 'USD'} />
                  </td>
                  <td>
                    <div className="mt-actions">
                      {isManager ? (
                        <Link className="mt-button" href={`/organizer/events/${event.id}`}>
                          Edit
                        </Link>
                      ) : null}
                      <Link className="mt-button" href={`/organizer/events/${event.id}/command`}>
                        Command
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  )
}
