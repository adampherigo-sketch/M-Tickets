import type { CheckInResult, TicketKind, TicketStatus } from '../../domain'

/** An attendee as sent to the browser (dates as ISO strings). */
export interface AttendeeView {
  ticketId: string
  attendeeName: string
  attendeeEmail: string | null
  buyerEmail: string
  ticketTypeId: string
  ticketTypeName: string
  kind: TicketKind
  status: TicketStatus
  ticketCode: string
  checkedInAt: string | null
}

/** What the check-in endpoint returns. */
export interface CheckInFeedback {
  result: CheckInResult
  message: string
  attendeeName: string | null
  ticketTypeName: string | null
}

export interface ThankYouState {
  message: string | null
}
