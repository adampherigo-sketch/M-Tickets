'use server'

import { startPaymentOnboarding } from '@zevaryn/m-tickets/server'
import { redirect } from 'next/navigation'
import { requireManager } from '@/lib/auth'
import { withMessage } from '@/lib/forms'
import { ticketsContext } from '@/lib/tickets'

export async function connectStripeAction(): Promise<void> {
  const { membership, user } = await requireManager()
  let url: string
  try {
    url = await startPaymentOnboarding(ticketsContext(), {
      tenantId: membership.tenantId,
      tenantName: membership.tenantName,
      email: user.email ?? null,
      actorRole: membership.role,
      provider: 'stripe',
    })
  } catch (error) {
    console.error(error)
    redirect(withMessage('/organizer/payments', 'error', 'Could not reach Stripe. Please try again.'))
  }
  redirect(url)
}
