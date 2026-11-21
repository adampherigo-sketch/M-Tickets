/**
 * QR payload: "MT1.<ticket code>.<signature>".
 *
 * The signature is an HMAC-SHA256 of "MT1.<code>" with TICKETS_QR_SECRET,
 * truncated to 128 bits and base64url-encoded. It is opaque (no database ids)
 * and lets the check-in endpoint reject a forged or mistyped QR code before it
 * touches the database. Rotating the secret invalidates printed QR codes but
 * not typed codes, which stay the fallback at the door.
 *
 * Uses Web Crypto only, so it runs in Node, the edge and the browser alike.
 */
import { base64url } from './base64url'
import { isTicketCode } from './ticketCode'

export const QR_PREFIX = 'MT1'
const SIGNATURE_BYTES = 16
const MIN_SECRET_LENGTH = 32

export type QrVerification = { ok: true; code: string } | { ok: false; reason: 'malformed' | 'bad_signature' }

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`TICKETS_QR_SECRET must be at least ${MIN_SECRET_LENGTH} characters`)
  }
}

async function sign(code: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${QR_PREFIX}.${code}`)))
  return base64url(mac.slice(0, SIGNATURE_BYTES))
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function signQrPayload(code: string, secret: string): Promise<string> {
  assertSecret(secret)
  if (!isTicketCode(code)) throw new Error('Not a ticket code')
  return `${QR_PREFIX}.${code}.${await sign(code, secret)}`
}

export async function verifyQrPayload(payload: string, secret: string): Promise<QrVerification> {
  assertSecret(secret)
  const parts = payload.trim().split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [prefix, code, signature] = parts as [string, string, string]
  if (prefix !== QR_PREFIX || !isTicketCode(code) || signature.length === 0) return { ok: false, reason: 'malformed' }
  const expected = await sign(code, secret)
  return constantTimeEqual(expected, signature) ? { ok: true, code } : { ok: false, reason: 'bad_signature' }
}

/** Scanners and keyboards both feed the same box; this tells them apart. */
export function looksLikeQrPayload(input: string): boolean {
  return input.trim().startsWith(`${QR_PREFIX}.`)
}
