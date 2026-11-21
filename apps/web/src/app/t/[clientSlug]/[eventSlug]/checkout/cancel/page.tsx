import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Checkout cancelled', robots: { index: false } }

type Params = Promise<{ clientSlug: string; eventSlug: string }>

/**
 * The buyer backed out of checkout. Their seats are released when the hold
 * expires (or immediately when Stripe reports the session expired).
 */
export default async function CheckoutCancelPage({ params }: { params: Params }) {
  const { clientSlug, eventSlug } = await params
  return (
    <main className="mt-page mt-narrow">
      <h1>Checkout cancelled</h1>
      <p>You have not been charged. Any seats held for you will be released shortly.</p>
      <Link className="mt-button" href={`/t/${clientSlug}/${eventSlug}`}>
        Back to the event
      </Link>
    </main>
  )
}
