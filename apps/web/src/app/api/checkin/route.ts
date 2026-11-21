import { TicketsDbError } from '@zevaryn/m-tickets/db'
import { CHECK_IN_MESSAGES } from '@zevaryn/m-tickets/domain'
import { checkIn } from '@zevaryn/m-tickets/server'
import type { CheckInFeedback } from '@zevaryn/m-tickets/ui'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { organizerForApi } from '@/lib/auth'
import { ticketsContext } from '@/lib/tickets'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  eventId: z.uuid(),
  // A QR payload or a typed code. Anything longer is not either.
  input: z.string().min(1).max(200),
})

/**
 * Check-in endpoint (organizer session required, any role). Validation,
 * double check-in prevention and the audit log all happen in
 * tickets_check_in(); QR signatures are verified before that.
 */
export async function POST(request: NextRequest) {
  const organizer = await organizerForApi()
  if (!organizer) return NextResponse.json({ error: 'Sign in again.' }, { status: 401 })

  const body = bodySchema.safeParse(await request.json().catch(() => null))
  if (!body.success)
    return NextResponse.json({ error: 'Send an eventId and the scanned or typed code.' }, { status: 400 })

  try {
    const response = await checkIn(ticketsContext(), organizer.supabase, body.data)
    const feedback: CheckInFeedback = {
      result: response.result,
      message: CHECK_IN_MESSAGES[response.result],
      attendeeName: response.ticket?.attendeeName ?? null,
      ticketTypeName: response.ticket?.ticketTypeName ?? null,
    }
    return NextResponse.json(feedback)
  } catch (error) {
    if (error instanceof TicketsDbError && error.code === 'forbidden') {
      return NextResponse.json({ error: 'You are not on the team for this event.' }, { status: 403 })
    }
    console.error('[m-tickets] check-in failed', error)
    return NextResponse.json({ error: 'Check-in failed. Try again.' }, { status: 500 })
  }
}
