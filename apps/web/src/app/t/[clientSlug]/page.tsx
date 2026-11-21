import { getStorefront } from '@zevaryn/m-tickets/db'
import { EmptyState, EventDate, Money, PublicCounts } from '@zevaryn/m-tickets/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { publicClient } from '@/lib/supabase/clients'

type Params = Promise<{ clientSlug: string }>

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const storefront = await getStorefront(publicClient(), (await params).clientSlug)
  return { title: storefront ? `${storefront.tenant.name} events` : 'Events' }
}

/** A client's public ticket page: every published, upcoming event. */
export default async function StorefrontPage({ params }: { params: Params }) {
  const { clientSlug } = await params
  const storefront = await getStorefront(publicClient(), clientSlug)
  if (!storefront) notFound()

  return (
    <main className="mt-page">
      <h1>{storefront.tenant.name}</h1>
      <p className="mt-muted">Upcoming events</p>
      {storefront.events.length === 0 ? (
        <EmptyState title="No upcoming events">Check back soon.</EmptyState>
      ) : (
        storefront.events.map((event) => (
          <Link key={event.slug} href={`/t/${storefront.tenant.slug}/${event.slug}`} className="mt-card mt-card--link">
            <h2>{event.title}</h2>
            <EventDate startsAt={event.startsAt} endsAt={event.endsAt} timezone={event.timezone} />
            {event.venueName ? <p className="mt-muted">{event.venueName}</p> : null}
            {event.summary ? <p>{event.summary}</p> : null}
            <p>
              {event.priceFromCents !== null && event.currency ? (
                <>
                  From <Money cents={event.priceFromCents} currency={event.currency} />
                  {event.hasRsvp ? ' · Free RSVP available' : ''}
                </>
              ) : event.hasRsvp ? (
                'Free · RSVP'
              ) : null}
            </p>
            <PublicCounts counts={event.counts} />
          </Link>
        ))
      )}
    </main>
  )
}
