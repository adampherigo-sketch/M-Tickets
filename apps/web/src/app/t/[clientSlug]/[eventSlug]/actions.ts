'use server'

import { placeOrder } from '@zevaryn/m-tickets/server'
import { redirect } from 'next/navigation'
import { parseDeliveryChoice, parseOrderLines, withMessage } from '@/lib/forms'
import { dispatchAfterResponse, ticketsContext } from '@/lib/tickets'

/**
 * Public, unauthenticated. All validation happens in the M-Tickets server layer
 * and again inside tickets_place_order (prices, inventory, sales windows).
 * Next step: rate limiting / bot protection before this goes live.
 */
export async function placeOrderAction(clientSlug: string, eventSlug: string, form: FormData): Promise<void> {
  const eventPath = `/t/${encodeURIComponent(clientSlug)}/${encodeURIComponent(eventSlug)}`
  const outcome = await placeOrder(ticketsContext(), {
    clientSlug,
    eventSlug,
    request: {
      buyerName: String(form.get('buyerName') ?? ''),
      buyerEmail: String(form.get('buyerEmail') ?? ''),
      lines: parseOrderLines(form),
      delivery: parseDeliveryChoice(form),
    },
  })
  if (outcome.kind === 'rejected') redirect(withMessage(eventPath, 'error', outcome.message))
  if (outcome.kind === 'confirmed') {
    // A free order is complete already and its confirmation is queued: send it now.
    dispatchAfterResponse()
    redirect(`/t/${encodeURIComponent(clientSlug)}/orders/${outcome.orderToken}`)
  }
  redirect(outcome.redirectUrl)
}
