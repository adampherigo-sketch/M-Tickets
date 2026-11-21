/**
 * Database functions raise `MT_<CODE>` messages (SQLSTATE P0001, or 42501 for
 * permission). This turns them, and the few constraint violations the app
 * expects, into typed errors.
 */
export type TicketsDbErrorCode =
  | 'event_not_on_sale'
  | 'invalid_quantity'
  | 'unknown_ticket_type'
  | 'not_on_sale_yet'
  | 'sales_ended'
  | 'exceeds_per_order_max'
  | 'sold_out'
  | 'exceeds_remaining'
  | 'mixed_currency'
  | 'payments_not_configured'
  | 'invalid_hold'
  | 'order_not_found'
  | 'amount_mismatch'
  | 'order_not_refundable'
  | 'forbidden'
  | 'bad_request'
  | 'not_authenticated'
  | 'code_collision'
  | 'duplicate_slug'
  | 'in_use'
  | 'unknown'

export class TicketsDbError extends Error {
  constructor(
    readonly code: TicketsDbErrorCode,
    message: string,
    readonly pgCode?: string,
  ) {
    super(message)
    this.name = 'TicketsDbError'
  }
}

interface PgLikeError {
  message: string
  code?: string
  details?: string | null
}

export function toTicketsDbError(error: PgLikeError, context: string): TicketsDbError {
  const mt = /MT_([A-Z_]+)/.exec(error.message)
  if (mt)
    return new TicketsDbError(mt[1]!.toLowerCase() as TicketsDbErrorCode, `${context}: ${error.message}`, error.code)
  const text = `${error.message} ${error.details ?? ''}`
  if (error.code === '23505' && /ticket_code|qr_payload/.test(text)) {
    return new TicketsDbError('code_collision', `${context}: ticket code collision`, error.code)
  }
  if (error.code === '23505' && /slug/.test(text)) {
    return new TicketsDbError('duplicate_slug', `${context}: that link name is already used`, error.code)
  }
  if (error.code === '23503') return new TicketsDbError('in_use', `${context}: still referenced`, error.code)
  if (error.code === '42501') return new TicketsDbError('forbidden', `${context}: not allowed`, error.code)
  return new TicketsDbError('unknown', `${context}: ${error.message}`, error.code)
}

export function unwrap<R extends { data: unknown; error: PgLikeError | null }>(
  result: R,
  context: string,
): NonNullable<R['data']> {
  if (result.error) throw toTicketsDbError(result.error, context)
  if (result.data === null || result.data === undefined)
    throw new TicketsDbError('unknown', `${context}: no data returned`)
  return result.data as NonNullable<R['data']>
}
