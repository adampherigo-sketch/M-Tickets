import { getBuyerOrder } from '@zevaryn/m-tickets/server'
import { EventDate, Money, StatusBadge, TicketCode, TicketQr } from '@zevaryn/m-tickets/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ticketsContext } from '@/lib/tickets'

// The token in the URL is the buyer's credential: never index, cache or refer it.
export const metadata: Metadata = {
  title: 'Your tickets',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
}
export const dynamic = 'force-dynamic'

type Params = Promise<{ clientSlug: string; token: string }>

/** The buyer's tickets, each with its QR code and a typeable code. */
export default async function OrderPage({ params }: { params: Params }) {
  const { clientSlug, token } = await params
  const order = await getBuyerOrder(ticketsContext(), token)
  if (!order || order.tenantSlug !== clientSlug) notFound()
  const { event } = order
  // The event sold out between the buyer's hold lapsing and their payment landing.
  const soldOut = order.refundReason === 'sold_out'
  const showTickets = order.status === 'completed' || (order.status === 'refunded' && !soldOut)
  const waiting = order.status === 'pending' || order.status === 'refund_pending'

  return (
    <main className="mt-page mt-narrow">
      {waiting ? <meta httpEquiv="refresh" content="5" /> : null}
      <p>
        <Link href={`/t/${order.tenantSlug}/${event.slug}`}>← {event.title}</Link>
      </p>
      <h1>{soldOut ? 'Sold out' : order.tickets.every((t) => t.kind === 'rsvp') ? "You're going!" : 'Your tickets'}</h1>
      <p>
        <strong>{event.title}</strong> · {order.tenantName}
        <br />
        <EventDate startsAt={event.startsAt} endsAt={event.endsAt} timezone={event.timezone} />
        {event.venueName ? (
          <>
            <br />
            {event.venueName}
            {event.venueAddress ? `, ${event.venueAddress}` : ''}
          </>
        ) : null}
      </p>

      {order.status === 'pending' ? (
        <p className="mt-notice">Confirming your payment… this page refreshes on its own.</p>
      ) : null}
      {order.status === 'expired' ? (
        <p className="mt-error">
          This order expired before payment completed. If you were charged, the charge is refunded automatically.
        </p>
      ) : null}
      {order.status === 'refund_pending' ? (
        <p className="mt-error" role="alert">
          <strong>Sold out.</strong> The last tickets went to other buyers before your payment went through. We are
          refunding your payment in full now; this page updates on its own.
        </p>
      ) : null}
      {order.status === 'refunded' && soldOut ? (
        <p className="mt-error" role="alert">
          <strong>Sold out: you have been refunded.</strong> The last tickets went to other buyers before your payment
          went through, so we refunded the full amount. It can take 5 to 10 business days to appear on your statement.
        </p>
      ) : null}
      {order.status === 'refunded' && !soldOut ? (
        <p className="mt-error">This order was refunded. These tickets are no longer valid.</p>
      ) : null}

      {showTickets
        ? order.tickets.map((ticket) => (
            <section key={ticket.id} className="mt-card mt-ticket">
              {ticket.status === 'valid' || ticket.status === 'checked_in' ? (
                <TicketQr payload={ticket.qrPayload} label={`QR code for ${ticket.attendeeName}'s ticket`} />
              ) : null}
              <div className="mt-stack">
                <div>
                  <strong>{ticket.attendeeName}</strong> · {ticket.ticketTypeName}
                </div>
                <div>
                  <TicketCode code={ticket.ticketCode} />
                </div>
                <StatusBadge status={ticket.status} />
                <p className="mt-muted">Show the QR code at the door, or read out the code.</p>
              </div>
            </section>
          ))
        : null}

      {order.totalCents > 0 ? (
        <p className="mt-muted">
          {soldOut ? 'Amount refunded' : 'Order total'} <Money cents={order.totalCents} currency={order.currency} />
        </p>
      ) : null}
      <p className="mt-muted">Keep this link private: anyone with it can use these tickets.</p>
    </main>
  )
}
