import { WebhookSignatureError } from '@zevaryn/m-tickets/payments'
import { handlePaymentWebhook } from '@zevaryn/m-tickets/server'
import { NextResponse, type NextRequest } from 'next/server'
import { dispatchAfterResponse, ticketsContext } from '@/lib/tickets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Stripe Connect webhook ("events on connected accounts"). Subscribe to:
 *   checkout.session.completed, checkout.session.async_payment_succeeded,
 *   checkout.session.async_payment_failed, checkout.session.expired,
 *   charge.refunded, account.updated
 *
 * 400 on a bad signature (Stripe stops retrying); 500 on our failure (Stripe
 * retries, and every step is idempotent).
 */
export async function POST(request: NextRequest) {
  const ctx = ticketsContext()
  if (!ctx.payments.has('stripe')) return NextResponse.json({ error: 'Stripe is not configured' }, { status: 503 })

  // The signature covers the exact bytes, so read the raw body before anything parses it.
  const rawBody = await request.text()
  try {
    const outcome = await handlePaymentWebhook(ctx, 'stripe', rawBody, request.headers.get('stripe-signature'))
    // The order's confirmation was queued in the same transaction: send it now.
    if (outcome === 'order_completed') dispatchAfterResponse()
    return NextResponse.json({ received: true, outcome })
  } catch (error) {
    if (error instanceof WebhookSignatureError)
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
    console.error('[m-tickets] stripe webhook failed', error)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}
