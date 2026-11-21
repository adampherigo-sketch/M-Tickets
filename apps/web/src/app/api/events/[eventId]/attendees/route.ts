import { getEvent, listAttendees } from '@zevaryn/m-tickets/db'
import { NextResponse, type NextRequest } from 'next/server'
import { organizerForApi } from '@/lib/auth'
import { toAttendeeView } from '@/lib/views'

export const dynamic = 'force-dynamic'

/** Guest list for the command page's live tally (polled). RLS scopes it to the user's tenants. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const organizer = await organizerForApi()
  if (!organizer) return NextResponse.json({ error: 'Sign in again.' }, { status: 401 })
  const { eventId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const event = await getEvent(organizer.supabase, eventId)
  if (!event) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const attendees = await listAttendees(organizer.supabase, eventId)
  return NextResponse.json(
    { attendees: attendees.map(toAttendeeView) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
