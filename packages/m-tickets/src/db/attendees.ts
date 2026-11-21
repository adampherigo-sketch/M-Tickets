/** Guest list and check-in, for the event command page (signed-in client). */
import type { DbClient } from '@zevaryn/database'
import { z } from 'zod'
import type { CheckInMethod, CheckInResult, TicketKind, TicketStatus } from '../domain'
import { toTicketsDbError, unwrap } from './errors'

export interface Attendee {
  ticketId: string
  attendeeName: string
  attendeeEmail: string | null
  buyerName: string
  buyerEmail: string
  ticketTypeId: string
  ticketTypeName: string
  kind: TicketKind
  status: TicketStatus
  ticketCode: string
  checkedInAt: Date | null
}

/** Guests who hold (or held) a real ticket; unpaid holds and voids are left out. */
export async function listAttendees(client: DbClient, eventId: string): Promise<Attendee[]> {
  const rows = unwrap(
    await client
      .from('tickets')
      .select(
        'id, attendee_name, attendee_email, ticket_code, status, checked_in_at, ticket_type_id, ticket_types(name, kind), ticket_orders(buyer_name, buyer_email)',
      )
      .eq('event_id', eventId)
      .in('status', ['valid', 'checked_in', 'refunded'])
      .order('attendee_name'),
    'List attendees',
  )
  return rows.map((row) => ({
    ticketId: row.id,
    attendeeName: row.attendee_name,
    attendeeEmail: row.attendee_email,
    buyerName: row.ticket_orders.buyer_name,
    buyerEmail: row.ticket_orders.buyer_email,
    ticketTypeId: row.ticket_type_id,
    ticketTypeName: row.ticket_types.name,
    kind: row.ticket_types.kind,
    status: row.status,
    ticketCode: row.ticket_code,
    checkedInAt: row.checked_in_at ? new Date(row.checked_in_at) : null,
  }))
}

const checkInResponseSchema = z.object({
  result: z.enum([
    'checked_in',
    'already_checked_in',
    'not_found',
    'wrong_event',
    'not_valid',
    'invalid_input',
    'invalid_signature',
  ]),
  ticket: z
    .object({
      id: z.uuid(),
      event_id: z.uuid(),
      ticket_type_id: z.uuid(),
      attendee_name: z.string(),
      ticket_type_name: z.string(),
      status: z.enum(['pending', 'valid', 'checked_in', 'refunded', 'void']),
      checked_in_at: z.string().nullable(),
    })
    .nullable(),
})

export interface CheckInResponse {
  result: CheckInResult
  ticket: {
    id: string
    eventId: string
    ticketTypeId: string
    attendeeName: string
    ticketTypeName: string
    status: TicketStatus
    checkedInAt: string | null
  } | null
}

/**
 * Calls tickets_check_in. The function checks membership, locks the ticket so
 * two scanners cannot both admit it, and logs every attempt.
 */
export async function checkInTicket(
  client: DbClient,
  input: {
    eventId: string
    method: CheckInMethod
    code?: string
    rejectedReason?: 'invalid_input' | 'invalid_signature'
  },
): Promise<CheckInResponse> {
  const { data, error } = await client.rpc('tickets_check_in', {
    p_event_id: input.eventId,
    p_method: input.method,
    ...(input.code ? { p_ticket_code: input.code } : {}),
    ...(input.rejectedReason ? { p_rejected_reason: input.rejectedReason } : {}),
  })
  if (error) throw toTicketsDbError(error, 'Check in')
  const parsed = checkInResponseSchema.parse(data)
  return {
    result: parsed.result,
    ticket: parsed.ticket
      ? {
          id: parsed.ticket.id,
          eventId: parsed.ticket.event_id,
          ticketTypeId: parsed.ticket.ticket_type_id,
          attendeeName: parsed.ticket.attendee_name,
          ticketTypeName: parsed.ticket.ticket_type_name,
          status: parsed.ticket.status,
          checkedInAt: parsed.ticket.checked_in_at,
        }
      : null,
  }
}

/** Queues thank-you messages for checked-in guests; returns how many were new. */
export async function queueThankYou(client: DbClient, eventId: string): Promise<number> {
  const { data, error } = await client.rpc('tickets_queue_thank_you', { p_event_id: eventId })
  if (error) throw toTicketsDbError(error, 'Queue thank-you messages')
  return data
}
