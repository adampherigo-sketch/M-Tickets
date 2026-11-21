/**
 * Domain vocabulary for M-Tickets. Mirrors the database enums by value, but is
 * declared here so the domain stays free of generated or framework types.
 */
export type EventStatus = 'draft' | 'published' | 'cancelled'
export type TicketKind = 'rsvp' | 'paid'
export type TicketStatus = 'pending' | 'valid' | 'checked_in' | 'refunded' | 'void'
export type OrderStatus = 'pending' | 'completed' | 'expired' | 'refund_pending' | 'refunded'
export type RefundReason = 'requested' | 'sold_out'
export type CheckInMethod = 'qr' | 'manual'
export type CheckInResult =
  | 'checked_in'
  | 'already_checked_in'
  | 'not_found'
  | 'wrong_event'
  | 'not_valid'
  | 'invalid_input'
  | 'invalid_signature'
export type SalesState = 'not_started' | 'on_sale' | 'ended' | 'sold_out'

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error })
