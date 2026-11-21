/**
 * Ticket lifecycle and check-in rules.
 *
 *   pending ──confirm_payment──▶ valid ──check_in──▶ checked_in
 *      │                           │                     │
 *      └──────void──────┐          ├──refund──▶ refunded ◀┘ (refund)
 *                       ▼          │
 *                      void ◀──void┘
 *
 * refunded and void are terminal. The database functions in
 * 20261120000300_tickets_functions.sql apply the same transitions atomically;
 * tests/db/orders-and-checkin.test.ts holds the two in step.
 */
import type { CheckInResult, TicketStatus } from './types'

export type TicketTransition = 'confirm_payment' | 'check_in' | 'refund' | 'void'

export const TICKET_TRANSITIONS: Readonly<
  Record<TicketTransition, { from: readonly TicketStatus[]; to: TicketStatus }>
> = {
  confirm_payment: { from: ['pending'], to: 'valid' },
  check_in: { from: ['valid'], to: 'checked_in' },
  refund: { from: ['valid', 'checked_in'], to: 'refunded' },
  void: { from: ['pending', 'valid'], to: 'void' },
}

export class InvalidTicketTransitionError extends Error {
  constructor(
    readonly from: TicketStatus,
    readonly transition: TicketTransition,
  ) {
    super(`A ${from} ticket cannot ${transition.replace('_', ' ')}`)
    this.name = 'InvalidTicketTransitionError'
  }
}

export function canTransition(from: TicketStatus, transition: TicketTransition): boolean {
  return TICKET_TRANSITIONS[transition].from.includes(from)
}

export function applyTransition(from: TicketStatus, transition: TicketTransition): TicketStatus {
  if (!canTransition(from, transition)) throw new InvalidTicketTransitionError(from, transition)
  return TICKET_TRANSITIONS[transition].to
}

export function isTerminal(status: TicketStatus): boolean {
  return (Object.keys(TICKET_TRANSITIONS) as TicketTransition[]).every((t) => !canTransition(status, t))
}

/** Counts toward attendance and inventory once issued. */
export function isAdmitting(status: TicketStatus): boolean {
  return status === 'valid' || status === 'checked_in'
}

/** What check-in should do with a ticket that was found (or not). */
export function decideCheckIn(
  ticket: { status: TicketStatus; eventId: string } | null,
  eventId: string,
): CheckInResult {
  if (!ticket) return 'not_found'
  if (ticket.eventId !== eventId) return 'wrong_event'
  if (ticket.status === 'checked_in') return 'already_checked_in'
  if (canTransition(ticket.status, 'check_in')) return 'checked_in'
  return 'not_valid'
}

export interface AttendanceTally {
  /** Tickets that admit someone: valid + checked in. */
  expected: number
  checkedIn: number
  notArrived: number
  /** 0–100, rounded down. */
  percentArrived: number
}

export function tallyAttendance(tickets: readonly { status: TicketStatus }[]): AttendanceTally {
  let expected = 0
  let checkedIn = 0
  for (const ticket of tickets) {
    if (!isAdmitting(ticket.status)) continue
    expected += 1
    if (ticket.status === 'checked_in') checkedIn += 1
  }
  return {
    expected,
    checkedIn,
    notArrived: expected - checkedIn,
    percentArrived: expected === 0 ? 0 : Math.floor((checkedIn / expected) * 100),
  }
}

export const CHECK_IN_MESSAGES: Readonly<Record<CheckInResult, string>> = {
  checked_in: 'Checked in',
  already_checked_in: 'Already checked in',
  not_found: 'No ticket with that code',
  wrong_event: 'This ticket is for a different event',
  not_valid: 'Ticket is not valid (refunded, void or unpaid)',
  invalid_input: 'That is not a ticket code',
  invalid_signature: 'QR code failed verification',
}
