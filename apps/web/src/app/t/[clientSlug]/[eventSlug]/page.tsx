import { getPublicEvent, type PublicTicketType } from '@zevaryn/m-tickets/db'
import { EventDate, PriceLabel, PublicCounts } from '@zevaryn/m-tickets/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Banners, type SearchParams } from '@/app/messages'
import { publicClient } from '@/lib/supabase/clients'
import { placeOrderAction } from './actions'

type Params = Promise<{ clientSlug: string; eventSlug: string }>

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { clientSlug, eventSlug } = await params
  const data = await getPublicEvent(publicClient(), clientSlug, eventSlug)
  return { title: data ? `${data.event.title} · ${data.tenant.name}` : 'Event' }
}

const SALES_STATE_LABEL: Record<PublicTicketType['salesState'], string> = {
  on_sale: '',
  not_started: 'Not on sale yet',
  ended: 'Sales ended',
  sold_out: 'Sold out',
}

function quantityOptions(type: PublicTicketType): number[] {
  const max = type.remaining === null ? type.maxPerOrder : Math.min(type.maxPerOrder, type.remaining)
  return Array.from({ length: max + 1 }, (_, i) => i)
}

/** One event: details plus the buy / RSVP form. Works without client JavaScript. */
export default async function PublicEventPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { clientSlug, eventSlug } = await params
  const data = await getPublicEvent(publicClient(), clientSlug, eventSlug)
  if (!data) notFound()
  const { tenant, event, ticket_types: ticketTypes } = data
  const onSale = ticketTypes.filter((t) => t.salesState === 'on_sale')
  const allFree = onSale.every((t) => t.kind === 'rsvp')

  return (
    <main className="mt-page mt-narrow">
      <p>
        <Link href={`/t/${tenant.slug}`}>← {tenant.name}</Link>
      </p>
      <h1>{event.title}</h1>
      <EventDate startsAt={event.startsAt} endsAt={event.endsAt} timezone={event.timezone} />
      {event.venueName || event.venueAddress ? (
        <p>
          {event.venueName}
          {event.venueName && event.venueAddress ? <br /> : null}
          <span className="mt-muted">{event.venueAddress}</span>
        </p>
      ) : null}
      <PublicCounts counts={event.counts} />
      {event.description ? <p className="mt-prewrap">{event.description}</p> : null}

      <Banners params={await searchParams} />

      <form action={placeOrderAction.bind(null, tenant.slug, event.slug)} className="mt-card mt-stack">
        <h2>{allFree ? 'RSVP' : 'Tickets'}</h2>
        {ticketTypes.map((type) => (
          <div key={type.id} className="mt-row">
            <div className="mt-grow">
              <strong>{type.name}</strong> ·{' '}
              <PriceLabel kind={type.kind} cents={type.priceCents} currency={type.currency} />
              {type.description ? <div className="mt-muted">{type.description}</div> : null}
              {type.salesState !== 'on_sale' ? (
                <div className="mt-muted">{SALES_STATE_LABEL[type.salesState]}</div>
              ) : null}
              {type.remaining !== null && type.salesState === 'on_sale' ? (
                <div className="mt-muted">{type.remaining} left</div>
              ) : null}
            </div>
            {type.salesState === 'on_sale' ? (
              <label className="mt-field">
                <span>Quantity</span>
                <select name={`qty:${type.id}`} defaultValue={onSale.length === 1 ? '1' : '0'}>
                  {quantityOptions(type).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        ))}

        {onSale.length > 0 ? (
          <>
            <label className="mt-field">
              <span>Your name</span>
              <input name="buyerName" autoComplete="name" required maxLength={200} />
            </label>
            <label className="mt-field">
              <span>Email (your tickets are sent here)</span>
              <input name="buyerEmail" type="email" autoComplete="email" required maxLength={320} />
            </label>
            <button type="submit" className="mt-button mt-button--primary">
              {allFree ? 'RSVP' : 'Continue to payment'}
            </button>
            {!allFree ? (
              <p className="mt-muted">Payment is processed securely by {tenant.name}&apos;s payment provider.</p>
            ) : null}
          </>
        ) : (
          <p className="mt-muted">Nothing is on sale right now.</p>
        )}
      </form>
    </main>
  )
}
