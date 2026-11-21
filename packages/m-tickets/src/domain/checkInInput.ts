/**
 * One input box at the door takes both camera scans and typed codes.
 * Parsing (and QR signature verification) happens before the database is asked.
 */
import { looksLikeQrPayload, verifyQrPayload } from './qrToken'
import { normalizeTicketCode } from './ticketCode'
import type { CheckInMethod } from './types'

export type ParsedCheckIn =
  | { ok: true; method: CheckInMethod; code: string }
  | { ok: false; method: CheckInMethod; reason: 'invalid_input' | 'invalid_signature' }

export async function parseCheckInInput(input: string, qrSecret: string): Promise<ParsedCheckIn> {
  if (looksLikeQrPayload(input)) {
    const verified = await verifyQrPayload(input, qrSecret)
    if (verified.ok) return { ok: true, method: 'qr', code: verified.code }
    return {
      ok: false,
      method: 'qr',
      reason: verified.reason === 'bad_signature' ? 'invalid_signature' : 'invalid_input',
    }
  }
  const code = normalizeTicketCode(input)
  return code ? { ok: true, method: 'manual', code } : { ok: false, method: 'manual', reason: 'invalid_input' }
}
