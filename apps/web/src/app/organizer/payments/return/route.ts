import { refreshPaymentAccount } from '@zevaryn/m-tickets/server'
import { NextResponse, type NextRequest } from 'next/server'
import { organizerForApi } from '@/lib/auth'
import { ticketsContext } from '@/lib/tickets'

/** Stripe's onboarding return_url. Re-reads the account status, then back to the page. */
export async function GET(request: NextRequest) {
  const organizer = await organizerForApi()
  if (!organizer) return NextResponse.redirect(new URL('/login', request.url))
  if (organizer.isManager && request.nextUrl.searchParams.get('provider') === 'stripe') {
    try {
      await refreshPaymentAccount(ticketsContext(), {
        tenantId: organizer.membership.tenantId,
        actorRole: organizer.membership.role,
        provider: 'stripe',
      })
    } catch (error) {
      console.error(error)
    }
  }
  return NextResponse.redirect(new URL('/organizer/payments?returned=1', request.url))
}
