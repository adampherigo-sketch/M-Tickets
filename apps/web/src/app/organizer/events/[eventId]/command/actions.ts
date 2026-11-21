'use server'

import type { ThankYouState } from '@zevaryn/m-tickets/ui'
import { thankAttendees } from '@zevaryn/m-tickets/server'
import { requireManager } from '@/lib/auth'
import { dispatchAfterResponse, ticketsContext } from '@/lib/tickets'

export async function thankAttendeesAction(
  eventId: string,
  _state: ThankYouState,
  _form: FormData,
): Promise<ThankYouState> {
  const { supabase } = await requireManager()
  try {
    const queued = await thankAttendees(ticketsContext(), supabase, eventId)
    if (queued > 0) dispatchAfterResponse()
    return {
      message:
        queued === 0
          ? 'Everyone who checked in has already been thanked.'
          : `Sending ${queued} thank-you ${queued === 1 ? 'email' : 'emails'}.`,
    }
  } catch (error) {
    console.error(error)
    return { message: 'Could not queue thank-you messages. Please try again.' }
  }
}
