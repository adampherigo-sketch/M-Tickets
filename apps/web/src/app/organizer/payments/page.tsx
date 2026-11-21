import { listPaymentAccounts } from '@zevaryn/m-tickets/db'
import type { Metadata } from 'next'
import { Banners, param, type SearchParams } from '@/app/messages'
import { requireManager } from '@/lib/auth'
import { ticketsContext } from '@/lib/tickets'
import { connectStripeAction } from './actions'

export const metadata: Metadata = { title: 'Payments' }
export const dynamic = 'force-dynamic'

const STATUS_TEXT = {
  connected: 'Connected. Buyers can pay by card.',
  onboarding: 'Setup not finished. Stripe still needs some details.',
  disabled: 'Stripe has paused this account. Open your Stripe dashboard to fix it.',
} as const

/** Connect the client's own payment account. Revenue goes straight to it. */
export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  const { supabase, membership } = await requireManager()
  const params = await searchParams
  const accounts = await listPaymentAccounts(supabase, membership.tenantId)
  const stripe = accounts.find((a) => a.provider === 'stripe')
  const stripeAvailable = ticketsContext().payments.has('stripe')

  return (
    <main className="mt-page mt-narrow">
      <h1>Payments</h1>
      <Banners params={params} />
      {param(params, 'returned') ? (
        <p className="mt-notice">Welcome back. Your Stripe status is updated below.</p>
      ) : null}
      <p>
        Ticket money is paid into <strong>your own</strong> payment account. M-Tickets takes 0% of ticket sales. Your
        provider&apos;s standard processing fees apply and come out of each sale.
      </p>
      <p className="mt-muted">Free RSVPs never need a payment account.</p>

      <section className="mt-card mt-stack">
        <h2>Stripe</h2>
        {!stripeAvailable ? (
          <p className="mt-muted">Stripe is not configured on this server yet (STRIPE_SECRET_KEY).</p>
        ) : (
          <>
            <p>{stripe ? STATUS_TEXT[stripe.status] : 'Not connected.'}</p>
            {stripe?.status !== 'connected' ? (
              <form action={connectStripeAction}>
                <button type="submit" className="mt-button mt-button--primary">
                  {stripe ? 'Continue Stripe setup' : 'Connect Stripe'}
                </button>
              </form>
            ) : null}
          </>
        )}
      </section>

      <section className="mt-card">
        <h2>Square</h2>
        <p className="mt-muted">Coming soon for businesses that already use Square.</p>
      </section>
    </main>
  )
}
