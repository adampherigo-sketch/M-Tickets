import type { Attendee } from '@zevaryn/m-tickets/db'
import type { AttendeeView } from '@zevaryn/m-tickets/ui'

/** What the command page sends to the browser (JSON-safe, no internal fields). */
export function toAttendeeView(a: Attendee): AttendeeView {
  return {
    ticketId: a.ticketId,
    attendeeName: a.attendeeName,
    attendeeEmail: a.attendeeEmail,
    buyerEmail: a.buyerEmail,
    ticketTypeId: a.ticketTypeId,
    ticketTypeName: a.ticketTypeName,
    kind: a.kind,
    status: a.status,
    ticketCode: a.ticketCode,
    checkedInAt: a.checkedInAt?.toISOString() ?? null,
  }
}
