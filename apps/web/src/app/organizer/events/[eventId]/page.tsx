import { getEvent, getEventStats, listTicketTypes, type TicketTypeRecord } from '@zevaryn/m-tickets/db'
import { utcToZonedLocal } from '@zevaryn/m-tickets/domain'
import { Money, PriceLabel, Stat, StatusBadge } from '@zevaryn/m-tickets/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Banners, type SearchParams } from '@/app/messages'
import { requireManager } from '@/lib/auth'
import {
  addTicketTypeAction,
  deleteTicketTypeAction,
  publishEventAction,
  saveEventAction,
  unpublishEventAction,
  updateTicketTypeAction,
} from '../actions'
import { EventForm } from '../EventForm'

export const metadata: Metadata = { title: 'Edit event' }

type Params = Promise<{ eventId: string }>

/** Event editor: details, ticket types, public-counts toggle, publish state. */
export default async function EventEditorPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { eventId } = await params
  const { supabase, membership } = await requireManager()
  const event = await getEvent(supabase, eventId)
  if (!event) notFound()
  const [ticketTypes, stats] = await Promise.all([listTicketTypes(supabase, eventId), getEventStats(supabase, eventId)])

  return (
    <main className="mt-page">
      <p>
        <Link href="/organizer/events">← Events</Link>
      </p>
      <div className="mt-row mt-wrap">
        <div className="mt-grow">
          <h1>{event.title}</h1>
          <StatusBadge status={event.status} />
        </div>
        <div className="mt-actions">
          <Link className="mt-button" href={`/organizer/events/${event.id}/command`}>
            Command page
          </Link>
          {event.status === 'published' ? (
            <>
              <Link className="mt-button" href={`/t/${membership.tenantSlug}/${event.slug}`}>
                View public page
              </Link>
              <form action={unpublishEventAction.bind(null, event.id)}>
                <button type="submit" className="mt-button">
                  Unpublish
                </button>
              </form>
            </>
          ) : event.status === 'draft' ? (
            <form action={publishEventAction.bind(null, event.id)}>
              <button type="submit" className="mt-button mt-button--primary">
                Publish
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <Banners params={await searchParams} />

      <section className="mt-card mt-grid" aria-label="Counts">
        <Stat label="RSVPs" value={stats.rsvps} />
        <Stat label="Tickets sold" value={stats.ticketsSold} />
        <Stat label="Checked in" value={`${stats.checkedIn} / ${stats.attendees}`} />
        <Stat
          label="Gross (paid to you)"
          value={<Money cents={stats.grossCents} currency={ticketTypes[0]?.currency ?? 'USD'} />}
        />
      </section>

      <EventForm
        action={saveEventAction.bind(null, event.id)}
        event={event}
        defaultTimezone={membership.timezone}
        submitLabel="Save details"
      />

      <section className="mt-card">
        <h2>Ticket types</h2>
        {ticketTypes.length === 0 ? (
          <p className="mt-muted">None yet. Add a free RSVP or a paid ticket below.</p>
        ) : null}
        {ticketTypes.map((type) => (
          <details key={type.id} className="mt-card">
            <summary>
              <strong>{type.name}</strong> ·{' '}
              <PriceLabel kind={type.kind} cents={type.priceCents} currency={type.currency} /> · {type.taken}
              {type.quantityLimit !== null ? ` / ${type.quantityLimit}` : ''} taken
            </summary>
            <TicketTypeFields
              action={updateTicketTypeAction.bind(null, event.id, type.id)}
              type={type}
              timezone={event.timezone}
              submitLabel="Save ticket type"
            />
            <form action={deleteTicketTypeAction.bind(null, event.id, type.id)}>
              <button type="submit" className="mt-button mt-button--danger">
                Delete ticket type
              </button>
            </form>
          </details>
        ))}
        <h3>Add a ticket type</h3>
        <TicketTypeFields
          action={addTicketTypeAction.bind(null, event.id)}
          timezone={event.timezone}
          submitLabel="Add"
        />
      </section>
    </main>
  )
}

function TicketTypeFields({
  action,
  type,
  timezone,
  submitLabel,
}: {
  action: (form: FormData) => Promise<void>
  type?: TicketTypeRecord
  timezone: string
  submitLabel: string
}) {
  return (
    <form action={action} className="mt-stack">
      <div className="mt-grid">
        <label className="mt-field">
          <span>Name</span>
          <input name="name" defaultValue={type?.name} required maxLength={120} placeholder="General admission" />
        </label>
        <label className="mt-field">
          <span>Kind</span>
          <select name="kind" defaultValue={type?.kind ?? 'rsvp'}>
            <option value="rsvp">Free RSVP</option>
            <option value="paid">Paid ticket</option>
          </select>
        </label>
        <label className="mt-field">
          <span>Price (paid only)</span>
          <input
            name="price"
            inputMode="decimal"
            defaultValue={type && type.kind === 'paid' ? (type.priceCents / 100).toFixed(2) : ''}
            placeholder="25.00"
          />
        </label>
        <label className="mt-field">
          <span>Currency</span>
          <input name="currency" defaultValue={type?.currency ?? 'USD'} maxLength={3} />
        </label>
        <label className="mt-field">
          <span>Quantity limit (blank = unlimited)</span>
          <input name="quantityLimit" inputMode="numeric" defaultValue={type?.quantityLimit ?? ''} />
        </label>
        <label className="mt-field">
          <span>Max per order</span>
          <input name="maxPerOrder" inputMode="numeric" defaultValue={type?.maxPerOrder ?? 10} />
        </label>
        <label className="mt-field">
          <span>Sales start (optional)</span>
          <input
            type="datetime-local"
            name="salesStart"
            defaultValue={type?.salesStart ? utcToZonedLocal(type.salesStart, timezone) : ''}
          />
        </label>
        <label className="mt-field">
          <span>Sales end (optional)</span>
          <input
            type="datetime-local"
            name="salesEnd"
            defaultValue={type?.salesEnd ? utcToZonedLocal(type.salesEnd, timezone) : ''}
          />
        </label>
        <label className="mt-field">
          <span>Order on page</span>
          <input name="sortOrder" inputMode="numeric" defaultValue={type?.sortOrder ?? 0} />
        </label>
      </div>
      <label className="mt-field">
        <span>Description</span>
        <input name="description" defaultValue={type?.description} maxLength={1000} />
      </label>
      <div>
        <button type="submit" className="mt-button mt-button--primary">
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
