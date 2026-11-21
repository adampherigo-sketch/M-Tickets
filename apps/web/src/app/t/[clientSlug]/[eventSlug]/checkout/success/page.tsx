import { getBuyerOrder } from '@zevaryn/m-tickets/server'
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { param, type SearchParams } from '@/app/messages'
import { ticketsContext } from '@/lib/tickets'

export const metadata: Metadata = { title: 'Payment received', robots: { index: false } }
export const dynamic = 'force-dynamic'

type Params = Promise<{ clientSlug: string; eventSlug: string }>

/**
 * Stripe sends the buyer here after paying. The order completes when the
 * webhook arrives, usually within seconds, so this page waits for it.
 */
export default async function CheckoutSuccessPage({
  params,
  searchParams,
}: {
  params: Params
  searchParams: SearchParams
}) {
  const { clientSlug, eventSlug } = await params
  const token = param(await searchParams, 'order') ?? ''
  const order = await getBuyerOrder(ticketsContext(), token)
  // pending/expired: the webhook has not landed yet. Anything else (tickets
  // issued, or sold out and refunded) is shown on the order page.
  if (order && order.tenantSlug === clientSlug && order.status !== 'pending' && order.status !== 'expired') {
    redirect(`/t/${clientSlug}/orders/${token}`)
  }

  return (
    <main className="mt-page mt-narrow">
      {order ? <meta httpEquiv="refresh" content="3" /> : null}
      <h1>Thanks! Confirming your payment…</h1>
      <p>This usually takes a few seconds. This page refreshes on its own.</p>
      {order ? (
        <p>
          <Link href={`/t/${clientSlug}/orders/${token}`}>View your order</Link>
        </p>
      ) : (
        <p className="mt-muted">
          We could not find that order. If you were charged, check your email for a receipt, or{' '}
          <Link href={`/t/${clientSlug}/${eventSlug}`}>go back to the event</Link>.
        </p>
      )}
    </main>
  )
}
